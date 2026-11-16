// #183: enrolled fleet/team cached caps treat a pending batch as pending, not unknown.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { loadSettledReceipts } from "../src/cap.js";
import { agentSpendPolicy, cachedAgentVerdict, cachedTeamVerdict } from "../src/hosted/teams.js";
import { ANTHROPIC_EXPECTED, mockUpstream } from "./support/batch.js";

const SONNET = { model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
const ABATCH = JSON.stringify({ requests: ["a", "b", "c"].map((custom_id) => ({ custom_id, params: SONNET })) });

async function wrapper(t, gate) {
  const up = http.createServer((req, res) => { req.resume(); req.on("end", () => mockUpstream()(req, res)); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-fleet-batch-")), "r.jsonl");
  const pending = () => loadSettledReceipts(receiptsPath);
  const p = await startMeteringProxy({ upstreams: { anthropic: base, openai: base }, receiptsPath, teamCheck: () => gate(pending(), Date.now()), who: { agent_id: "worker", run_id: "r1" } });
  t.after(() => { up.closeAllConnections(); up.close(); p.server.closeAllConnections(); p.server.close(); });
  return { pending, call: (method, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body }) };
}

async function flow(t, gate, total) {
  const s = await wrapper(t, gate);
  assert.equal((await s.call("POST", "/anthropic/v1/messages/batches", ABATCH)).status, 200);
  assert.equal((await s.call("POST", "/anthropic/v1/messages", JSON.stringify(SONNET))).status, 200, "sync call allowed while batch pending");
  assert.equal((await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results")).status, 200, "results read allowed");
  const rows = s.pending();
  assert.ok(rows.every((r) => r.cost_usd !== null), "batch settled");
  assert.ok(total(rows) >= ANTHROPIC_EXPECTED, "settled batch cost counts toward the cap total");
}

const today = () => new Date().toISOString();

test("enrolled agent fleet day cap: batch create, sync call, results read all pass and settle", async (t) => {
  const spend = { spent: { day: 0, month: 0 }, unknown: 0, as_of: today() };
  await flow(t, (pending, now) => cachedAgentVerdict(spend, { day: 1000 }, pending, now), (rows) => {
    const v = cachedAgentVerdict(spend, { day: ANTHROPIC_EXPECTED }, rows, Date.now());
    assert.equal(v.verdict, "budget_exceeded");
    return v.spent_usd;
  });
});

test("enrolled hosted team cap: same flow passes via cachedTeamVerdict", async (t) => {
  const team = (day) => ({ name: "crew", caps: { day }, spent: { day: 0, month: 0 }, unknown: 0, as_of: today() });
  await flow(t, (pending, now) => cachedTeamVerdict(team(1000), pending, now), (rows) => {
    const v = cachedTeamVerdict(team(ANTHROPIC_EXPECTED), rows, Date.now());
    assert.equal(v.verdict, "budget_exceeded");
    return v.spent_usd;
  });
});

test("non-batch null-cost receipts still return accounting_unavailable; pending batch is not unknown", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  const ts = "2026-11-15T11:00:00Z";
  const spend = { spent: { day: 0, month: 0 }, unknown: 0, as_of: ts };
  const team = { name: "crew", caps: { day: 5 }, spent: { day: 0, month: 0 }, unknown: 0, as_of: ts };
  const batch = { id: "b", ts, cost_usd: null, reason: "batch_pending", batch_id: "msgbatch_01" };
  const cut = { id: "c", ts, cost_usd: null, reason: "upstream_5xx" };
  assert.equal(cachedAgentVerdict(spend, { day: 5 }, [batch], now), null);
  assert.equal(cachedTeamVerdict(team, [batch], now), null);
  assert.equal(cachedAgentVerdict(spend, { day: 5 }, [batch, cut], now).verdict, "accounting_unavailable");
  assert.equal(cachedTeamVerdict(team, [batch, cut], now).unknown_receipts, 1);
  // Server-side fleet view: pending shown as pending, not unknown; settled counts its cost.
  const p = agentSpendPolicy([batch, cut], now);
  assert.deepEqual([p.unknown, p.pending_batches], [1, 1]);
  const settled = agentSpendPolicy([{ ...batch, cost_usd: 0.4 }], now);
  assert.deepEqual([settled.unknown, settled.pending_batches, settled.spent.day], [0, 0, 0.4]);
});
