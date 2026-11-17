// #277: Gemini Live API (BidiGenerateContent WebSocket): per-turn metering at Live modality rates,
// caps between turns, admission on setup, kill and honest unknowns.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startMeteringProxy, baseUrlOverrides } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createKillCheck, kill } from "../src/kill.js";
import { encodeFrame } from "../src/realtime.js";
import { GEMINI_LIVE_PATH, geminiLiveUsage, isExplicitTurn, isTurnInput, setupModel } from "../src/gemini-live.js";
import { startRealtimeUpstream, connectRealtime } from "./fixtures/realtime-upstream.js";

const PATH = "/gemini/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(10); } };
const ws = (rs) => rs.filter((r) => r.provider === "gemini" && r.transport === "websocket");
const turns = (rs) => ws(rs).filter((r) => r.status === 101 && !r.blocked);
const SETUP = (model = "models/gemini-3.8-live") => ({ setup: { model } });
const USAGE = {
  promptTokenCount: 2000, responseTokenCount: 1000, totalTokenCount: 3000,
  promptTokensDetails: [{ modality: "TEXT", tokenCount: 200 }, { modality: "AUDIO", tokenCount: 1800 }],
  responseTokensDetails: [{ modality: "TEXT", tokenCount: 100 }, { modality: "AUDIO", tokenCount: 900 }],
};
const turn = (usage = USAGE, extra = {}) => ({ serverContent: { turnComplete: true, ...extra }, usageMetadata: usage });
const INPUT = { realtimeInput: { audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } } };

// Upstream: on setup replies setupComplete; on each realtimeInput replies with the next scripted message.
function geminiUpstream({ replies = [], onInput = null } = {}) {
  let i = 0;
  return {
    onMessage: (conn, m) => {
      if (m.setup) conn.send({ setupComplete: {} });
      if (m.realtimeInput || m.clientContent) {
        if (onInput) onInput(conn, m);
        else if (i < replies.length) conn.send(replies[i++]);
      }
    },
  };
}

async function setup(t, { upstream = {}, proxy = {} } = {}) {
  const up = await startRealtimeUpstream(upstream);
  const receipts = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-glive-"));
  const { server, port } = await startMeteringProxy({ receiptsPath: join(dir, "receipts.jsonl"), upstreams: { openai: up.url, gemini: up.url, anthropic: up.url }, onReceipt: (r) => receipts.push(r), ...proxy });
  t.after(async () => { server.close(); server.closeAllConnections(); await up.close(); });
  const geminiCall = () => fetch(`http://127.0.0.1:${port}/gemini/v1beta/models/gemini-2.5-flash:generateContent`, { method: "POST", body: JSON.stringify({ contents: [], n: Math.random() }) });
  return { up, server, port, receipts, geminiCall };
}

test("gemini-live.js helpers: path, setup model, turn input, usage mapper", () => {
  assert.ok(GEMINI_LIVE_PATH.test(PATH));
  assert.ok(GEMINI_LIVE_PATH.test("/gemini/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained"));
  assert.ok(!GEMINI_LIVE_PATH.test("/gemini/v1beta/models/x:streamGenerateContent"));
  assert.ok(!GEMINI_LIVE_PATH.test("/gemini/ws/google.ai.generativelanguage.v2.GenerativeService.BidiGenerateContent"));
  assert.equal(setupModel(SETUP()), "gemini-3.8-live");
  assert.equal(setupModel({ setup: { model: "gemini-3.8-live" } }), "gemini-3.8-live");
  assert.equal(setupModel({ setup: {} }), null);
  assert.equal(setupModel(null), null);
  assert.ok(isTurnInput(INPUT) && isTurnInput({ clientContent: {} }) && isTurnInput({ toolResponse: {} }));
  assert.ok(!isTurnInput(SETUP()) && !isTurnInput(null));
  assert.equal(geminiLiveUsage(null), null);
  assert.equal(geminiLiveUsage({ promptTokenCount: 1 }), null);
  const u = geminiLiveUsage({ ...USAGE, toolUsePromptTokenCount: 10, thoughtsTokenCount: 5, cachedContentTokenCount: 50, cacheTokensDetails: [{ modality: "TEXT", tokenCount: 50 }] });
  assert.deepEqual([u.input_tokens, u.cached_input_tokens, u.output_tokens], [1960, 50, 1005]);
  assert.deepEqual(u.modality_tokens.input, { text: 160, image: 0, audio: 1800, video: 0 });
  assert.deepEqual(u.modality_tokens.output, { text: 105, image: 0, audio: 900, video: 0 });
  const plain = geminiLiveUsage({ promptTokenCount: 5, responseTokenCount: 6 });
  assert.equal(plain.modality_tokens, undefined);
  assert.ok(baseUrlOverrides(4100, ["gemini"]).includes(`COSTCAP_GEMINI_LIVE_URL=ws://127.0.0.1:4100${PATH}`));
  assert.ok(!baseUrlOverrides(4100, ["openai"]).some((l) => l.startsWith("COSTCAP_GEMINI_LIVE_URL")));
});

test("AC1 one receipt at Live audio/text rates, frames byte-identical, key passed and redacted", async (t) => {
  const reply = encodeFrame(1, JSON.stringify(turn()));
  const { up, port, receipts } = await setup(t, { upstream: geminiUpstream({ onInput: (conn) => {
    conn.send(encodeFrame(1, '{"serverContent":{"modelTurn"', { fin: false }));
    conn.send(encodeFrame(0, ':{"parts":[]}}}', { fin: true }));
    conn.socket.write(reply.subarray(0, 5));
    setTimeout(() => conn.socket.write(reply.subarray(5)), 20);
  } }) });
  const c = await connectRealtime(port, `${PATH}?key=K`, { "x-costcap-tag": "team=voice", "Sec-WebSocket-Extensions": "permessage-deflate" });
  assert.equal(c.status, 101);
  c.send(SETUP());
  await c.waitFor((m) => m.setupComplete);
  c.send(INPUT);
  await c.waitFor((m) => m.usageMetadata);
  await until(() => turns(receipts).length === 1);
  const r = turns(receipts)[0];
  assert.equal(r.model, "gemini-3.8-live");
  assert.equal(r.transport, "websocket");
  assert.equal(r.cost_source, "table");
  assert.equal(r.cost_usd, 0.0168);
  assert.deepEqual(r.tags, { team: "voice" });
  assert.equal(r.path, "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=REDACTED");
  const h = up.handshakes[0];
  assert.equal(h.url, "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=K");
  assert.ok(!Object.keys(h.headers).some((k) => k.startsWith("x-costcap-")));
  assert.equal(h.headers["sec-websocket-extensions"], undefined);
  // Server frames reach the client byte-for-byte (including the fragmented message).
  const got = Buffer.concat(c.rawBytes);
  assert.ok(got.includes(reply));
  assert.ok(got.includes(encodeFrame(1, '{"serverContent":{"modelTurn"', { fin: false })));
  assert.ok(c.messages.some((m) => m.serverContent?.modelTurn));
  // Client frames reach upstream unchanged (setup then input).
  assert.deepEqual(up.sessions[0].received, [SETUP(), INPUT]);
  c.close();
});

test("AC2 cap between turns: message forwarded, then 1008 budget_exceeded; HTTP and handshake 429", async (t) => {
  const cap = createCapEngine({ caps: { run: 0.03 } });
  const { up, port, receipts, geminiCall } = await setup(t, { upstream: geminiUpstream({ replies: [turn(), turn()] }), proxy: { cap } });
  const c = await connectRealtime(port, PATH);
  c.send(SETUP());
  await c.waitFor((m) => m.setupComplete);
  c.send(INPUT);
  await c.waitFor((m) => m.usageMetadata);
  c.send(INPUT);
  await c.closed;
  assert.equal(c.messages.filter((m) => m.usageMetadata).length, 2);
  assert.equal(c.closeCode, 1008);
  const closeFrame = c.frames.find((f) => f.opcode === 8);
  assert.equal(closeFrame.payload.subarray(2).toString(), "costcap: budget_exceeded");
  await up.sessions[0].closed;
  assert.equal(up.sessions[0].received.filter((m) => m.realtimeInput).length, 2);
  assert.equal(turns(receipts).length, 2);
  assert.equal((await geminiCall()).status, 429);
  const before = up.upgrades;
  const c2 = await connectRealtime(port, PATH);
  assert.equal(c2.status, 429);
  assert.match(JSON.stringify(c2.body), /budget_exceeded/);
  assert.equal(up.upgrades, before);
});

test("AC3 --models refuses setup before upstream; --unknown-models refuse closes model_unpriced", async (t) => {
  const { up, port, receipts } = await setup(t, { upstream: geminiUpstream(), proxy: { allowedModels: () => ["gemini-2.5-flash"] } });
  const c = await connectRealtime(port, PATH);
  assert.equal(c.status, 101);
  c.send(SETUP());
  await c.closed;
  assert.equal(c.closeCode, 1008);
  assert.match(c.frames.find((f) => f.opcode === 8).payload.subarray(2).toString(), /model_not_allowed/);
  await sleep(30);
  assert.equal(up.sessions[0].received.length, 0);
  const b = ws(receipts).find((r) => r.blocked);
  assert.equal(b.reason, "model_not_allowed");
  assert.equal(b.cost_usd, 0);
  assert.equal(b.model, "gemini-3.8-live");
});

test("AC3 --unknown-models refuse with an unpriced setup model closes 1008 model_unpriced", async (t) => {
  const { up, port, receipts } = await setup(t, { upstream: geminiUpstream(), proxy: { unknownModels: "refuse" } });
  const c = await connectRealtime(port, PATH);
  c.send(SETUP("models/gemini-9-live"));
  await c.closed;
  assert.equal(c.closeCode, 1008);
  assert.match(c.frames.find((f) => f.opcode === 8).payload.subarray(2).toString(), /model_unpriced/);
  assert.equal(up.sessions[0].received.length, 0);
  assert.equal(ws(receipts).find((r) => r.blocked).reason, "model_unpriced");
});

test("AC3 a first message that is not setup is refused before upstream", async (t) => {
  const { up, port } = await setup(t, { upstream: geminiUpstream() });
  const c = await connectRealtime(port, PATH);
  c.send(INPUT);
  await c.closed;
  assert.equal(c.closeCode, 1008);
  assert.equal(up.sessions[0].received.length, 0);
});

test("AC3 kill: 429 killed before 101, and kill closes an idle session within 1 s", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-glive-kill-"));
  const killPath = join(dir, "KILL");
  const killCheck = createKillCheck(killPath, { hostFile: null });
  const { up, port } = await setup(t, { upstream: geminiUpstream(), proxy: { killCheck } });
  const c = await connectRealtime(port, PATH);
  c.send(SETUP());
  await c.waitFor((m) => m.setupComplete);
  const t0 = Date.now();
  kill(killPath, "test");
  await c.closed;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(c.closeCode, 1008);
  const before = up.upgrades;
  const c2 = await connectRealtime(port, PATH);
  assert.equal(c2.status, 429);
  assert.equal(c2.body.error, "killed");
  assert.equal(up.upgrades, before);
});

async function unknownCase(t, { model = "models/gemini-3.8-live", onInput, reason }) {
  const { port, receipts, geminiCall, server } = await setup(t, { upstream: geminiUpstream({ onInput }) });
  const c = await connectRealtime(port, PATH);
  c.send(SETUP(model));
  await c.waitFor((m) => m.setupComplete);
  c.send(INPUT);
  await until(() => ws(receipts).some((r) => r.reason === reason));
  const u = ws(receipts).filter((r) => r.reason === reason);
  assert.equal(u.length, 1);
  assert.equal(u[0].cost_usd, null);
  c.close();
  assert.equal((await geminiCall()).status, 429);
  server.settle({ receipt_id: u[0].id });
  assert.equal((await geminiCall()).status, 200);
}

test("AC4 upstream close after realtimeInput before usage latches stream_incomplete; settle clears", async (t) => {
  await unknownCase(t, { onInput: (conn) => setTimeout(() => conn.socket.destroy(), 20), reason: "stream_incomplete" });
});

test("AC4 IMAGE prompt tokens on native-audio latch modality_unpriced", async (t) => {
  const usage = { ...USAGE, promptTokensDetails: [{ modality: "TEXT", tokenCount: 200 }, { modality: "IMAGE", tokenCount: 1800 }] };
  await unknownCase(t, { model: "models/gemini-2.5-flash-native-audio-preview-12-2025", onInput: (conn) => conn.send(turn(usage)), reason: "modality_unpriced" });
});

test("AC4 cachedContentTokenCount with no cache rate latches an unknown", async (t) => {
  await unknownCase(t, { onInput: (conn) => conn.send(turn({ ...USAGE, cachedContentTokenCount: 500 })), reason: "cache_read_unpriced" });
});

test("AC4 groundingMetadata on a turn latches tool_use_unpriced", async (t) => {
  await unknownCase(t, { onInput: (conn) => { conn.send({ serverContent: { groundingMetadata: { webSearchQueries: ["q"] } } }); conn.send(turn()); }, reason: "tool_use_unpriced" });
});

test("AC4 a handshake that never gets 101 is $0 and latches nothing", async (t) => {
  const { port, receipts, geminiCall } = await setup(t, { upstream: { reject: { status: 403, body: { error: "forbidden" } } } });
  const c = await connectRealtime(port, `${PATH}?key=bad`);
  assert.equal(c.status, 403);
  const r = ws(receipts)[0];
  assert.equal(r.cost_usd, 0);
  assert.equal(r.path.includes("key=REDACTED"), true);
  assert.equal((await geminiCall()).status, 200);
});

test("AC5 extended thinking bills thoughts as text; Constrained access_token is metered and redacted", async (t) => {
  const { up, port, receipts } = await setup(t, { upstream: geminiUpstream({ replies: [turn({ ...USAGE, thoughtsTokenCount: 400 })] }) });
  const p = "/gemini/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=T";
  const c = await connectRealtime(port, p);
  c.send(SETUP("models/gemini-3.8-live-extended-thinking"));
  await c.waitFor((m) => m.setupComplete);
  c.send(INPUT);
  await until(() => turns(receipts).length === 1);
  const r = turns(receipts)[0];
  assert.equal(r.cost_usd, Number((0.0168 + 400 * 4.5 / 1e6).toFixed(6)));
  assert.match(r.path, /BidiGenerateContentConstrained\?access_token=REDACTED$/);
  assert.match(up.handshakes[0].url, /access_token=T$/);
  c.close();
});

test("AC5 costcap pricing show prints the Live rows; pricing verify passes", () => {
  const s = spawnSync(process.execPath, ["src/cli.js", "pricing", "show", "gemini-3.1-flash-live-preview"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /gemini-3\.1-flash-live-preview: input \$0\.75, .*output \$4\.5/);
  assert.match(s.stdout, /gemini-3\.1-flash-live-preview \(audio\): input \$3, .*output \$12/);
  const v = spawnSync(process.execPath, ["src/cli.js", "pricing", "verify"], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test("AC6 Gemini HTTP and Anthropic upgrades still get 501", async (t) => {
  const { up, port } = await setup(t);
  for (const p of ["/gemini/v1beta/models/x:streamGenerateContent", "/anthropic/v1/messages"]) {
    const c = await connectRealtime(port, p);
    assert.equal(c.status, 501);
    assert.equal(c.body.error, "websocket_unsupported");
    assert.match(c.body.message, /Gemini Live/);
  }
  assert.equal(up.upgrades, 0);
});

// #283: a partial frame sharing a client read with `setup` must not be dropped at admission.
const { createHash } = await import("node:crypto");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const upBytes = (conn) => Buffer.concat(conn.frames.map((f) => f.raw));

test("#283 AC1 setup + first 100 bytes of a 3 KB realtimeInput in one write: upstream gets every byte in order", async (t) => {
  const { up, port } = await setup(t, { upstream: geminiUpstream() });
  const c = await connectRealtime(port, PATH);
  const s = encodeFrame(1, JSON.stringify(SETUP()), { mask: true });
  const big = { realtimeInput: { audio: { data: "A".repeat(3000), mimeType: "audio/pcm;rate=16000" } } };
  const f = encodeFrame(1, JSON.stringify(big), { mask: true });
  c.socket.write(Buffer.concat([s, f.subarray(0, 100)]));
  await sleep(50);
  c.socket.write(f.subarray(100));
  await until(() => up.sessions[0]?.received.length === 2);
  assert.deepEqual(up.sessions[0].received, [SETUP(), big]);
  assert.ok(upBytes(up.sessions[0]).equals(Buffer.concat([s, f])));
  c.close();
});

test("#283 AC2 setup back-to-back with a 150 KB realtimeInput.video frame reaches upstream byte-identical", async (t) => {
  const { up, port } = await setup(t, { upstream: geminiUpstream() });
  const c = await connectRealtime(port, PATH);
  const video = { realtimeInput: { video: { data: "V".repeat(150 * 1024), mimeType: "image/jpeg" } } };
  const sent = Buffer.concat([encodeFrame(1, JSON.stringify(SETUP()), { mask: true }), encodeFrame(1, JSON.stringify(video), { mask: true })]);
  c.socket.write(sent);
  await until(() => up.sessions[0] && upBytes(up.sessions[0]).length >= sent.length);
  const got = upBytes(up.sessions[0]);
  assert.equal(got.length, sent.length);
  assert.equal(sha(got), sha(sent));
  assert.deepEqual(up.sessions[0].received.map((m) => Object.keys(m)[0]), ["setup", "realtimeInput"]);
  c.close();
});

test("#283 AC4 the frame straddling admission is tapped: upstream close before usage latches stream_incomplete", async (t) => {
  const { up, port, receipts } = await setup(t, { upstream: geminiUpstream({ onInput: (conn) => setTimeout(() => conn.socket.destroy(), 20) }) });
  const c = await connectRealtime(port, PATH);
  const s = encodeFrame(1, JSON.stringify(SETUP()), { mask: true });
  const f = encodeFrame(1, JSON.stringify(INPUT), { mask: true });
  c.socket.write(Buffer.concat([s, f.subarray(0, 10)]));
  await sleep(50);
  c.socket.write(f.subarray(10));
  await until(() => ws(receipts).some((r) => r.reason === "stream_incomplete"));
  assert.equal(ws(receipts).filter((r) => r.reason === "stream_incomplete").length, 1);
  assert.deepEqual(up.sessions[0].received, [SETUP(), INPUT]);
  c.close();
});

// #284: trailing mic input after the last usage, then a normal hang-up, is not a cut turn.
const AUDIO_END = { realtimeInput: { audioStreamEnd: true } };
const closeNormal = (c) => { c.socket.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]), { mask: true })); c.socket.end(); };
async function hangUp(t, { after, proxy = {} }) {
  const { up, port, receipts, geminiCall } = await setup(t, { upstream: { onMessage: (conn, m) => {
    if (m.setup) conn.send({ setupComplete: {} });
    if (m.realtimeInput?.audio && !conn.replied) { conn.replied = true; conn.send(turn()); }
  } }, proxy });
  const c = await connectRealtime(port, PATH);
  c.send(SETUP());
  await c.waitFor((m) => m.setupComplete);
  c.send(INPUT);
  await c.waitFor((m) => m.usageMetadata);
  await after(c, up);
  return { c, up, receipts, geminiCall };
}

test("#284 helper: isExplicitTurn only for turnComplete, activityEnd and toolResponse", () => {
  assert.ok(isExplicitTurn({ clientContent: { turnComplete: true } }) && isExplicitTurn({ realtimeInput: { activityEnd: {} } }) && isExplicitTurn({ toolResponse: {} }));
  assert.ok(!isExplicitTurn(INPUT) && !isExplicitTurn(AUDIO_END) && !isExplicitTurn({ clientContent: { turns: [] } }) && !isExplicitTurn(null));
});

test("#284 AC1 trailing audio + audioStreamEnd then close 1000: no stream_incomplete, next call 200", async (t) => {
  const { up, receipts, geminiCall } = await hangUp(t, { after: async (c, up) => {
    c.send(INPUT); c.send(AUDIO_END);
    await until(() => up.sessions[0].received.some((m) => m.realtimeInput?.audioStreamEnd));
    closeNormal(c);
    await up.sessions[0].closed;
  } });
  await sleep(50);
  assert.equal(ws(receipts).filter((r) => r.reason === "stream_incomplete").length, 0);
  assert.equal(turns(receipts).length, 1);
  assert.equal((await geminiCall()).status, 200);
  assert.ok(up);
});

test("#284 AC2 serverContent without usage then client close 1000 still latches", async (t) => {
  const { receipts, geminiCall } = await hangUp(t, { after: async (c, up) => {
    up.sessions[0].send({ serverContent: { modelTurn: { parts: [{ text: "hi" }] } } });
    await c.waitFor((m) => m.serverContent?.modelTurn);
    closeNormal(c);
    await up.sessions[0].closed;
  } });
  await until(() => ws(receipts).some((r) => r.reason === "stream_incomplete"));
  assert.equal(ws(receipts).filter((r) => r.reason === "stream_incomplete").length, 1);
  assert.equal((await geminiCall()).status, 429);
});

for (const [name, msg] of [["clientContent turnComplete", { clientContent: { turns: [{ role: "user", parts: [{ text: "q" }] }], turnComplete: true } }], ["activityEnd", { realtimeInput: { activityEnd: {} } }], ["toolResponse", { toolResponse: { functionResponses: [] } }]]) {
  test(`#284 AC3 ${name} then close 1000 with no usage still latches`, async (t) => {
    const { receipts, geminiCall } = await hangUp(t, { after: async (c, up) => {
      c.send(msg);
      await until(() => up.sessions[0].received.length >= 3);
      closeNormal(c);
      await up.sessions[0].closed;
    } });
    await until(() => ws(receipts).some((r) => r.reason === "stream_incomplete"));
    assert.equal((await geminiCall()).status, 429);
  });
}

test("#284 AC4 cap close while the mic streams writes the cap receipt only", async (t) => {
  const cap = createCapEngine({ caps: { run: 0.01 } });
  const { c, receipts } = await hangUp(t, { proxy: { cap }, after: async (c) => { c.send(INPUT); c.send(INPUT); await c.closed; } });
  assert.equal(c.closeCode, 1008);
  await sleep(50);
  assert.equal(ws(receipts).filter((r) => r.reason === "stream_incomplete").length, 0);
});
