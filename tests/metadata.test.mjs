import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

// Native Node type stripping: this module only depends on node built-ins.
const { MetadataPublisher, CONTEXT_TOKEN, CONTEXT_LABEL } = await import("../metadata.ts");

async function server(t, respond) {
  const dir = await mkdtemp(join(tmpdir(), "pica-meta-"));
  const path = join(dir, "api.sock");
  const requests = [], sockets = new Set();
  const netServer = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", data => {
      buffer += data;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]);
      requests.push(request);
      respond(socket, request, requests.length);
    });
  });
  await new Promise(resolve => netServer.listen(path, resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise(resolve => netServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, requests };
}
const ack = (s, r) => s.end(JSON.stringify({ id: r.id, result: { type: "pane_metadata_reported" } }) + "\n");
async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), "expected condition within deadline");
}

test("metadata-only leased token, fragmented acknowledgement, and source-scoped clear", async t => {
  const s = await server(t, (socket, r) => {
    socket.write(JSON.stringify({ id: r.id, result: {} }));
    setTimeout(() => socket.end("\n"), 5);
  });
  const publisher = new MetadataPublisher(s.path, "test:p1", { refreshMs: 10000 });
  await publisher.set(true);
  const p = s.requests[0].params;
  assert.equal(s.requests[0].method, "pane.report_metadata");
  assert.deepEqual(p.tokens, { [CONTEXT_TOKEN]: CONTEXT_LABEL });
  assert.ok(p.ttl_ms > 0);
  assert.equal(p.agent, "pi");
  assert.equal(p.applies_to_source, "herdr:pi");
  assert.equal(p.state_labels, undefined);
  assert.equal(p.state, undefined);
  assert.equal(publisher.status, "acknowledged");
  await publisher.close();
  assert.deepEqual(s.requests.at(-1).params.tokens, { [CONTEXT_TOKEN]: null });
});

test("API errors are not successful delivery; retry then later refresh recover", async t => {
  let reject = true;
  const s = await server(t, (socket, r) => reject
    ? socket.end(JSON.stringify({ id: r.id, error: { code: "busy", message: "retry" } }) + "\n")
    : ack(socket, r));
  const publisher = new MetadataPublisher(s.path, "test:p1", { refreshMs: 40, timeoutMs: 30 });
  t.after(() => publisher.close());
  await publisher.set(true);
  assert.equal(publisher.status, "failed");
  assert.ok(s.requests.length >= 2);
  reject = false;
  await waitFor(() => publisher.status === "acknowledged");
  assert.equal(publisher.status, "acknowledged");
  assert.equal(s.requests.at(-1).params.tokens[CONTEXT_TOKEN], CONTEXT_LABEL);
});

test("rapid full/clear/full transitions and shutdown cannot leave a stale clear last", async t => {
  const s = await server(t, (socket, r) => setTimeout(() => ack(socket, r), 10));
  const publisher = new MetadataPublisher(s.path, "test:p1", { refreshMs: 10000 });
  const first = publisher.set(true);
  const second = publisher.set(false);
  const third = publisher.set(true);
  await Promise.all([first, second, third]);
  assert.equal(s.requests.at(-1).params.tokens[CONTEXT_TOKEN], CONTEXT_LABEL);
  await publisher.close();
  assert.equal(s.requests.at(-1).params.tokens[CONTEXT_TOKEN], null);
  const n = s.requests.length;
  await delay(40);
  assert.equal(s.requests.length, n);
  const seqs = s.requests.map(r => r.params.seq);
  assert.ok(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]));
});

test("failed clears retry without leaving an acknowledged stale full warning", async t => {
  let rejectClear = true;
  const s = await server(t, (socket, r) => r.params.tokens[CONTEXT_TOKEN] === null && rejectClear
    ? socket.end(JSON.stringify({ id: r.id, error: { code: "busy" } }) + "\n")
    : ack(socket, r));
  const p = new MetadataPublisher(s.path, "test:p1", { refreshMs: 30 });
  t.after(() => p.close());
  await p.set(true);
  await p.set(false);
  assert.equal(p.status, "failed");
  rejectClear = false;
  await waitFor(() => p.status === "acknowledged");
  assert.equal(p.status, "acknowledged");
  assert.equal(s.requests.at(-1).params.tokens[CONTEXT_TOKEN], null);
});

test("shutdown followed by a new publisher keeps the source sequence increasing", async t => {
  const s = await server(t, ack);
  const old = new MetadataPublisher(s.path, "test:p1");
  await old.set(true);
  await old.close();
  const replacement = new MetadataPublisher(s.path, "test:p1");
  await replacement.set(true);
  await replacement.close();
  assert.deepEqual(s.requests.map(r => r.params.tokens[CONTEXT_TOKEN]), [CONTEXT_LABEL, null, CONTEXT_LABEL, null]);
  assert.ok(s.requests.every((r, i) => i === 0 || r.params.seq > s.requests[i - 1].params.seq));
});

test("mismatched response IDs and hung sockets are bounded failures", async t => {
  for (const reply of ["wrong-id", "hang"]) await t.test(reply, async t => {
    const s = await server(t, (socket) => {
      if (reply === "wrong-id") socket.end('{"id":"other","result":{}}\n');
    });
    const p = new MetadataPublisher(s.path, "test:p1", { refreshMs: 10000, timeoutMs: 25 });
    await p.set(true);
    assert.equal(p.status, "failed");
    await p.close();
  });
});
