// Issue #268: week scopes for the org budget, fleet tag caps and hosted model
// caps. Pure units: validation, ISO-week windows across a month boundary and in
// the org timezone, unknown cost, alerts, and back-compat with a frozen copy of
// the 20dfc3a wrapper checks (test/fixtures/validators-20dfc3a.js).
import test from "node:test";
import assert from "node:assert/strict";
import { parseOrgBudget, orgBudgetVerdict, orgBudgetPolicy, legacyOrgBudgetPolicy, weekOrgBudgetPolicy, validOrgBudgetPolicy, cachedOrgVerdict, cachedOrgRemaining } from "../src/hosted/org-budget.js";
import { parseFleetTagCaps, fleetTagCapsPolicy, fleetTagCapsPayload, validFleetTagCaps, cachedFleetTagVerdict } from "../src/hosted/tag-caps.js";
import { modelSpendPolicy, splitWeekModelCaps, validWeekModelCaps, validModelSpend, cachedFleetModelVerdict, fleetModelRules, modelCapStatus } from "../src/hosted/model-caps.js";
import { modelCapsError, parseModelCap } from "../src/model-cap.js";
import { evaluateOrgAlerts, evaluateTagAlerts, evaluateModelAlerts } from "../src/hosted/alerts.js";
import * as frozen from "./fixtures/validators-20dfc3a.js";

const LA = { timezone: "America/Los_Angeles", monthStartDay: 1 };
const r = (id, ts, cost, extra = {}) => ({ id, ts, cost_usd: cost, ...extra });

test("#268 AC4: parseOrgBudget accepts week (null clears), rejects 0, -1 and strings", () => {
  assert.deepEqual(parseOrgBudget({ week: 10 }), { week: 10 });
  assert.deepEqual(parseOrgBudget({ week: null }, { week: 10, day: 1 }), { day: 1 });
  assert.equal(parseOrgBudget({ week: null }, { week: 10 }), null);
  for (const bad of [0, -1, "5", Infinity]) assert.throws(() => parseOrgBudget({ week: bad }), (e) => e.status === 400);
});

test("#268 AC1: org week in America/Los_Angeles starts Monday 00:00 local", () => {
  const sun = Date.parse("2026-11-16T07:30:00Z"); // Sun 2026-11-15 23:30 PST
  const mon = Date.parse("2026-11-16T08:30:00Z"); // Mon 2026-11-16 00:30 PST
  const now = Date.parse("2026-11-16T09:00:00Z"); // Mon 01:00 PST
  const receiptsByAgent = { a: [r("1", new Date(sun).toISOString(), 6)], b: [r("2", new Date(mon).toISOString(), 4)] };
  const v = orgBudgetVerdict({ budget: { week: 10 }, agentIds: ["a", "b"], receiptsByAgent, nowMs: now, budgetPeriod: LA });
  assert.equal(v.spend.week_usd, 4);
  assert.equal(v.verdict, "ok");
  receiptsByAgent.b.push(r("3", new Date(now).toISOString(), 6));
  const over = orgBudgetVerdict({ budget: { week: 10 }, agentIds: ["a", "b"], receiptsByAgent, nowMs: now, budgetPeriod: LA });
  assert.equal(over.verdict, "budget_exceeded");
  assert.equal(over.scope, "org:week");
  assert.equal(over.cap_usd, 10);
  // The wrapper's cached check agrees, and adds its own unsynced receipts.
  const full = orgBudgetPolicy(v, now);
  assert.equal(cachedOrgVerdict(full, [], now, LA), null);
  const hit = cachedOrgVerdict(full, [r("p", new Date(now).toISOString(), 6)], now, LA);
  assert.deepEqual({ verdict: hit.verdict, scope: hit.scope, cap: hit.cap_usd }, { verdict: "budget_exceeded", scope: "org:week", cap: 10 });
  // Next Monday the synced week spend no longer counts.
  assert.equal(cachedOrgVerdict(orgBudgetPolicy(over, now), [], now + 7 * 86_400_000, LA), null);
  // Preflight remainders stay day/month (week preflight is out of scope).
  assert.deepEqual(cachedOrgRemaining(full, [], now, LA), { day: null, month: null });
  // No agents yet: week spend is 0.
  assert.equal(orgBudgetVerdict({ budget: { week: 1 }, agentIds: [], receiptsByAgent: {}, nowMs: now }).spend.week_usd, 0);
});

test("#268 AC6: an unknown receipt inside the capped week is accounting_unavailable and raises no alert", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const v = orgBudgetVerdict({ budget: { week: 10 }, agentIds: ["a"], receiptsByAgent: { a: [r("1", "2026-11-17T12:00:00Z", null)] }, nowMs: now });
  assert.equal(v.verdict, "accounting_unavailable");
  assert.deepEqual(evaluateOrgAlerts({ orgId: "o", verdict: v, nowMs: now }), []);
  assert.equal(cachedOrgVerdict(orgBudgetPolicy(v, now), [], now).verdict, "accounting_unavailable");
});

test("#268 AC6: org week cap_approaching at 50% and cap_hit at the cap", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const verdict = (spent) => orgBudgetVerdict({ budget: { week: 10, warnFractions: [0.5] }, agentIds: ["a"], receiptsByAgent: { a: [r("1", "2026-11-17T12:00:00Z", spent)] }, nowMs: now });
  const half = evaluateOrgAlerts({ orgId: "o", verdict: verdict(5), nowMs: now }, { warnFractions: [0.5] });
  assert.deepEqual(half.map((a) => [a.kind, a.scope]), [["cap_approaching", "week"]]);
  const hit = evaluateOrgAlerts({ orgId: "o", verdict: verdict(10), nowMs: now }, { warnFractions: [0.5] });
  assert.deepEqual(hit.map((a) => [a.kind, a.key]), [["cap_hit", "cap_hit:org:o:week"]]);
  const blocked = evaluateOrgAlerts({ orgId: "o", verdict: verdict(1), blockedScopes: ["week"], nowMs: now }, { warnFractions: [0.5] });
  assert.equal(blocked[0].kind, "cap_hit");
});

test("#268 AC2: a tag week across a month boundary counts both months; month spend is this month only", () => {
  const rules = [{ key: "customer", scope: "week", usd: 10 }];
  const receipts = [
    r("1", "2026-11-30T12:00:00Z", 8, { tags: { customer: "acme" } }), // Mon, 2026-W49
    r("2", "2026-12-02T09:00:00Z", 3, { tags: { customer: "acme" } }),
    r("3", "2026-11-23T12:00:00Z", 50, { tags: { customer: "acme" } }), // previous week
    r("4", "2026-12-02T09:00:00Z", 1, { tags: { customer: "globex" } }),
  ];
  const now = Date.parse("2026-12-02T12:00:00Z");
  const p = fleetTagCapsPolicy(rules, receipts, now, undefined, null, { week: true });
  assert.deepEqual(p.spend.customer.acme, { day: 3, week: 11, month: 3, unknown: 0, unknown_week: 0 });
  const hit = cachedFleetTagVerdict(p, [], { customer: "acme" }, [], now);
  assert.deepEqual({ v: hit.verdict, scope: hit.scope, spend: hit.spend_usd, fleet: hit.fleet }, { v: "tag_budget_exceeded", scope: "week", spend: 11, fleet: true });
  assert.equal(cachedFleetTagVerdict(p, [], { customer: "globex" }, [], now), null);
  // Pending receipts from last month but this week count too.
  const p2 = fleetTagCapsPolicy(rules, receipts.slice(1, 2), now, undefined, null, { week: true });
  assert.equal(cachedFleetTagVerdict(p2, [], { customer: "acme" }, [], now), null);
  assert.equal(cachedFleetTagVerdict(p2, [], { customer: "acme" }, [receipts[0]], now).spend_usd, 11);
  // A new week drops the synced week spend.
  assert.equal(cachedFleetTagVerdict(p, [], { customer: "acme" }, [], Date.parse("2026-12-07T01:00:00Z")), null);
  // Unknown cost in the week (even last month) refuses that value only, and raises no alert.
  const unk = fleetTagCapsPolicy(rules, [r("u", "2026-11-30T12:00:00Z", null, { tags: { customer: "acme" } })], now, undefined, null, { week: true });
  assert.equal(unk.spend.customer.acme.unknown, 0);
  assert.equal(unk.spend.customer.acme.unknown_week, 1);
  assert.equal(cachedFleetTagVerdict(unk, [], { customer: "acme" }, [], now).verdict, "accounting_unavailable");
  assert.equal(cachedFleetTagVerdict(unk, [], { customer: "acme" }, [r("u2", "2026-12-01T00:00:00Z", null, { tags: { customer: "acme" } })], now).unknown_receipts, 2);
  assert.deepEqual(evaluateTagAlerts({ orgId: "o", rules, spend: unk.spend, nowMs: now }), []);
});

test("#268: a truncated week payload bounds an unlisted value by max(month, week)", () => {
  const rules = [{ key: "customer", scope: "week", usd: 5 }];
  const now = Date.parse("2026-12-02T12:00:00Z");
  const receipts = [r("1", "2026-11-30T12:00:00Z", 9, { tags: { customer: "a" } }), r("2", "2026-12-02T09:00:00Z", 6, { tags: { customer: "b" } }), r("3", "2026-11-30T09:00:00Z", 1, { tags: { customer: "c" } })];
  const p = fleetTagCapsPolicy(rules, receipts, now, 2, null, { week: true });
  assert.equal(p.truncated, true);
  assert.deepEqual(Object.keys(p.spend.customer), ["a", "b"]);
  const hit = cachedFleetTagVerdict(p, [], { customer: "zzz" }, [], now);
  assert.equal(hit.spend_usd, 6, "the unlisted value counts at the lowest listed max(month, week)");
  const allUnknown = fleetTagCapsPolicy(rules, [r("u", "2026-11-30T12:00:00Z", null, { tags: { customer: "a" } }), r("v", "2026-11-30T12:00:00Z", 1, { tags: { customer: "b" } })], now, 1, null, { week: true });
  assert.equal(cachedFleetTagVerdict(allUnknown, [], { customer: "zzz" }, [], now).verdict, "accounting_unavailable");
});

test("#268 AC6: tag week rule alerts per value at 50% and at the cap", () => {
  const rules = [{ key: "customer", scope: "week", usd: 10, warnFractions: [0.5] }];
  const now = Date.parse("2026-12-02T12:00:00Z");
  const spend = fleetTagCapsPolicy(rules, [r("1", "2026-11-30T12:00:00Z", 5, { tags: { customer: "acme" } }), r("2", "2026-12-01T12:00:00Z", 10, { tags: { customer: "globex" } })], now, Infinity, null, { week: true }).spend;
  const out = evaluateTagAlerts({ orgId: "o", rules, spend, nowMs: now });
  assert.deepEqual(out.map((a) => [a.kind, a.tag.value, a.scope]), [["cap_approaching", "acme", "week"], ["cap_hit", "globex", "week"]]);
  assert.ok(!out.some((a) => a.kind === "cap_projected"), "no cap_projected for weeks");
});

test("#268 AC4: tag week validation, duplicate rule and the wire payload split", () => {
  assert.deepEqual(parseFleetTagCaps([{ key: "customer", scope: "week", usd: 5 }]), { rules: [{ key: "customer", scope: "week", usd: 5 }] });
  for (const usd of [0, -1, "5"]) assert.ok(parseFleetTagCaps([{ key: "customer", scope: "week", usd }]).error);
  assert.equal(parseFleetTagCaps([{ key: "customer", scope: "week", usd: 1 }, { key: "customer", scope: "week", usd: 2 }]).error, "Duplicate rule customer:week");
  const now = Date.parse("2026-12-02T12:00:00Z");
  const onlyWeek = fleetTagCapsPayload([{ key: "customer", scope: "week", usd: 5 }], [], now);
  assert.equal(onlyWeek.tag_caps, null);
  assert.equal(onlyWeek.tag_caps_v2.rules.length, 1);
  const noWeek = fleetTagCapsPayload([{ key: "customer", scope: "day", usd: 5 }], [], now);
  assert.equal(noWeek.tag_caps_v2, null);
  assert.equal(noWeek.tag_caps.rules.length, 1);
  assert.deepEqual(fleetTagCapsPayload(null, [], now), { tag_caps: null, tag_caps_v2: null });
  assert.equal(validFleetTagCaps({ ...onlyWeek.tag_caps_v2, spend: { customer: { a: { day: 0, month: 0, unknown: 0, week: -1 } } } }), false);
  assert.equal(validFleetTagCaps({ ...onlyWeek.tag_caps_v2, spend: { customer: { a: { day: 0, month: 0, unknown: 0, unknown_week: 0.5 } } } }), false);
});

test("#268 AC3: hosted model week rules; the local --model-cap flag still rejects week", () => {
  assert.equal(modelCapsError([{ model: "gpt-4o", scope: "week", usd: 50 }]), null);
  for (const usd of [0, -1, "5"]) assert.ok(modelCapsError([{ model: "gpt-4o", scope: "week", usd }]));
  assert.ok(modelCapsError([{ model: "gpt-4o", scope: "week", usd: 1 }, { model: "gpt-4o", scope: "week", usd: 2 }]));
  assert.throws(() => parseModelCap("claude-opus-4-8:week=5"), (e) => e.code === "invalid_model_cap");
  const rules = [{ model: "claude-opus-4-8", scope: "week", usd: 5 }, { model: "gpt-4o", scope: "day", usd: 1 }];
  assert.deepEqual(splitWeekModelCaps(rules), { legacy: [rules[1]], week: [rules[0]] });
  assert.deepEqual(splitWeekModelCaps(undefined), { legacy: [], week: [] });
  assert.deepEqual(fleetModelRules(rules), [rules[1]], "the local fallback engine never gets week rules");
  assert.equal(validWeekModelCaps(null), true);
  assert.equal(validWeekModelCaps([rules[0]]), true);
  for (const bad of ["x", [rules[1]], [{ ...rules[0], usd: 0 }], [{ ...rules[0], model: "" }], [null]]) assert.equal(validWeekModelCaps(bad), false);
  const now = Date.parse("2026-12-02T12:00:00Z");
  const receipts = [r("1", "2026-11-30T12:00:00Z", 3, { model: "claude-opus-4-8" }), r("2", "2026-12-01T12:00:00Z", 2, { model: "anthropic/claude-opus-4.8" }), r("3", "2026-12-01T12:00:00Z", 9, { model: "gpt-4o-mini" })];
  const models = modelSpendPolicy(receipts, rules, now);
  assert.deepEqual(models["claude-opus-4-8"], { day: 0, week: 5, month: 2, unknown: 0, unknown_week: 0 });
  assert.equal(validModelSpend(models), true);
  assert.equal(validModelSpend({ x: { day: 0, month: 0, unknown: 0, week: -1 } }), false);
  assert.equal(validModelSpend({ x: { day: 0, month: 0, unknown: 0, unknown_week: 1.5 } }), false);
  const spend = { as_of: new Date(now).toISOString(), models };
  const hit = cachedFleetModelVerdict(spend, rules, ["claude-opus-4-8"], [], now);
  assert.deepEqual({ scope: hit.scope, fleet: hit.fleet, spend: hit.spend_usd }, { scope: "week", fleet: true, spend: 5 });
  assert.equal(cachedFleetModelVerdict(spend, rules, ["gpt-4o-mini"], [], now), null);
  assert.deepEqual(modelCapStatus(receipts, rules, now)[0], { model: "claude-opus-4-8", scope: "week", usd: 5, spent: 5, unknown: 0 });
  // Unknown cost inside the week (last month) refuses that model only and raises no spend alert.
  const unk = modelSpendPolicy([r("u", "2026-11-30T12:00:00Z", null, { model: "claude-opus-4-8" })], rules, now);
  const v = cachedFleetModelVerdict({ as_of: spend.as_of, models: unk }, rules, ["claude-opus-4-8"], [], now);
  assert.equal(v.verdict, "accounting_unavailable");
  assert.equal(cachedFleetModelVerdict({ as_of: spend.as_of, models: {} }, rules, ["claude-opus-4-8"], [r("u2", "2026-11-30T13:00:00Z", null, { model: "claude-opus-4-8" })], now).verdict, "accounting_unavailable");
  assert.equal(modelCapStatus([r("u", "2026-11-30T12:00:00Z", null, { model: "claude-opus-4-8" })], rules, now)[0].spent, null);
  assert.deepEqual(evaluateModelAlerts({ agentId: "a", rules, spend: unk }), []);
  // AC6: 50% then the cap.
  const warn = evaluateModelAlerts({ agentId: "a", rules: [rules[0]], spend: { "claude-opus-4-8": { day: 0, week: 2.5, month: 0, unknown: 0, unknown_week: 0 } } }, { warnFractions: [0.5] });
  assert.deepEqual(warn.map((a) => [a.kind, a.scope]), [["cap_approaching", "week"]]);
  assert.equal(evaluateModelAlerts({ agentId: "a", rules: [rules[0]], spend: models })[0].kind, "cap_hit");
});

test("#268 AC5: a week-capped /v1/policy passes the frozen 20dfc3a checks; an old response still works", () => {
  const now = Date.parse("2026-12-02T12:00:00Z");
  const v = orgBudgetVerdict({ budget: { day: 100, week: 10 }, agentIds: ["a"], receiptsByAgent: { a: [r("1", "2026-11-30T12:00:00Z", 12)] }, nowMs: now });
  const full = orgBudgetPolicy(v, now);
  const legacy = legacyOrgBudgetPolicy(full);
  assert.deepEqual(legacy.caps, { day: 100 });
  assert.equal(legacy.verdict, "ok", "a week hit is not reported as a day/month refusal to an old wrapper");
  assert.equal(frozen.validOrgBudgetPolicy(legacy), true);
  assert.equal(frozen.validOrgBudgetPolicy(legacyOrgBudgetPolicy(orgBudgetPolicy(orgBudgetVerdict({ budget: { week: 10 }, agentIds: [], receiptsByAgent: {}, nowMs: now }), now))), true);
  assert.equal(weekOrgBudgetPolicy(full), full);
  assert.equal(weekOrgBudgetPolicy(orgBudgetPolicy(orgBudgetVerdict({ budget: { day: 1 }, agentIds: [], receiptsByAgent: {}, nowMs: now }), now)), null);
  assert.equal(validOrgBudgetPolicy(full), true);
  assert.equal(validOrgBudgetPolicy({ ...full, caps: { week: -1 } }), false);
  const tags = fleetTagCapsPayload([{ key: "customer", scope: "week", usd: 5 }, { key: "customer", scope: "day", usd: 5 }], [r("1", "2026-12-02T09:00:00Z", 1, { tags: { customer: "acme" } })], now);
  assert.equal(frozen.validFleetTagCaps(tags.tag_caps), true);
  assert.equal(frozen.validFleetTagCaps(tags.tag_caps_v2), false, "this is why week rules need their own field");
  assert.equal(validFleetTagCaps(tags.tag_caps_v2), true);
  const models = modelSpendPolicy([r("1", "2026-12-02T09:00:00Z", 1, { model: "gpt-4o" })], [{ model: "gpt-4o", scope: "week", usd: 5 }], now);
  assert.equal(frozen.validModelSpend(models), true);
  const split = splitWeekModelCaps([{ model: "gpt-4o", scope: "week", usd: 5 }, { model: "gpt-4o", scope: "day", usd: 5 }]);
  assert.deepEqual(frozen.validatePolicy({ version: 2, caps: {}, killed: false, modelCaps: split.legacy, model_caps_week: split.week }), []);
  assert.equal(frozen.validatePolicy({ version: 2, caps: {}, killed: false, modelCaps: [...split.legacy, ...split.week] }).length, 1);
  // A 20dfc3a-shaped (no week fields) response: day/month enforced unchanged by the new code.
  const old = { caps: { day: 1 }, spend: { day_usd: 1, month_usd: 1, unknown_count: 0 }, verdict: "budget_exceeded", as_of: new Date(now).toISOString() };
  assert.equal(validOrgBudgetPolicy(old), true);
  assert.equal(cachedOrgVerdict(old, [], now).scope, "org:day");
  const oldTags = { rules: [{ key: "customer", scope: "day", usd: 1 }], spend: { customer: { acme: { day: 1, month: 1, unknown: 0 } } }, truncated: false, as_of: new Date(now).toISOString() };
  assert.equal(validFleetTagCaps(oldTags), true);
  assert.equal(cachedFleetTagVerdict(oldTags, [], { customer: "acme" }, [], now).scope, "day");
  const oldModels = { as_of: new Date(now).toISOString(), models: { "gpt-4o": { day: 1, month: 1, unknown: 0 } } };
  assert.equal(validModelSpend(oldModels.models), true);
  assert.equal(cachedFleetModelVerdict(oldModels, [{ model: "gpt-4o", scope: "day", usd: 1 }], ["gpt-4o"], [], now).scope, "day");
});
