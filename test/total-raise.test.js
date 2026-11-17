// #287: time-boxed raises for lifetime (total) caps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePolicy, resolvePolicy, splitTotalRaise, splitWeekRaise, raiseTotalError, effectiveCaps, nextRaiseExpiry, LEGACY_RAISE_KEYS } from "../src/hosted/policy.js";
import { validatePolicy as b91ValidatePolicy } from "./fixtures/policy-b91f36e.js";
import { validatePolicy as v201ValidatePolicy } from "./fixtures/policy-20194db.js";
import { parseCapRequest, createCapRequest, approveCapRequest, expireRaises } from "../src/hosted/cap-requests.js";
import { createHostedServer } from "../src/hosted/server.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const entry = (amount, h, id) => ({ amount_usd: amount, expires_at: new Date(NOW + h * 3600_000).toISOString(), request_id: id });

test("unit: total is a raise scope, travels split out and validates", () => {
  assert.equal(parseCapRequest({ scope: "total", amount_usd: 50, duration_hours: 48, reason: "finish eval" }).scope, "total");
  assert.ok(!LEGACY_RAISE_KEYS.includes("total"));
  const policy = { version: 3, caps: { total: 200, day: 5 }, raise: { total: [entry(40, 48, "a")], day: [entry(1, 2, "d")], week: undefined } };
  delete policy.raise.week;
  const { policy: rest, raise_total } = splitTotalRaise(policy);
  assert.equal(rest.raise.total, undefined);
  assert.deepEqual(rest.raise.day.length, 1);
  assert.equal(raise_total.length, 1);
  assert.equal(raiseTotalError(raise_total), null);
  assert.equal(raiseTotalError(null), null);
  assert.ok(raiseTotalError([{ amount_usd: -1, expires_at: "x", request_id: "r" }]));
  assert.ok(raiseTotalError("x"));
  assert.deepEqual(b91ValidatePolicy(rest), []);
  assert.deepEqual(b91ValidatePolicy(policy).length, 1); // the trap the split avoids
  assert.deepEqual(validatePolicy(policy), []);
  // No total raise: the policy object passes through untouched.
  const plain = { version: 1, caps: { total: 200 } };
  assert.equal(splitTotalRaise(plain).policy, plain);
  assert.equal(splitTotalRaise(plain).raise_total, null);
  const onlyTotal = splitTotalRaise({ version: 1, caps: { total: 1 }, raise: { total: [entry(1, 1, "x")] } }).policy;
  assert.equal("raise" in onlyTotal, false);
});

test("unit AC1-AC3: request, approve lower, stack, base edits, expiry", () => {
  const s = { agents: { a1: { id: "a1", orgId: "o", policy: { version: 1, caps: { total: 200 } } }, a2: { id: "a2", orgId: "o", policy: { version: 1, caps: { day: 1 } } } }, capRequests: {} };
  const input = parseCapRequest({ scope: "total", amount_usd: 50, duration_hours: 48, reason: "finish eval" });
  assert.throws(() => createCapRequest(s, { agent: s.agents.a2, actor: "x", input, id: "n", nowMs: NOW }), (e) => e.status === 400 && /Agent has no total cap to raise/.test(e.message));
  const r1 = createCapRequest(s, { agent: s.agents.a1, actor: "x", input, id: "r1", nowMs: NOW });
  assert.equal(r1.status, "pending");
  assert.throws(() => createCapRequest(s, { agent: s.agents.a1, actor: "x", input, id: "r1b", nowMs: NOW }), (e) => e.status === 409);
  const { before, after } = approveCapRequest(s, { request: r1, approval: { amount_usd: 40, duration_hours: 48, note: null }, actor: "admin", nowMs: NOW });
  assert.deepEqual(before.raise, {});
  assert.equal(after.raise.total[0].amount_usd, 40);
  assert.equal(effectiveCaps(s.agents.a1.policy, NOW).total, 240);
  const r2 = createCapRequest(s, { agent: s.agents.a1, actor: "x", input: { ...input, amount_usd: 25, duration_hours: 24 }, id: "r2", nowMs: NOW });
  approveCapRequest(s, { request: r2, approval: { amount_usd: 25, duration_hours: 24, note: null }, actor: "admin", nowMs: NOW });
  assert.equal(effectiveCaps(s.agents.a1.policy, NOW).total, 265);
  assert.equal(nextRaiseExpiry(s.agents.a1.policy, NOW), NOW + 24 * 3600_000);
  assert.equal(effectiveCaps({ ...s.agents.a1.policy, caps: { total: 150 } }, NOW).total, 215);
  assert.equal(effectiveCaps({ ...s.agents.a1.policy, caps: {} }, NOW).total, undefined);
  // Offline expiry: the wrapper reverts on its own.
  assert.equal(effectiveCaps(s.agents.a1.policy, NOW + 24 * 3600_000).total, 240);
  assert.equal(effectiveCaps(s.agents.a1.policy, NOW + 48 * 3600_000).total, 200);
  const rows = expireRaises(s, NOW + 49 * 3600_000);
  assert.deepEqual(rows.map((r) => [r.request_id, r.scope]).sort(), [["r1", "total"], ["r2", "total"]]);
  assert.equal(s.agents.a1.policy.raise, undefined);
  assert.equal(s.capRequests.r1.status, "expired");
});

async function fixture(t, clock) {
  const codes = {}, delivered = [];
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-287-")), "store.json");
  const origin = "http://localhost";
  const service = createHostedServer({ storePath, origin, secureCookies: false, stripeEnv: {}, now: () => clock.now, verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = () => `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    const r = await fetch(`${base()}/auth/verify`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code: codes[email] }) });
    return r.headers.get("set-cookie").split(";")[0];
  };
  return { request, login, delivered, service };
}

test("hosted AC1/AC3/AC4/AC5: total raise lifecycle, policy body back-compat, alerts", async (t) => {
  const clock = { now: NOW };
  const f = await fixture(t, clock);
  let owner = await f.login("t287@example.invalid");
  const tok = (await f.request("/v1/enrollment-tokens", { caps: { total: 200 } }, owner)).body.token;
  const a = (await f.request("/v1/enroll", { name: "total-bot" }, null, tok)).body;
  const plainBefore = (await f.request("/v1/policy", undefined, null, a.token)).body;
  assert.equal("raise_total" in plainBefore, false);
  await f.request("/v1/receipts", { receipts: [{ id: "1", ts: "2026-11-18T10:00:00Z", cost_usd: 200 }] }, null, a.token);
  await f.service.evaluateFleetAlerts();
  const hits = () => f.delivered.filter((x) => x.kind === "cap_hit" && x.scope === "total");
  assert.equal(hits().length, 1);
  const noTotal = (await f.request("/v1/enroll", { name: "nt" }, null, (await f.request("/v1/enrollment-tokens", { caps: { day: 10 } }, owner)).body.token)).body;
  const ask = { scope: "total", amount_usd: 50, duration_hours: 48, reason: "finish eval" };
  const nt = await f.request(`/v1/agents/${noTotal.agentId}/cap-requests`, ask, null, noTotal.token);
  assert.equal(nt.status, 400);
  assert.match(nt.body.error, /Agent has no total cap to raise/);
  const created = await f.request(`/v1/agents/${a.agentId}/cap-requests`, ask, null, a.token);
  assert.equal(created.status, 201);
  assert.equal((await f.request(`/v1/agents/${a.agentId}/cap-requests`, ask, null, a.token)).status, 409);
  assert.equal((await f.request(`/v1/cap-requests/${created.body.id}/approve`, { amount_usd: 40 }, owner)).status, 200);
  const budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body;
  assert.equal(budget.budget_remaining.total_usd, 40);
  const pol = (await f.request("/v1/policy", undefined, null, a.token)).body;
  assert.equal(pol.raise?.total, undefined);
  assert.equal(pol.raise_total.length, 1);
  const { team, agent_spend, settlements, tag_caps, tag_caps_v2, budget_period, org_budget, org_budget_v2, model_caps_week, model_caps_total, tag_caps_total, org_budget_total, raise_week, raise_total, ...legacyBody } = pol;
  assert.deepEqual(b91ValidatePolicy(legacyBody), []);
  assert.deepEqual(v201ValidatePolicy(legacyBody), []);
  assert.equal(resolvePolicy({ fetched: legacyBody, nowMs: clock.now }).caps.total, 200);
  assert.equal(effectiveCaps({ ...legacyBody, raise: { ...(legacyBody.raise ?? {}), total: raise_total } }, clock.now).total, 240);
  let ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
  assert.ok(ev.audit.some((e) => e.action === "cap_request.approve" && e.detail?.after?.raise?.total));
  await f.service.evaluateFleetAlerts();
  const alerts = (await f.request("/v1/alerts", undefined, owner)).body;
  const list = alerts.alerts ?? alerts;
  assert.ok(!list.some((x) => x.kind === "cap_hit" && x.scope === "total" && x.active), "total cap_hit resolves once raised");
  // Expiry: back to the base, audited, cap_hit fires once more and is not re-paged.
  clock.now = NOW + 49 * 3600_000;
  await f.service.evaluateFleetAlerts();
  await f.service.evaluateFleetAlerts();
  assert.equal(hits().length, 2);
  owner = await f.login("t287@example.invalid");
  ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
  assert.ok(ev.audit.some((e) => e.action === "cap_request.expire" && e.detail.scope === "total"));
  const after = (await f.request("/v1/policy", undefined, null, a.token)).body;
  assert.equal("raise_total" in after, false);
  assert.equal(after.raise, undefined);
  // A week raise still travels in raise_week (split order independent).
  assert.equal(splitWeekRaise(splitTotalRaise({ version: 1, caps: { week: 1, total: 1 }, raise: { week: [entry(1, 1, "w")], total: [entry(1, 1, "t")] } }).policy).raise_week.length, 1);
});

test("AC6: a total raise never turns unknown cost into headroom", async () => {
  const { cachedAgentVerdict } = await import("../src/hosted/teams.js");
  const policy = { version: 2, caps: { total: 200 }, raise: { total: [entry(40, 48, "r")] } };
  const caps = resolvePolicy({ fetched: policy, nowMs: NOW }).caps;
  assert.equal(caps.total, 240);
  const v = cachedAgentVerdict({ spent: { day: 0, week: 0, month: 0, total: 199.8 }, unknown: 1, as_of: new Date(NOW).toISOString() }, caps, [], NOW);
  assert.equal(v?.verdict, "accounting_unavailable");
  const ok = cachedAgentVerdict({ spent: { day: 0, week: 0, month: 0, total: 199.8 }, unknown: 0, as_of: new Date(NOW).toISOString() }, caps, [{ id: "x", ts: new Date(NOW).toISOString(), cost_usd: 5 }], NOW);
  assert.equal(ok, null);
  const refused = cachedAgentVerdict({ spent: { day: 0, week: 0, month: 0, total: 230 }, unknown: 0, as_of: new Date(NOW).toISOString() }, resolvePolicy({ fetched: policy, nowMs: NOW + 49 * 3600_000 }).caps, [{ id: "y", ts: new Date(NOW).toISOString(), cost_usd: 1 }], NOW + 49 * 3600_000);
  assert.deepEqual([refused.verdict, refused.scope], ["budget_exceeded", "total"]);
  assert.equal(refused.retry_after_seconds, undefined);
});
