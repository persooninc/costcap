// #273: GPT-Live (/v1/live/sessions WebSocket) per-second session metering, caps, ticker,
// admission, kill, honest unknowns and backend response usage.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createKillCheck, kill } from "../src/kill.js";
import { LIVE_PATH } from "../src/realtime.js";
import { encodeFrame } from "../src/realtime.js";
import { startRealtimeUpstream, connectRealtime } from "./fixtures/realtime-upstream.js";

const PATH = "/openai/v1/live/sessions";
const START = { type: "session.start", session: { model: "gpt-live-1" } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(10); } };
const live = (rs) => rs.filter((r) => r.transport === "websocket" && r.path === "/v1/live/sessions");
const metered = (rs) => live(rs).filter((r) => r.cost_basis === "duration" && !r.blocked && r.reason !== "session_usage_unconfirmed");
const snap = (seconds) => ({ type: "session.usage.updated", usage: { seconds } });
const closedEv = (seconds) => ({ type: "session.closed", usage: { seconds } });

/** Upstream that echoes session.started and answers session.close with session.closed(finalSeconds). */
const liveUpstream = ({ snaps = [], final = null, onStart, onClose } = {}) => ({
  onMessage: (conn, m) => {
    if (m.type === "session.start") {
      conn.send({ type: "session.started", session: { id: "live_1", model: m.session.model } });
      for (const s of snaps) conn.send(snap(s));
      onStart?.(conn);
    }
    if (m.type === "session.close") {
      if (onClose) return onClose(conn);
      if (final !== null) { conn.send(closedEv(final)); setTimeout(() => conn.socket.end(), 20); }
    }
  },
});

async function setup(t, { upstream = {}, proxy = {} } = {}) {
  const up = await startRealtimeUpstream(upstream);
  const receipts = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-live-"));
  const { server, port } = await startMeteringProxy({ receiptsPath: join(dir, "receipts.jsonl"), upstreams: { openai: up.url, anthropic: up.url }, onReceipt: (r) => receipts.push(r), ...proxy });
  t.after(async () => { server.close(); server.closeAllConnections(); await up.close(); });
  const chatCall = () => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", messages: [], n: Math.random() }) });
  return { up, server, port, receipts, dir, chatCall };
}

test("LIVE_PATH matches only the exact sessions path", () => {
  assert.ok(LIVE_PATH.test("/openai/v1/live/sessions"));
  assert.ok(LIVE_PATH.test("/openai/v1/live/sessions/"));
  assert.ok(!LIVE_PATH.test("/openai/v1/live/sessions/x/fork"));
  assert.ok(!LIVE_PATH.test("/openai/v1/realtime"));
});

test("AC1 metering: snapshots 12, 30 and closed 90 -> 12/18/60 s, $0.075, frames byte-identical", async (t) => {
  const { up, port, receipts, chatCall } = await setup(t, { upstream: liveUpstream({ snaps: [12, 30], final: 90 }) });
  const c = await connectRealtime(port, PATH, { Authorization: "Bearer sk-test", "x-costcap-tag": "team=voice" });
  assert.equal(c.status, 101);
  c.send(START);
  await c.waitFor((m) => m.type === "session.usage.updated" && m.usage.seconds === 30);
  c.send({ type: "session.close" });
  await c.waitFor((m) => m.type === "session.closed");
  await until(() => metered(receipts).length === 3);
  const r = metered(receipts);
  assert.deepEqual(r.map((x) => x.billed_seconds), [12, 18, 60]);
  assert.deepEqual(r.map((x) => x.session_seconds), [12, 30, 90]);
  assert.deepEqual(r.map((x) => x.cost_usd), [0.01, 0.015, 0.05]);
  assert.equal(Number(r.reduce((s, x) => s + x.cost_usd, 0).toFixed(6)), 0.075);
  for (const x of r) {
    assert.equal(x.model, "gpt-live-1");
    assert.equal(x.session_id, "live_1");
    assert.equal(x.transport, "websocket");
    assert.equal(x.cost_source, "table");
    assert.deepEqual(x.tags, { team: "voice" });
  }
  const sess = up.sessions[0];
  // Upstream-sent bytes reach the client unchanged.
  const upBytes = Buffer.concat([...[{ type: "session.started", session: { id: "live_1", model: "gpt-live-1" } }, snap(12), snap(30), closedEv(90)].map((e) => encodeFrame(1, JSON.stringify(e)))]);
  await until(() => Buffer.concat(c.rawBytes).length >= upBytes.length);
  assert.ok(Buffer.concat(c.rawBytes).subarray(0, upBytes.length).equals(upBytes));
  assert.deepEqual(sess.received.map((m) => m.type), ["session.start", "session.close"]);
  assert.equal(up.handshakes[0].url, "/v1/live/sessions");
  assert.equal(up.handshakes[0].headers.authorization, "Bearer sk-test");
  assert.ok(!Object.keys(up.handshakes[0].headers).some((k) => k.startsWith("x-costcap-")));
  assert.equal(live(receipts).filter((x) => x.cost_usd === null).length, 0);
  assert.equal((await chatCall()).status, 200);
});

test("AC2 cap: the 30 s snapshot is forwarded, then budget_exceeded, session.close, final 31 s, 1008; next handshake 429", async (t) => {
  const { up, port, receipts } = await setup(t, { upstream: liveUpstream({ snaps: [12, 30], final: 31 }), proxy: { cap: createCapEngine({ caps: { run: 0.02 } }) } });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.type === "error");
  await c.closed;
  assert.equal(c.closeCode, 1008);
  const idx30 = c.messages.findIndex((m) => m.type === "session.usage.updated" && m.usage.seconds === 30);
  const idxErr = c.messages.findIndex((m) => m.type === "error");
  assert.ok(idx30 >= 0 && idxErr > idx30);
  assert.equal(c.messages[idxErr].error.code, "budget_exceeded");
  assert.ok(up.sessions[0].received.some((m) => m.type === "session.close"));
  await until(() => metered(receipts).length === 3);
  assert.deepEqual(metered(receipts).map((x) => x.cost_usd), [0.01, 0.015, 0.000833]);
  const upgrades = up.upgrades;
  const again = await connectRealtime(port, PATH);
  assert.equal(again.status, 429);
  assert.equal(up.upgrades, upgrades);
});

test("AC3 ticker: 12 s of injected clock after a 12 s snapshot closes the session; ledger holds API seconds only", async (t) => {
  let clock = Date.parse("2026-11-16T12:00:00Z");
  const { up, port, receipts } = await setup(t, {
    upstream: liveUpstream({ snaps: [12], final: 12 }),
    proxy: { cap: createCapEngine({ caps: { run: 0.02 } }), now: () => clock, liveTickMs: 20 },
  });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.type === "session.usage.updated");
  await until(() => metered(receipts).length === 1);
  await sleep(80);
  assert.ok(!up.sessions[0].received.some((m) => m.type === "session.close"), "no close before the clock advances");
  clock += 12_000;
  await until(() => up.sessions[0].received.some((m) => m.type === "session.close"), 500);
  await c.closed;
  assert.equal(c.closeCode, 1008);
  assert.deepEqual(metered(receipts).map((x) => x.billed_seconds), [12, 0]);
  assert.ok(live(receipts).every((x) => x.session_seconds === undefined || x.session_seconds <= 12));
});

test("AC4 admission: --models refuses session.start before it reaches the upstream", async (t) => {
  const { up, port, receipts } = await setup(t, { upstream: liveUpstream(), proxy: { allowedModels: () => ["gpt-realtime"] } });
  const c = await connectRealtime(port, PATH);
  assert.equal(c.status, 101);
  c.send(START);
  await c.closed;
  assert.equal(c.closeCode, 1008);
  assert.equal(c.messages.find((m) => m.type === "error").error.code, "model_not_allowed");
  await sleep(50);
  assert.ok(!up.sessions[0].received.some((m) => m.type === "session.start"));
  const b = live(receipts).find((r) => r.blocked);
  assert.equal(b.reason, "model_not_allowed");
  assert.equal(b.cost_usd, 0);
  assert.equal(b.model, "gpt-live-1");
});

test("AC4 admission: --unknown-models refuse blocks an unpriced live model", async (t) => {
  const { up, port, receipts } = await setup(t, { upstream: liveUpstream(), proxy: { unknownModels: "refuse" } });
  const c = await connectRealtime(port, PATH);
  c.send({ type: "session.start", session: { model: "gpt-live-9" } });
  await c.closed;
  assert.equal(c.messages.find((m) => m.type === "error").error.code, "model_unpriced");
  assert.equal(up.sessions[0].received.length, 0);
  assert.equal(live(receipts).at(-1).reason, "model_unpriced");
});

test("AC4 kill file -> 429 before 101; costcap kill closes an idle session within 1 s", async (t) => {
  const killFile = join(mkdtempSync(join(tmpdir(), "cc-lk-")), "KILL");
  const { up, port, receipts } = await setup(t, { upstream: liveUpstream({ final: 5 }), proxy: { killCheck: createKillCheck(killFile) } });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.type === "session.started");
  const t0 = Date.now();
  kill(killFile);
  await c.closed;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(c.closeCode, 1008);
  assert.equal(c.messages.at(-1).error.code, "killed");
  assert.ok(receipts.some((r) => r.blocked && r.reason === "killed" && r.path === "/v1/live/sessions"));
  await until(() => metered(receipts).length === 1);
  assert.equal(metered(receipts)[0].billed_seconds, 5);
  const upgrades = up.upgrades;
  const again = await connectRealtime(port, PATH);
  assert.equal(again.status, 429);
  assert.equal(again.body.error, "killed");
  assert.equal(up.upgrades, upgrades);
});

test("AC5 client drop after 12 s: proxy sends session.close, bills 8 s from closed 20, no latch", async (t) => {
  const { up, port, receipts, chatCall } = await setup(t, { upstream: liveUpstream({ snaps: [12], final: 20 }) });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.type === "session.usage.updated");
  c.close();
  await until(() => metered(receipts).length === 2);
  assert.ok(up.sessions[0].received.some((m) => m.type === "session.close"));
  assert.deepEqual(metered(receipts).map((x) => x.billed_seconds), [12, 8]);
  assert.equal(live(receipts).filter((x) => x.cost_usd === null).length, 0);
  assert.equal((await chatCall()).status, 200);
});

test("AC5 upstream drop before session.closed: one session_usage_unconfirmed latch, settle restores 200", async (t) => {
  const { up, server, port, receipts, chatCall } = await setup(t, { upstream: liveUpstream({ snaps: [12] }) });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.type === "session.usage.updated");
  up.sessions[0].socket.destroy();
  await c.closed;
  await sleep(50);
  const u = live(receipts).filter((r) => r.reason === "session_usage_unconfirmed");
  assert.equal(u.length, 1);
  assert.equal(u[0].cost_usd, null);
  assert.equal(u[0].session_seconds_lower_bound, 12);
  assert.equal((await chatCall()).status, 429);
  assert.equal(server.settle({ receipt_id: u[0].id }), true);
  assert.equal((await chatCall()).status, 200);
});

test("AC5 session.closed timeout latches unconfirmed", async (t) => {
  const { port, receipts } = await setup(t, { upstream: liveUpstream({ snaps: [12], onClose: () => {} }), proxy: { liveCloseTimeoutMs: 100 } });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.type === "session.usage.updated");
  c.close();
  await until(() => live(receipts).some((r) => r.reason === "session_usage_unconfirmed"));
  assert.equal(live(receipts).filter((r) => r.reason === "session_usage_unconfirmed").length, 1);
});

test("AC5 snapshots 30 then 25 bill 0 s for the second", async (t) => {
  const { port, receipts } = await setup(t, { upstream: liveUpstream({ snaps: [30, 25], final: 30 }) });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await until(() => metered(receipts).length === 2);
  assert.deepEqual(metered(receipts).map((x) => [x.billed_seconds, x.cost_usd]), [[30, 0.025], [0, 0]]);
  c.close();
});

test("AC6 backend response.completed is priced once per id; unpriced backend latches model_unpriced", async (t) => {
  const completed = (id, model) => ({ type: "response.event", event: { type: "response.completed", response: { id, model, usage: { input_tokens: 1000, output_tokens: 200 } } } });
  const { port, receipts, chatCall } = await setup(t, { upstream: liveUpstream({ onStart: (conn) => {
    conn.send(completed("r1", "gpt-5.4-mini"));
    conn.send(completed("r1", "gpt-5.4-mini"));
    setTimeout(() => conn.send(completed("r2", "gpt-unknown-backend")), 50);
  } }) });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await until(() => live(receipts).some((r) => r.response_id === "r2"));
  const r1 = live(receipts).filter((r) => r.response_id === "r1");
  assert.equal(r1.length, 1);
  assert.equal(r1[0].cost_usd, 0.00165);
  assert.equal(r1[0].model, "gpt-5.4-mini");
  const r2 = live(receipts).find((r) => r.response_id === "r2");
  assert.equal(r2.cost_usd, null);
  assert.equal(r2.reason, "model_unpriced");
  assert.equal((await chatCall()).status, 429);
  c.close();
});

test("unpriced live model without refuse latches model_unpriced on the first snapshot", async (t) => {
  const { port, receipts } = await setup(t, { upstream: liveUpstream({ snaps: [3], final: 3 }) });
  const c = await connectRealtime(port, PATH);
  c.send({ type: "session.start", session: { model: "gpt-live-9" } });
  await until(() => live(receipts).some((r) => r.reason === "model_unpriced"));
  c.close();
});

test("AC7 /live/sessions/x/fork upgrade still gets 501", async (t) => {
  const { up, port } = await setup(t);
  const c = await connectRealtime(port, "/openai/v1/live/sessions/x/fork");
  assert.equal(c.status, 501);
  assert.equal(c.body.error, "websocket_unsupported");
  assert.equal(up.upgrades, 0);
});
