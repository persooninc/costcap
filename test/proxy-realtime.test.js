// #194: OpenAI Realtime API (/v1/realtime WebSocket) metering, caps, admission, kill and honest unknowns.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createKillCheck, kill } from "../src/kill.js";
import { closePayload, createFrameParser, encodeFrame, realtimeUsage, writeHttpJson } from "../src/realtime.js";
import { startRealtimeUpstream, connectRealtime } from "./fixtures/realtime-upstream.js";

export const AC1_USAGE = {
  total_tokens: 1900, input_tokens: 1300, output_tokens: 600,
  input_token_details: { text_tokens: 300, audio_tokens: 1000, image_tokens: 0, cached_tokens: 500, cached_tokens_details: { text_tokens: 100, audio_tokens: 400, image_tokens: 0 } },
  output_token_details: { text_tokens: 100, audio_tokens: 500 },
};
const PATH = "/openai/v1/realtime?model=gpt-realtime";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(10); } };
const respond = (conn, id, usage = AC1_USAGE) => { conn.send({ type: "response.created", response: { id } }); conn.send({ type: "response.done", response: { id, status: "completed", usage } }); };
const rt = (rs) => rs.filter((r) => r.transport === "websocket");

async function setup(t, { upstream = {}, proxy = {} } = {}) {
  const up = await startRealtimeUpstream(upstream);
  const receipts = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-rt-"));
  const { server, port } = await startMeteringProxy({ receiptsPath: join(dir, "receipts.jsonl"), upstreams: { openai: up.url, anthropic: up.url }, onReceipt: (r) => receipts.push(r), ...proxy });
  t.after(async () => { server.close(); server.closeAllConnections(); await up.close(); });
  const chatCall = () => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", messages: [], n: Math.random() }) });
  return { up, server, port, receipts, dir, chatCall };
}

test("AC1 meters one response.done at realtime audio/text rates, frames byte-identical", async (t) => {
  const { up, port, receipts } = await setup(t, { upstream: { onSession: (conn) => {
    conn.send({ type: "session.created", session: { id: "sess_1", model: "gpt-realtime" } });
    conn.send({ type: "response.created", response: { id: "resp_1" } });
    // A message split across TCP chunks, then a fragmented message (text + continuation).
    const done = encodeFrame(1, JSON.stringify({ type: "response.done", response: { id: "resp_1", usage: AC1_USAGE } }));
    conn.socket.write(done.subarray(0, 7));
    setTimeout(() => {
      conn.socket.write(done.subarray(7));
      conn.send(encodeFrame(1, '{"type":"rate_limits', { fin: false }));
      conn.send(encodeFrame(0, '.updated"}', { fin: true }));
    }, 30);
  } } });
  const c = await connectRealtime(port, PATH, { Authorization: "Bearer sk-test", "OpenAI-Beta": "realtime=v1", "x-costcap-tag": "team=voice", "Sec-WebSocket-Extensions": "permessage-deflate" });
  assert.equal(c.status, 101);
  await c.waitFor((m) => m.type === "rate_limits.updated");
  const r = rt(receipts);
  assert.equal(r.length, 1);
  assert.equal(r[0].model, "gpt-realtime");
  assert.equal(r[0].response_id, "resp_1");
  assert.equal(r[0].session_id, "sess_1");
  assert.equal(r[0].cost_source, "table");
  assert.equal(r[0].cost_usd, 0.0538);
  assert.deepEqual(r[0].tags, { team: "voice" });
  const got = Buffer.concat(c.rawBytes);
  assert.equal(c.frames.length, 5);
  assert.ok(got.includes(Buffer.from('{"type":"rate_limits')));
  const h = up.handshakes[0].headers;
  assert.equal(h.authorization, "Bearer sk-test");
  assert.equal(h["openai-beta"], "realtime=v1");
  assert.equal(h["sec-websocket-extensions"], undefined);
  assert.ok(!Object.keys(h).some((k) => k.startsWith("x-costcap-")));
  assert.equal(up.handshakes[0].url, "/v1/realtime?model=gpt-realtime");
  c.close();
});

test("AC1 client frames are byte-identical to the upstream's", async (t) => {
  const frames = [
    encodeFrame(1, JSON.stringify({ type: "session.created", session: { id: "s", model: "gpt-realtime" } })),
    encodeFrame(1, "x".repeat(70000)),
    encodeFrame(9, "ping"),
    encodeFrame(2, Buffer.from([1, 2, 3]), { fin: false }), encodeFrame(0, Buffer.from([4]), { fin: true }),
  ];
  const all = Buffer.concat(frames);
  const { port } = await setup(t, { upstream: { onSession: (conn) => { conn.socket.write(all.subarray(0, 3)); setTimeout(() => conn.socket.write(all.subarray(3)), 20); } } });
  const c = await connectRealtime(port, PATH);
  await until(() => Buffer.concat(c.rawBytes).length >= all.length);
  assert.ok(Buffer.concat(c.rawBytes).equals(all));
  c.close();
});

test("AC2 cap between responses: forward response.done, error event, close 1008, upstream closed", async (t) => {
  let conn;
  const { up, port, receipts, chatCall } = await setup(t, { upstream: { onSession: (cn) => { conn = cn; } }, proxy: { cap: createCapEngine({ caps: { run: 0.1 } }) } });
  const c = await connectRealtime(port, PATH);
  await until(() => conn);
  respond(conn, "r1");
  await until(() => rt(receipts).length === 1);
  respond(conn, "r2");
  await c.closed;
  const types = c.messages.map((m) => m.type);
  assert.deepEqual(types.slice(-2), ["response.done", "error"]);
  assert.equal(c.messages.at(-1).error.code, "budget_exceeded");
  assert.equal(c.messages.at(-1).error.type, "costcap");
  assert.equal(c.closeCode, 1008);
  await conn.closed;
  // A later client frame never reaches the upstream (socket already closed).
  const before = conn.received.length;
  try { c.send({ type: "response.create" }); } catch { /* closed */ }
  await sleep(50);
  assert.equal(conn.received.length, before);
  const chat = await chatCall();
  assert.equal(chat.status, 429);
  assert.equal((await chat.json()).error.type ?? "budget_exceeded", "budget_exceeded");
  const upgrades = up.upgrades;
  const c2 = await connectRealtime(port, PATH);
  assert.equal(c2.status, 429);
  assert.equal(up.upgrades, upgrades);
});

test("AC3 admission: allowlist 403 and kill 429 before 101, upstream untouched", async (t) => {
  const killFile = join(mkdtempSync(join(tmpdir(), "cc-k-")), "KILL");
  const { up, port, receipts } = await setup(t, { proxy: { allowedModels: () => ["gpt-4o-mini"], killCheck: createKillCheck(killFile) } });
  const a = await connectRealtime(port, PATH);
  assert.equal(a.status, 403);
  assert.equal(a.body.error, "model_not_allowed");
  assert.equal(receipts.at(-1).reason, "model_not_allowed");
  kill(killFile);
  const b = await connectRealtime(port, PATH);
  assert.equal(b.status, 429);
  assert.equal(b.body.error, "killed");
  assert.equal(up.upgrades, 0);
});

test("AC3 unknown model refused when --unknown-models refuse", async (t) => {
  const { up, port } = await setup(t, { proxy: { unknownModels: "refuse" } });
  const a = await connectRealtime(port, "/openai/v1/realtime?model=gpt-made-up");
  assert.equal(a.status, 403);
  assert.equal(a.body.error, "model_unpriced");
  assert.equal(up.upgrades, 0);
});

test("#197 a {discount} on an unpriced model doesn't open --unknown-models refuse on the handshake", async (t) => {
  const userPrices = { version: "t", sha256: "0".repeat(64), upstreams: { openai: { "gpt-made-up": { discount: 0.2 } } } };
  const { up, port } = await setup(t, { proxy: { unknownModels: "refuse", userPrices } });
  const a = await connectRealtime(port, "/openai/v1/realtime?model=gpt-made-up");
  assert.equal(a.status, 403);
  assert.equal(a.body.error, "model_unpriced");
  assert.equal(up.upgrades, 0);
});

test("AC3 kill closes an idle open session within 1s and writes a blocked receipt", async (t) => {
  const killFile = join(mkdtempSync(join(tmpdir(), "cc-k-")), "KILL");
  let conn;
  const { port, receipts } = await setup(t, { upstream: { onSession: (cn) => { conn = cn; } }, proxy: { killCheck: createKillCheck(killFile) } });
  const c = await connectRealtime(port, PATH);
  await until(() => conn);
  const t0 = Date.now();
  kill(killFile);
  await c.closed;
  await conn.closed;
  assert.ok(Date.now() - t0 < 1000, `closed in ${Date.now() - t0}ms`);
  assert.equal(c.closeCode, 1008);
  const r = receipts.find((x) => x.blocked && x.reason === "killed");
  assert.ok(r);
  assert.equal(r.transport, "websocket");
});

test("AC4 client disconnect mid-response -> stream_incomplete latch; settle unblocks", async (t) => {
  let conn;
  const { port, receipts, server, chatCall } = await setup(t, { upstream: { onSession: (cn) => { conn = cn; } } });
  const c = await connectRealtime(port, PATH);
  await until(() => conn);
  conn.send({ type: "response.created", response: { id: "r_cut" } });
  await c.waitFor((m) => m.type === "response.created");
  c.close();
  await until(() => receipts.some((r) => r.reason === "stream_incomplete"));
  const r = receipts.find((x) => x.reason === "stream_incomplete");
  assert.equal(r.cost_usd, null);
  assert.equal(r.response_id, "r_cut");
  const blocked = await chatCall();
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, "accounting_unavailable");
  assert.equal(server.settle({ receipt_id: r.id }), true);
  assert.equal((await chatCall()).status, 200);
});

test("AC4 audio on an unpriced id (gpt-realtime-9) -> modality_unpriced (latched, session closed)", async (t) => {
  let conn;
  const { port, receipts, server, chatCall } = await setup(t, { upstream: { onSession: (cn) => { conn = cn; } } });
  const c = await connectRealtime(port, "/openai/v1/realtime?model=gpt-realtime-9");
  await until(() => conn);
  respond(conn, "r_mini");
  await c.closed;
  const mini = receipts.find((r) => r.response_id === "r_mini");
  assert.equal(mini.reason, "modality_unpriced");
  assert.equal(mini.cost_usd, null);
  assert.equal(c.messages.at(-1).error.code, "accounting_unavailable");
  assert.equal(server.settle({ receipt_id: mini.id }), true);
  assert.equal((await chatCall()).status, 200);
});

// #276: current OpenAI voice models are priced and never latch.
for (const [model, cost] of [["gpt-realtime-2", 0.0546], ["gpt-realtime-1.5", 0.0538], ["gpt-realtime-mini", 0.016486]]) {
  test(`#276 AC1 ${model} response.done priced at ${cost}, no latch`, async (t) => {
    let conn;
    const { port, receipts, chatCall } = await setup(t, { upstream: { onSession: (cn) => { conn = cn; } } });
    const c = await connectRealtime(port, `/openai/v1/realtime?model=${model}`);
    assert.equal(c.status, 101);
    await until(() => conn);
    respond(conn, "r_ok");
    await until(() => rt(receipts).length === 1);
    const r = rt(receipts)[0];
    assert.equal(r.cost_usd, cost);
    assert.equal(r.cost_source, "table");
    assert.equal(r.reason, undefined);
    assert.equal((await chatCall()).status, 200);
    c.close();
  });
}

test("#276 AC3 gpt-realtime-2: --cap 0.10 closes 1008 after the second response; refuse admits it", async (t) => {
  let conn;
  const { port, receipts } = await setup(t, { upstream: { onSession: (cn) => { conn = cn; } }, proxy: { cap: createCapEngine({ caps: { run: 0.1 } }), unknownModels: "refuse" } });
  const c = await connectRealtime(port, "/openai/v1/realtime?model=gpt-realtime-2");
  assert.equal(c.status, 101);
  await until(() => conn);
  respond(conn, "r1");
  await until(() => rt(receipts).length === 1);
  respond(conn, "r2");
  await c.closed;
  assert.equal(c.closeCode, 1008);
  assert.equal(c.messages.at(-1).error.code, "budget_exceeded");
  assert.equal(rt(receipts).length, 2);
});

test("AC4 transcription-completed with usage -> transcription_unpriced", async (t) => {
  let conn;
  const { port, receipts } = await setup(t, { upstream: { onSession: (cn) => { conn = cn; } } });
  const c = await connectRealtime(port, PATH);
  await until(() => conn);
  conn.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "hi" });
  conn.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "hi", usage: { type: "tokens", total_tokens: 5 } });
  await c.closed;
  const tr = receipts.filter((r) => r.reason === "transcription_unpriced");
  assert.equal(tr.length, 1);
  assert.equal(tr[0].cost_usd, null);
  assert.equal(tr[0].item_id, "item_1");
});

test("AC4 upstream handshake 401 -> client 401, $0 receipt, next call 200", async (t) => {
  const { port, receipts, chatCall } = await setup(t, { upstream: { reject: { status: 401, body: { error: { message: "bad key" } } } } });
  const c = await connectRealtime(port, PATH);
  assert.equal(c.status, 401);
  assert.equal(c.body.error.message, "bad key");
  const r = receipts.find((x) => x.transport === "websocket");
  assert.equal(r.cost_usd, 0);
  assert.equal(r.status, 401);
  assert.equal((await chatCall()).status, 200);
});

test("upstream unreachable -> 502, $0 receipt, no latch", async (t) => {
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: "http://127.0.0.1:1" }, onReceipt: (r) => receipts.push(r) });
  t.after(() => server.close());
  const c = await connectRealtime(port, PATH);
  assert.equal(c.status, 502);
  assert.equal(receipts[0].cost_usd, 0);
  assert.equal(server.accountingFailure(), null);
});

test("response.done without usable usage latches usage_unavailable and closes", async (t) => {
  let conn;
  const { port, receipts, server } = await setup(t, { upstream: { onSession: (cn) => { conn = cn; } } });
  const c = await connectRealtime(port, PATH);
  await until(() => conn);
  conn.send({ type: "response.done", response: { id: "r_x", usage: {} } });
  await c.closed;
  assert.equal(receipts.find((r) => r.response_id === "r_x").reason, "usage_unavailable");
  assert.equal(c.closeCode, 1008);
  assert.ok(server.accountingFailure());
});

test("invalid x-costcap-tag on a handshake is refused 400", async (t) => {
  const { port, up } = await setup(t);
  const c = await connectRealtime(port, PATH, { "x-costcap-tag": "=" });
  assert.equal(c.status, 400);
  assert.equal(up.upgrades, 0);
});

test("proxy close shuts open sessions", async (t) => {
  let conn;
  const { port, server } = await setup(t, { upstream: { onSession: (cn) => { conn = cn; } } });
  const c = await connectRealtime(port, PATH);
  await until(() => conn);
  server.close();
  await c.closed;
  assert.equal(c.closeCode, 1001);
});

test("realtimeUsage maps singular *_token_details with a cached split", () => {
  const u = realtimeUsage(AC1_USAGE);
  assert.deepEqual(u, { input_tokens: 800, cached_input_tokens: 500, output_tokens: 600, modality_tokens: {
    input: { text: 200, image: 0, audio: 600, video: 0 }, cached_input: { text: 100, image: 0, audio: 400, video: 0 }, output: { text: 100, image: 0, audio: 500, video: 0 } } });
  assert.deepEqual(realtimeUsage({ input_tokens: 10, output_tokens: 2 }), { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 });
  assert.equal(realtimeUsage({ input_tokens: 1 }), null);
  assert.equal(realtimeUsage(null), null);
});

test("frame codec: masked, 16/64-bit lengths, oversize marks corrupt", () => {
  const p = createFrameParser();
  const big = "y".repeat(70000);
  const frames = p.push(Buffer.concat([encodeFrame(1, "hi", { mask: true }), encodeFrame(1, "z".repeat(300), { mask: true }), encodeFrame(1, big)]));
  assert.deepEqual(frames.map((f) => f.message.data.length), [2, 300, 70000]);
  assert.equal(closePayload(1008, "x").readUInt16BE(0), 1008);
  const small = createFrameParser({ maxMessageBytes: 10 });
  small.push(encodeFrame(1, "z".repeat(70000)));
  assert.equal(small.corrupt, true);
  assert.deepEqual(small.push(Buffer.from([1])), []);
  const frag = createFrameParser({ maxMessageBytes: 4 });
  frag.push(Buffer.concat([encodeFrame(1, "abc", { fin: false }), encodeFrame(0, "def")]));
  assert.equal(frag.corrupt, true);
  assert.equal(createFrameParser().pending, 0);
});

test("writeHttpJson writes status, headers and body; no-op on destroyed sockets", () => {
  let out = "";
  writeHttpJson({ destroyed: false, end: (s) => { out = s; } }, 418, { a: 1 }, { "retry-after": "3" });
  assert.match(out, /^HTTP\/1.1 418 Error\r\n/);
  assert.match(out, /retry-after: 3/);
  writeHttpJson({ destroyed: true, end: () => { throw new Error("no"); } }, 400, {});
});
