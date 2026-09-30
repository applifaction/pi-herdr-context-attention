import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const piDir = process.env.PI_TEST_PACKAGE_DIR ?? join(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const requireFromPi = createRequire(join(piDir, "package.json"));
const { createJiti } = requireFromPi("jiti");
const piJiti = createJiti(join(piDir, "package.json"));
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-ai": fileURLToPath(piJiti.esmResolve("@earendil-works/pi-ai")),
    "@earendil-works/pi-coding-agent": join(piDir, "dist/index.js"),
  },
});
const installAttention = process.env.BASELINE_ONLY ? () => {} : await jiti.import("../index.ts", { default: true });
const { AgentSession } = await jiti.import("@earendil-works/pi-coding-agent");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const integrationPath = process.env.HERDR_PI_INTEGRATION_PATH ?? join(agentDir, "extensions", "herdr-agent-state.ts");
const nativeSource = await readFile(integrationPath, "utf8");
const nativeJS = stripTypeScriptTypes(nativeSource);
let instance = 0;
const overflow = {
  role: "assistant", stopReason: "error", content: [],
  errorMessage: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
};
const success = { role: "assistant", stopReason: "stop", content: [] };
const entry = (message) => ({ type: "message", message });

async function harness(t, { branch = [], mode = "tui", reverse = false, idle = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-context-test-"));
  const envKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "test.sock"), HERDR_PANE_ID: "test:p1" });
  const reports = [], busEvents = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", data => {
      buffer += data;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      reports.push(request);
      socket.end(JSON.stringify({ id: request.id, result: {} }) + "\n");
    });
  });
  await new Promise(resolve => server.listen(process.env.HERDR_SOCKET_PATH, resolve));
  const handlers = new Map(), emitter = new EventEmitter();
  const ctx = {
    mode, isIdle: () => idle,
    sessionManager: {
      getSessionId: () => "test-session", getSessionFile: () => "/tmp/test-session.jsonl",
      getBranch: () => branch,
    },
  };
  const commands = new Map();
  const notifications = [];
  ctx.ui = { notify: (message) => notifications.push(message) };
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: {
      on: (name, handler) => emitter.on(name, handler),
      emit(name, data) { busEvents.push({ name, data }); emitter.emit(name, data); },
    },
  };
  const native = (await import(`data:text/javascript;base64,${Buffer.from(nativeJS + `\n// instance ${instance++}`).toString("base64")}`)).default;
  if (reverse) { installAttention(pi); native(pi); }
  else { native(pi); installAttention(pi); }
  const emit = async (type, fields = {}) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...fields }, ctx);
  };
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    await delay(30);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
    await rm(dir, { recursive: true, force: true });
  });
  return {
    emit, pi, ctx, reports, busEvents, commands, notifications,
    async badge() {
      await delay(60);
      return reports.filter(r => r.method === "pane.report_metadata").at(-1)?.params.tokens?.pica_context;
    },
    setIdle(value) { idle = value; },
    setBranch(value) { branch = value; },
    async state() {
      await delay(60); // Drain native integration's asynchronous socket queue.
      return reports.filter(r => r.method === "pane.report_agent").at(-1)?.params;
    },
  };
}

async function failWithOverflow(h) {
  h.setIdle(false);
  await h.emit("agent_start");
  await h.emit("message_end", { message: overflow });
  await h.emit("agent_end", { messages: [overflow] });
  h.setIdle(true);
  await h.emit("agent_settled");
}

test("context full uses its own warning token without changing native status", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  assert.equal(await h.badge(), "⚠ Context full");
  assert.equal((await h.state()).state, "idle");
  assert.equal(h.busEvents.length, 0);
});

test("real Herdr integration keeps lifecycle and session identity unchanged", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  const state = await h.state();
  assert.equal(state.state, "idle");
  assert.equal(await h.badge(), "⚠ Context full");
  assert.equal(state.agent_session_path, "/tmp/test-session.jsonl");
});

test("reload restores unresolved overflow regardless of extension load order", async t => {
  for (const reverse of [false, true]) await t.test(`reverse=${reverse}`, async t => {
    const h = await harness(t, { branch: [entry(success), entry(overflow)], reverse });
    await h.emit("session_start", { reason: "reload" });
    assert.equal(await h.badge(), "⚠ Context full");
  });
});

test("automatic recovery does not flash attention; compaction and success clear evidence", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  h.setIdle(false);
  await h.emit("agent_start");
  await h.emit("message_end", { message: overflow });
  await h.emit("agent_end", { messages: [overflow] });
  assert.equal((await h.state()).state, "working");
  await h.emit("session_before_compact", { reason: "overflow" });
  assert.equal(await h.badge(), "⌛ Compacting context");
  await h.emit("session_compact", { reason: "overflow" });
  await h.emit("agent_start");
  await h.emit("message_end", { message: success });
  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal((await h.state()).state, "idle");
  assert.equal(await h.badge(), null);
  assert.equal(h.reports.some(r => r.method === "pane.report_metadata" && r.params.tokens.pica_context === "⚠ Context full"), false);
  assert.equal(h.busEvents.length, 0);
});

test("manual compaction replaces the full warning with progress then clears on success", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  await h.emit("session_before_compact", { reason: "manual" });
  assert.equal(await h.badge(), "⌛ Compacting context");
  await h.emit("session_compact", { reason: "manual" });
  assert.equal(await h.badge(), null);
  assert.equal((await h.state()).state, "idle");
});

test("cancelled or failed automatic compaction restores the unresolved full warning", async t => {
  for (const outcome of ["cancel", "error"]) await t.test(outcome, async t => {
    const h = await harness(t);
    await h.emit("session_start", { reason: "startup" });
    h.setIdle(false);
    await h.emit("agent_start");
    await h.emit("message_end", { message: overflow });
    const controller = new AbortController();
    await h.emit("session_before_compact", { reason: "overflow", signal: controller.signal });
    assert.equal(await h.badge(), "⌛ Compacting context");
    if (outcome === "cancel") controller.abort();
    h.setIdle(true);
    await h.emit("agent_settled");
    assert.equal(await h.badge(), "⚠ Context full");
  });
});

test("compaction progress works without a previous context overflow", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  const controller = new AbortController();
  await h.emit("session_before_compact", { reason: "manual", signal: controller.signal });
  assert.equal(await h.badge(), "⌛ Compacting context");
  controller.abort();
  assert.equal(await h.badge(), null);
});

test("real SDK manual compact failure restores full without a session_compact event", async t => {
  const h = await harness(t, { branch: [entry(overflow)] });
  await h.emit("session_start", { reason: "startup" });
  let release;
  const aborted = new Promise(resolve => { release = resolve; });
  const events = [];
  // Invoke the actual installed SDK method. No model/auth/network is available;
  // it must fail after abort(), exercising Pi's real manual-error exit path.
  const session = { sessionManager: h.ctx.sessionManager, model: undefined, abort: () => aborted, _emit: e => events.push(e) };
  const result = AgentSession.prototype.compact.call(session).catch(error => error);
  assert.equal(await h.badge(), "⌛ Compacting context");
  await h.emit("agent_settled"); // Native compact() aborts the previous run first.
  assert.equal(await h.badge(), "⌛ Compacting context");
  release();
  assert.ok(await result instanceof Error);
  assert.equal(events.at(-1).type, "compaction_end");
  assert.equal(await h.badge(), "⚠ Context full");
});

test("manual observer preserves arguments/results, scopes sessions, and detaches on shutdown", async t => {
  const original = AgentSession.prototype.compact;
  const expected = { summary: "fixture summary" };
  const calls = [];
  AgentSession.prototype.compact = async function (...args) { calls.push({ receiver: this, args }); return expected; };
  const fixtureMethod = AgentSession.prototype.compact;
  t.after(() => { AgentSession.prototype.compact = original; });
  const h = await harness(t, { branch: [entry(overflow)] });
  await h.emit("session_start", { reason: "startup" });
  const other = { sessionManager: {} };
  assert.equal(await AgentSession.prototype.compact.call(other, "unrelated"), expected);
  assert.equal(await h.badge(), "⚠ Context full");
  const own = { sessionManager: h.ctx.sessionManager };
  assert.equal(await AgentSession.prototype.compact.call(own, "focus instructions"), expected);
  assert.deepEqual(calls.at(-1), { receiver: own, args: ["focus instructions"] });
  assert.equal(await h.badge(), null);
  await h.emit("session_shutdown", { reason: "reload" });
  assert.equal(AgentSession.prototype.compact, fixtureMethod);
});

test("shutdown during manual compaction prevents late completion from restoring metadata", async t => {
  const h = await harness(t, { branch: [entry(overflow)] });
  await h.emit("session_start", { reason: "startup" });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const result = AgentSession.prototype.compact.call({ sessionManager: h.ctx.sessionManager,
    model: undefined, abort: () => gate, _emit: () => {} }).catch(error => error);
  assert.equal(await h.badge(), "⌛ Compacting context");
  await h.emit("session_shutdown", { reason: "quit" });
  const count = h.reports.length;
  release();
  assert.ok(await result instanceof Error);
  assert.equal(await h.badge(), null);
  assert.equal(h.reports.length, count);
});

test("repeated events do not acquire native blockers and preserve foreign blockers", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  await h.emit("agent_settled");
  await h.emit("agent_settled");
  assert.equal(h.busEvents.length, 0);
  assert.equal(await h.badge(), "⚠ Context full");
  h.pi.events.emit("herdr:blocked", { active: true, label: "Approval pending" });
  await h.emit("session_compact", { reason: "manual" });
  assert.equal((await h.state()).state, "blocked");
  h.pi.events.emit("herdr:blocked", { active: false });
  assert.equal((await h.state()).state, "idle");
});

test("retry shows working, restores attention if retry aborts, clears on success", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  h.setIdle(false);
  await h.emit("agent_start");
  assert.equal((await h.state()).state, "working");
  assert.equal(await h.badge(), null);
  await h.emit("message_end", { message: { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" } });
  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal(await h.badge(), "⚠ Context full");
  h.setIdle(false);
  await h.emit("agent_start");
  await h.emit("message_end", { message: success });
  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal((await h.state()).state, "idle");
  assert.equal(await h.badge(), null);
});

test("ignores normal completion, unrelated errors, quoted errors and stale overflow before compact", async t => {
  const cases = [
    [entry(success)],
    [entry({ ...overflow, errorMessage: "WebSocket error" })],
    [entry({ ...overflow, errorMessage: "Rate limit: too many tokens per minute" })],
    [entry({ role: "toolResult", isError: true, content: [{ type: "text", text: overflow.errorMessage }] })],
    [entry({ ...success, content: [{ type: "text", text: overflow.errorMessage }] })],
    [entry(overflow), { type: "compaction" }],
    [entry(overflow), entry(success)],
  ];
  for (const [i, branch] of cases.entries()) await t.test(`case ${i}`, async t => {
    const h = await harness(t, { branch });
    await h.emit("session_start", { reason: "resume" });
    await h.emit("agent_settled");
    assert.equal((await h.state()).state, "idle");
    assert.equal(await h.badge(), null);
  });
});

test("headless subagents never set the parent pane's attention", async t => {
  for (const mode of ["rpc", "json", "print"]) await t.test(mode, async t => {
    const h = await harness(t, { mode, branch: [entry(overflow)] });
    await h.emit("session_start", { reason: "startup" });
    await failWithOverflow(h);
    assert.equal(await h.state(), undefined);
    await h.emit("session_shutdown", { reason: "quit" });
    assert.equal(h.reports.length, 0);
    assert.equal(h.busEvents.length, 0);
  });
});

test("tree navigation uses active branch only", async t => {
  const h = await harness(t, { branch: [entry(overflow)] });
  await h.emit("session_start", { reason: "startup" });
  assert.equal(await h.badge(), "⚠ Context full");
  h.setBranch([entry(success)]);
  await h.emit("session_tree");
  assert.equal(await h.badge(), null);
  h.setBranch([entry(overflow)]);
  await h.emit("session_tree");
  assert.equal(await h.badge(), "⚠ Context full");
});

test("shutdown clears the owned token and cancels pending startup publication", async t => {
  const h = await harness(t, { branch: [entry(overflow)], reverse: true });
  await h.emit("session_start", { reason: "startup" });
  await h.emit("session_shutdown", { reason: "reload" });
  assert.equal((await h.state()).state, "idle");
  assert.equal(await h.badge(), null);
  assert.equal(h.busEvents.length, 0);
});

test("startup during a run waits for settled; unrelated retry failures preserve evidence", async t => {
  const h = await harness(t, { idle: false, branch: [entry(overflow), entry({ ...overflow, errorMessage: "WebSocket error" })] });
  await h.emit("session_start", { reason: "reload" });
  assert.equal((await h.state()).state, "working");
  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal(await h.badge(), "⚠ Context full");
});

test("outside Herdr, TUI context errors have no side effects", async t => {
  const h = await harness(t, { branch: [entry(overflow)] });
  delete process.env.HERDR_ENV;
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  await h.state();
  await h.emit("session_shutdown", { reason: "quit" });
  assert.equal(h.reports.filter(r => r.method === "pane.report_metadata").length, 0);
  assert.equal(h.busEvents.length, 0);
});

test("optional read-only replay of a real session's last context-overflow branch", {
  skip: !process.env.PI_REPLAY_SESSION,
}, async t => {
  const entries = (await readFile(process.env.PI_REPLAY_SESSION, "utf8")).trim().split("\n").map(JSON.parse);
  const failure = entries.findLast(e => e.type === "message" && e.message.stopReason === "error"
    && e.message.errorMessage?.includes("exceeds the context window"));
  assert.ok(failure, "the supplied session must contain a real context overflow");
  const byId = new Map(entries.map(e => [e.id, e]));
  const branch = [];
  for (let e = failure; e; e = byId.get(e.parentId)) branch.unshift(e);
  const h = await harness(t, { branch });
  await h.emit("session_start", { reason: "resume" });
  assert.equal(await h.badge(), "⚠ Context full");
});

test("successful tool-use and output-length responses clear a prior overflow", async t => {
  for (const stopReason of ["toolUse", "length"]) await t.test(stopReason, async t => {
    const h = await harness(t);
    await h.emit("session_start", { reason: "startup" });
    await failWithOverflow(h);
    assert.equal(await h.badge(), "⚠ Context full");
    h.setIdle(false);
    await h.emit("agent_start");
    await h.emit("message_end", { message: { ...success, stopReason } });
    h.setIdle(true);
    await h.emit("agent_settled");
    assert.equal(await h.badge(), null);
  });
});

test("status command proves this runtime loaded the extension and reports delivery", async t => {
  const h = await harness(t, { branch: [entry(overflow)] });
  await h.emit("session_start", { reason: "startup" });
  await h.badge();
  await h.commands.get("herdr-context-status").handler("", h.ctx);
  assert.match(h.notifications.at(-1), /v0\.3\.0 loaded; Herdr: enabled; context full: true; compacting: false; delivery: acknowledged/);
});
