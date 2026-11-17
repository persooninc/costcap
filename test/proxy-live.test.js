// #273: OpenAI GPT-Live (/v1/live/sessions WebSocket): per-second metering, caps mid-session,
// admission on session.start, kill and honest unknowns.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy, baseUrlOverrides } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createKillCheck, kill } from "../src/kill.js";
import { operationName } from "../src/otlp.js";
import { LIVE_PATH, backendResponse, createSnapshotMeter, durationCost, liveRate, sessionSeconds } from "../src/live.js";
import { startRealtimeUpstream, connectRealtime } from "./fixtures/realtime-upstream.js";

const PATH = "/openai/v1/live/sessions";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(10); } };
const live = (rs) => rs.filter((r) => r.path === "/v1/live/sessions");
const billed = (rs) => live(rs).filter((r) => r.cost_basis === "duration");
const START = { type: "session.start", session: { model: "gpt-live-1" } };
const snap = (seconds) => ({ type: "session.usage.updated", usage: { seconds } });
const closed = (seconds) => ({ type: "session.closed", usage: { seconds } });
const started = { type: "session.started", session: { id: "ls_1", model: "gpt-live-1" } };

// Upstream: on session.start replies session.started + snapshots; on session.close replies session.closed(final).
function liveUpstream({ snaps = [], final = null, onStart = null } = {}) {
  return {
    onMessage: (conn, m) => {
      if (m.type === "session.start") { conn.send(started); if (onStart) onStart(conn); else for (const s of snaps) conn.send(snap(s)); }
      if (m.type === "session.close" && final !== null) conn.send(closed(final));
    },
  };
}

async function setup(t, { upstream = {}, proxy = {} } = {}) {
  const up = await startRealtimeUpstream(upstream);
  const receipts = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-live-"));
  const { server, port } = await startMeteringProxy({ receiptsPath: join(dir, "receipts.jsonl"), upstreams: { openai: up.url, anthropic: up.url }, onReceipt: (r) => receipts.push(r), ...proxy });
  t.after(async () => { server.close(); server.closeAllConnections(); await up.close(); });
  const chatCall = () => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", messages: [], n: Math.random() }) });
  return { up, server, port, receipts, dir, chatCall };
}

test("live.js helpers: path, rate, snapshot meter, backend envelope", () => {
  assert.ok(LIVE_PATH.test("/openai/v1/live/sessions"));
  assert.ok(!LIVE_PATH.test("/openai/v1/live/sessions/x/fork"));
  assert.equal(liveRate("gpt-live-1").per_minute, 0.05);
  assert.equal(liveRate("gpt-4o-mini"), null);
  assert.equal(durationCost(1, 0.05), 0.000833);
  assert.equal(sessionSeconds(snap(12)), 12);
  assert.equal(sessionSeconds({ usage: { seconds: -1 } }), null);
  const m = createSnapshotMeter();
  assert.deepEqual(m.take(30), { billed_seconds: 30, session_seconds: 30 });
  assert.deepEqual(m.take(25), { billed_seconds: 0, session_seconds: 30 });
  const r = { id: "r1", model: "gpt-5.4-mini", usage: { input_tokens: 1, output_tokens: 1 } };
  assert.equal(backendResponse({ type: "response.event", event: { type: "response.completed", response: r } }), r);
  assert.equal(backendResponse({ type: "response.event", event: { type: "response.created", response: r } }), null);
  assert.equal(operationName("/v1/live/sessions"), "live");
  assert.ok(baseUrlOverrides(4100, ["openai"]).some((l) => l === "COSTCAP_OPENAI_LIVE_URL=ws://127.0.0.1:4100/openai/v1/live/sessions"));
  // #277: the Gemini Live URL is exported only when gemini is wrapped.
  assert.ok(!baseUrlOverrides(4100, ["openai"]).some((l) => l.startsWith("COSTCAP_GEMINI_LIVE_URL=")));
  assert.ok(baseUrlOverrides(4100, ["gemini"]).some((l) => l.startsWith("COSTCAP_GEMINI_LIVE_URL=ws://127.0.0.1:4100/gemini/ws/")));
});

test("AC1 meters 12 / 18 / 60 s at $0.05/min, frames byte-identical, next call 200", async (t) => {
  const { up, port, receipts, chatCall } = await setup(t, { upstream: liveUpstream({ snaps: [12, 30], final: 90 }) });
  const c = await connectRealtime(port, PATH, { Authorization: "Bearer sk-test", "x-costcap-tag": "team=voice" });
  assert.equal(c.status, 101);
  c.send(START);
  await c.waitFor((m) => m.type === "session.usage.updated" && m.usage.seconds === 30);
  c.send({ type: "session.close" });
  await c.waitFor((m) => m.type === "session.closed");
  await until(() => billed(receipts).length === 3);
  const r = billed(receipts);
  assert.deepEqual(r.map((x) => x.billed_seconds), [12, 18, 60]);
  assert.deepEqual(r.map((x) => x.session_seconds), [12, 30, 90]);
  assert.deepEqual(r.map((x) => x.cost_usd), [0.01, 0.015, 0.05]);
  assert.equal(Number(r.reduce((a, x) => a + x.cost_usd, 0).toFixed(6)), 0.075);
  for (const x of r) { assert.equal(x.transport, "websocket"); assert.equal(x.session_id, "ls_1"); assert.equal(x.model, "gpt-live-1"); assert.deepEqual(x.tags, { team: "voice" }); }
  assert.equal(up.handshakes[0].url, "/v1/live/sessions");
  assert.ok(!Object.keys(up.handshakes[0].headers).some((k) => k.startsWith("x-costcap-")));
  // Client received exactly what upstream sent (unmasked server frames).
  const got = Buffer.concat(c.rawBytes);
  for (const ev of [started, snap(12), snap(30), closed(90)]) assert.ok(got.includes(Buffer.from(JSON.stringify(ev))));
  assert.equal(up.sessions[0].received[0].type, "session.start");
  c.close();
  assert.equal((await chatCall()).status, 200);
});

test("AC2 cap hit mid-session: event forwarded, error + 1008, final delta billed, next handshake 429", async (t) => {
  const cap = createCapEngine({ caps: { run: 0.02 } });
  const { up, port, receipts } = await setup(t, { upstream: liveUpstream({ snaps: [12, 30], final: 31 }), proxy: { cap } });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  const err = await c.waitFor((m) => m.type === "error");
  assert.equal(err.error.code, "budget_exceeded");
  const iSnap = c.messages.findIndex((m) => m.usage?.seconds === 30), iErr = c.messages.indexOf(err);
  assert.ok(iSnap >= 0 && iSnap < iErr);
  await c.closed;
  assert.equal(c.closeCode, 1008);
  assert.ok(up.sessions[0].received.some((m) => m.type === "session.close"));
  const r = billed(receipts);
  assert.deepEqual(r.map((x) => x.cost_usd), [0.01, 0.015, 0.000833]);
  const before = up.upgrades;
  const c2 = await connectRealtime(port, PATH);
  assert.equal(c2.status, 429);
  assert.equal(up.upgrades, before);
});

test("AC3 ticker: wall-clock estimate closes the session early, ledger holds only API seconds", async (t) => {
  let clock = 1_000_000;
  const cap = createCapEngine({ caps: { run: 0.02 } });
  const { up, port, receipts } = await setup(t, { upstream: liveUpstream({ snaps: [12], final: 12 }), proxy: { cap, now: () => clock, liveTickMs: 50 } });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.usage?.seconds === 12);
  await sleep(120);
  assert.ok(!up.sessions[0].received.some((m) => m.type === "session.close"));
  clock += 12_000;
  await until(() => up.sessions[0].received.some((m) => m.type === "session.close"), 500);
  await c.closed;
  assert.equal(c.closeCode, 1008);
  const r = billed(receipts);
  assert.deepEqual(r.map((x) => x.session_seconds), [12, 12]);
  assert.equal(r.reduce((a, x) => a + x.cost_usd, 0), 0.01);
});

test("AC4 --models refuses session.start before upstream; kill file 429 before 101; kill closes idle session", async (t) => {
  const { up, port, receipts } = await setup(t, { upstream: liveUpstream(), proxy: { allowedModels: () => ["gpt-realtime"] } });
  const c = await connectRealtime(port, PATH);
  assert.equal(c.status, 101);
  c.send(START);
  const err = await c.waitFor((m) => m.type === "error");
  assert.equal(err.error.code, "model_not_allowed");
  await c.closed;
  assert.equal(c.closeCode, 1008);
  await sleep(30);
  assert.equal(up.sessions[0].received.length, 0);
  const b = live(receipts).find((r) => r.blocked);
  assert.equal(b.reason, "model_not_allowed");
  assert.equal(b.cost_usd, 0);
  assert.equal(b.model, "gpt-live-1");
});

test("AC4 kill: 429 killed before 101, and kill closes an idle session within 1 s", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-live-kill-"));
  const killPath = join(dir, "KILL");
  const killCheck = createKillCheck(killPath, { hostFile: null });
  const { up, port } = await setup(t, { upstream: liveUpstream({ final: 3 }), proxy: { killCheck } });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.type === "session.started");
  const t0 = Date.now();
  kill(killPath, "test");
  await c.closed;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(c.closeCode, 1008);
  await until(() => up.sessions[0].received.some((m) => m.type === "session.close"));
  const before = up.upgrades;
  const c2 = await connectRealtime(port, PATH);
  assert.equal(c2.status, 429);
  assert.equal(c2.body.error, "killed");
  assert.equal(up.upgrades, before);
});

test("AC5 client drop: proxy sends session.close and bills the final delta, no latch", async (t) => {
  const { up, port, receipts, chatCall } = await setup(t, { upstream: liveUpstream({ snaps: [12], final: 20 }) });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.usage?.seconds === 12);
  c.close();
  await until(() => billed(receipts).length === 2);
  assert.ok(up.sessions[0].received.some((m) => m.type === "session.close"));
  assert.deepEqual(billed(receipts).map((x) => x.billed_seconds), [12, 8]);
  await sleep(30);
  assert.ok(!live(receipts).some((r) => r.reason === "session_usage_unconfirmed"));
  assert.equal((await chatCall()).status, 200);
});

test("AC5 upstream drop before session.closed latches one unconfirmed receipt; settle restores 200", async (t) => {
  const { port, receipts, chatCall, server } = await setup(t, { upstream: liveUpstream({ onStart: (conn) => { conn.send(snap(12)); setTimeout(() => conn.socket.destroy(), 30); } }) });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.closed;
  await until(() => live(receipts).some((r) => r.reason === "session_usage_unconfirmed"));
  const u = live(receipts).filter((r) => r.reason === "session_usage_unconfirmed");
  assert.equal(u.length, 1);
  assert.equal(u[0].cost_usd, null);
  assert.equal(u[0].session_seconds_lower_bound, 12);
  assert.equal((await chatCall()).status, 429);
  server.settle({ receipt_id: u[0].id });
  assert.equal((await chatCall()).status, 200);
});

test("AC5 close timeout without session.closed latches; backwards snapshot bills 0", async (t) => {
  const { port, receipts } = await setup(t, { upstream: liveUpstream({ snaps: [30, 25] }), proxy: { liveCloseWaitMs: 100 } });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.usage?.seconds === 25);
  await until(() => billed(receipts).length === 2);
  assert.deepEqual(billed(receipts).map((x) => x.billed_seconds), [30, 0]);
  c.close();
  await until(() => live(receipts).some((r) => r.reason === "session_usage_unconfirmed"));
  assert.equal(live(receipts).find((r) => r.reason === "session_usage_unconfirmed").session_seconds_lower_bound, 30);
});

test("AC6 backend response.completed priced once per id; unpriced backend model latches", async (t) => {
  const resp = (id, model) => ({ type: "response.event", event: { type: "response.completed", response: { id, model, usage: { input_tokens: 1000, output_tokens: 200 } } } });
  const { port, receipts, chatCall } = await setup(t, { upstream: liveUpstream({ onStart: (conn) => { conn.send(resp("r1", "gpt-5.4-mini")); conn.send(resp("r1", "gpt-5.4-mini")); conn.send(resp("r2", "no-such-model-x")); conn.send(snap(1)); } }) });
  const c = await connectRealtime(port, PATH);
  c.send(START);
  await c.waitFor((m) => m.type === "session.usage.updated");
  await until(() => live(receipts).some((r) => r.reason === "model_unpriced"));
  const b = live(receipts).filter((r) => r.backend);
  assert.equal(b.length, 2);
  assert.equal(b[0].cost_usd, 0.00165);
  assert.equal(b[0].response_id, "r1");
  assert.equal(b[1].cost_usd, null);
  assert.equal(b[1].reason, "model_unpriced");
  c.close();
  assert.equal((await chatCall()).status, 429);
});

test("AC7 /live/sessions/x/fork and chat-path upgrades still get 501", async (t) => {
  const { up, port } = await setup(t);
  for (const p of ["/openai/v1/live/sessions/x/fork", "/openai/v1/chat/completions"]) {
    const c = await connectRealtime(port, p);
    assert.equal(c.status, 501);
  }
  assert.equal(up.upgrades, 0);
});

test("costcap pricing show lists the gpt-live-1 per-minute row", async () => {
  const { spawnSync } = await import("node:child_process");
  const s = spawnSync(process.execPath, ["src/cli.js", "pricing", "show", "gpt-live-1"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /gpt-live-1: \$0\.05 per minute/);
});
