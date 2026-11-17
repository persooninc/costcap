// Issue #286: lifetime "total" caps for the org budget, fleet tag caps and hosted
// model caps. Unit checks of each pure module, the wire compatibility with a
// b91f36e wrapper, and one hosted integration run (API, policy, alerts, retention).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOrgBudget, orgBudgetVerdict, orgBudgetPolicy, legacyOrgBudgetPolicy, weekOrgBudgetPolicy, totalOrgBudgetPolicy, validOrgTotalPolicy, cachedOrgTotalVerdict, lifetimeSpend } from "../src/hosted/org-budget.js";
import { parseFleetTagCaps, fleetTagCapsPayload, fleetTagTotalPolicy, validFleetTagTotal, cachedFleetTagTotalVerdict } from "../src/hosted/tag-caps.js";
import { modelSpendPolicy, splitWeekModelCaps, validTotalModelCaps, validModelSpend, cachedFleetModelTotalVerdict, modelCapStatus } from "../src/hosted/model-caps.js";
import { modelCapsError, modelBudgetExceededBody, parseModelCap } from "../src/model-cap.js";
import { tagBudgetExceededBody, parseTagCaps } from "../src/tag-cap.js";
import { evaluateOrgAlerts, evaluateTagAlerts, evaluateModelAlerts } from "../src/hosted/alerts.js";
import { totalCapKeep, expiredReceiptKeys } from "../src/hosted/retention.js";
import { createHostedServer } from "../src/hosted/server.js";
import * as old from "./fixtures/validators-b91f36e.js";

const ms = (iso) => Date.parse(iso);
const NOV = ms("2026-11-16T12:00:00Z");
const DEC = ms("2026-12-02T12:00:00Z");
const rc = (id, ts, cost_usd, extra = {}) => ({ id, ts, cost_usd, ...extra });

test("#286 AC1: total validates for the org budget, fleet tag rules and hosted model caps", () => {
  assert.deepEqual(parseOrgBudget({ total: 5000 }), { total: 5000 });
  assert.deepEqual(parseOrgBudget({ day: 10 }, { total: 5000 }), { day: 10, total: 5000 });
  assert.equal(parseOrgBudget({ total: null }, { total: 5000 }), null);
  for (const bad of [0, -1, "5", Infinity]) assert.throws(() => parseOrgBudget({ total: bad }), /total cap must be a positive number/, String(bad));
  const both = parseFleetTagCaps([{ key: "customer", scope: "total", usd: 500 }, { key: "customer", scope: "day", usd: 5 }], { total: true });
  assert.equal(both.rules.length, 2);
  assert.match(parseFleetTagCaps([{ key: "customer", scope: "total", usd: 500 }]).error, /day, week or month/, "the wire validator never accepts total");
  for (const usd of [0, -2, "1"]) assert.ok(parseFleetTagCaps([{ key: "customer", scope: "total", usd }], { total: true }).error);
  assert.equal(modelCapsError([{ model: "gpt-6", scope: "total", usd: 20 }]), null);
  assert.ok(modelCapsError([{ model: "gpt-6", scope: "total", usd: 0 }]));
  // Local flags keep rejecting total (Out).
  assert.throws(() => parseModelCap("gpt-6:total=20"));
  assert.throws(() => parseTagCaps(["customer:total=5"]));
});

test("#286 AC2: tag total across months, unsynced spend, never-resets refusal, other values pass", () => {
  const rules = [{ key: "customer", scope: "total", usd: 500 }, { key: "customer", scope: "day", usd: 1000 }];
  const receipts = [
    rc("s", "2026-09-10T00:00:00Z", 300, { tags: { customer: "acme" } }),
    rc("o", "2026-10-10T00:00:00Z", 150, { tags: { customer: "acme" } }),
    rc("b", "2026-10-11T00:00:00Z", 5, { tags: { customer: "beta" } }),
    rc("x", "2026-10-11T00:00:00Z", 99, { tags: { customer: "acme" }, blocked: true }),
  ];
  const payload = fleetTagCapsPayload(rules, receipts, NOV);
  assert.deepEqual(payload.tag_caps.rules.map((r) => r.scope), ["day"], "old block keeps day/month only");
  const tot = payload.tag_caps_total;
  assert.ok(validFleetTagTotal(tot));
  assert.deepEqual(tot.spend.customer.acme, { total: 450, unknown: 0 });
  const pending = [rc("p1", "2026-11-16T10:00:00Z", 40, { tags: { customer: "acme" } })];
  assert.equal(cachedFleetTagTotalVerdict(tot, { customer: "acme" }, pending), null);
  pending.push(rc("p2", "2026-11-16T11:00:00Z", 15, { tags: { customer: "acme" } }));
  const hit = cachedFleetTagTotalVerdict(tot, { customer: "acme" }, pending);
  assert.deepEqual([hit.verdict, hit.scope, hit.spend_usd, hit.cap_usd, hit.retry_after_s], ["tag_budget_exceeded", "total", 505, 500, undefined]);
  assert.match(tagBudgetExceededBody(hit).message, /does not reset; raise the cap/);
  assert.equal(cachedFleetTagTotalVerdict(tot, { customer: "beta" }, pending), null);
  // December: same lifetime spend, still refused.
  assert.equal(cachedFleetTagTotalVerdict(fleetTagTotalPolicy(rules, receipts, DEC), { customer: "acme" }, pending).scope, "total");
  assert.equal(cachedFleetTagTotalVerdict(null, { customer: "acme" }, pending), null);
  // Truncation: an unlisted value is bounded by the lowest listed known total.
  const many = fleetTagTotalPolicy(rules, [...receipts, rc("c", "2026-10-01T00:00:00Z", 1, { tags: { customer: "gamma" } })], NOV, 2);
  assert.equal(many.truncated, true);
  assert.deepEqual(Object.keys(many.spend.customer), ["acme", "beta"]);
  assert.equal(cachedFleetTagTotalVerdict({ ...many, rules: [{ key: "customer", scope: "total", usd: 5 }] }, { customer: "zeta" }, []).spend_usd, 5);
  const allUnknown = fleetTagTotalPolicy(rules, [rc("u", "2026-10-01T00:00:00Z", null, { tags: { customer: "u" } }), rc("v", "2026-10-01T00:00:00Z", null, { tags: { customer: "v" } })], NOV, 1);
  assert.equal(cachedFleetTagTotalVerdict(allUnknown, { customer: "zeta" }, []).verdict, "accounting_unavailable");
  assert.equal(cachedFleetTagTotalVerdict({ ...allUnknown, truncated: false }, { customer: "zeta" }, []), null);
  for (const bad of [{ ...tot, rules: [{ key: "customer", scope: "day", usd: 1 }] }, { ...tot, truncated: "no" }, { ...tot, spend: { customer: { a: { total: -1, unknown: 0 } } } }, { ...tot, spend: { customer: null } }, { ...tot, spend: null }]) assert.equal(validFleetTagTotal(bad), false);
});

test("#286 AC3: org total over two months incl. a revoked agent; model total refuses one model only", () => {
  const receiptsByAgent = { live: [rc("1", "2026-10-03T00:00:00Z", 600)], revoked: [rc("2", "2026-11-02T00:00:00Z", 400)] };
  const v = orgBudgetVerdict({ budget: { total: 1000 }, agentIds: ["live", "revoked"], receiptsByAgent, nowMs: NOV });
  assert.deepEqual([v.spend.total_usd, v.verdict, v.scope, v.cap_usd], [1000, "budget_exceeded", "org:total", 1000]);
  assert.equal(orgBudgetPolicy(v, NOV), null, "a total-only budget sends no org_budget block");
  const t = totalOrgBudgetPolicy(v, NOV);
  assert.ok(validOrgTotalPolicy(t));
  const hit = cachedOrgTotalVerdict(t, []);
  assert.deepEqual([hit.verdict, hit.scope, hit.retry_after_s], ["budget_exceeded", "org:total", undefined]);
  assert.match(hit.message, /does not reset/);
  assert.equal(cachedOrgTotalVerdict({ ...t, spend_usd: 999 }, []), null);
  assert.equal(cachedOrgTotalVerdict({ ...t, spend_usd: 999 }, [rc("p", "2026-11-16T00:00:00Z", 1)]).scope, "org:total");
  for (const bad of [{ ...t, cap: 0 }, { ...t, spend_usd: -1 }, { ...t, unknown_count: 1.5 }, { ...t, as_of: "x" }, "x"]) assert.equal(validOrgTotalPolicy(bad), false);
  // With a month cap too: the old blocks keep the month verdict, ignoring the total hit.
  const mixed = orgBudgetVerdict({ budget: { month: 5000, total: 1000 }, agentIds: ["live", "revoked"], receiptsByAgent, nowMs: NOV });
  const legacy = legacyOrgBudgetPolicy(orgBudgetPolicy(mixed, NOV));
  assert.deepEqual([legacy.caps, legacy.verdict], [{ month: 5000 }, "ok"]);
  assert.ok(old.validOrgBudgetPolicy(legacy));
  assert.equal(weekOrgBudgetPolicy(orgBudgetPolicy(mixed, NOV)), null);
  // Model total.
  const rules = [{ model: "gpt-6", scope: "total", usd: 20 }, { model: "gpt-4o", scope: "day", usd: 50 }];
  const receipts = [rc("a", "2026-10-02T00:00:00Z", 12, { model: "gpt-6" }), rc("b", "2026-11-02T00:00:00Z", 8, { model: "gpt-6" }), rc("c", "2026-11-16T00:00:00Z", 3, { model: "gpt-4o" })];
  const spend = modelSpendPolicy(receipts, rules, NOV);
  assert.deepEqual([spend["gpt-6"].total, spend["gpt-6"].month, spend["gpt-4o"].total], [20, 8, undefined]);
  assert.ok(validModelSpend(spend) && old.validModelSpend(spend));
  const split = splitWeekModelCaps(rules);
  assert.deepEqual(split.total, [rules[0]]);
  assert.ok(validTotalModelCaps(split.total) && !validTotalModelCaps([rules[1]]) && !validTotalModelCaps([]));
  const as = { as_of: new Date(NOV).toISOString(), models: spend };
  const mh = cachedFleetModelTotalVerdict(as, split.total, ["gpt-6"], []);
  assert.deepEqual([mh.scope, mh.spend_usd, mh.cap_usd], ["total", 20, 20]);
  assert.match(modelBudgetExceededBody(mh).message, /does not reset/);
  assert.equal(cachedFleetModelTotalVerdict(as, split.total, ["gpt-4o"], []), null);
  assert.equal(cachedFleetModelTotalVerdict({ ...as, models: { "gpt-6": { day: 0, month: 0, unknown: 0 } } }, split.total, ["gpt-6"], []).verdict, "accounting_unavailable", "no lifetime spend from server: never $0");
  assert.deepEqual(modelCapStatus(receipts, rules, NOV).map((r) => r.spent), [20, 3]);
});

test("#286 AC4: unknown cost in the capped history makes only that verdict accounting_unavailable", () => {
  const rules = [{ key: "customer", scope: "total", usd: 500 }];
  const unk = rc("u", "2026-08-10T00:00:00Z", null, { tags: { customer: "acme" } });
  const tot = fleetTagTotalPolicy(rules, [unk, rc("b", "2026-10-01T00:00:00Z", 1, { tags: { customer: "beta" } })], NOV);
  assert.equal(cachedFleetTagTotalVerdict(tot, { customer: "acme" }, []).verdict, "accounting_unavailable");
  assert.equal(cachedFleetTagTotalVerdict(tot, { customer: "beta" }, []), null);
  assert.equal(cachedFleetTagTotalVerdict(tot, { customer: "beta" }, [rc("p", "2026-11-16T00:00:00Z", null, { tags: { customer: "beta" } })]).verdict, "accounting_unavailable");
  const settled = fleetTagTotalPolicy(rules, [{ ...unk, cost_usd: 2 }], NOV);
  assert.deepEqual(settled.spend.customer.acme, { total: 2, unknown: 0 });
  // No total rule: the old receipt changes nothing.
  assert.equal(fleetTagCapsPayload([{ key: "customer", scope: "month", usd: 5 }], [unk], NOV).tag_caps.spend.customer.acme, undefined);
  // Org and model totals.
  const ov = orgBudgetVerdict({ budget: { total: 100, month: 1000 }, agentIds: ["a"], receiptsByAgent: { a: [rc("u", "2026-07-01T00:00:00Z", null)] }, nowMs: NOV });
  assert.deepEqual([ov.verdict, ov.scope, ov.spend.unknown_count], ["accounting_unavailable", "org:total", 0]);
  assert.equal(orgBudgetPolicy(ov, NOV).verdict, "ok", "the month block is not paused by an old receipt");
  assert.equal(cachedOrgTotalVerdict(totalOrgBudgetPolicy(ov, NOV), []).verdict, "accounting_unavailable");
  assert.equal(orgBudgetVerdict({ budget: { month: 1000 }, agentIds: ["a"], receiptsByAgent: { a: [rc("u", "2026-07-01T00:00:00Z", null)] }, nowMs: NOV }).verdict, "ok");
  const ms6 = modelSpendPolicy([rc("u", "2026-07-01T00:00:00Z", null, { model: "gpt-6" })], [{ model: "gpt-6", scope: "total", usd: 5 }], NOV);
  assert.equal(cachedFleetModelTotalVerdict({ models: ms6 }, [{ model: "gpt-6", scope: "total", usd: 5 }], ["gpt-6"], []).verdict, "accounting_unavailable");
  assert.deepEqual(lifetimeSpend([rc("b", "2026-01-01T00:00:00Z", null, { reason: "batch_pending" }), rc("z", "bad", 1), null]), { usd: 0, unknown: 0, pending: 1 });
});

test("#286 AC5 (pure): total alerts for org, tag values and models; unknown raises none", () => {
  const verdict = { caps: { total: 100 }, spend: { day_usd: 0, week_usd: 0, month_usd: 0, total_usd: 85, unknown_count: 0 }, verdict: "ok" };
  assert.deepEqual(evaluateOrgAlerts({ orgId: "o", verdict, nowMs: NOV }, { warnFractions: [0.8] }).map((a) => [a.kind, a.scope]), [["cap_approaching", "total"]]);
  assert.deepEqual(evaluateOrgAlerts({ orgId: "o", verdict: { ...verdict, spend: { ...verdict.spend, total_usd: 100 } }, nowMs: NOV }).map((a) => a.kind), ["cap_hit"]);
  const rules = [{ key: "customer", scope: "total", usd: 500 }];
  const tag = evaluateTagAlerts({ orgId: "o", rules, spend: { customer: { acme: { day: 0, month: 0, unknown: 0, total: 500, unknown_total: 0 }, beta: { day: 0, month: 0, unknown: 0, total: 1, unknown_total: 2 } } }, nowMs: NOV });
  assert.deepEqual(tag.map((a) => [a.kind, a.tag.value, a.scope]), [["cap_hit", "acme", "total"]]);
  const model = evaluateModelAlerts({ agentId: "a", rules: [{ model: "gpt-6", scope: "total", usd: 20 }], spend: { "gpt-6": { day: 0, month: 0, unknown: 0, total: 17, unknown_total: 0 } } }, { warnFractions: [0.8] });
  assert.deepEqual(model.map((a) => [a.kind, a.scope]), [["cap_approaching", "total"]]);
});

test("#286 AC6 (pure): retention keeps what counts toward a total; old payloads are byte-identical", () => {
  const items = {
    k1: { orgId: "o", agentId: "a", receipt: rc("1", "2026-08-01T00:00:00Z", 1, { model: "gpt-6", tags: { customer: "acme" } }) },
    k2: { orgId: "o", agentId: "b", receipt: rc("2", "2026-08-01T00:00:00Z", 1, { model: "gpt-4o" }) },
  };
  const cutoff = NOV - 30 * 86_400_000, floor = NOV - 32 * 86_400_000;
  const agents = [{ id: "a", orgId: "o", policy: { modelCaps: [{ model: "gpt-6", scope: "total", usd: 5 }] } }, { id: "b", orgId: "o", policy: {} }];
  assert.deepEqual(expiredReceiptKeys(items, "o", cutoff, floor, totalCapKeep({ agents, teams: [], org: {}, orgId: "o" })), ["k2"]);
  assert.deepEqual(expiredReceiptKeys(items, "o", cutoff, floor, totalCapKeep({ agents, teams: [], org: { tagCaps: [{ key: "customer", scope: "total", usd: 1 }] }, orgId: "o" })), []);
  assert.deepEqual(expiredReceiptKeys(items, "o", cutoff, floor, totalCapKeep({ agents, teams: [], org: { orgBudget: { total: 9 } }, orgId: "o" })), []);
  assert.deepEqual(expiredReceiptKeys(items, "o", cutoff, floor, totalCapKeep({ agents: [], teams: [], org: { tagCaps: [{ key: "customer", scope: "day", usd: 1 }] }, orgId: "o" })), ["k1", "k2"]);
  assert.deepEqual(expiredReceiptKeys(items, "o", cutoff, floor, new Set(["a"])), ["k2"], "a Set of agent ids still works");
  // No total rules: the payload has exactly the pre-#286 keys.
  assert.deepEqual(Object.keys(fleetTagCapsPayload([{ key: "customer", scope: "week", usd: 5 }], [], NOV)), ["tag_caps", "tag_caps_v2"]);
  const withTotal = fleetTagCapsPayload([{ key: "customer", scope: "week", usd: 5 }, { key: "customer", scope: "total", usd: 5 }], [], NOV);
  assert.ok(old.validFleetTagCaps(withTotal.tag_caps) && old.validFleetTagCaps(withTotal.tag_caps_v2));
  assert.deepEqual(withTotal.tag_caps_v2.rules.map((r) => r.scope), ["week"]);
  assert.equal("total" in modelSpendPolicy([], [{ model: "gpt-6", scope: "day", usd: 5 }], NOV)["gpt-6"], false);
});

// ---- Hosted integration.
async function fixture(t, clock) {
  const codes = {}, delivered = [];
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-286-")), "store.json");
  const origin = "http://localhost";
  const service = createHostedServer({ storePath, origin, secureCookies: false, stripeEnv: {}, now: () => clock.now, verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = () => `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, auth, method) => {
    const r = await fetch(`${base()}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), text: JSON.stringify(await Promise.resolve(null)) };
  };
  const raw = async (path, auth) => (await fetch(`${base()}${path}`, { headers: { origin, authorization: `Bearer ${auth}` } })).text();
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    const r = await fetch(`${base()}/auth/verify`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code: codes[email] }) });
    return r.headers.get("set-cookie").split(";")[0];
  };
  return { request, raw, login, delivered, service };
}

test("#286 hosted: org, tag and model totals through the API, /v1/policy, alerts, retention and audit", async (t) => {
  const clock = { now: ms("2026-09-10T12:00:00Z") };
  const f = await fixture(t, clock);
  let owner = await f.login("t286-owner@example.invalid");
  const enroll = async (name) => (await f.request("/v1/enroll", { name }, null, (await f.request("/v1/enrollment-tokens", { caps: { month: 10000 } }, owner)).body.token)).body;
  const a = await enroll("a-bot");
  const b = await enroll("b-bot");
  // Pre-#286 /v1/policy with a day tag cap and no totals, for the byte-identical check.
  assert.equal((await f.request("/v1/tag-caps", { tagCaps: [{ key: "customer", scope: "day", usd: 1000 }] }, owner, null, "PUT")).status, 200);
  const before = await f.raw("/v1/policy", a.token);
  assert.equal(/_total"/.test(before), false);
  // AC1: validation, viewer, audit.
  assert.equal((await f.request("/v1/invitations", { email: "t286-viewer@example.invalid", role: "viewer" }, owner)).status, 201);
  const viewer = await f.login("t286-viewer@example.invalid");
  assert.equal((await f.request("/v1/org-budget", { total: 1000 }, viewer, null, "PUT")).status, 403);
  for (const bad of [0, -5, "x"]) assert.equal((await f.request("/v1/org-budget", { total: bad }, owner, null, "PUT")).status, 400);
  assert.equal((await f.request("/v1/tag-caps", { tagCaps: [{ key: "customer", scope: "total", usd: 0 }] }, owner, null, "PUT")).status, 400);
  assert.equal((await f.request(`/v1/agents/${a.agentId}/policy`, { caps: { month: 10000 }, modelCaps: [{ model: "gpt-6", scope: "total", usd: -1 }] }, owner)).status, 400);
  assert.deepEqual((await f.request("/v1/org-budget", { total: 1000, warnFractions: [0.8] }, owner, null, "PUT")).body.org_budget.caps, { total: 1000 });
  const rules = [{ key: "customer", scope: "day", usd: 1000 }, { key: "customer", scope: "total", usd: 500, warnFractions: [0.8] }];
  assert.equal((await f.request("/v1/tag-caps", { tagCaps: rules }, owner, null, "PUT")).status, 200);
  assert.deepEqual((await f.request("/v1/tag-caps", undefined, viewer)).body.tagCaps, rules);
  assert.equal((await f.request(`/v1/agents/${a.agentId}/policy`, { caps: { month: 10000 }, warnFractions: [0.8], modelCaps: [{ model: "gpt-6", scope: "total", usd: 20 }] }, owner)).status, 200);
  const audit = (await f.request("/v1/evidence.json", undefined, owner)).body.audit;
  assert.deepEqual(audit.filter((e) => e.action === "org_budget.change").at(-1).detail.after, { total: 1000, warnFractions: [0.8] });
  assert.deepEqual(audit.filter((e) => e.action === "tag_caps.change").at(-1).detail.next, rules);
  // September and October receipts (b is revoked later; its spend still counts).
  await f.request("/v1/receipts", { receipts: [rc("s1", "2026-09-10T11:00:00Z", 300, { tags: { customer: "acme" } })] }, null, a.token);
  clock.now = ms("2026-10-15T12:00:00Z");
  await f.request("/v1/receipts", { receipts: [rc("o1", "2026-10-15T11:00:00Z", 150, { tags: { customer: "acme" } }), rc("o2", "2026-10-15T11:00:00Z", 12, { model: "gpt-6" })] }, null, a.token);
  await f.request("/v1/receipts", { receipts: [rc("o3", "2026-10-15T11:00:00Z", 400)] }, null, b.token);
  clock.now = NOV;
  owner = await f.login("t286-owner@example.invalid");
  assert.equal((await f.request(`/v1/agents/${b.agentId}/revoke`, {}, owner)).status, 200);
  await f.request("/v1/receipts", { receipts: [rc("n1", "2026-11-16T11:00:00Z", 8, { model: "gpt-6" })] }, null, a.token);
  // /v1/policy: additive fields, accepted by the b91f36e validators.
  const pol = (await f.request("/v1/policy", undefined, null, a.token)).body;
  assert.equal(pol.modelCaps, undefined);
  assert.deepEqual(pol.model_caps_total, [{ model: "gpt-6", scope: "total", usd: 20 }]);
  assert.deepEqual([pol.agent_spend.models["gpt-6"].total, pol.agent_spend.models["gpt-6"].month], [20, 8]);
  assert.deepEqual(pol.tag_caps_total.spend.customer.acme, { total: 450, unknown: 0 });
  assert.deepEqual(pol.tag_caps.rules, [rules[0]]);
  assert.deepEqual([pol.org_budget, pol.org_budget_total.cap, pol.org_budget_total.spend_usd], [null, 1000, 870]);
  const { team: _t, agent_spend: _s, settlements: _x, tag_caps: tc, tag_caps_v2: tc2, org_budget: ob, org_budget_v2: ob2, model_caps_week: _w, budget_period: _b, ...policyOnly } = pol;
  assert.deepEqual(old.validatePolicy(Object.fromEntries(Object.entries(policyOnly).filter(([k]) => !k.endsWith("_total")))), []);
  assert.ok(old.validFleetTagCaps(tc) && old.validFleetTagCaps(tc2) && old.validOrgBudgetPolicy(ob) && old.validOrgBudgetPolicy(ob2) && old.validModelSpend(pol.agent_spend.models));
  // Wrapper refusals: model total (other models pass) and tag total after $40 + $15 unsynced.
  assert.equal(cachedFleetModelTotalVerdict(pol.agent_spend, pol.model_caps_total, ["gpt-6"], []).scope, "total");
  assert.equal(cachedFleetModelTotalVerdict(pol.agent_spend, pol.model_caps_total, ["gpt-4o"], []), null);
  const p = [rc("p1", "2026-11-16T11:10:00Z", 40, { tags: { customer: "acme" } })];
  assert.equal(cachedFleetTagTotalVerdict(pol.tag_caps_total, { customer: "acme" }, p), null);
  assert.equal(cachedFleetTagTotalVerdict(pol.tag_caps_total, { customer: "acme" }, [...p, rc("p2", "2026-11-16T11:20:00Z", 15, { tags: { customer: "acme" } })]).scope, "total");
  // Alerts: org at 87% approaching, acme at 90% approaching, gpt-6 hit.
  await f.service.evaluateFleetAlerts();
  await f.service.evaluateFleetAlerts();
  const totals = () => f.delivered.filter((x) => x.scope === "total" && x.tag?.value !== "(untagged)").map((x) => `${x.kind}:${x.org ? "org" : x.tag ? x.tag.value : x.model}`).sort();
  assert.deepEqual(totals(), ["cap_approaching:acme", "cap_approaching:org", "cap_hit:gpt-6"]);
  await f.request("/v1/receipts", { receipts: [rc("n2", "2026-11-16T11:30:00Z", 130, { tags: { customer: "acme" } })] }, null, a.token);
  const ob1 = (await f.request("/v1/org-budget", undefined, owner)).body.org_budget;
  assert.deepEqual([ob1.spend.total_usd, ob1.verdict, ob1.scope], [1000, "budget_exceeded", "org:total"]);
  await f.service.evaluateFleetAlerts();
  assert.deepEqual(totals(), ["cap_approaching:acme", "cap_approaching:org", "cap_hit:acme", "cap_hit:gpt-6", "cap_hit:org"]);
  // December: still over, no re-fire.
  clock.now = DEC;
  owner = await f.login("t286-owner@example.invalid");
  await f.service.evaluateFleetAlerts();
  assert.equal(totals().length, 5);
  assert.equal((await f.request("/v1/org-budget", undefined, owner)).body.org_budget.scope, "org:total");
  // Retention: 30 days with totals keeps everything; removing them frees the old receipts.
  assert.equal((await f.request("/v1/retention", { days: 30 }, owner)).status, 200);
  assert.equal((await f.request("/v1/retention", undefined, owner)).body.eligible_count, 0);
  // Raise above spend: alerts resolve.
  assert.equal((await f.request("/v1/org-budget", { total: 5000 }, owner, null, "PUT")).status, 200);
  assert.equal((await f.request("/v1/tag-caps", { tagCaps: [rules[0]] }, owner, null, "PUT")).status, 200);
  assert.equal((await f.request(`/v1/agents/${a.agentId}/policy`, { caps: { month: 10000 }, modelCaps: null }, owner)).status, 200);
  await f.service.evaluateFleetAlerts();
  const list = (await f.request("/v1/alerts?status=all", undefined, owner)).body;
  const active = (list.alerts ?? list).filter((x) => x.scope === "total" && x.active);
  assert.deepEqual(active, []);
  assert.equal((await f.request("/v1/org-budget", { total: null }, owner, null, "PUT")).status, 200);
  assert.ok((await f.request("/v1/retention", undefined, owner)).body.eligible_count >= 3);
  // Back to no totals: /v1/policy has no total fields.
  assert.equal(/_total"/.test(await f.raw("/v1/policy", a.token)), false);
});
