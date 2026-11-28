// Issue #261: weekly caps (ISO week, Monday 00:00 in the org budget-period
// timezone) for hosted agents and teams, enforced fleet-wide and alerted.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { periodKey, periodBounds, weekLabel, inSpendWindow } from "../src/period.js";
import { createAgentBudgets, assertAgentPolicy, budgetRemaining } from "../src/agent-budget.js";
import { validatePolicy, resolvePolicy, raiseError } from "../src/hosted/policy.js";
import { parseTeamInput, teamVerdict, teamPolicy, validTeamPolicy, cachedTeamVerdict, agentSpendPolicy, validAgentSpend, cachedAgentVerdict, cachedAgentRemaining } from "../src/hosted/teams.js";
import { hostedAgentVerdict } from "../src/hosted/agent-verdict.js";
import { evaluateAlerts, evaluateTeamAlerts, capPeriod, armWarnings, claimWarning, blocksInCurrentPeriod } from "../src/hosted/alerts.js";
import { parseCapRequest } from "../src/hosted/cap-requests.js";
import { weekLabel as digestWeekLabel, weekBounds } from "../src/hosted/digest.js";
import { createHostedServer } from "../src/hosted/server.js";

const LA = { timezone: "America/Los_Angeles", monthStartDay: 1 };
const ms = (iso) => Date.parse(iso);
// Sunday 2026-11-15 23:30 PST and Monday 2026-11-16 00:30 PST.
const SUN_LATE = "2026-11-16T07:30:00Z";
const MON_EARLY = "2026-11-16T08:30:00Z";
const MON_1AM = ms("2026-11-16T09:00:00Z");

test("#261 period: week keys are ISO Monday weeks in the org timezone (LA vs UTC)", () => {
  assert.equal(periodKey("week", ms(SUN_LATE), LA), "2026-W46");
  assert.equal(periodKey("week", ms(MON_EARLY), LA), "2026-W47");
  // Under UTC both instants are already Monday.
  assert.equal(periodKey("week", ms(SUN_LATE)), "2026-W47");
  assert.equal(periodKey("week", ms(MON_EARLY)), "2026-W47");
  // monthStartDay never shifts weeks.
  assert.equal(periodKey("week", ms(SUN_LATE), { ...LA, monthStartDay: 15 }), "2026-W46");
  const b = periodBounds("week", MON_1AM, LA);
  assert.equal(new Date(b.start).toISOString(), "2026-11-16T08:00:00.000Z");
  assert.equal(new Date(b.end).toISOString(), "2026-11-23T08:00:00.000Z");
  assert.equal(digestWeekLabel, weekLabel); // the digest reuses the moved helpers
});

test("#261 period: week bounds across DST and New Year", () => {
  // US DST starts Sun 2026-03-08: the week Mon Mar 2 .. Mon Mar 9 is 167 hours long in LA.
  const spring = periodBounds("week", ms("2026-03-05T12:00:00Z"), LA);
  assert.equal((spring.end - spring.start) / 3600_000, 167);
  assert.equal(new Date(spring.end).toISOString(), "2026-03-09T07:00:00.000Z");
  // DST ends Sun 2026-11-01: that week is 169 hours.
  const fall = periodBounds("week", ms("2026-10-29T12:00:00Z"), LA);
  assert.equal((fall.end - fall.start) / 3600_000, 169);
  // 2026 has 53 ISO weeks; Fri 2027-01-01 is still 2026-W53, Mon 2027-01-04 is 2027-W01.
  assert.equal(periodKey("week", ms("2027-01-01T12:00:00Z")), "2026-W53");
  assert.equal(periodKey("week", ms("2027-01-04T00:00:00Z")), "2027-W01");
  // LA New Year's Eve evening is already Jan 1 in UTC; both are W53.
  assert.equal(periodKey("week", ms("2027-01-01T05:00:00Z"), LA), "2026-W53");
  assert.equal(periodKey("week", ms("2027-01-04T07:59:00Z"), LA), "2026-W53");
  assert.equal(periodKey("week", ms("2027-01-04T08:00:00Z"), LA), "2027-W01");
  assert.deepEqual(weekBounds("2026-W53"), { weekStart: ms("2026-12-28T00:00:00Z"), weekEnd: ms("2027-01-04T00:00:00Z") });
});

test("#261 inSpendWindow: current month OR current week", () => {
  const now = ms("2026-12-02T12:00:00Z");
  assert.equal(inSpendWindow(ms("2026-11-30T12:00:00Z"), now), true); // previous month, same week
  assert.equal(inSpendWindow(ms("2026-11-29T12:00:00Z"), now), false); // previous month and week
  assert.equal(inSpendWindow(ms("2026-12-20T12:00:00Z"), now), true);
});

test("#261 agent-budget: week scope in spend/check/remaining and --policy files", () => {
  const history = [{ id: "a", ts: SUN_LATE, cost_usd: 6, agent_id: "x" }, { id: "b", ts: MON_EARLY, cost_usd: 4, agent_id: "x" }];
  const b = createAgentBudgets({ policy: { agents: { x: { week: 10 } } }, history, now: () => new Date(MON_1AM), budgetPeriod: LA });
  assert.equal(b.spend({ agent_id: "x" }).week, 4);
  assert.equal(b.check({ agent_id: "x" }), null);
  assert.equal(budgetRemaining(b, { agent_id: "x" }).week_usd, 6);
  b.record({ id: "c", ts: new Date(MON_1AM).toISOString(), cost_usd: 6, agent_id: "x" });
  assert.deepEqual(b.check({ agent_id: "x" }), { verdict: "budget_exceeded", reason: "budget_exceeded", scope: "week", cap_usd: 10, spent_usd: 10, agent_id: "x", run_id: null });
  // Under UTC both receipts are the same week: 10 already.
  const utc = createAgentBudgets({ policy: { agents: { x: { week: 10 } } }, history, now: () => new Date(MON_1AM) });
  assert.equal(utc.check({ agent_id: "x" }).scope, "week");
  assert.doesNotThrow(() => assertAgentPolicy({ agents: { x: { week: 5 } }, teams: { t: { agents: ["y"], week: 9 } } }));
  assert.throws(() => assertAgentPolicy({ agents: { x: { week: 0 } } }), /Invalid x week cap/);
  assert.throws(() => assertAgentPolicy({ agents: { x: { weekly: 5 } } }), /Unknown limit weekly/);
  // No week cap: no week_usd field (same convention as hour_usd).
  const none = createAgentBudgets({ policy: { agents: { x: { day: 5 } } }, history, now: () => new Date(MON_1AM) });
  assert.equal("week_usd" in budgetRemaining(none, { agent_id: "x" }), false);
});

test("#261 AC1: hosted verdict and the wrapper's cached verdict split the week at local Monday", () => {
  const agent = { id: "x", policy: { caps: { week: 10 } } };
  const receipts = [{ id: "a", ts: SUN_LATE, cost_usd: 6 }, { id: "b", ts: MON_EARLY, cost_usd: 4 }];
  const v = hostedAgentVerdict({ agent, receipts, nowMs: MON_1AM, budgetPeriod: LA });
  assert.equal(v.ok, true);
  assert.equal(v.budget_remaining.week_usd, 6);
  const snap = agentSpendPolicy(receipts, MON_1AM, LA);
  assert.equal(snap.spent.week, 4);
  const caps = resolvePolicy({ fetched: { version: 1, caps: { week: 10 } } }).caps;
  assert.deepEqual(caps, { week: 10 });
  assert.equal(cachedAgentVerdict(snap, caps, [], MON_1AM, LA), null);
  const more = [{ id: "c", ts: new Date(MON_1AM).toISOString(), cost_usd: 6 }];
  assert.deepEqual(cachedAgentVerdict(snap, caps, more, MON_1AM + 1000, LA), { verdict: "budget_exceeded", reason: "budget_exceeded", scope: "week", cap_usd: 10, spent_usd: 10, fleet: true });
  const after = hostedAgentVerdict({ agent, receipts: [...receipts, ...more], nowMs: MON_1AM + 1000, budgetPeriod: LA });
  assert.equal(after.verdict, "budget_exceeded");
  assert.equal(after.scope, "week");
  assert.equal(after.cap_usd, 10);
  // UTC: both receipts fall in the UTC week starting Monday 00:00Z, so 10 already.
  assert.equal(hostedAgentVerdict({ agent, receipts, nowMs: MON_1AM }).scope, "week");
  // Preflight remainders stay day/month (week preflight is out of scope).
  assert.deepEqual(cachedAgentRemaining(snap, caps, [], MON_1AM, LA), { day: null, month: null, week: 6 }); // #271: week preflight remainder
});

test("#261 AC2: a week that starts in the previous month counts both months; month spend stays $3", () => {
  const agent = { id: "x", policy: { caps: { week: 10 } } };
  const receipts = [{ id: "a", ts: "2026-11-30T12:00:00Z", cost_usd: 8 }, { id: "b", ts: "2026-12-02T09:00:00Z", cost_usd: 3 }];
  const now = ms("2026-12-02T12:00:00Z");
  const v = hostedAgentVerdict({ agent, receipts, nowMs: now });
  assert.equal(v.verdict, "budget_exceeded");
  assert.equal(v.spent_usd, 11);
  const snap = agentSpendPolicy(receipts, now);
  assert.deepEqual(snap.spent, { day: 3, week: 11, month: 3 });
  assert.equal(cachedAgentVerdict(snap, { week: 10 }, [], now).spent_usd, 11);
  const tv = teamVerdict({ team: { name: "ops", agents: ["x"], week: 10 }, receiptsByAgent: { x: receipts }, nowMs: now });
  assert.deepEqual([tv.spend.week_usd, tv.spend.month_usd, tv.scope], [11, 3, "team:ops:week"]);
  // A receipt from an older month outside this week never counts.
  assert.equal(agentSpendPolicy([{ id: "o", ts: "2026-11-20T00:00:00Z", cost_usd: 99 }], now).spent.week, 0);
});

test("#261 AC3: team week cap, synced + unsynced spend, POST validation", () => {
  const orgAgents = [{ id: "a", orgId: "o" }, { id: "b", orgId: "o" }];
  assert.deepEqual(parseTeamInput({ name: "ops", agents: ["a", "b"], week: 20 }, { orgAgents, teams: [], orgId: "o" }), { name: "ops", agents: ["a", "b"], week: 20 });
  assert.throws(() => parseTeamInput({ name: "ops", agents: ["a"] }, { orgAgents, teams: [], orgId: "o" }), /day, week or month cap/);
  assert.throws(() => parseTeamInput({ name: "ops", agents: ["a"], week: 0 }, { orgAgents, teams: [], orgId: "o" }), /week cap must be a positive number/);
  const now = ms("2026-11-18T12:00:00Z");
  const team = { name: "ops", agents: ["a", "b"], week: 20 };
  const tv = teamVerdict({ team, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-16T10:00:00Z", cost_usd: 12 }] }, nowMs: now });
  assert.equal(tv.verdict, "ok");
  assert.deepEqual(tv.caps, { week: 20 });
  const cached = teamPolicy(tv, now);
  assert.equal(cached.spent.week, 12);
  assert.equal(validTeamPolicy(cached), true);
  const hit = cachedTeamVerdict(cached, [{ id: "p", ts: "2026-11-18T11:00:00Z", cost_usd: 9 }], now);
  assert.deepEqual(hit, { verdict: "budget_exceeded", reason: "budget_exceeded", scope: "team:ops:week", team: "ops", cap_usd: 20, spent_usd: 21 });
  // Next Monday, synced week spend no longer counts.
  assert.equal(cachedTeamVerdict(cached, [], ms("2026-11-23T00:00:01Z")), null);
});

test("#261 AC4 (#271: week is now a raise scope): caps.week validation; unknown cap keys are rejected", () => {
  assert.deepEqual(validatePolicy({ version: 1, caps: { week: 50 } }), []);
  for (const bad of [0, -1, "5"]) assert.deepEqual(validatePolicy({ version: 1, caps: { week: bad } }), ["caps.week must be a positive number"]);
  assert.match(validatePolicy({ version: 1, caps: { weekly: 5 } }).join(), /caps.weekly is not a cap scope/);
  assert.match(validatePolicy({ version: 1, caps: [] }).join(), /caps must be an object/);
  assert.equal(resolvePolicy({ fetched: { version: 1, caps: { week: 50, day: 9 } } }).caps.week, 50);
  assert.equal(resolvePolicy({ local: { week: 20 }, fetched: { version: 1, caps: { week: 50 } } }).caps.week, 20);
  assert.equal(raiseError({ week: [{ amount_usd: 1, expires_at: "2026-12-01T00:00:00Z", request_id: "r" }] }), null);
  assert.match(raiseError({ lifetime: [{ amount_usd: 1, expires_at: "2026-12-01T00:00:00Z", request_id: "r" }] }), /not a cap scope/);
  assert.equal(parseCapRequest({ scope: "week", amount_usd: 20, duration_hours: 4, reason: "x" }).scope, "week");
  // An old snapshot (no spent.week) is still a valid policy response and counts week from 0 + pending.
  const old = { spent: { day: 1, month: 2 }, unknown: 0, pending_batches: 0, as_of: "2026-11-18T00:00:00Z" };
  assert.equal(validAgentSpend(old), true);
  assert.equal(validAgentSpend({ ...old, spent: { ...old.spent, week: -1 } }), false);
  assert.equal(validTeamPolicy({ name: "ops", caps: { day: 5 }, spent: { day: 1, month: 2 }, unknown: 0, as_of: old.as_of }), true);
  assert.equal(cachedAgentVerdict(old, { week: 3 }, [{ id: "p", ts: "2026-11-18T01:00:00Z", cost_usd: 3 }], ms("2026-11-18T02:00:00Z")).scope, "week");
});

test("#261 AC5: week cap_approaching once, cap_hit, resolve and re-fire next week", () => {
  const caps = { week: 10 };
  const at = (spent, nowMs) => evaluateAlerts({ agentId: "x", caps, spend: { week: spent }, nowMs }, { warnFractions: [0.5], budgetPeriod: LA });
  const mon = ms("2026-11-16T20:00:00Z");
  const a5 = at(5, mon);
  assert.deepEqual(a5.map((a) => [a.kind, a.scope]), [["cap_approaching", "week"]]);
  const arm = {};
  const st = armWarnings(arm, { id: "x", scope: "week", cap: 10, spent: 5, nowMs: mon, budgetPeriod: LA });
  assert.equal(claimWarning(st, a5[0], [0.5]), true);
  assert.equal(claimWarning(armWarnings(arm, { id: "x", scope: "week", cap: 10, spent: 6, nowMs: mon + 3600_000, budgetPeriod: LA }), a5[0], [0.5]), false); // once per week
  assert.deepEqual(at(10, mon).map((a) => [a.kind, a.scope]), [["cap_hit", "week"]]);
  assert.equal(capPeriod("week", mon, LA), "2026-W47");
  const nextMon = ms("2026-11-23T08:00:00Z");
  assert.equal(capPeriod("week", nextMon, LA), "2026-W48");
  // New week: spend is 0 so nothing fires (the server resolves the open alerts), and it re-arms.
  assert.deepEqual(at(0, nextMon), []);
  assert.equal(claimWarning(armWarnings(arm, { id: "x", scope: "week", cap: 10, spent: 5, nowMs: nextMon, budgetPeriod: LA }), a5[0], [0.5]), true);
  // A blocked scope:"week" receipt pages cap_hit even under the cap.
  assert.deepEqual(evaluateAlerts({ agentId: "x", caps, spend: { week: 1 }, blockedReasons: ["budget_exceeded:week"], nowMs: mon }).map((a) => a.kind), ["cap_hit"]);
  // Team: same, with a team field.
  const tv = { name: "ops", caps: { week: 10 }, spend: { day_usd: 0, week_usd: 5, month_usd: 5, unknown_count: 0 }, verdict: "ok" };
  const ta = evaluateTeamAlerts({ orgId: "o", verdict: tv, nowMs: mon }, { warnFractions: [0.5] });
  assert.deepEqual(ta.map((a) => [a.kind, a.scope, a.team, a.key]), [["cap_approaching", "week", "ops", "cap_approaching:team:o:ops:week:p50"]]);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: { ...tv, spend: { ...tv.spend, week_usd: 10 } }, nowMs: mon }).map((a) => [a.kind, a.scope]), [["cap_hit", "week"]]);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: tv, blockedScopes: ["week"], nowMs: mon }).map((a) => a.kind), ["cap_hit"]);
  // Last week's block does not page after the local Monday rollover.
  const blocks = [{ reason: "budget_exceeded", scope: "week", ts: new Date(nextMon - 60_000).toISOString() }];
  assert.equal(blocksInCurrentPeriod(blocks, { reason: "budget_exceeded", nowMs: nextMon + 60_000, budgetPeriod: LA }).length, 0);
  assert.equal(blocksInCurrentPeriod(blocks, { reason: "budget_exceeded", nowMs: nextMon - 1000, budgetPeriod: LA }).length, 1);
});

test("#261 AC6: unknown cost in the current week refuses; a pending batch stays pending", () => {
  const now = ms("2026-12-02T12:00:00Z");
  const agent = { id: "x", policy: { caps: { week: 10 } } };
  // Unknown receipt on Nov 30 (previous month, current week) is still counted as unknown.
  const unknown = [{ id: "u", ts: "2026-11-30T12:00:00Z", cost_usd: null }];
  assert.equal(hostedAgentVerdict({ agent, receipts: unknown, nowMs: now }).verdict, "accounting_unavailable");
  const snap = agentSpendPolicy(unknown, now, null, null, { week: true }); // #267: the server passes the week cap
  assert.equal(snap.unknown, 1);
  assert.equal(cachedAgentVerdict({ ...snap, unknown: 0 }, { week: 10 }, [{ id: "p", ts: "2026-12-02T11:00:00Z", cost_usd: null }], now).verdict, "accounting_unavailable");
  const pending = [{ id: "pb", ts: "2026-11-30T12:00:00Z", cost_usd: null, reason: "batch_pending" }];
  const ps = agentSpendPolicy(pending, now, null, null, { week: true });
  assert.deepEqual([ps.unknown, ps.pending_batches], [0, 1]);
});

// ---- Hosted integration: API, wrapper policy payload, alerts sweep, audit, viewer, isolation.
async function fixture(t, clock) {
  const codes = {}, delivered = [];
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-261-")), "store.json");
  const origin = "http://localhost";
  const service = createHostedServer({ storePath, origin, secureCookies: false, stripeEnv: {}, now: () => clock.now, verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  // Regression: on loaded runners undici reused a socket the server had just
  // idle-closed (5s default) and fetch failed mid-test. Outlive the client.
  service.server.keepAliveTimeout = 60_000;
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth, method) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}/auth/verify`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code: codes[email] }) });
    return r.headers.get("set-cookie").split(";")[0];
  };
  return { request, login, delivered, service };
}

test("#261 hosted: caps.week API, budget week_usd, policy payload, team week, alerts and audit", async (t) => {
  const clock = { now: MON_1AM };
  const f = await fixture(t, clock);
  let owner = await f.login("week-owner@example.invalid");
  assert.equal((await f.request("/v1/budget-period", { timezone: "America/Los_Angeles" }, owner)).status, 200);
  const enroll = async (name) => (await f.request("/v1/enroll", { name }, null, (await f.request("/v1/enrollment-tokens", { caps: { week: 10 } }, owner)).body.token)).body;
  const a = await enroll("a-bot");
  const b = await enroll("b-bot");
  const url = `/v1/agents/${a.agentId}/policy`;
  for (const bad of [{ week: 0 }, { week: -1 }, { week: "5" }, { weekly: 5 }]) assert.equal((await f.request(url, { caps: bad }, owner)).status, 400, JSON.stringify(bad));
  assert.equal((await f.request(url, { caps: { week: 10 }, warnFractions: [0.5] }, owner)).status, 200);
  // Viewer: 403 on agent policy and teams.
  assert.equal((await f.request("/v1/invitations", { email: "week-viewer@example.invalid", role: "viewer" }, owner)).status, 201);
  const viewer = await f.login("week-viewer@example.invalid");
  assert.equal((await f.request(url, { caps: { week: 99 } }, viewer)).status, 403);
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [a.agentId], week: 5 }, viewer)).status, 403);
  // Audit has before/after for the week change.
  const ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
  const change = ev.audit.filter((e) => e.action === "policy.change").at(-1);
  assert.equal(change.detail.policy.caps.week, 10);
  // AC1 receipts: Sun 23:30 and Mon 00:30 local.
  await f.request("/v1/receipts", { receipts: [{ id: "s", ts: SUN_LATE, cost_usd: 6 }, { id: "m", ts: MON_EARLY, cost_usd: 4 }] }, null, a.token);
  let budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, viewer)).body;
  assert.equal(budget.ok, true);
  assert.equal(budget.budget_remaining.week_usd, 6);
  const pol = (await f.request("/v1/policy", undefined, null, a.token)).body;
  assert.equal(pol.caps.week, 10);
  assert.equal(pol.agent_spend.spent.week, 4);
  // Alerts: $5 of $10 week -> cap_approaching (week) once.
  await f.request("/v1/receipts", { receipts: [{ id: "m2", ts: new Date(MON_1AM - 60_000).toISOString(), cost_usd: 1 }] }, null, a.token);
  await f.service.evaluateFleetAlerts();
  await f.service.evaluateFleetAlerts();
  const weekAlerts = () => f.delivered.filter((x) => x.agentId === a.agentId && x.scope === "week");
  assert.deepEqual(weekAlerts().map((x) => x.kind), ["cap_approaching"]);
  // $10 -> cap_hit (week), and the budget verdict refuses.
  await f.request("/v1/receipts", { receipts: [{ id: "m3", ts: new Date(MON_1AM - 30_000).toISOString(), cost_usd: 5 }] }, null, a.token);
  await f.service.evaluateFleetAlerts();
  assert.deepEqual(weekAlerts().map((x) => x.kind), ["cap_approaching", "cap_hit"]);
  budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body;
  assert.deepEqual([budget.verdict, budget.scope, budget.cap_usd], ["budget_exceeded", "week", 10]);
  // Next local Monday: both resolve, nothing re-fires at $0.
  clock.now = ms("2026-11-23T08:30:00Z");
  await f.service.evaluateFleetAlerts();
  assert.equal(weekAlerts().length, 2);
  owner = await f.login("week-owner@example.invalid"); // sessions expire within a week
  const fleet = (await f.request("/v1/fleet", undefined, owner)).body;
  assert.equal(fleet.agents.find((x) => x.id === a.agentId).spend.week.usd, 0);
  // Crossed again in the new week: fires again.
  await f.request("/v1/receipts", { receipts: [{ id: "n1", ts: new Date(clock.now - 1000).toISOString(), cost_usd: 10 }] }, null, a.token);
  await f.service.evaluateFleetAlerts();
  assert.deepEqual(weekAlerts().map((x) => x.kind), ["cap_approaching", "cap_hit", "cap_hit"]);
  // Team with only a week cap: 200; with no cap: 400; audited.
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [b.agentId] }, owner)).status, 400);
  const team = await f.request("/v1/teams", { name: "ops", agents: [b.agentId], week: 20 }, owner);
  assert.equal(team.status, 200);
  assert.deepEqual(team.body.caps, { week: 20 });
  assert.equal(team.body.spend.week_usd, 0);
  const tchange = (await f.request("/v1/evidence.json", undefined, owner)).body.audit.filter((e) => e.action === "team.change").at(-1);
  assert.equal(tchange.detail.next.week, 20);
  await f.request("/v1/receipts", { receipts: [{ id: "t1", ts: new Date(clock.now - 1000).toISOString(), cost_usd: 21 }] }, null, b.token);
  const bpol = (await f.request("/v1/policy", undefined, null, b.token)).body;
  assert.deepEqual([bpol.team.caps.week, bpol.team.spent.week], [20, 21]);
  assert.equal(cachedTeamVerdict(bpol.team, [], clock.now, bpol.budget_period).scope, "team:ops:week");
  await f.service.evaluateFleetAlerts();
  assert.ok(f.delivered.some((x) => x.team === "ops" && x.scope === "week" && x.kind === "cap_hit"));
  // Cross-org isolation: another org never sees these agents' week spend.
  const other = await f.login("week-other@example.invalid");
  assert.equal((await f.request(`/v1/agents/${a.agentId}/budget`, undefined, other)).status, 404);
});
