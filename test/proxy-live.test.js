// #273: OpenAI GPT-Live (/v1/live/sessions WebSocket): per-second duration metering, caps mid-session,
// session.start admission, kill, honest unknowns and backend response usage.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createKillCheck, kill } from "../src/kill.js";
import { encodeFrame } from "../src/realtime.js";
import { LIVE_PATH, backendResponse, durationCost, liveSeconds, sessionStartModel } from "../src/live.js";
import { startRealtimeUpstream, connectRealtime } from "./fixtures/realtime-upstream.js";

const PATH = "/openai/v1/live/sessions";
const START = { type: "session.start", session: { model: "gpt-live-1", voice: "marin" } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(10); } };
const live = (rs) => rs.filter((r) => r.transport === "websocket" && r.path === "/v1/live/sessions");
const billedOf = (rs) => live(rs).filter((r) => r.cost_basis === "duration" && r.billed_seconds != null);
const snap = (conn, seconds) => conn.send({ type: "session.usage.updated", usage: { seconds } });

async function setup(t, { upstream = {}, proxy = {}, closeSeconds } = {}) {
  let conn;
  const up = await startRealtimeUpstream({ onSession: (c) => {
    conn = c;
    if (closeSeconds !== undefined) c.closeSeconds = closeSeconds;
    c.socket.on("data", () => {
      if (!c.startedSent && c.received.some((m) => m.type === "session.start")) {
        c.startedSent = true;
        c.send({ type: "session.started", session: { id: "sess_live", model: "gpt-live-1" } });
      }
    });
    upstream.onSession?.(c);
  }, ...upstream });
  const receipts = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-live-"));
  const { server, port } = await startMeteringProxy({ receiptsPath: join(dir, "receipts.jsonl"), upstreams: { openai: up.url }, onReceipt: (r) => receipts.push(r), liveTickMs: 20, ...proxy });
  t.after(async () => { server.close(); server.closeAllConnections(); await up.close(); });
  const chatCall = () => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", messages: [], n: Math.random() }) });
  const open = async () => {
    const c = await connectRealtime(port, PATH, { Authorization: "Bearer sk-test" });
    assert.equal(c.status, 101);
    c.send(START);
    await until(() => conn?.received.some((m) => m.type === "session.start"));
    await c.waitFor((m) => m.type === "session.started");
    return c;
  };
  return { up, server, port, receipts, chatCall, open, conn: () => conn };
}

test("live.js helpers", () => {
  assert.ok(LIVE_PATH.test("/openai/v1/live/sessions"));
  assert.ok(!LIVE_PATH.test("/openai/v1/live/sessions/x/fork"));
  assert.equal(liveSeconds({ usage: { seconds: 12 } }), 12);
  assert.equal(liveSeconds({ usage: { seconds: -1 } }), null);
  assert.equal(durationCost(12, 0.05), 0.01);
  assert.equal(durationCost(1, 0.05), 0.000833);
  assert.equal(sessionStartModel(START), "gpt-live-1");
  assert.deepEqual(backendResponse({ type: "response.event", event: { type: "response.completed", response: { id: "r", model: "m", usage: { input_tokens: 1 } } } }), { id: "r", model: "m", usage: { input_tokens: 1 } });
  assert.equal(backendResponse({ type: "response.event", event: { type: "response.created", response: {} } }), null);
});

test("AC1 snapshots 12 then 30, session.closed 90: three delta receipts, byte-identical frames, chat 200", async (t) => {
  const s = await setup(t, { closeSeconds: () => 90 });
  const c = await s.open();
  const conn = s.conn();
  snap(conn, 12);
  snap(conn, 30);
  await until(() => billedOf(s.receipts).length === 2);
  c.send({ type: "session.close" });
  await c.waitFor((m) => m.type === "session.closed");
  await until(() => billedOf(s.receipts).length === 3);
  const r = billedOf(s.receipts);
  assert.deepEqual(r.map((x) => x.billed_seconds), [12, 18, 60]);
  assert.deepEqual(r.map((x) => x.session_seconds), [12, 30, 90]);
  assert.deepEqual(r.map((x) => x.cost_usd), [0.01, 0.015, 0.05]);
  assert.equal(Number(r.reduce((a, x) => a + x.cost_usd, 0).toFixed(6)), 0.075);
  for (const x of r) { assert.equal(x.model, "gpt-live-1"); assert.equal(x.session_id, "sess_live"); assert.equal(x.transport, "websocket"); assert.equal(x.cost_source, "table"); }
  assert.equal(s.up.handshakes[0].url, "/v1/live/sessions");
  // Client frames byte-identical to the upstream's frames.
  await sleep(50);
  const upBytes = Buffer.concat(c.rawBytes);
  for (const m of [{ type: "session.usage.updated", usage: { seconds: 12 } }, { type: "session.closed", session: { id: "sess_live" }, usage: { seconds: 90 } }]) assert.ok(upBytes.includes(encodeFrame(1, JSON.stringify(m))));
  // Upstream sees the client's session.start byte-for-byte (masked frame relayed raw).
  assert.deepEqual(conn.received[0], START);
  assert.equal((await s.chatCall()).status, 200);
  assert.ok(!s.receipts.some((x) => x.cost_usd === null));
});

test("AC2 --cap 0.02: 30 s snapshot forwarded, error budget_exceeded, session.close upstream, final 31 billed, 429 before 101", async (t) => {
  const s = await setup(t, { closeSeconds: () => 31, proxy: { cap: createCapEngine({ caps: { run: 0.02 } }) } });
  const c = await s.open();
  const conn = s.conn();
  snap(conn, 30);
  await c.closed;
  const types = c.messages.map((m) => m.type);
  assert.ok(types.indexOf("session.usage.updated") < types.indexOf("error"));
  assert.equal(c.messages.find((m) => m.type === "error").error.code, "budget_exceeded");
  assert.equal(c.closeCode, 1008);
  assert.ok(conn.received.some((m) => m.type === "session.close"));
  const r = billedOf(s.receipts);
  assert.deepEqual(r.map((x) => x.cost_usd), [0.025, 0.000833]);
  const upgrades = s.up.upgrades;
  const c2 = await connectRealtime(s.port, PATH);
  assert.equal(c2.status, 429);
  assert.equal(s.up.upgrades, upgrades);
});

test("AC3 ticker: 12 s snapshot then 12 s of clock closes the session; ledger holds only reported seconds", async (t) => {
  let clock = Date.parse("2026-11-17T12:00:00Z");
  const s = await setup(t, { closeSeconds: () => null, proxy: { now: () => clock, cap: createCapEngine({ caps: { run: 0.02 } }), liveCloseWaitMs: 200 } });
  await s.open();
  const conn = s.conn();
  snap(conn, 12);
  await until(() => billedOf(s.receipts).length === 1);
  await sleep(60);
  assert.ok(!conn.received.some((m) => m.type === "session.close"));
  clock += 12_000;
  await until(() => conn.received.some((m) => m.type === "session.close"), 200);
  conn.send({ type: "session.closed", usage: { seconds: 24 } });
  await until(() => billedOf(s.receipts).length === 2);
  assert.deepEqual(billedOf(s.receipts).map((x) => x.billed_seconds), [12, 12]);
});

test("AC4 admission: allowlist refuses session.start without forwarding it; $0 blocked receipt", async (t) => {
  const s = await setup(t, { proxy: { allowedModels: () => ["gpt-realtime"] } });
  const c = await connectRealtime(s.port, PATH);
  assert.equal(c.status, 101);
  c.send(START);
  await c.closed;
  assert.equal(c.messages.find((m) => m.type === "error").error.code, "model_not_allowed");
  assert.equal(c.closeCode, 1008);
  await sleep(50);
  assert.ok(!s.conn().received.some((m) => m.type === "session.start"));
  const b = live(s.receipts).find((r) => r.reason === "model_not_allowed");
  assert.equal(b.cost_usd, 0);
  assert.equal(b.blocked, true);
  assert.equal(b.model, "gpt-live-1");
});

test("AC4 --unknown-models refuse rejects an unpriced live model at session.start", async (t) => {
  const s = await setup(t, { proxy: { unknownModels: "refuse" } });
  const c = await connectRealtime(s.port, PATH);
  c.send({ type: "session.start", session: { model: "gpt-live-9" } });
  await c.closed;
  assert.equal(c.messages.find((m) => m.type === "error").error.code, "model_unpriced");
  assert.ok(!s.conn().received.some((m) => m.type === "session.start"));
});

test("AC4 kill file: 429 before 101; costcap kill closes an idle session within 1 s", async (t) => {
  const f = join(mkdtempSync(join(tmpdir(), "cc-k-")), "KILL");
  const s = await setup(t, { closeSeconds: () => 3, proxy: { killCheck: createKillCheck(f) } });
  const c = await s.open();
  const t0 = Date.now();
  kill(f, "stop");
  await c.closed;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(c.closeCode, 1008);
  assert.ok(live(s.receipts).some((r) => r.blocked && r.reason === "killed"));
  await until(() => billedOf(s.receipts).length === 1);
  assert.equal(billedOf(s.receipts)[0].billed_seconds, 3);
  const again = await connectRealtime(s.port, PATH);
  assert.equal(again.status, 429);
  assert.equal(again.body.error, "killed");
  assert.equal(s.up.upgrades, 1);
});

test("AC5 client drop after 12 s: proxy sends session.close, final 20 bills 8 s, no latch", async (t) => {
  const s = await setup(t, { closeSeconds: () => 20 });
  const c = await s.open();
  snap(s.conn(), 12);
  await until(() => billedOf(s.receipts).length === 1);
  c.close();
  await until(() => billedOf(s.receipts).length === 2);
  assert.ok(s.conn().received.some((m) => m.type === "session.close"));
  assert.equal(billedOf(s.receipts)[1].billed_seconds, 8);
  assert.ok(!s.receipts.some((r) => r.cost_usd === null));
  assert.equal((await s.chatCall()).status, 200);
});

test("AC5 upstream drop before session.closed: one session_usage_unconfirmed, 429 until settled", async (t) => {
  const s = await setup(t);
  const c = await s.open();
  snap(s.conn(), 12);
  await until(() => billedOf(s.receipts).length === 1);
  s.conn().socket.destroy();
  await c.closed;
  await until(() => s.receipts.some((r) => r.reason === "session_usage_unconfirmed"));
  const u = s.receipts.filter((r) => r.reason === "session_usage_unconfirmed");
  assert.equal(u.length, 1);
  assert.equal(u[0].cost_usd, null);
  assert.equal(u[0].session_seconds_lower_bound, 12);
  assert.equal((await s.chatCall()).status, 429);
  assert.equal(s.server.settle({ receipt_id: u[0].id }), true);
  assert.equal((await s.chatCall()).status, 200);
});

test("AC5 a snapshot that goes backwards bills 0", async (t) => {
  const s = await setup(t, { closeSeconds: () => 40 });
  const c = await s.open();
  snap(s.conn(), 30);
  snap(s.conn(), 25);
  await until(() => billedOf(s.receipts).length === 2);
  c.send({ type: "session.close" });
  await until(() => billedOf(s.receipts).length === 3);
  assert.deepEqual(billedOf(s.receipts).map((r) => r.billed_seconds), [30, 0, 10]);
  assert.equal(billedOf(s.receipts)[1].cost_usd, 0);
});

test("AC5 session.close wait timeout latches unconfirmed", async (t) => {
  const s = await setup(t, { proxy: { cap: createCapEngine({ caps: { run: 0.005 } }), liveCloseWaitMs: 100 } });
  const c = await s.open();
  snap(s.conn(), 12);
  await c.closed;
  assert.equal(c.closeCode, 1008);
  assert.equal(s.receipts.filter((r) => r.reason === "session_usage_unconfirmed").length, 1);
});

test("AC6 backend response.completed priced once per id; unpriced backend latches model_unpriced", async (t) => {
  const s = await setup(t);
  await s.open();
  const ev = { type: "response.event", event: { type: "response.completed", response: { id: "resp_1", model: "gpt-5.4-mini", usage: { input_tokens: 1000, output_tokens: 200 } } } };
  s.conn().send(ev);
  s.conn().send(ev);
  s.conn().send({ type: "response.event", event: { type: "response.completed", response: { id: "resp_2", model: "gpt-made-up", usage: { input_tokens: 1, output_tokens: 1 } } } });
  await until(() => live(s.receipts).filter((r) => r.response_id).length === 2);
  await sleep(50);
  const r = live(s.receipts).filter((x) => x.response_id);
  assert.equal(r.length, 2);
  assert.equal(r[0].cost_usd, 0.00165);
  assert.equal(r[0].model, "gpt-5.4-mini");
  assert.equal(r[1].cost_usd, null);
  assert.equal(r[1].reason, "model_unpriced");
});

test("AC7 /live/sessions/x/fork upgrade stays 501", async (t) => {
  const s = await setup(t);
  const c = await connectRealtime(s.port, "/openai/v1/live/sessions/sess_1/fork");
  assert.equal(c.status, 501);
  assert.equal(c.body.error, "websocket_unsupported");
  assert.equal(s.up.upgrades, 0);
});
