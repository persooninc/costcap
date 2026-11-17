// Issue #208: time-boxed cap raise requests (validation, roles, fake clock, overlay, audit).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { resolvePolicy, effectiveCaps, activeRaises, nextRaiseExpiry, validatePolicy, raiseError } from "../src/hosted/policy.js";
import { parseCapRequest, parseApproval, expireRaises, findRequest, createCapRequest, approveCapRequest } from "../src/hosted/cap-requests.js";
import { hostedAgentVerdict } from "../src/hosted/agent-verdict.js";
import { buildEvidence } from "../src/hosted/evidence.js";

const T0 = Date.parse("2026-11-16T12:00:00.000Z");
const HOUR = 3600_000;

async function fixture(t) {
  let code, clock = T0;
  const delivered = [];
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-capreq-")), "store.json");
  const origin = "http://localhost";
  const service = createHostedServer({ storePath, origin, secureCookies: false, stripeEnv: {}, now: () => clock, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}/auth/verify`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code }) });
    return r.headers.get("set-cookie").split(";")[0];
  };
  const owner = await login("capreq-owner@example.invalid");
  const enrollAgent = async (name) => {
    const token = (await request("/v1/enrollment-tokens", { caps: { day: 5, month: 50 } }, owner)).body.token;
    return (await request("/v1/enroll", { name }, null, token)).body;
  };
  const agent = await enrollAgent("worker");
  const other = await enrollAgent("other");
  return { request, login, owner, agent, other, service, delivered, tick: (ms) => { clock += ms; }, now: () => clock };
}

const ask = { scope: "day", amount_usd: 20, duration_hours: 4, reason: "finish nightly batch" };

test("unit: parseCapRequest validates scope, amount, duration and reason", () => {
  assert.deepEqual(parseCapRequest({ ...ask, reason: "  r " }), { ...ask, reason: "r" });
  for (const bad of [{ ...ask, scope: "lifetime" }, { ...ask, amount_usd: 0 }, { ...ask, amount_usd: -1 }, { ...ask, amount_usd: "20" }, { ...ask, amount_usd: Infinity }, { ...ask, amount_usd: 100_001 },
    { ...ask, duration_hours: 0 }, { ...ask, duration_hours: 169 }, { ...ask, duration_hours: 1.5 }, { ...ask, reason: "" }, { ...ask, reason: "x".repeat(501) }, undefined]) {
    assert.throws(() => parseCapRequest(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test("unit: parseApproval can only lower amount or duration", () => {
  const req = { amount_usd: 20, duration_hours: 4 };
  assert.deepEqual(parseApproval({}, req), { amount_usd: 20, duration_hours: 4, note: null });
  assert.deepEqual(parseApproval({ amount_usd: 10, duration_hours: 2, reason: " ok " }, req), { amount_usd: 10, duration_hours: 2, note: "ok" });
  assert.deepEqual(parseApproval(undefined, req), { amount_usd: 20, duration_hours: 4, note: null });
  for (const bad of [{ amount_usd: 21 }, { amount_usd: 0 }, { duration_hours: 5 }, { duration_hours: 0 }, { reason: 5 }, { reason: "x".repeat(501) }]) assert.throws(() => parseApproval(bad, req), (e) => e.status === 400);
});

test("unit: overlay applies only before expires_at and only raises a base cap", () => {
  const policy = { version: 2, caps: { day: 5, month: 50 }, killed: false, raise: { day: { cap: 25, expires_at: new Date(T0 + HOUR).toISOString(), request_id: "r1" }, hour: { cap: 9, expires_at: new Date(T0 + HOUR).toISOString(), request_id: "r2" } } };
  assert.deepEqual(validatePolicy(policy), []);
  assert.deepEqual(effectiveCaps(policy, T0), { day: 25, month: 50 }); // no base hour cap: raise ignored
  assert.deepEqual(effectiveCaps(policy, T0 + HOUR), { day: 5, month: 50 });
  assert.equal(Object.keys(activeRaises(policy, T0 + HOUR)).length, 0);
  assert.equal(nextRaiseExpiry(policy, T0), T0 + HOUR);
  assert.equal(nextRaiseExpiry(policy, T0 + HOUR), null);
  assert.deepEqual(effectiveCaps(null, T0), {});
  // Lowest value wins: a local cap still tightens a raised fleet cap; killed is never lifted.
  assert.equal(resolvePolicy({ local: { day: 8 }, lastKnown: policy, nowMs: T0 }).caps.day, 8);
  assert.equal(resolvePolicy({ local: { day: 80 }, lastKnown: policy, nowMs: T0 }).caps.day, 25);
  assert.equal(resolvePolicy({ lastKnown: policy, nowMs: T0 + HOUR }).caps.day, 5);
  assert.equal(resolvePolicy({ lastKnown: policy, nowMs: T0 }).raiseExpiresAt, T0 + HOUR);
  assert.equal(resolvePolicy({ lastKnown: { ...policy, killed: true }, nowMs: T0 }).killed, true);
  // Invalid overlays are refused like any invalid policy.
  for (const bad of [[], "x", { lifetime: { cap: 1, expires_at: "2026-11-16T00:00:00Z", request_id: "r" } }, { day: { cap: -1, expires_at: "2026-11-16T00:00:00Z", request_id: "r" } }, { day: { cap: 1, expires_at: "nope", request_id: "r" } }, { day: null }]) assert.ok(raiseError(bad), JSON.stringify(bad));
  assert.equal(raiseError(null), null);
});

test("unit: expireRaises drops only expired scopes and marks requests expired", () => {
  const s = { agents: { a: { id: "a", orgId: "o", policy: { version: 3, caps: { day: 5, month: 50 }, killed: false, raise: {
    day: { cap: 25, expires_at: new Date(T0).toISOString(), request_id: "r1" }, month: { cap: 90, expires_at: new Date(T0 + HOUR).toISOString(), request_id: "r2" } } } }, b: { id: "b", orgId: "o", policy: { version: 1, caps: {} } } },
  capRequests: { r1: { id: "r1", status: "approved", reason: "x" } } };
  const rows = expireRaises(s, T0);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].scope, rows[0].request_id, rows[0].reason], ["day", "r1", "x"]);
  assert.equal(s.capRequests.r1.status, "expired");
  assert.equal(s.agents.a.policy.version, 4);
  assert.deepEqual(Object.keys(s.agents.a.policy.raise), ["month"]);
  assert.deepEqual(expireRaises(s, T0), []);
  expireRaises(s, T0 + HOUR);
  assert.equal(s.agents.a.policy.raise, undefined);
  assert.equal(s.agents.a.policy.version, 5);
});

test("unit: createCapRequest/approve guards (no base cap, revoked agent, decided request)", () => {
  const s = { agents: { a: { id: "a", orgId: "o", revoked: false, policy: { version: 1, caps: { day: 5 } } } } };
  assert.throws(() => createCapRequest(s, { agent: s.agents.a, actor: "a", input: { ...ask, scope: "month" }, id: "x", nowMs: T0 }), (e) => e.status === 400);
  const r = createCapRequest(s, { agent: s.agents.a, actor: "a", input: ask, id: "r1", nowMs: T0 });
  assert.throws(() => findRequest(s, "other-org", "r1"), (e) => e.status === 404);
  assert.throws(() => findRequest(s, "o", "nope"), (e) => e.status === 404);
  s.agents.a.revoked = true;
  assert.throws(() => approveCapRequest(s, { request: r, approval: { amount_usd: 1, duration_hours: 1 }, actor: "u", nowMs: T0 }), (e) => e.status === 409);
  s.agents.a.revoked = false; s.agents.a.policy.caps = {};
  assert.throws(() => approveCapRequest(s, { request: r, approval: { amount_usd: 1, duration_hours: 1 }, actor: "u", nowMs: T0 }), (e) => e.status === 409);
  r.status = "denied";
  assert.throws(() => findRequest(s, "o", "r1"), (e) => e.status === 409);
});

test("hosted: request limits, roles, approval overlay, verdict across expiry and audit", async (t) => {
  const f = await fixture(t);
  const { request, owner, agent, other } = f;
  // AC1: validation, own-agent only, one pending per scope.
  assert.equal((await request(`/v1/agents/${agent.agentId}/cap-requests`, { ...ask, amount_usd: -5 }, null, agent.token)).status, 400);
  assert.equal((await request(`/v1/agents/${agent.agentId}/cap-requests`, { ...ask, duration_hours: 200 }, null, agent.token)).status, 400);
  assert.equal((await request(`/v1/agents/${other.agentId}/cap-requests`, ask, null, agent.token)).status, 404);
  assert.equal((await request(`/v1/agents/nope/cap-requests`, ask, owner)).status, 404);
  const created = await request(`/v1/agents/${agent.agentId}/cap-requests`, ask, null, agent.token);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "pending");
  assert.equal((await request(`/v1/agents/${agent.agentId}/cap-requests`, ask, null, agent.token)).status, 409);
  assert.equal((await request(`/v1/agents/${agent.agentId}/cap-requests`, { ...ask, scope: "month" }, owner)).status, 201); // member, other scope
  // AC2: viewer gets 403 for decisions but can list.
  const viewerEmail = "capreq-viewer@example.invalid";
  assert.equal((await request("/v1/invitations", { email: viewerEmail, role: "viewer" }, owner)).status < 300, true);
  const viewer = await f.login(viewerEmail);
  const listed = await request("/v1/cap-requests?status=pending", undefined, viewer);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.canDecide, false);
  assert.equal(listed.body.requests.length, 2);
  assert.equal(listed.body.requests[0].agent_name, "worker");
  assert.equal((await request(`/v1/cap-requests/${created.body.id}/approve`, {}, viewer)).status, 403);
  assert.equal((await request("/v1/cap-requests?status=bogus", undefined, owner)).status, 400);
  assert.equal((await request(`/v1/cap-requests/nope/approve`, {}, owner)).status, 404);
  assert.equal((await request(`/v1/cap-requests/${created.body.id}/approve`, { amount_usd: 30 }, owner)).status, 400);
  // Spend $6 today: over the $5 base day cap.
  assert.equal((await request("/v1/receipts", { receipts: [{ id: "r-6", ts: new Date(f.now()).toISOString(), cost_usd: 6, model: "m" }] }, null, agent.token)).status, 200);
  const before = await request(`/v1/agents/${agent.agentId}/budget`, undefined, null, agent.token);
  assert.equal(before.body.verdict, "budget_exceeded");
  assert.equal(before.body.cap_usd, 5);
  const policyBefore = (await request("/v1/policy", undefined, null, agent.token)).body;
  // Approve, lowering the amount; base caps stay unchanged, version bumps.
  const approved = await request(`/v1/cap-requests/${created.body.id}/approve`, { amount_usd: 15, duration_hours: 2 }, owner);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "approved");
  assert.equal((await request(`/v1/cap-requests/${created.body.id}/approve`, {}, owner)).status, 409);
  const policy = (await request("/v1/policy", undefined, null, agent.token)).body;
  assert.equal(policy.version, policyBefore.version + 1);
  assert.deepEqual(policy.caps, { day: 5, month: 50 });
  assert.deepEqual(policy.raise.day.map((r) => r.amount_usd), [15]);
  assert.equal(policy.raise.day[0].expires_at, new Date(f.now() + 2 * HOUR).toISOString());
  // AC5: verdict uses the raised cap.
  const during = await request(`/v1/agents/${agent.agentId}/budget`, undefined, null, agent.token);
  assert.equal(during.body.verdict, "ok");
  assert.equal(during.body.budget_remaining.day_usd, 14);
  // AC2: a later "Save caps" edit keeps the active raise.
  assert.equal((await request(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 6, month: 50 } }, owner)).status, 200);
  assert.equal((await request("/v1/policy", undefined, null, agent.token)).body.raise.day[0].amount_usd, 15);
  // AC4: killed is never lifted by a raise.
  assert.equal((await request(`/v1/agents/${agent.agentId}/policy`, { killed: true }, owner)).status, 200);
  assert.equal((await request(`/v1/agents/${agent.agentId}/budget`, undefined, null, agent.token)).body.verdict, "killed");
  assert.equal((await request(`/v1/agents/${agent.agentId}/policy`, { killed: false }, owner)).status, 200);
  // No cap_hit while raised (alerts use the effective cap).
  await f.service.evaluateFleetAlerts();
  assert.ok(!f.delivered.some((a) => a.kind === "cap_hit" && a.scope === "day"));
  // Deny the month request.
  const pending = (await request("/v1/cap-requests?status=pending", undefined, owner)).body.requests;
  assert.equal(pending.length, 1);
  const denied = await request(`/v1/cap-requests/${pending[0].id}/deny`, { reason: "not this month" }, owner);
  assert.equal(denied.body.status, "denied");
  // Fake clock past expiry: the verdict reverts to the base cap and cap_hit fires.
  f.tick(2 * HOUR);
  const after = await request(`/v1/agents/${agent.agentId}/budget`, undefined, null, agent.token);
  assert.equal(after.body.verdict, "budget_exceeded");
  assert.equal(after.body.cap_usd, 6);
  await f.service.evaluateFleetAlerts();
  assert.ok(f.delivered.some((a) => a.kind === "cap_hit"));
  const all = (await request("/v1/cap-requests", undefined, owner)).body.requests;
  assert.equal(all.find((r) => r.id === created.body.id).status, "expired");
  assert.equal((await request("/v1/policy", undefined, null, agent.token)).body.raise, undefined);
  // AC6: audit events with actor, before/after caps and reason, in CSV and evidence.
  const evidence = (await request("/v1/evidence.json", undefined, owner)).body;
  const byAction = (a) => evidence.audit.filter((e) => e.action === a);
  for (const action of ["cap_request.create", "cap_request.approve", "cap_request.deny", "cap_request.expire"]) assert.ok(byAction(action).length, action);
  const ap = byAction("cap_request.approve")[0];
  assert.equal(ap.detail.reason, ask.reason);
  assert.deepEqual(ap.detail.before.caps, { day: 5, month: 50 });
  assert.equal(ap.detail.after.raise.day[0].amount_usd, 15);
  assert.equal(byAction("cap_request.create")[0].actor, agent.agentId);
  assert.equal(byAction("cap_request.expire")[0].actor, "cap-raise-expiry");
  const csv = (await request("/v1/audit.csv", undefined, owner)).body;
  for (const action of ["cap_request.create", "cap_request.approve", "cap_request.deny", "cap_request.expire"]) assert.match(csv, new RegExp(action.replace(".", "\\.")));
});

test("unit: hosted verdict and evidence use the effective cap; unknown cost is never $0", () => {
  const agent = { id: "a", policy: { version: 2, caps: { day: 5 }, killed: false, raise: { day: { cap: 25, expires_at: new Date(T0 + HOUR).toISOString(), request_id: "r" } } } };
  const receipts = [{ id: "1", ts: new Date(T0).toISOString(), cost_usd: 6 }];
  assert.equal(hostedAgentVerdict({ agent, receipts, nowMs: T0 }).verdict, "ok");
  assert.equal(hostedAgentVerdict({ agent, receipts, nowMs: T0 + HOUR }).verdict, "budget_exceeded");
  assert.equal(hostedAgentVerdict({ agent, receipts: [...receipts, { id: "2", ts: new Date(T0).toISOString(), cost_usd: null }], nowMs: T0 }).verdict, "accounting_unavailable");
  const spendFor = () => ({ day: { usd: 6, unknown: 0 }, month: { usd: 6, unknown: 0 } });
  const ev = buildEvidence({ orgId: "o", nowMs: T0, spendFor, agents: [agent] });
  assert.deepEqual(ev.agents[0].effective_caps, { day: 25 });
  assert.equal(ev.agents[0].raises.day[0].request_id, "r");
  assert.equal(buildEvidence({ orgId: "o", nowMs: T0 + HOUR, spendFor, agents: [agent] }).agents[0].effective_caps, undefined);
});

// Issue #212: raises stack on top of the current base cap.
const iso = (ms) => new Date(ms).toISOString();
function stackStore() {
  return { agents: { a: { id: "a", orgId: "o", revoked: false, policy: { version: 1, caps: { day: 10 }, killed: false } } }, capRequests: {} };
}
function file(s, id, amount, hours, nowMs) {
  const req = createCapRequest(s, { agent: s.agents.a, actor: "a", input: { scope: "day", amount_usd: amount, duration_hours: hours, reason: id }, id, nowMs });
  return approveCapRequest(s, { request: findRequest(s, "o", req.id), approval: { amount_usd: amount, duration_hours: hours, note: null }, actor: "owner", nowMs });
}

test("#212 unit: r1 then r2 on the same scope stack and expire independently, each audited once", () => {
  const s = stackStore();
  file(s, "r1", 20, 4, T0);
  assert.deepEqual(effectiveCaps(s.agents.a.policy, T0), { day: 30 });
  file(s, "r2", 5, 1, T0 + 60_000);
  assert.deepEqual(effectiveCaps(s.agents.a.policy, T0 + 60_000), { day: 35 });
  assert.deepEqual(validatePolicy(s.agents.a.policy), []);
  assert.deepEqual(s.agents.a.policy.raise.day.map((r) => r.request_id), ["r1", "r2"]);
  // r2 lapses first; r1 keeps its $20.
  const rows1 = expireRaises(s, T0 + 60_000 + HOUR);
  assert.deepEqual(rows1.map((r) => r.request_id), ["r2"]);
  assert.deepEqual(effectiveCaps(s.agents.a.policy, T0 + 2 * HOUR), { day: 30 });
  assert.equal(s.capRequests.r1.status, "approved");
  const rows2 = expireRaises(s, T0 + 10 * HOUR);
  assert.deepEqual(rows2.map((r) => r.request_id), ["r1"]);
  assert.deepEqual(expireRaises(s, T0 + 20 * HOUR), []);
  assert.deepEqual([s.capRequests.r1.status, s.capRequests.r2.status], ["expired", "expired"]);
  assert.equal(s.agents.a.policy.raise, undefined);
});

test("#212 unit: lowering the base during a raise lowers the effective cap at once", () => {
  const s = stackStore();
  file(s, "r1", 20, 4, T0);
  s.agents.a.policy = { ...s.agents.a.policy, caps: { day: 2 }, version: s.agents.a.policy.version + 1 };
  assert.deepEqual(effectiveCaps(s.agents.a.policy, T0), { day: 22 });
  assert.equal(resolvePolicy({ lastKnown: s.agents.a.policy, nowMs: T0 }).caps.day, 22);
  assert.equal(hostedAgentVerdict({ agent: s.agents.a, receipts: [{ id: "x", ts: iso(T0), cost_usd: 25 }], nowMs: T0 }).verdict, "budget_exceeded");
});

test("#212 unit: offline wrapper reverts at each expiry via nextRaiseExpiry", () => {
  const policy = { version: 3, caps: { day: 10 }, killed: false, raise: { day: [
    { amount_usd: 20, expires_at: iso(T0 + 4 * HOUR), request_id: "r1" },
    { amount_usd: 5, expires_at: iso(T0 + HOUR), request_id: "r2" }] } };
  let r = resolvePolicy({ lastKnown: policy, nowMs: T0 });
  assert.deepEqual([r.caps.day, r.raiseExpiresAt], [35, T0 + HOUR]);
  r = resolvePolicy({ lastKnown: policy, nowMs: r.raiseExpiresAt });
  assert.deepEqual([r.caps.day, r.raiseExpiresAt], [30, T0 + 4 * HOUR]);
  r = resolvePolicy({ lastKnown: policy, nowMs: r.raiseExpiresAt });
  assert.deepEqual([r.caps.day, r.raiseExpiresAt], [10, null]);
});

test("#212 unit: legacy {cap} overlays migrate without growing; orphaned approved requests expire once", () => {
  const s = { agents: { a: { id: "a", orgId: "o", policy: { version: 2, caps: { day: 10, month: 50 }, killed: false, raise: {
    day: { cap: 30, expires_at: iso(T0 + 4 * HOUR), request_id: "r1" }, month: { cap: 40, expires_at: iso(T0 + HOUR), request_id: "rx" } } } } },
  capRequests: {
    r1: { id: "r1", orgId: "o", agentId: "a", scope: "day", status: "approved", approved_amount_usd: 20, expires_at: iso(T0 + 4 * HOUR), reason: "a" },
    r0: { id: "r0", orgId: "o", agentId: "a", scope: "day", status: "approved", approved_amount_usd: 7, expires_at: iso(T0 + 30 * 60_000), reason: "overwritten" } } };
  // Legacy read before migration: amount = cap - current base, never negative.
  assert.deepEqual(effectiveCaps(s.agents.a.policy, T0), { day: 30, month: 50 });
  assert.deepEqual(validatePolicy(s.agents.a.policy), []);
  assert.deepEqual(expireRaises(s, T0), []);
  assert.deepEqual(s.agents.a.policy.raise, { day: [{ amount_usd: 20, expires_at: iso(T0 + 4 * HOUR), request_id: "r1" }] });
  s.agents.a.policy.caps.day = 2;
  assert.deepEqual(effectiveCaps(s.agents.a.policy, T0), { day: 22, month: 50 });
  // r0 lost its overlay before #212: it still expires and is audited exactly once.
  const rows = expireRaises(s, T0 + HOUR);
  assert.deepEqual(rows.map((r) => r.request_id), ["r0"]);
  assert.equal(s.capRequests.r0.status, "expired");
  assert.deepEqual(expireRaises(s, T0 + 2 * HOUR), []);
  for (const bad of [{ day: [] }, { day: [{ amount_usd: 0, expires_at: iso(T0), request_id: "r" }] }, { day: [{ amount_usd: 1, expires_at: "nope", request_id: "r" }] }, { day: { expires_at: iso(T0), request_id: "r" } }]) assert.ok(raiseError(bad), JSON.stringify(bad));
});
