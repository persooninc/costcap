// Issue #165: configurable hosted cap_approaching warning fractions per agent and team.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { evaluateAlerts, evaluateTeamAlerts, warnFractionsError, approachKey, armWarnings, claimWarning, capPeriod, sortWarnFractions } from "../src/hosted/alerts.js";
import { validatePolicy } from "../src/hosted/policy.js";
import { parseTeamInput } from "../src/hosted/teams.js";
import { buildEvidence } from "../src/hosted/evidence.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const st = (spend, caps = { day: 10 }) => ({ agentId: "a1", caps, spend, nowMs: NOW });

test("unit: highest crossed fraction wins, 0.8 keeps the legacy key, others get :p<pct>", () => {
  const w = { warnFractions: [0.5, 0.8, 0.95] };
  assert.deepEqual(evaluateAlerts(st({ day: 4 }), w), []);
  assert.deepEqual(evaluateAlerts(st({ day: 5.1 }), w), [{ kind: "cap_approaching", scope: "day", key: "cap_approaching:a1:day:p50", cap: 10, spent: 5.1, fraction: 0.5 }]);
  assert.equal(evaluateAlerts(st({ day: 8.2 }), w)[0].key, "cap_approaching:a1:day");
  assert.equal(evaluateAlerts(st({ day: 8.2 }), w)[0].fraction, 0.8);
  assert.equal(evaluateAlerts(st({ day: 9.6 }), w)[0].key, "cap_approaching:a1:day:p95");
  assert.deepEqual(evaluateAlerts(st({ day: 10 }), w).map((a) => a.kind), ["cap_hit"]);
  assert.equal(approachKey("x", "month", 1 / 3), "cap_approaching:x:month:p33.3333");
});

test("unit: [] turns cap_approaching off but cap_hit still fires; approachFraction alias and default unchanged", () => {
  assert.deepEqual(evaluateAlerts(st({ day: 9.9 }), { warnFractions: [] }), []);
  assert.deepEqual(evaluateAlerts(st({ day: 10 }), { warnFractions: [] }).map((a) => a.kind), ["cap_hit"]);
  assert.deepEqual(evaluateAlerts(st({ day: 5 }), { approachFraction: 0.5 }), [{ kind: "cap_approaching", scope: "day", key: "cap_approaching:a1:day", cap: 10, spent: 5 }]);
  assert.deepEqual(evaluateAlerts(st({ day: 8 })), [{ kind: "cap_approaching", scope: "day", key: "cap_approaching:a1:day", cap: 10, spent: 8 }]);
  assert.deepEqual(evaluateAlerts(st({ day: 8 }), { warnFractions: null }), evaluateAlerts(st({ day: 8 })));
});

test("unit: team fractions, team off switch, unknown cost raises nothing", () => {
  const v = (spent, unknown = 0) => ({ name: "ops", caps: { month: 100 }, spend: { day_usd: spent, month_usd: spent, unknown_count: unknown }, verdict: "ok" });
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: v(50) }, { warnFractions: [0.5] }), [{ kind: "cap_approaching", key: "cap_approaching:team:o:ops:month:p50", team: "ops", scope: "month", cap: 100, spent: 50, fraction: 0.5 }]);
  assert.equal(evaluateTeamAlerts({ orgId: "o", verdict: v(85) }, { warnFractions: [0.5] })[0].fraction, 0.5);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: v(85) }, { warnFractions: [] }), []);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: v(95, 1) }, { warnFractions: [0.5] }), []);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: v(49) }, { warnFractions: [0.5] }), []);
});

test("unit: validation of warnFractions in policy and team input", () => {
  const base = { version: 1, caps: { day: 1 } };
  assert.deepEqual(validatePolicy({ ...base, warnFractions: [0.5, 0.8, 0.95] }), []);
  assert.deepEqual(validatePolicy({ ...base, warnFractions: [] }), []);
  assert.deepEqual(validatePolicy({ ...base, warnFractions: null }), []);
  for (const bad of [[0], [1], [0.5, 0.5], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], ["x"], 0.8, [NaN], [-0.1]]) assert.equal(validatePolicy({ ...base, warnFractions: bad }).length, 1, JSON.stringify(bad));
  assert.equal(warnFractionsError([0.2]), null);
  assert.deepEqual(sortWarnFractions([0.95, 0.5, 0.8]), [0.5, 0.8, 0.95]);
  const ctx = { orgId: "o", orgAgents: [{ id: "a", orgId: "o" }], teams: [] };
  assert.deepEqual(parseTeamInput({ name: "ops", agents: ["a"], month: 100, warnFractions: [0.9, 0.5] }, ctx).warnFractions, [0.5, 0.9]);
  assert.equal(parseTeamInput({ name: "ops", agents: ["a"], month: 100, warnFractions: null }, ctx).warnFractions, null);
  assert.equal("warnFractions" in parseTeamInput({ name: "ops", agents: ["a"], month: 100 }, ctx), false);
  assert.throws(() => parseTeamInput({ name: "ops", agents: ["a"], month: 100, warnFractions: [1.5] }, ctx), (e) => e.status === 400 && /between 0 and 1/.test(e.message));
});

test("unit: once per period, skipped lower fractions are covered, cap raise re-arms only moved thresholds", () => {
  const arm = {};
  const fr = [0.5, 0.8, 0.95];
  const s1 = armWarnings(arm, { id: "a", scope: "day", cap: 10, spent: 9.6, nowMs: NOW });
  assert.equal(claimWarning(s1, { fraction: 0.95 }, fr), true);
  assert.equal(claimWarning(s1, { fraction: 0.95 }, fr), false);
  assert.equal(claimWarning(s1, { fraction: 0.5 }, fr), false);
  // Cap raised to 11.5: 0.95 threshold (10.925) moved above 9.6 and re-arms; 0.8 (9.2) did not.
  const s2 = armWarnings(arm, { id: "a", scope: "day", cap: 11.5, spent: 9.6, nowMs: NOW });
  assert.deepEqual(s2.fired.sort(), [0.5, 0.8]);
  // Next UTC day resets everything.
  const s3 = armWarnings(arm, { id: "a", scope: "day", cap: 12, spent: 0, nowMs: NOW + 86_400_000 });
  assert.deepEqual(s3.fired, []);
  assert.equal(s3.period, "2026-11-16");
  assert.equal(capPeriod("month", NOW), "2026-11");
  // Non-finite spend never re-arms or crashes.
  assert.deepEqual(armWarnings(arm, { id: "a", scope: "day", cap: 12, spent: NaN, nowMs: NOW + 86_400_000 }).fired, []);
});

test("unit: evidence carries fraction only when present", () => {
  const ev = buildEvidence({ orgId: "o", alerts: [{ id: "1", kind: "cap_approaching", key: "k", fraction: 0.95 }, { id: "2", kind: "cap_hit", key: "h" }], nowMs: NOW, spendFor: () => ({}) });
  assert.equal(ev.alerts[0].fraction, 0.95);
  assert.equal("fraction" in ev.alerts[1], false);
});

async function fixture(t, clock) {
  let code;
  const delivered = [];
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-warn-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {}, now: () => clock.ms,
    verifyChallenge: async (v) => v === "ok", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {},
    deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => { const c = await request("/auth/request", { email, turnstileToken: "ok" }); return request("/auth/verify", { challengeId: c.body.challengeId, code }); };
  const agent = async (cookie, name, caps = {}) => { const e = await request("/v1/enrollment-tokens", { caps }, cookie); return (await request("/v1/enroll", { name }, null, e.body.token)).body; };
  let n = 0;
  const spend = (token, cost) => request("/v1/receipts", { receipts: [{ id: `r${++n}`, ts: new Date(clock.ms).toISOString(), cost_usd: cost, model: "m" }] }, null, token);
  return { request, login, agent, spend, delivered, sweep: () => service.evaluateFleetAlerts() };
}

test("regression: policy API round-trip, audit, 400/403, null reset", async (t) => {
  const f = await fixture(t, { ms: NOW });
  const owner = await f.login("warn-owner@example.invalid");
  await f.request("/v1/invitations", { email: "warn-viewer@example.invalid", role: "viewer" }, owner.cookie);
  const viewer = await f.login("warn-viewer@example.invalid");
  const a = await f.agent(owner.cookie, "research", { day: 10 });
  const url = `/v1/agents/${a.agentId}/policy`;
  const ok = await f.request(url, { warnFractions: [0.95, 0.5, 0.8] }, owner.cookie);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.warnFractions, [0.5, 0.8, 0.95]);
  const audit = (await f.request("/v1/evidence.json", undefined, owner.cookie)).body.audit.find((e) => e.action === "policy.change");
  assert.deepEqual(audit.detail.policy.warnFractions, [0.5, 0.8, 0.95]);
  assert.equal(audit.detail.previous.warnFractions, undefined);
  for (const bad of [[0], [1], [0.5, 0.5], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], ["x"], 0.8]) assert.equal((await f.request(url, { warnFractions: bad }, owner.cookie)).status, 400, JSON.stringify(bad));
  assert.equal((await f.request(url, { warnFractions: [0.5] }, viewer.cookie)).status, 403);
  // Omitted keeps the stored value.
  assert.deepEqual((await f.request(url, { caps: { day: 10 } }, owner.cookie)).body.warnFractions, [0.5, 0.8, 0.95]);
  // null resets to the default (stored absent, evaluated as [0.8]).
  assert.equal((await f.request(url, { warnFractions: null }, owner.cookie)).body.warnFractions, undefined);
  assert.deepEqual((await f.request(url, { warnFractions: [] }, owner.cookie)).body.warnFractions, []);
});

test("regression: sweeps deliver 0.5, 0.8, 0.95 once each, jumps cover lower fractions, next UTC day re-arms", async (t) => {
  const clock = { ms: NOW };
  const f = await fixture(t, clock);
  const owner = await f.login("warn-sweep@example.invalid");
  const a = await f.agent(owner.cookie, "seq", { day: 10 });
  const b = await f.agent(owner.cookie, "jump", { day: 10 });
  for (const x of [a, b]) assert.equal((await f.request(`/v1/agents/${x.agentId}/policy`, { warnFractions: [0.5, 0.8, 0.95] }, owner.cookie)).status, 200);
  const warns = (id) => f.delivered.filter((d) => d.kind === "cap_approaching" && d.agentId === id);
  for (const step of [4, 1.1, 3.1, 1.4, 0.1]) { await f.spend(a.token, step); await f.sweep(); await f.sweep(); }
  assert.deepEqual(warns(a.agentId).map((d) => d.fraction), [0.5, 0.8, 0.95]);
  assert.equal(warns(a.agentId)[1].key, `cap_approaching:${a.agentId}:day`);
  assert.equal(warns(a.agentId)[2].period, "2026-11-15");
  await f.spend(b.token, 4); await f.sweep();
  await f.spend(b.token, 5.6); await f.sweep(); await f.sweep();
  assert.deepEqual(warns(b.agentId).map((d) => d.fraction), [0.95]);
  // Raising the cap to 11 moves only the 0.95 threshold (10.45) above $9.70 spend.
  await f.request(`/v1/agents/${a.agentId}/policy`, { caps: { day: 11 } }, owner.cookie);
  await f.sweep();
  assert.equal(warns(a.agentId).length, 3);
  await f.spend(a.token, 0.8); await f.sweep(); await f.sweep();
  assert.deepEqual(warns(a.agentId).map((d) => d.fraction), [0.5, 0.8, 0.95, 0.95]);
  // Next UTC day: day spend resets; each fraction fires again once.
  clock.ms = NOW + 86_400_000;
  await f.sweep();
  await f.spend(a.token, 5.6); await f.sweep(); await f.sweep();
  assert.deepEqual(warns(a.agentId).map((d) => d.fraction), [0.5, 0.8, 0.95, 0.95, 0.5]);
  const again = await f.login("warn-sweep@example.invalid"); // the day-old session expired
  const listed = (await f.request("/v1/fleet", undefined, again.cookie)).body.alerts.find((x) => x.active && x.agentId === a.agentId);
  assert.equal(listed.fraction, 0.5);
  assert.equal(listed.period, "2026-11-16");
});

test("regression: team warnFractions [0.5] fires p50 at $50, not 80%; [] on an agent still pages cap_hit", async (t) => {
  const f = await fixture(t, { ms: NOW });
  const owner = await f.login("warn-team@example.invalid");
  const rb = await f.agent(owner.cookie, "rb"), tb = await f.agent(owner.cookie, "tb");
  const made = await f.request("/v1/teams", { name: "ops", agents: [rb.agentId, tb.agentId], month: 100, warnFractions: [0.5] }, owner.cookie);
  assert.equal(made.status, 200);
  assert.deepEqual(made.body.warnFractions, [0.5]);
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [rb.agentId], month: 100, warnFractions: [2] }, owner.cookie)).status, 400);
  // Omitting warnFractions on update keeps it.
  assert.deepEqual((await f.request("/v1/teams", { name: "ops", agents: [rb.agentId, tb.agentId], month: 100 }, owner.cookie)).body.warnFractions, [0.5]);
  await f.spend(rb.token, 30); await f.spend(tb.token, 20); await f.sweep();
  // #247 projections are covered in projection-247.test.js; this test pins the warning fractions.
  const team = () => f.delivered.filter((d) => d.team === "ops" && d.kind !== "cap_projected");
  assert.deepEqual(team().map((d) => d.key), [`cap_approaching:team:${team()[0].orgId}:ops:month:p50`]);
  await f.spend(rb.token, 35); await f.sweep(); await f.sweep();
  assert.equal(team().length, 1);
  const audit = (await f.request("/v1/evidence.json", undefined, owner.cookie)).body.audit.filter((e) => e.action === "team.change");
  assert.deepEqual(audit.at(-1).detail.next.warnFractions, [0.5]);
  // Agent off switch.
  const solo = await f.agent(owner.cookie, "solo", { day: 10 });
  await f.request(`/v1/agents/${solo.agentId}/policy`, { warnFractions: [] }, owner.cookie);
  await f.spend(solo.token, 9.9); await f.sweep();
  assert.equal(f.delivered.filter((d) => d.agentId === solo.agentId).length, 0);
  await f.spend(solo.token, 0.2); await f.sweep();
  assert.deepEqual(f.delivered.filter((d) => d.agentId === solo.agentId).map((d) => d.kind), ["cap_hit"]);
  // null resets the team to the default.
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [rb.agentId, tb.agentId], month: 100, warnFractions: null }, owner.cookie)).body.warnFractions, undefined);
});
