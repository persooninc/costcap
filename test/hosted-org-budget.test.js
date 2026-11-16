// Issue #240: org-wide day/month budget. Pure unit coverage of src/hosted/org-budget.js.
import test from "node:test";
import assert from "node:assert/strict";
import { parseOrgBudget, orgBudgetOf, orgBudgetVerdict, orgBudgetPolicy, validOrgBudgetPolicy, cachedOrgVerdict, cachedOrgRemaining, orgScope } from "../src/hosted/org-budget.js";
import { hostedAgentVerdict } from "../src/hosted/agent-verdict.js";
import { buildEvidence } from "../src/hosted/evidence.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const ts = (iso) => iso;
const r = (id, cost, at = "2026-11-16T10:00:00Z", extra = {}) => ({ id, ts: ts(at), cost_usd: cost, ...extra });

test("parseOrgBudget: positive USD, null clears, unknown fields and hour scope are 400", () => {
  assert.deepEqual(parseOrgBudget({ day: 1 }), { day: 1 });
  assert.deepEqual(parseOrgBudget({ month: 2000, warnFractions: [0.9, 0.5] }), { month: 2000, warnFractions: [0.5, 0.9] });
  assert.deepEqual(parseOrgBudget({ month: 5 }, { day: 1 }), { day: 1, month: 5 });
  assert.deepEqual(parseOrgBudget({ day: null }, { day: 1, month: 5 }), { month: 5 });
  assert.equal(parseOrgBudget({ day: null, month: null }, { day: 1, month: 5 }), null);
  assert.deepEqual(parseOrgBudget({ warnFractions: null }, { day: 1, warnFractions: [0.5] }), { day: 1 });
  for (const bad of [{ day: 0 }, { day: -1 }, { month: "5" }, { day: Infinity }, { hour: 1 }, { run: 1 }, { teams: [] }, { warnFractions: [2] }, null, [], "x"]) {
    assert.throws(() => parseOrgBudget(bad), (err) => err.status === 400, JSON.stringify(bad));
  }
});

test("orgBudgetOf: null without a cap", () => {
  assert.equal(orgBudgetOf(undefined), null);
  assert.equal(orgBudgetOf({}), null);
  assert.equal(orgBudgetOf({ orgBudget: { warnFractions: [0.5] } }), null);
  assert.deepEqual(orgBudgetOf({ orgBudget: { day: 1 } }), { day: 1 });
});

test("orgBudgetVerdict: sums every agent, scope org:<window>, no agents is ok", () => {
  assert.equal(orgBudgetVerdict({ budget: null, agentIds: [], receiptsByAgent: {}, nowMs: NOW }), null);
  const empty = orgBudgetVerdict({ budget: { day: 1, warnFractions: [0.5] }, agentIds: [], receiptsByAgent: {}, nowMs: NOW });
  assert.equal(empty.verdict, "ok");
  assert.deepEqual(empty.warnFractions, [0.5]);
  const under = orgBudgetVerdict({ budget: { day: 1 }, agentIds: ["a", "b"], receiptsByAgent: { a: [r("1", 0.4)], b: [r("1", 0.4)] }, nowMs: NOW });
  assert.equal(under.verdict, "ok");
  assert.equal(under.spend.day_usd, 0.8);
  const over = orgBudgetVerdict({ budget: { day: 1, month: 100 }, agentIds: ["a", "b"], receiptsByAgent: { a: [r("1", 0.4), r("2", 0.4)], b: [r("1", 0.4)] }, nowMs: NOW });
  assert.equal(over.verdict, "budget_exceeded");
  assert.equal(over.scope, "org:day");
  assert.equal(over.cap_usd, 1);
  assert.equal(over.spent_usd, 1.2);
  assert.deepEqual(over.caps, { day: 1, month: 100 });
  const month = orgBudgetVerdict({ budget: { month: 1 }, agentIds: ["a"], receiptsByAgent: { a: [r("1", 0.6, "2026-11-02T00:00:00Z"), r("2", 0.6)] }, nowMs: NOW });
  assert.equal(month.scope, "org:month");
  assert.equal(month.spend.day_usd, 0.6);
});

test("orgBudgetVerdict: unknown cost is accounting_unavailable, a pending batch is pending, blocked receipts do not count", () => {
  const unknown = orgBudgetVerdict({ budget: { day: 100 }, agentIds: ["a", "b"], receiptsByAgent: { a: [r("1", 0.1)], b: [r("1", null)] }, nowMs: NOW });
  assert.equal(unknown.verdict, "accounting_unavailable");
  assert.equal(unknown.spend.unknown_count, 1);
  assert.equal(unknown.unknown_receipts, 1);
  const pending = orgBudgetVerdict({ budget: { day: 100 }, agentIds: ["a"], receiptsByAgent: { a: [r("1", null, undefined, { reason: "batch_pending" })] }, nowMs: NOW });
  assert.equal(pending.spend.unknown_count, 0);
  const blocked = orgBudgetVerdict({ budget: { day: 1 }, agentIds: ["a"], receiptsByAgent: { a: [r("1", 5, undefined, { blocked: true })] }, nowMs: NOW });
  assert.equal(blocked.verdict, "ok");
});

test("orgBudgetVerdict: period rollover follows the org budget period (#209)", () => {
  const bp = { timezone: "America/New_York", monthStartDay: 1 };
  // 03:00Z on the 16th is still the 15th in New York.
  const rec = { a: [r("1", 2, "2026-11-16T03:00:00Z")] };
  const ny = orgBudgetVerdict({ budget: { day: 1 }, agentIds: ["a"], receiptsByAgent: rec, nowMs: NOW, budgetPeriod: bp });
  assert.equal(ny.verdict, "ok");
  const utc = orgBudgetVerdict({ budget: { day: 1 }, agentIds: ["a"], receiptsByAgent: rec, nowMs: NOW });
  assert.equal(utc.verdict, "budget_exceeded");
  const nextMonth = orgBudgetVerdict({ budget: { month: 1 }, agentIds: ["a"], receiptsByAgent: { a: [r("1", 5, "2026-10-31T12:00:00Z")] }, nowMs: NOW });
  assert.equal(nextMonth.verdict, "ok");
});

test("orgBudgetPolicy / validOrgBudgetPolicy round-trip and reject bad payloads", () => {
  assert.equal(orgBudgetPolicy(null, NOW), null);
  const v = orgBudgetVerdict({ budget: { day: 1 }, agentIds: ["a"], receiptsByAgent: { a: [r("1", 0.5)] }, nowMs: NOW });
  const p = orgBudgetPolicy(v, NOW);
  assert.deepEqual(p, { caps: { day: 1 }, spend: { day_usd: 0.5, month_usd: 0.5, unknown_count: 0 }, verdict: "ok", as_of: new Date(NOW).toISOString() });
  assert.equal(validOrgBudgetPolicy(p), true);
  assert.equal(validOrgBudgetPolicy(null), true);
  assert.equal(validOrgBudgetPolicy(undefined), true);
  for (const bad of ["x", { ...p, as_of: "nope" }, { ...p, verdict: 1 }, { ...p, caps: {} }, { ...p, caps: { day: -1 } }, { ...p, spend: { ...p.spend, unknown_count: -1 } }, { ...p, spend: { ...p.spend, day_usd: "1" } }, { ...p, spend: undefined }]) {
    assert.equal(validOrgBudgetPolicy(bad), false, JSON.stringify(bad));
  }
});

test("cachedOrgVerdict / cachedOrgRemaining: synced plus unsynced spend, unknown refuses, past day is zero", () => {
  const org = { caps: { day: 1, month: 10 }, spend: { day_usd: 0.8, month_usd: 0.8, unknown_count: 0 }, verdict: "ok", as_of: new Date(NOW).toISOString() };
  assert.equal(cachedOrgVerdict(null, [], NOW), null);
  assert.equal(cachedOrgVerdict(org, [], NOW), null);
  const hit = cachedOrgVerdict(org, [r("x", 0.4, "2026-11-16T11:00:00Z")], NOW);
  assert.equal(hit.verdict, "budget_exceeded");
  assert.equal(hit.scope, orgScope("day"));
  assert.equal(hit.spent_usd, 1.2);
  assert.equal(hit.org, true);
  const unk = cachedOrgVerdict(org, [r("x", null, "2026-11-16T11:00:00Z")], NOW);
  assert.equal(unk.verdict, "accounting_unavailable");
  assert.equal(cachedOrgVerdict({ ...org, spend: { ...org.spend, unknown_count: 2 } }, [], NOW).unknown_receipts, 2);
  // Next UTC day: synced day spend no longer counts.
  assert.equal(cachedOrgVerdict(org, [], NOW + 86_400_000), null);
  assert.deepEqual(cachedOrgRemaining(org, [r("x", 0.1, "2026-11-16T11:00:00Z")], NOW), { day: 0.1, month: 9.1 });
  assert.deepEqual(cachedOrgRemaining({ ...org, caps: { month: 10 } }, [], NOW), { day: null, month: 9.2 });
  assert.equal(cachedOrgRemaining(null, [], NOW), null);
});

test("hostedAgentVerdict: agent cap first, team next, then the org budget", () => {
  const agent = { id: "a", policy: { caps: { day: 0.5 } } };
  const org = { caps: { day: 1 }, spend: { day_usd: 2, month_usd: 2, unknown_count: 0 }, verdict: "budget_exceeded", scope: "org:day", cap_usd: 1, spent_usd: 2 };
  const own = hostedAgentVerdict({ agent, receipts: [r("1", 0.6)], nowMs: NOW, orgBudget: org });
  assert.equal(own.scope, "day");
  const viaOrg = hostedAgentVerdict({ agent: { id: "a", policy: {} }, receipts: [], nowMs: NOW, orgBudget: org });
  assert.equal(viaOrg.verdict, "budget_exceeded");
  assert.equal(viaOrg.scope, "org:day");
  assert.equal(viaOrg.hit.org, true);
  assert.deepEqual(viaOrg.org_budget, org);
  const unk = hostedAgentVerdict({ agent: { id: "a", policy: {} }, receipts: [], nowMs: NOW, orgBudget: { ...org, verdict: "accounting_unavailable", scope: undefined, unknown_receipts: 1 } });
  assert.equal(unk.reason, "unreconciled_receipt");
  const team = { name: "ops", verdict: "budget_exceeded", scope: "team:ops:day", cap_usd: 1, spent_usd: 1 };
  assert.equal(hostedAgentVerdict({ agent: { id: "a", policy: {} }, receipts: [], nowMs: NOW, team, orgBudget: org }).scope, "team:ops:day");
  const ok = hostedAgentVerdict({ agent: { id: "a", policy: {} }, receipts: [], nowMs: NOW, orgBudget: { ...org, verdict: "ok" } });
  assert.equal(ok.ok, true);
});

test("buildEvidence: org_budget is the verdict, null when unset", () => {
  const spendFor = () => ({ day: { usd: 0, unknown: 0 }, month: { usd: 0, unknown: 0 } });
  assert.equal(buildEvidence({ orgId: "o", nowMs: NOW, spendFor }).org_budget, null);
  const v = orgBudgetVerdict({ budget: { day: 1 }, agentIds: ["a"], receiptsByAgent: { a: [r("1", 2)] }, nowMs: NOW });
  assert.deepEqual(buildEvidence({ orgId: "o", nowMs: NOW, spendFor, orgBudget: v }).org_budget, { caps: { day: 1 }, spend: v.spend, verdict: "budget_exceeded", scope: "org:day" });
});
