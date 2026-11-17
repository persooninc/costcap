// Issue #265: lifetime "total" caps that never reset, for hosted agents
// (caps.total) and teams (total), enforced fleet-wide, alerted and kept
// through retention.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { periodKey } from "../src/period.js";
import { createAgentBudgets, assertAgentPolicy, budgetRemaining, totalCapMessage } from "../src/agent-budget.js";
import { validatePolicy, resolvePolicy, raiseError } from "../src/hosted/policy.js";
import { parseTeamInput, teamVerdict, teamPolicy, validTeamPolicy, cachedTeamVerdict, agentSpendPolicy, validAgentSpend, cachedAgentVerdict, cachedAgentRemaining } from "../src/hosted/teams.js";
import { hostedAgentVerdict } from "../src/hosted/agent-verdict.js";
import { evaluateAlerts, evaluateTeamAlerts, capPeriod, armWarnings, claimWarning, blocksInCurrentPeriod } from "../src/hosted/alerts.js";
import { isExpired, expiredReceiptKeys, totalCapAgents, retentionCutoffMs, retentionFloorMs } from "../src/hosted/retention.js";
import { parseCapRequest } from "../src/hosted/cap-requests.js";
import { createHostedServer } from "../src/hosted/server.js";

const ms = (iso) => Date.parse(iso);
const NOV = ms("2026-11-16T12:00:00Z");
const DEC = ms("2026-12-02T12:00:00Z");

test("#265 period: total is one period that never rolls over", () => {
  assert.equal(periodKey("total", ms("2020-01-01T00:00:00Z")), "total");
  assert.equal(periodKey("total", DEC, { timezone: "America/Los_Angeles", monthStartDay: 15 }), "total");
  assert.equal(capPeriod("total", NOV), capPeriod("total", DEC));
});

test("#265 agent-budget: total scope in spend/check/remaining and --policy files", () => {
  assert.doesNotThrow(() => assertAgentPolicy({ agents: { a: { total: 10 } }, teams: { t: { total: 15, agents: ["b"] } } }));
  assert.throws(() => assertAgentPolicy({ agents: { a: { total: 0 } } }), /Invalid a total cap/);
  assert.throws(() => assertAgentPolicy({ teams: { t: { total: -1, agents: ["b"] } } }), /Invalid team t total cap/);
  const history = [
    { id: "old", ts: "2025-03-01T00:00:00Z", cost_usd: 6, agent_id: "a" },
    { id: "now", ts: "2026-11-16T11:00:00Z", cost_usd: 3, agent_id: "a" },
    { id: "blk", ts: "2026-11-16T11:00:00Z", cost_usd: 50, agent_id: "a", blocked: true },
  ];
  const b = createAgentBudgets({ policy: { agents: { a: { total: 10, month: 100 } } }, history, now: () => new Date(NOV) });
  assert.equal(b.spend({ agent_id: "a" }).total, 9);
  assert.equal(b.spend({ agent_id: "a" }).month, 3);
  assert.equal(b.check({ agent_id: "a" }), null);
  const rem = budgetRemaining(b, { agent_id: "a", run_id: null });
  assert.deepEqual([rem.total_usd, rem.month_usd], [1, 97]);
  b.record({ id: "x", ts: "2026-11-16T11:30:00Z", cost_usd: 1.2, agent_id: "a" });
  const hit = b.check({ agent_id: "a" });
  assert.deepEqual([hit.verdict, hit.scope, hit.cap_usd, hit.retry_after_s], ["budget_exceeded", "total", 10, undefined]);
  assert.match(hit.message, /does not reset/);
  // No total cap: no total_usd key in remaining.
  const plain = createAgentBudgets({ policy: { agents: { a: { month: 100 } } }, history, now: () => new Date(NOV) });
  assert.equal("total_usd" in budgetRemaining(plain, { agent_id: "a", run_id: null }), false);
  // Team total via a local policy file.
  const team = createAgentBudgets({ policy: { teams: { ops: { total: 15, agents: ["a", "b"] } } }, history: [{ id: "1", ts: "2026-10-05T00:00:00Z", cost_usd: 8, agent_id: "a" }, { id: "2", ts: "2026-11-05T00:00:00Z", cost_usd: 7.1, agent_id: "b" }], now: () => new Date(NOV) });
  const th = team.check({ agent_id: "b" });
  assert.deepEqual([th.scope, th.team], ["total", "ops"]);
  assert.deepEqual(totalCapMessage("day", 1), {});
  assert.match(totalCapMessage("team:ops:total", 15).message, /\$15/);
});

test("#265 AC1: validation of caps.total and team total; total is a raise scope since #287", () => {
  for (const bad of [0, -1, "5", null]) assert.ok(validatePolicy({ version: 1, caps: { total: bad } }).length, String(bad));
  assert.deepEqual(validatePolicy({ version: 1, caps: { total: 10, month: 100 } }), []);
  assert.equal(raiseError({ total: [{ amount_usd: 5, expires_at: "2027-01-01T00:00:00Z", request_id: "r" }] }), null);
  assert.equal(parseCapRequest({ scope: "total", amount_usd: 5, duration_hours: 1, reason: "x" }).scope, "total");
  const orgAgents = [{ id: "a", orgId: "o" }, { id: "b", orgId: "o" }];
  assert.deepEqual(parseTeamInput({ name: "pilot", agents: ["a"], total: 50 }, { orgAgents, teams: [], orgId: "o" }), { name: "pilot", agents: ["a"], total: 50 });
  for (const total of [0, -5, "50"]) assert.throws(() => parseTeamInput({ name: "pilot", agents: ["a"], total }, { orgAgents, teams: [], orgId: "o" }), /total cap must be a positive number/);
  // The wrapper resolves caps.total like the other scopes (local can only tighten).
  assert.equal(resolvePolicy({ fetched: { version: 1, caps: { total: 10 } } }).caps.total, 10);
});

test("#265 AC2: hosted verdict counts every month; the wrapper's cached verdict refuses with scope total", () => {
  const agent = { id: "a", policy: { caps: { total: 10, month: 100 } } };
  const receipts = [{ id: "oct", ts: "2026-10-20T12:00:00Z", cost_usd: 6 }, { id: "nov", ts: "2026-11-10T12:00:00Z", cost_usd: 3 }];
  const v = hostedAgentVerdict({ agent, receipts, nowMs: NOV });
  assert.equal(v.ok, true);
  assert.deepEqual([v.budget_remaining.total_usd, v.budget_remaining.month_usd], [1, 97]);
  // Without a total cap the window stays the current month: no total_usd, old receipts ignored.
  const plain = hostedAgentVerdict({ agent: { id: "a", policy: { caps: { month: 100 } } }, receipts, nowMs: NOV });
  assert.equal("total_usd" in plain.budget_remaining, false);
  // Fleet snapshot with total, then a $1.20 unsynced call.
  const snap = agentSpendPolicy(receipts, NOV, null, null, { total: true });
  assert.equal(snap.spent.total, 9);
  assert.equal(validAgentSpend(snap), true);
  assert.equal("total" in agentSpendPolicy(receipts, NOV).spent, false);
  assert.equal(cachedAgentVerdict(snap, { total: 10, month: 100 }, [], NOV), null);
  const hit = cachedAgentVerdict(snap, { total: 10, month: 100 }, [{ id: "p", ts: "2026-11-16T11:00:00Z", cost_usd: 1.2 }], NOV);
  assert.deepEqual([hit.verdict, hit.scope, hit.cap_usd, hit.fleet, "retry_after_s" in hit], ["budget_exceeded", "total", 10, true, false]);
  assert.match(hit.message, /does not reset/);
  // Next month: still refused (the total never rolls over); raising the cap lifts it.
  const synced = agentSpendPolicy([...receipts, { id: "p", ts: "2026-11-16T11:00:00Z", cost_usd: 1.2 }], NOV, null, null, { total: true });
  assert.equal(cachedAgentVerdict(synced, { total: 10, month: 100 }, [], DEC).scope, "total");
  assert.equal(hostedAgentVerdict({ agent, receipts: [...receipts, { id: "p", ts: "2026-11-16T11:00:00Z", cost_usd: 1.2 }], nowMs: DEC }).scope, "total");
  assert.equal(cachedAgentVerdict(synced, { total: 20, month: 100 }, [], DEC), null);
  // Preflight remainders stay day/month (total preflight is out of scope).
  assert.equal(cachedAgentRemaining(synced, { total: 20 }, [], DEC), null);
});

test("#265 AC3: team total spans months and members; another org never counts", () => {
  const team = { orgId: "o", name: "pilot", agents: ["A", "B"], total: 15 };
  const receiptsByAgent = { A: [{ id: "1", ts: "2026-10-05T12:00:00Z", cost_usd: 8 }], B: [{ id: "2", ts: "2026-11-05T12:00:00Z", cost_usd: 7.1 }], C: [{ id: "3", ts: "2026-11-05T12:00:00Z", cost_usd: 100 }] };
  const v = teamVerdict({ team, receiptsByAgent, nowMs: NOV });
  assert.deepEqual([v.verdict, v.scope, v.cap_usd, v.spend.total_usd], ["budget_exceeded", "team:pilot:total", 15, 15.1]);
  const p = teamPolicy(v, NOV);
  assert.equal(p.spent.total, 15.1);
  assert.equal(validTeamPolicy(p), true);
  const hit = cachedTeamVerdict(p, [], DEC);
  assert.deepEqual([hit.scope, hit.team], ["team:pilot:total", "pilot"]);
  assert.match(hit.message, /does not reset/);
  // An agent verdict carries the team refusal.
  const av = hostedAgentVerdict({ agent: { id: "A", policy: { caps: {} } }, receipts: receiptsByAgent.A, nowMs: NOV, team: v });
  assert.equal(av.scope, "team:pilot:total");
  // A team without total keeps its windowed history (no total_usd).
  assert.equal("total_usd" in teamVerdict({ team: { ...team, total: undefined, month: 100 }, receiptsByAgent, nowMs: NOV }).spend, false);
  // Under the cap: ok, and a pending unsynced receipt pushes it over.
  const under = teamPolicy(teamVerdict({ team: { ...team, total: 20 }, receiptsByAgent, nowMs: NOV }), NOV);
  assert.equal(cachedTeamVerdict(under, [], NOV), null);
  assert.equal(cachedTeamVerdict(under, [{ id: "x", ts: "2026-11-16T11:00:00Z", cost_usd: 5 }], NOV).scope, "team:pilot:total");
});

test("#265 AC4: an old unknown-cost receipt makes a total cap accounting_unavailable; settling it adds to total", () => {
  const agent = { id: "a", policy: { caps: { total: 10 } } };
  const old = { id: "u", ts: new Date(NOV - 40 * 86_400_000).toISOString(), cost_usd: null };
  assert.equal(hostedAgentVerdict({ agent, receipts: [old], nowMs: NOV }).verdict, "accounting_unavailable");
  // Without a total cap the 40-day-old receipt is outside the windows (unchanged behavior).
  assert.equal(hostedAgentVerdict({ agent: { id: "a", policy: { caps: { month: 10 } } }, receipts: [old], nowMs: NOV }).verdict, "ok");
  assert.equal(agentSpendPolicy([old], NOV, null, null, { total: true }).unknown, 1);
  const team = { orgId: "o", name: "t", agents: ["a"], total: 10 };
  assert.equal(teamVerdict({ team, receiptsByAgent: { a: [old] }, nowMs: NOV }).verdict, "accounting_unavailable");
  // Settled (#125) at $2: the costed receipt adds $2.
  const settled = { ...old, cost_usd: 2 };
  assert.equal(hostedAgentVerdict({ agent, receipts: [settled], nowMs: NOV }).budget_remaining.total_usd, 8);
  assert.equal(agentSpendPolicy([settled], NOV, null, null, { total: true }).spent.total, 2);
  // The engine's settle() also moves an unknown into total.
  const b = createAgentBudgets({ policy: { agents: { a: { total: 10 } } }, history: [{ ...old, agent_id: "a" }], now: () => new Date(NOV) });
  assert.equal(b.check({ agent_id: "a" }).verdict, "accounting_unavailable");
  assert.equal(b.settle({ receipt_id: "u", settled_cost_usd: 2 }), true);
  assert.equal(b.spend({ agent_id: "a" }).total, 2);
  // A pending batch stays pending, not unknown.
  const ps = agentSpendPolicy([{ id: "pb", ts: old.ts, cost_usd: null, reason: "batch_pending" }], NOV, null, null, { total: true });
  assert.deepEqual([ps.unknown, ps.pending_batches], [0, 1]);
});

test("#265 AC5: total cap_approaching and cap_hit fire once across a month rollover", () => {
  const caps = { total: 10 };
  const at = (spent, nowMs) => evaluateAlerts({ agentId: "x", caps, spend: { total: spent }, nowMs }, { warnFractions: [0.8] });
  const a8 = at(8, NOV);
  assert.deepEqual(a8.map((a) => [a.kind, a.scope]), [["cap_approaching", "total"]]);
  const arm = {};
  assert.equal(claimWarning(armWarnings(arm, { id: "x", scope: "total", cap: 10, spent: 8, nowMs: NOV }), a8[0], [0.8]), true);
  // Next month: the arm state is the same period, so it does not re-fire.
  assert.equal(claimWarning(armWarnings(arm, { id: "x", scope: "total", cap: 10, spent: 8.5, nowMs: DEC }), a8[0], [0.8]), false);
  assert.deepEqual(at(10, DEC).map((a) => [a.kind, a.scope, a.key]), [["cap_hit", "total", "cap_hit:x:total"]]);
  // Cap raised above spend: nothing is active (the server resolves), and the warning re-arms.
  assert.deepEqual(evaluateAlerts({ agentId: "x", caps: { total: 100 }, spend: { total: 10 }, nowMs: DEC }, { warnFractions: [0.8] }), []);
  assert.equal(claimWarning(armWarnings(arm, { id: "x", scope: "total", cap: 100, spent: 10, nowMs: DEC }), a8[0], [0.8]), true);
  // A blocked scope:"total" receipt pages cap_hit.
  assert.deepEqual(evaluateAlerts({ agentId: "x", caps, spend: { total: 1 }, blockedReasons: ["budget_exceeded:total"], nowMs: NOV }).map((a) => [a.kind, a.scope]), [["cap_hit", "total"]]);
  const blocks = [{ reason: "budget_exceeded", scope: "team:ops:total", ts: new Date(DEC - 60_000).toISOString() }];
  assert.equal(blocksInCurrentPeriod(blocks, { reason: "budget_exceeded", nowMs: DEC, scopeOf: (r) => r.scope.slice("team:ops:".length) }).length, 1);
  // Team.
  const tv = { name: "ops", caps: { total: 10 }, spend: { day_usd: 0, week_usd: 0, month_usd: 0, total_usd: 8, unknown_count: 0 }, verdict: "ok" };
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: tv, nowMs: DEC }).map((a) => [a.kind, a.scope, a.key]), [["cap_approaching", "total", "cap_approaching:team:o:ops:total"]]);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: { ...tv, spend: { ...tv.spend, total_usd: 10 } }, nowMs: DEC }).map((a) => [a.kind, a.scope]), [["cap_hit", "total"]]);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: tv, blockedScopes: ["total"], nowMs: DEC }).map((a) => a.kind), ["cap_hit"]);
});

test("#265 AC6: retention keeps receipts that count toward a total cap", () => {
  const cutoff = retentionCutoffMs(7, NOV), floor = retentionFloorMs(NOV);
  const old = { receipt: { id: "r", ts: new Date(NOV - 60 * 86_400_000).toISOString(), cost_usd: 1 } };
  assert.equal(isExpired(old, cutoff, floor), true);
  const store = { "a:r": { ...old, orgId: "o", agentId: "a" }, "b:r": { ...old, orgId: "o", agentId: "b" }, "c:r": { ...old, orgId: "o", agentId: "c" } };
  const agents = [{ id: "a", orgId: "o", policy: { caps: { total: 10 } } }, { id: "b", orgId: "o", policy: { caps: {} } }, { id: "c", orgId: "o", policy: {} }, { id: "z", orgId: "other", policy: { caps: { total: 1 } } }];
  const teams = [{ orgId: "o", name: "t", agents: ["b"], total: 5 }, { orgId: "o", name: "u", agents: ["c"], month: 5 }];
  const keep = totalCapAgents(agents, teams, "o");
  assert.deepEqual([...keep].sort(), ["a", "b"]);
  assert.deepEqual(expiredReceiptKeys(store, "o", cutoff, floor, keep), ["c:r"]);
  // Cap removed: deleted on the next sweep.
  assert.deepEqual(expiredReceiptKeys(store, "o", cutoff, floor, totalCapAgents(agents.map((a) => ({ ...a, policy: {} })), [], "o")).sort(), ["a:r", "b:r", "c:r"]);
  assert.deepEqual(expiredReceiptKeys(store, "o", cutoff, floor).sort(), ["a:r", "b:r", "c:r"]); // default: no protection
});

// ---- Hosted integration: API, wrapper policy payload, alerts sweep, retention, audit, viewer.
async function fixture(t, clock) {
  const codes = {}, delivered = [];
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-265-")), "store.json");
  const origin = "http://localhost";
  const opts = { storePath, origin, secureCookies: false, stripeEnv: {}, now: () => clock.now, verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } };
  let service = createHostedServer(opts);
  const listen = async () => { await new Promise((r) => service.server.listen(0, "127.0.0.1", r)); };
  await listen();
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
  // Restart on the same store file (persistence check).
  const restart = async () => { service.server.closeAllConnections(); service.server.close(); service = createHostedServer(opts); await listen(); };
  return { request, login, delivered, get service() { return service; }, restart };
}

test("#265 hosted: caps.total API, budget total_usd, policy payload, team total, alerts, retention and audit", async (t) => {
  const clock = { now: ms("2026-10-20T12:00:00Z") };
  const f = await fixture(t, clock);
  let owner = await f.login("total-owner@example.invalid");
  const enroll = async (name) => (await f.request("/v1/enroll", { name }, null, (await f.request("/v1/enrollment-tokens", { caps: { month: 100 } }, owner)).body.token)).body;
  const a = await enroll("a-bot");
  const b = await enroll("b-bot");
  const c = await enroll("c-bot");
  const url = `/v1/agents/${a.agentId}/policy`;
  for (const bad of [{ total: 0 }, { total: -1 }, { total: "5" }]) assert.equal((await f.request(url, { caps: bad }, owner)).status, 400, JSON.stringify(bad));
  assert.equal((await f.request(url, { caps: { total: 10, month: 100 }, warnFractions: [0.8] }, owner)).status, 200);
  assert.equal((await f.request("/v1/invitations", { email: "total-viewer@example.invalid", role: "viewer" }, owner)).status, 201);
  let viewer = await f.login("total-viewer@example.invalid");
  assert.equal((await f.request(url, { caps: { total: 99 } }, viewer)).status, 403);
  assert.equal((await f.request("/v1/teams", { name: "pilot", agents: [b.agentId], total: 5 }, viewer)).status, 403);
  let change = (await f.request("/v1/evidence.json", undefined, owner)).body.audit.filter((e) => e.action === "policy.change").at(-1);
  assert.equal(change.detail.policy.caps.total, 10);
  assert.equal(change.detail.previous.caps.total, undefined);
  // October spend $6, then November $3.
  await f.request("/v1/receipts", { receipts: [{ id: "oct", ts: "2026-10-20T11:00:00Z", cost_usd: 6 }] }, null, a.token);
  clock.now = ms("2026-11-16T12:00:00Z");
  owner = await f.login("total-owner@example.invalid");
  viewer = await f.login("total-viewer@example.invalid");
  await f.request("/v1/receipts", { receipts: [{ id: "nov", ts: "2026-11-16T11:00:00Z", cost_usd: 3 }] }, null, a.token);
  // Survives a restart.
  await f.restart();
  let budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, viewer)).body;
  assert.deepEqual([budget.ok, budget.budget_remaining.total_usd, budget.budget_remaining.month_usd], [true, 1, 97]);
  let pol = (await f.request("/v1/policy", undefined, null, a.token)).body;
  assert.deepEqual([pol.caps.total, pol.agent_spend.spent.total, pol.agent_spend.spent.month], [10, 9, 3]);
  // The wrapper's cached verdict with a $1.20 unsynced call refuses with scope total.
  const hit = cachedAgentVerdict(pol.agent_spend, resolvePolicy({ fetched: pol }).caps, [{ id: "p", ts: "2026-11-16T11:30:00Z", cost_usd: 1.2 }], clock.now, pol.budget_period);
  assert.deepEqual([hit.scope, hit.cap_usd], ["total", 10]);
  // $9 of $10 (>= 80%): cap_approaching fires once across two sweeps.
  await f.service.evaluateFleetAlerts();
  await f.service.evaluateFleetAlerts();
  const totalAlerts = () => f.delivered.filter((x) => x.agentId === a.agentId && x.scope === "total");
  assert.deepEqual(totalAlerts().map((x) => x.kind), ["cap_approaching"]);
  await f.request("/v1/receipts", { receipts: [{ id: "p", ts: "2026-11-16T11:30:00Z", cost_usd: 1.2 }] }, null, a.token);
  await f.service.evaluateFleetAlerts();
  budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body;
  assert.deepEqual([budget.verdict, budget.scope, budget.cap_usd], ["budget_exceeded", "total", 10]);
  // Next month: still refused and no duplicate alert.
  clock.now = ms("2026-12-02T12:00:00Z");
  owner = await f.login("total-owner@example.invalid");
  await f.service.evaluateFleetAlerts();
  budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body;
  assert.equal(budget.scope, "total");
  const kinds = totalAlerts().map((x) => x.kind);
  assert.equal(kinds.filter((k) => k === "cap_hit").length, 1);
  // Raise to 20: the verdict lifts and the alert resolves.
  assert.equal((await f.request(url, { caps: { total: 20, month: 100 } }, owner)).status, 200);
  change = (await f.request("/v1/evidence.json", undefined, owner)).body.audit.filter((e) => e.action === "policy.change").at(-1);
  assert.deepEqual([change.detail.previous.caps.total, change.detail.policy.caps.total], [10, 20]);
  budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body;
  assert.equal(budget.ok, true);
  await f.service.evaluateFleetAlerts();
  const alerts = (await f.request("/v1/alerts", undefined, owner)).body;
  const list = alerts.alerts ?? alerts;
  assert.ok(list.filter((x) => x.agentId === a.agentId && x.scope === "total" && x.kind === "cap_hit").every((x) => !x.active));
  // Team with only a total cap.
  assert.equal((await f.request("/v1/teams", { name: "pilot", agents: [b.agentId, c.agentId] }, owner)).status, 400);
  const team = await f.request("/v1/teams", { name: "pilot", agents: [b.agentId, c.agentId], total: 15 }, owner);
  assert.equal(team.status, 200);
  assert.deepEqual(team.body.caps, { total: 15 });
  const tchange = (await f.request("/v1/evidence.json", undefined, owner)).body.audit.filter((e) => e.action === "team.change").at(-1);
  assert.equal(tchange.detail.next.total, 15);
  await f.request("/v1/receipts", { receipts: [{ id: "b1", ts: "2026-10-05T12:00:00Z", cost_usd: 8 }] }, null, b.token);
  await f.request("/v1/receipts", { receipts: [{ id: "c1", ts: "2026-12-01T12:00:00Z", cost_usd: 7.1 }] }, null, c.token);
  const bpol = (await f.request("/v1/policy", undefined, null, b.token)).body;
  assert.deepEqual([bpol.team.caps.total, bpol.team.spent.total], [15, 15.1]);
  assert.equal(cachedTeamVerdict(bpol.team, [], clock.now, bpol.budget_period).scope, "team:pilot:total");
  assert.equal((await f.request(`/v1/agents/${c.agentId}/budget`, undefined, owner)).body.scope, "team:pilot:total");
  await f.service.evaluateFleetAlerts();
  assert.ok(f.delivered.some((x) => x.team === "pilot" && x.scope === "total" && x.kind === "cap_hit"));
  // Retention 7 days: the 60-day-old receipt of A (own total) and B (team total) stay; D's goes.
  const d = await enroll("d-bot");
  await f.request("/v1/receipts", { receipts: [{ id: "d-old", ts: "2026-10-20T11:00:00Z", cost_usd: 1 }] }, null, d.token);
  assert.equal((await f.request("/v1/retention", { days: 7 }, owner)).status, 200);
  const ret = (await f.request("/v1/retention", undefined, owner)).body;
  assert.equal(ret.eligible_count, 1);
  f.service.purgeExpiredReceipts();
  assert.equal((await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body.budget_remaining.total_usd, 9.8);
  // Remove A's total cap: the next sweep deletes its old receipt.
  assert.equal((await f.request(url, { caps: { month: 100 } }, owner)).status, 200);
  assert.equal((await f.request("/v1/retention", undefined, owner)).body.eligible_count, 1); // A's "oct"
  f.service.purgeExpiredReceipts();
  assert.equal((await f.request("/v1/retention", undefined, owner)).body.eligible_count, 0);
  // Cross-org isolation.
  const other = await f.login("total-other@example.invalid");
  assert.equal((await f.request(`/v1/agents/${a.agentId}/budget`, undefined, other)).status, 404);
});
