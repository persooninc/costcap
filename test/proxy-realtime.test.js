// #194: OpenAI Realtime API (/v1/realtime WebSocket) metering, caps, kill and honest unknowns.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createKillCheck, kill } from "../src/kill.js";
import { OP, closePayload, createFrameParser, encodeFrame, isRealtimePath, upstreamHandshakeHeaders } from "../src/realtime.js";
import { AC1_USAGE, connectRealtime, responseDone, startRealtimeUpstream } from "./fixtures/realtime-upstream.js";

async function setup(t, upstreamOpts = {}, proxyOpts = {}) {
  const up = await startRealtimeUpstream(upstreamOpts);
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: up.url }, onReceipt: (r) => receipts.push(r), ...proxyOpts });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.close(); });
  return { up, p, receipts, port: p.port };
}
const chatCall = (port) => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini" }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("frame codec: masking, 16/64-bit lengths, fragmentation and split chunks", () => {
  const got = [];
  const parser = createFrameParser((op, p) => got.push([op, p.toString()]));
  const big = "x".repeat(70_000);
  const bytes = Buffer.concat([
    encodeFrame(OP.TEXT, "hel", { fin: false, mask: true }), encodeFrame(OP.PING, "p"), encodeFrame(OP.CONT, "lo", { fin: true }),
    encodeFrame(OP.TEXT, "y".repeat(300)), encodeFrame(OP.TEXT, big), encodeFrame(OP.CLOSE, closePayload(1008, "costcap: x")),
  ]);
  for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));
  assert.deepEqual(got.map(([op]) => op), [OP.PING, OP.TEXT, OP.TEXT, OP.TEXT, OP.CLOSE]);
  assert.equal(got[1][1], "hello");
  assert.equal(got[2][1].length, 300);
  assert.equal(got[3][1], big);
  // Oversized messages are skipped (still relayed by the proxy), stray continuations ignored.
  const small = [];
  const p2 = createFrameParser((op, p) => small.push(p.toString()), { maxMessageBytes: 4 });
  p2.push(Buffer.concat([encodeFrame(OP.CONT, "zz"), encodeFrame(OP.TEXT, "toolong"), encodeFrame(OP.TEXT, "ok")]));
  assert.deepEqual(small, ["ok"]);
  assert.equal(isRealtimePath("/openai/v1/realtime?model=x"), true);
  assert.equal(isRealtimePath("/openai/v1/%72ealtime"), false);
  assert.equal(isRealtimePath("/openai/v1/chat/completions"), false);
  assert.equal(isRealtimePath(undefined), false);
  assert.deepEqual(upstreamHandshakeHeaders({ Authorization: "a", "x-costcap-tag": "t", "Sec-WebSocket-Extensions": "permessage-deflate", host: "h", "content-length": "0" }, "up:1"), { authorization: "a", host: "up:1" });
});

test("AC1: one receipt per response.done at realtime audio rates; frames byte-identical", async (t) => {
  const done = responseDone("resp_1");
  const doneBytes = encodeFrame(OP.TEXT, JSON.stringify(done));
  const frag = Buffer.concat([encodeFrame(OP.TEXT, '{"type":"response.', { fin: false }), encodeFrame(OP.CONT, 'created","response":{"id":"resp_1"}}')]);
  const upstreamBytes = [encodeFrame(OP.TEXT, JSON.stringify({ type: "session.created", session: { id: "sess_1", model: "gpt-realtime-2025-08-28" } })), frag, doneBytes];
  const { up, receipts, port } = await setup(t, { onConnection: async (conn) => {
    await sleep(20);
    const all = Buffer.concat(upstreamBytes);
    // Split one message across TCP chunks.
    for (let i = 0; i < all.length; i += 13) { conn.socket.write(all.subarray(i, i + 13)); await sleep(1); }
  } });
  const client = await connectRealtime(port, "/openai/v1/realtime?model=gpt-realtime", { "x-costcap-tag": "feature=voice", "Sec-WebSocket-Extensions": "permessage-deflate" });
  assert.equal(client.status, 101);
  assert.equal(client.accepted, true);
  await client.waitFor((c) => c.messages.some((m) => m.type === "response.done"));
  assert.deepEqual(Buffer.concat(client.raw), Buffer.concat(upstreamBytes));
  const req = up.state.requests[0];
  assert.equal(req.url, "/v1/realtime?model=gpt-realtime");
  assert.equal(req.headers.authorization, "Bearer sk-test");
  assert.equal(req.headers["openai-beta"], "realtime=v1");
  assert.equal(req.headers["x-costcap-tag"], undefined);
  assert.equal(req.headers["sec-websocket-extensions"], undefined);
  const metered = receipts.filter((r) => r.response_id);
  assert.equal(metered.length, 1);
  const r = metered[0];
  assert.equal(r.model, "gpt-realtime-2025-08-28");
  assert.equal(r.transport, "websocket");
  assert.equal(r.session_id, "sess_1");
  assert.equal(r.response_id, "resp_1");
  assert.equal(r.cost_source, "table");
  assert.equal(r.cost_usd, 0.0538);
  assert.deepEqual(r.tags, { feature: "voice" });
  // Client frames reach the upstream unchanged.
  client.send({ type: "response.create" });
  await client.waitFor(() => up.state.conns[0].messages.some((m) => m.type === "response.create"));
  client.socket.destroy();
});

test("AC1 via ?model= when the session never names one", async (t) => {
  const { receipts, port } = await setup(t, { onConnection: (conn) => conn.send(responseDone("r1")) });
  const client = await connectRealtime(port);
  await client.waitFor(() => receipts.some((r) => r.response_id === "r1"));
  assert.equal(receipts.find((r) => r.response_id === "r1").model, "gpt-realtime");
  assert.equal(receipts.find((r) => r.response_id === "r1").cost_usd, 0.0538);
  client.socket.destroy();
});

test("AC2: cap hit between responses closes both sockets with 1008 after response.done", async (t) => {
  const cap = createCapEngine({ caps: { run: 0.10 } });
  const { up, receipts, port } = await setup(t, { onConnection: async (conn) => {
    conn.send(responseDone("r1"));
    await sleep(30);
    conn.send(responseDone("r2"));
  } }, { cap });
  const client = await connectRealtime(port);
  await client.closed;
  const types = client.messages.map((m) => m.type);
  assert.deepEqual(types, ["response.done", "response.done", "error"]);
  assert.deepEqual(client.messages[2].error, { type: "costcap", code: "budget_exceeded" });
  assert.equal(client.closeCode, 1008);
  const closeFrame = client.frames.find((f) => f.op === OP.CLOSE);
  assert.equal(closeFrame.payload.subarray(2).toString(), "costcap: budget_exceeded");
  await sleep(50);
  assert.equal(up.state.conns[0].closed, true);
  assert.equal(up.state.conns[0].gotClose, 1008);
  assert.ok(receipts.some((r) => r.blocked && r.reason === "budget_exceeded" && r.transport === "websocket"));
  // A later client frame never reaches the upstream.
  try { client.send({ type: "response.create" }); } catch { /* socket closed */ }
  await sleep(30);
  assert.equal(up.state.conns[0].messages.length, 0);
  // Next handshake is refused before 101; upgrade count unchanged.
  const refused = await connectRealtime(port);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.type ?? refused.body.error, "budget_exceeded");
  assert.equal(up.state.upgrades, 1);
});

test("AC2: the next HTTP chat call is refused after a realtime cap hit", async (t) => {
  const chat = http.createServer((req, res) => { req.resume(); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
  await new Promise((r) => chat.listen(0, "127.0.0.1", r));
  t.after(() => { chat.closeAllConnections(); chat.close(); });
  const cap = createCapEngine({ caps: { run: 0.05 } });
  const up = await startRealtimeUpstream({ onConnection: (conn) => conn.send(responseDone("r1")) });
  t.after(() => up.close());
  // Route HTTP to `chat` and upgrades to `up` by swapping the upstream after the session.
  const upstreams = { openai: up.url };
  const p = await startMeteringProxy({ upstreams, cap });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); });
  const client = await connectRealtime(p.port);
  await client.closed;
  upstreams.openai = `http://127.0.0.1:${chat.address().port}`;
  const r = await chatCall(p.port);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.type, "budget_exceeded");
});

test("AC3: allowlist and kill refuse the handshake before 101; open idle session killed within 1s", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-rt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const killFile = join(dir, "KILL");
  const { up, receipts, port } = await setup(t, {}, { allowedModels: () => ["gpt-realtime"], killCheck: createKillCheck(killFile, { hostFile: join(dir, "HOSTKILL") }) });
  const client = await connectRealtime(port);
  assert.equal(client.status, 101);
  const t0 = Date.now();
  kill(killFile, "stop");
  await client.closed;
  assert.ok(Date.now() - t0 < 1000, `closed in ${Date.now() - t0}ms`);
  assert.equal(client.closeCode, 1008);
  assert.equal(client.messages.at(-1).error.code, "killed");
  await sleep(30);
  assert.equal(up.state.conns[0].closed, true);
  assert.ok(receipts.some((r) => r.blocked && r.reason === "killed" && r.transport === "websocket"));
  const killed = await connectRealtime(port);
  assert.equal(killed.status, 429);
  assert.equal(killed.body.error, "killed");
  rmSync(killFile);
  const notAllowed = await connectRealtime(port, "/openai/v1/realtime?model=gpt-realtime-mini");
  assert.equal(notAllowed.status, 403);
  assert.equal(notAllowed.body.error, "model_not_allowed");
  assert.equal(up.state.upgrades, 1);
});

test("AC3: --models gpt-4o-mini refuses gpt-realtime; --unknown-models refuse refuses unpriced", async (t) => {
  const a = await setup(t, {}, { allowedModels: () => ["gpt-4o-mini"] });
  const r = await connectRealtime(a.port);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "model_not_allowed");
  const b = await setup(t, {}, { unknownModels: "refuse" });
  const u = await connectRealtime(b.port, "/openai/v1/realtime?model=gpt-realtime-future");
  assert.equal(u.status, 403);
  assert.equal(u.body.error, "model_unpriced");
  assert.equal(a.up.state.upgrades + b.up.state.upgrades, 0);
});

test("AC4: client disconnect mid-response latches stream_incomplete until settled", async (t) => {
  const { receipts, port, p } = await setup(t, { onConnection: (conn) => conn.send({ type: "response.created", response: { id: "r_mid" } }) });
  const client = await connectRealtime(port);
  await client.waitFor((c) => c.messages.length === 1);
  client.socket.destroy();
  await sleep(50);
  const inc = receipts.find((r) => r.reason === "stream_incomplete");
  assert.equal(inc.cost_usd, null);
  assert.equal(inc.response_id, "r_mid");
  const refused = await connectRealtime(port);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "accounting_unavailable");
  assert.equal(p.server.settle({ receipt_id: inc.id }), true);
  const ok = await connectRealtime(port);
  assert.equal(ok.status, 101);
  ok.socket.destroy();
});

test("AC4: audio on gpt-realtime-mini is modality_unpriced; transcription usage is transcription_unpriced", async (t) => {
  const a = await setup(t, { onConnection: (conn) => conn.send(responseDone("r1", AC1_USAGE)) });
  const c1 = await connectRealtime(a.port, "/openai/v1/realtime?model=gpt-realtime-mini");
  await c1.closed; // the latch closes the session after the receipt
  const r = a.receipts.find((x) => x.response_id === "r1");
  assert.equal(r.reason, "modality_unpriced");
  assert.equal(r.cost_usd, null);
  assert.equal(c1.messages.at(-1).error.code, "accounting_unavailable");
  const b = await setup(t, { onConnection: (conn) => conn.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "hi", usage: { type: "tokens", total_tokens: 20, input_tokens: 10, output_tokens: 10 } }) });
  const c2 = await connectRealtime(b.port);
  await c2.closed;
  const tr = b.receipts.find((x) => x.reason === "transcription_unpriced");
  assert.equal(tr.cost_usd, null);
  assert.equal(tr.item_id, "item_1");
});

test("AC4: upstream handshake 401 relays 401, $0 receipt, no latch", async (t) => {
  const { receipts, port } = await setup(t, { reject: { status: 401, body: { error: { message: "Incorrect API key" } } } });
  const r = await connectRealtime(port);
  assert.equal(r.status, 401);
  assert.equal(r.body.error.message, "Incorrect API key");
  await sleep(20);
  const rec = receipts.find((x) => x.transport === "websocket");
  assert.equal(rec.status, 401);
  assert.equal(rec.cost_usd, 0);
  const again = await connectRealtime(port);
  assert.equal(again.status, 401); // not 429: nothing latched
});

test("unreachable upstream: 502, $0 receipt, no latch", async (t) => {
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: "http://127.0.0.1:1" }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); });
  const r = await connectRealtime(p.port);
  assert.equal(r.status, 502);
  assert.equal(receipts[0].cost_usd, 0);
  assert.equal(p.server.accountingFailure(), null);
});

test("invalid tag header refuses the handshake with 400", async (t) => {
  const { up, port } = await setup(t);
  const r = await connectRealtime(port, undefined, { "x-costcap-tag": "=bad" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_tags");
  assert.equal(up.state.upgrades, 0);
});
