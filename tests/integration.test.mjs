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
  alias: { "@earendil-works/pi-ai": fileURLToPath(piJiti.esmResolve("@earendil-works/pi-ai")) },
});
const installAttention = process.env.BASELINE_ONLY ? () => {} : await jiti.import("../index.ts", { default: true });
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
      reports.push(JSON.parse(buffer.slice(0, newline)));
      socket.end('{"result":{}}\n');
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
  const pi = {
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
    emit, pi, ctx, reports, busEvents,
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

test("real Herdr integration: settled context overflow reports blocked, not idle/working", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  const state = await h.state();
  assert.equal(state.state, "blocked");
  assert.match(state.message, /compact/i);
  assert.equal(state.agent_session_path, "/tmp/test-session.jsonl");
});

test("reload restores unresolved overflow regardless of extension load order", async t => {
  for (const reverse of [false, true]) await t.test(`reverse=${reverse}`, async t => {
    const h = await harness(t, { branch: [entry(success), entry(overflow)], reverse });
    await h.emit("session_start", { reason: "reload" });
    assert.equal((await h.state()).state, "blocked");
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
  await h.emit("session_compact", { reason: "overflow" });
  await h.emit("agent_start");
  await h.emit("message_end", { message: success });
  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal((await h.state()).state, "idle");
  assert.equal(h.busEvents.filter(e => e.name === "herdr:blocked" && e.data.active).length, 0);
});

test("manual failed/cancelled compact keeps attention; only successful compact clears it", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  await h.emit("session_before_compact", { reason: "manual" });
  // No session_compact event means failure, cancellation, or still in progress.
  assert.equal((await h.state()).state, "blocked");
  await h.emit("session_compact", { reason: "manual" });
  assert.equal((await h.state()).state, "idle");
});

test("repeated events own just one blocked reference and preserve other blockers", async t => {
  const h = await harness(t);
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  await h.emit("agent_settled");
  await h.emit("agent_settled");
  assert.equal(h.busEvents.filter(e => e.data.active).length, 1);
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
  await h.emit("message_end", { message: { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" } });
  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal((await h.state()).state, "blocked");
  h.setIdle(false);
  await h.emit("agent_start");
  await h.emit("message_end", { message: success });
  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal((await h.state()).state, "idle");
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
  });
});

test("headless subagents never set the parent pane's attention", async t => {
  for (const mode of ["rpc", "json", "print"]) await t.test(mode, async t => {
    const h = await harness(t, { mode, branch: [entry(overflow)] });
    await h.emit("session_start", { reason: "startup" });
    await failWithOverflow(h);
    assert.equal(await h.state(), undefined);
    assert.equal(h.busEvents.length, 0);
  });
});

test("tree navigation uses active branch only", async t => {
  const h = await harness(t, { branch: [entry(overflow)] });
  await h.emit("session_start", { reason: "startup" });
  assert.equal((await h.state()).state, "blocked");
  h.setBranch([entry(success)]);
  await h.emit("session_tree");
  assert.equal((await h.state()).state, "idle");
  h.setBranch([entry(overflow)]);
  await h.emit("session_tree");
  assert.equal((await h.state()).state, "blocked");
});

test("shutdown balances the blocker and cancels a pending startup publication", async t => {
  const h = await harness(t, { branch: [entry(overflow)], reverse: true });
  await h.emit("session_start", { reason: "startup" });
  await h.emit("session_shutdown", { reason: "reload" });
  assert.equal((await h.state()).state, "idle");
  assert.equal(h.busEvents.filter(e => e.data.active).length, h.busEvents.filter(e => !e.data.active).length);
});

test("startup during a run waits for settled; unrelated retry failures preserve evidence", async t => {
  const h = await harness(t, { idle: false, branch: [entry(overflow), entry({ ...overflow, errorMessage: "WebSocket error" })] });
  await h.emit("session_start", { reason: "reload" });
  assert.equal((await h.state()).state, "working");
  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal((await h.state()).state, "blocked");
});

test("outside Herdr, TUI context errors have no side effects", async t => {
  const h = await harness(t, { branch: [entry(overflow)] });
  delete process.env.HERDR_ENV;
  await h.emit("session_start", { reason: "startup" });
  await failWithOverflow(h);
  await h.state();
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
  assert.equal((await h.state()).state, "blocked");
});
