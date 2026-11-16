// #183 follow-up: server-side team and hosted agent verdicts keep `reason`, so a
// synced pending batch from any team member is pending, not unknown, after a sync.
import test from "node:test";
import assert from "node:assert/strict";
import { teamVerdict, teamPolicy, cachedTeamVerdict } from "../src/hosted/teams.js";
import { hostedAgentVerdict } from "../src/hosted/agent-verdict.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const pb = { id: "pb", ts: "2026-11-15T10:00:00Z", cost_usd: null, reason: "batch_pending", batch_id: "msgbatch_01" };
const team = { name: "ops", agents: ["a", "b"], day: 10 };

test("teamVerdict: a synced pending batch is pending, not unknown; the synced team policy does not refuse", () => {
  const v = teamVerdict({ team, receiptsByAgent: { a: [pb], b: [{ id: "k", ts: pb.ts, cost_usd: 1 }] }, nowMs: NOW });
  assert.equal(v.verdict, "ok");
  assert.deepEqual(v.spend, { day_usd: 1, month_usd: 1, unknown_count: 0, pending_batch_count: 1, cost_complete: false });
  const cached = teamPolicy(v, NOW);
  assert.equal(cached.unknown, 0);
  assert.equal(cachedTeamVerdict(cached, [], NOW), null);
  assert.equal(hostedAgentVerdict({ agent: { id: "b", policy: { caps: {} } }, receipts: [], nowMs: NOW, team: v }).verdict, "ok");
});

test("teamVerdict: a settled batch counts its cost; a non-batch unknown still refuses", () => {
  assert.equal(teamVerdict({ team, receiptsByAgent: { a: [{ ...pb, cost_usd: 10 }] }, nowMs: NOW }).verdict, "budget_exceeded");
  const v = teamVerdict({ team, receiptsByAgent: { a: [pb, { id: "x", ts: pb.ts, cost_usd: null, reason: "upstream_error" }] }, nowMs: NOW });
  assert.equal(v.verdict, "accounting_unavailable");
  assert.equal(v.unknown_receipts, 1);
});

test("hostedAgentVerdict: an agent's own pending batch does not block its own cap", () => {
  const agent = { id: "a", policy: { caps: { day: 10 } } };
  assert.equal(hostedAgentVerdict({ agent, receipts: [pb], nowMs: NOW }).verdict, "ok");
  assert.equal(hostedAgentVerdict({ agent, receipts: [{ ...pb, reason: undefined }], nowMs: NOW }).verdict, "accounting_unavailable");
});
