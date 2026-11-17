// Issue #265: lifetime "total" caps that never reset, for hosted agents and teams
// (and local --policy files), enforced fleet-wide, alerted and kept through retention.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBudgets, assertAgentPolicy, budgetRemaining, TOTAL_NEVER_RESETS } from "../src/agent-budget.js";
import { validatePolicy, raiseError } from "../src/hosted/policy.js";
import { parseTeamInput, teamVerdict, teamPolicy, validTeamPolicy, cachedTeamVerdict, agentSpendPolicy, validAgentSpend, cachedAgentVerdict } from "../src/hosted/teams.js";
import { hostedAgentVerdict } from "../src/hosted/agent-verdict.js";
import { evaluateAlerts, evaluateTeamAlerts, capPeriod, armWarnings, claimWarning, blocksInCurrentPeriod } from "../src/hosted/alerts.js";
import { expiredReceiptKeys, isExpired, retentionCutoffMs, retentionFloorMs } from "../src/hosted/retention.js";
import { parseCapRequest } from "../src/hosted/cap-requests.js";
import { createHostedServer, costedReceipt } from "../src/hosted/server.js";

const ms = (iso) => Date.parse(iso);
const NOW = ms("2026-11-16T12:00:00Z");
const OCT = "2026-10-20T12:00:00Z";
const NOV = "2026-11-10T12:00:00Z";
const DEC = ms("2026-12-02T12:00:00Z");
const DAY = 86_400_000;

test("#265 engine: total sums every receipt, never resets, and refuses without a retry hint", () => {
  const history = [{ id: "a", ts: OCT, cost_usd: 6, agent_id: "x" }, { id: "b", ts: NOV, cost_usd: 3, agent_id: "x" }];
  const b = createAgentBudgets({ policy: { agents: { x: { total: 10, month: 100 } } }, history, now: () => new Date(NOW) });
  assert.equal(b.spend({ agent_id: "x" }).total, 9);
  assert.equal(b.check({ agent_id: "x" }), null);
  assert.deepEqual([budgetRemaining(b, { agent_id: "x" }).total_usd, budgetRemaining(b, { agent_id: "x" }).month_usd], [1, 97]);
  b.record({ id: "c", ts: new Date(NOW).toISOString(), cost_usd: 1.2, agent_id: "x" });
  const hit = b.check({ agent_id: "x" });
  assert.deepEqual(hit, { verdict: "budget_exceeded", reason: "budget_exceeded", scope: "total", cap_usd: 10, spent_usd: 10.2, message: TOTAL_NEVER_RESETS, agent_id: "x", run_id: null });
  assert.equal("retry_after_s" in hit, false);
  // Next month: still refused.
  const later = createAgentBudgets({ policy: { agents: { x: { total: 10 } } }, history: [...history, { id: "c", ts: NOV, cost_usd: 1.2, agent_id: "x" }], now: () => new Date(DEC) });
  assert.equal(later.check({ agent_id: "x" }).scope, "total");
  // Local --policy files accept total for agents and teams; 0/negative/strings refused.
  assert.doesNotThrow(() => assertAgentPolicy({ agents: { x: { total: 5 } }, teams: { t: { agents: ["y"], total: 9 } } }));
  for (const bad of [0, -1, "5"]) assert.throws(() => assertAgentPolicy({ agents: { x: { total: bad } } }), /Invalid x total cap/);
  // Team total in a local policy.
  const t = createAgentBudgets({ policy: { teams: { ops: { agents: ["x", "y"], total: 15 } } }, history: [{ id: "1", ts: OCT, cost_usd: 8, agent_id: "x" }, { id: "2", ts: NOV, cost_usd: 7.1, agent_id: "y" }], now: () => new Date(NOW) });
  assert.deepEqual([t.check({ agent_id: "y" }).scope, t.check({ agent_id: "y" }).team], ["total", "ops"]);
  // No total cap: no total_usd field.
  const none = createAgentBudgets({ policy: { agents: { x: { day: 5 } } }, history, now: () => new Date(NOW) });
  assert.equal("total_usd" in budgetRemaining(none, { agent_id: "x" }), false);
});

test("#265 AC1 unit: caps.total validation; total is not a raise scope", () => {
  assert.deepEqual(validatePolicy({ version: 1, caps: { total: 50 } }), []);
  for (const bad of [0, -1, "5", null]) assert.match(validatePolicy({ version: 1, caps: { total: bad } }).join(), /caps.total must be a positive number/);
  assert.match(raiseError({ total: [{ amount_usd: 1, expires_at: "2027-01-01T00:00:00Z", request_id: "r" }] }), /raise.total is not a cap scope/);
  assert.throws(() => parseCapRequest({ scope: "total", amount_usd: 5, duration_hours: 1, reason: "x" }), /scope must be one of/);
  const ctx = { orgId: "o", orgAgents: [{ id: "a", orgId: "o" }], teams: [] };
  assert.deepEqual(parseTeamInput({ name: "pilot", agents: ["a"], total: 50 }, ctx), { name: "pilot", agents: ["a"], total: 50 });
  for (const bad of [0, -2, "50"]) assert.throws(() => parseTeamInput({ name: "pilot", agents: ["a"], total: bad }, ctx), /Team total cap must be a positive number/);
  assert.throws(() => parseTeamInput({ name: "pilot", agents: ["a"] }, ctx), /day, week or month cap, or a total cap/);
});

test("#265 AC2 unit: hosted verdict counts last month; the cached wrapper verdict refuses with unsynced spend", () => {
  const agent = { id: "x", policy: { caps: { total: 10, month: 100 } } };
  const receipts = [{ id: "a", ts: OCT, cost_usd: 6 }, { id: "b", ts: NOV, cost_usd: 3 }];
  const v = hostedAgentVerdict({ agent, receipts, nowMs: NOW });
  assert.equal(v.ok, true);
  assert.deepEqual([v.budget_remaining.total_usd, v.budget_remaining.month_usd], [1, 97]);
  // Wrapper snapshot + one unsynced $1.20 call.
  const snap = agentSpendPolicy(receipts, NOW, null, null, { allTime: true });
  assert.deepEqual([snap.spent.total, snap.spent.month], [9, 3]);
  assert.equal(validAgentSpend(snap), true);
  assert.equal(cachedAgentVerdict(snap, agent.policy.caps, [], NOW), null);
  const hit = cachedAgentVerdict(snap, agent.policy.caps, [{ id: "c", ts: new Date(NOW).toISOString(), cost_usd: 1.2 }], NOW);
  assert.deepEqual([hit.verdict, hit.scope, hit.cap_usd, hit.spent_usd, hit.message], ["budget_exceeded", "total", 10, 10.2, TOTAL_NEVER_RESETS]);
  assert.equal("retry_after_s" in hit, false);
  // A snapshot from last month still counts toward total (it never rolls over).
  const synced = agentSpendPolicy([...receipts, { id: "c", ts: NOV, cost_usd: 1.2 }], NOW, null, null, { allTime: true });
  assert.equal(cachedAgentVerdict(synced, { total: 10 }, [], DEC).scope, "total");
  assert.equal(cachedAgentVerdict(synced, { total: 20 }, [], DEC), null);
  const full = hostedAgentVerdict({ agent, receipts: [...receipts, { id: "c", ts: NOV, cost_usd: 1.2 }], nowMs: DEC });
  assert.deepEqual([full.verdict, full.scope, full.cap_usd, full.message], ["budget_exceeded", "total", 10, TOTAL_NEVER_RESETS]);
  assert.equal(hostedAgentVerdict({ agent: { id: "x", policy: { caps: { total: 20 } } }, receipts: [...receipts, { id: "c", ts: NOV, cost_usd: 1.2 }], nowMs: DEC }).ok, true);
  // Without allTime the snapshot is unchanged (no total key).
  assert.equal("total" in agentSpendPolicy(receipts, NOW).spent, false);
});

test("#265 AC3 unit: team total across members and months; cached team verdict", () => {
  const team = { name: "pilot", agents: ["a", "b"], total: 15 };
  const v = teamVerdict({ team, nowMs: NOW, receiptsByAgent: { a: [{ id: "1", ts: OCT, cost_usd: 8 }], b: [{ id: "1", ts: NOV, cost_usd: 7.1 }] } });
  assert.deepEqual([v.verdict, v.scope, v.cap_usd, v.spent_usd, v.spend.total_usd, v.message], ["budget_exceeded", "team:pilot:total", 15, 15.1, 15.1, TOTAL_NEVER_RESETS]);
  const ok = teamVerdict({ team, nowMs: NOW, receiptsByAgent: { a: [{ id: "1", ts: OCT, cost_usd: 8 }] } });
  assert.equal(ok.verdict, "ok");
  const pol = teamPolicy(ok, NOW);
  assert.deepEqual([pol.caps.total, pol.spent.total], [15, 8]);
  assert.equal(validTeamPolicy(pol), true);
  const hit = cachedTeamVerdict(pol, [{ id: "p", ts: new Date(NOW).toISOString(), cost_usd: 7.1 }], DEC);
  assert.deepEqual([hit.scope, hit.message], ["team:pilot:total", TOTAL_NEVER_RESETS]);
  // Agent verdict carries the team's total hit.
  const av = hostedAgentVerdict({ agent: { id: "b", policy: {} }, receipts: [], nowMs: NOW, team: v });
  assert.deepEqual([av.verdict, av.scope, av.message], ["budget_exceeded", "team:pilot:total", TOTAL_NEVER_RESETS]);
  // A team without total keeps its old spend shape.
  assert.equal("total_usd" in teamVerdict({ team: { name: "m", agents: ["a"], month: 5 }, nowMs: NOW, receiptsByAgent: {} }).spend, false);
});

test("#265 AC4 unit: an old unknown receipt blocks a total cap; settling it adds its cost", () => {
  const old = new Date(NOW - 40 * DAY).toISOString();
  const agent = { id: "x", policy: { caps: { total: 10 } } };
  const items = [{ receipt: { id: "u", ts: old, cost_usd: null } }, { receipt: { id: "k", ts: NOV, cost_usd: 1 } }];
  const v = hostedAgentVerdict({ agent, receipts: items.map(costedReceipt), nowMs: NOW });
  assert.deepEqual([v.verdict, v.unknown_receipts], ["accounting_unavailable", 1]);
  // A month cap alone ignores that 40-day-old receipt (behaviour unchanged).
  assert.equal(hostedAgentVerdict({ agent: { id: "x", policy: { caps: { month: 10 } } }, receipts: items.map(costedReceipt), nowMs: NOW }).ok, true);
  assert.equal(agentSpendPolicy(items.map(costedReceipt), NOW, null, null, { allTime: true }).unknown, 1);
  items[0].settlement = { cost_usd: 2 };
  const settled = hostedAgentVerdict({ agent, receipts: items.map(costedReceipt), nowMs: NOW });
  assert.deepEqual([settled.ok, settled.budget_remaining.total_usd], [true, 7]);
  assert.equal(agentSpendPolicy(items.map(costedReceipt), NOW, null, null, { allTime: true }).spent.total, 3);
  // Team: an old unknown from a member makes the total unknowable.
  const tv = teamVerdict({ team: { name: "t", agents: ["x"], total: 10 }, nowMs: NOW, receiptsByAgent: { x: [{ id: "u", ts: old, cost_usd: null }] } });
  assert.equal(tv.verdict, "accounting_unavailable");
});

test("#265 AC5 unit: total alerts approach/hit once across a month rollover and resolve on raise", () => {
  const base = { agentId: "x", caps: { total: 10 }, nowMs: NOW };
  assert.equal(capPeriod("total", NOW), "total");
  assert.equal(capPeriod("total", DEC), "total");
  const warn = evaluateAlerts({ ...base, spend: { total: 8 } });
  assert.deepEqual(warn.map((a) => [a.kind, a.scope]), [["cap_approaching", "total"]]);
  const hit = evaluateAlerts({ ...base, spend: { total: 10 } });
  assert.deepEqual(hit.map((a) => [a.kind, a.scope, a.key]), [["cap_hit", "total", "cap_hit:x:total"]]);
  // Raised above spend: no alert, so the sweep resolves the active one.
  assert.deepEqual(evaluateAlerts({ ...base, caps: { total: 20 }, spend: { total: 10 } }), []);
  // A blocked total receipt pages cap_hit even without spend.
  assert.deepEqual(evaluateAlerts({ ...base, spend: {}, blockedReasons: ["budget_exceeded:total"] }).map((a) => a.kind), ["cap_hit"]);
  // Explicit fractions: once per cap, across months.
  const arm = {};
  const st = armWarnings(arm, { id: "x", scope: "total", cap: 10, spent: 8, nowMs: NOW });
  const alert = evaluateAlerts({ ...base, spend: { total: 8 } }, { warnFractions: [0.8] })[0];
  assert.equal(claimWarning(st, alert, [0.8]), true);
  const st2 = armWarnings(arm, { id: "x", scope: "total", cap: 10, spent: 8, nowMs: DEC });
  assert.equal(claimWarning(st2, alert, [0.8]), false);
  // Team total alerts.
  const verdict = { name: "pilot", caps: { total: 15 }, spend: { total_usd: 15.1, unknown_count: 0 }, verdict: "budget_exceeded" };
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict, nowMs: NOW }).map((a) => [a.kind, a.scope]), [["cap_hit", "total"]]);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: { ...verdict, spend: { total_usd: 12, unknown_count: 0 }, verdict: "ok" }, nowMs: NOW }).map((a) => a.kind), ["cap_approaching"]);
  // A blocked team total receipt counts in its (eternal) period.
  const blocks = blocksInCurrentPeriod([{ reason: "budget_exceeded", scope: "total", ts: new Date(NOW - 1000).toISOString() }], { reason: "budget_exceeded", nowMs: NOW });
  assert.equal(blocks.length, 1);
});

test("#265 AC6 unit: retention never deletes receipts that count toward a total cap", () => {
  const cutoff = retentionCutoffMs(7, NOW), floor = retentionFloorMs(NOW);
  const old = { orgId: "o", agentId: "x", receipt: { id: "r", ts: new Date(NOW - 60 * DAY).toISOString(), cost_usd: 1 } };
  assert.equal(isExpired(old, cutoff, floor), true);
  const receipts = { "x:r": old, "y:r": { ...old, agentId: "y" } };
  assert.deepEqual(expiredReceiptKeys(receipts, "o", cutoff, floor), ["x:r", "y:r"]);
  assert.deepEqual(expiredReceiptKeys(receipts, "o", cutoff, floor, new Set(["x"])), ["y:r"]);
});

// ---- Hosted integration: API, audit, viewer, persistence, policy payload, team, alerts, retention.
async function fixture(t, clock, storePath = join(mkdtempSync(join(tmpdir(), "cc-265-")), "store.json")) {
  const codes = {}, delivered = [];
  const origin = "http://localhost";
  const service = createHostedServer({ storePath, origin, secureCookies: false, stripeEnv: {}, now: () => clock.now, verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}/auth/verify`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code: codes[email] }) });
    return r.headers.get("set-cookie").split(";")[0];
  };
  return { request, login, delivered, service, storePath };
}

test("#265 hosted: caps.total API, audit, restart, budget, policy payload, team total, alerts, retention", async (t) => {
  const clock = { now: NOW };
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
  const viewer = await f.login("total-viewer@example.invalid");
  assert.equal((await f.request(url, { caps: { total: 99 } }, viewer)).status, 403);
  assert.equal((await f.request("/v1/teams", { name: "pilot", agents: [b.agentId], total: 5 }, viewer)).status, 403);
  const change = (await f.request("/v1/evidence.json", undefined, owner)).body.audit.filter((e) => e.action === "policy.change").at(-1);
  assert.equal(change.detail.policy.caps.total, 10);
  // Retention 7 days; the total-capped agent keeps a 60-day-old receipt even at ingest.
  assert.equal((await f.request("/v1/retention", { days: 7 }, owner)).status, 200);
  const ancient = new Date(NOW - 60 * DAY).toISOString();
  await f.request("/v1/receipts", { receipts: [{ id: "old", ts: ancient, cost_usd: 1 }, { id: "oct", ts: OCT, cost_usd: 5 }, { id: "nov", ts: NOV, cost_usd: 3 }] }, null, a.token);
  await f.request("/v1/receipts", { receipts: [{ id: "old", ts: new Date(NOW - 20 * DAY).toISOString(), cost_usd: 1 }] }, null, c.token);
  let budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, viewer)).body;
  assert.deepEqual([budget.ok, budget.budget_remaining.total_usd, budget.budget_remaining.month_usd], [true, 1, 97]);
  let pol = (await f.request("/v1/policy", undefined, null, a.token)).body;
  assert.deepEqual([pol.caps.total, pol.agent_spend.spent.total], [10, 9]);
  assert.equal(cachedAgentVerdict(pol.agent_spend, pol.caps, [{ id: "z", ts: new Date(NOW).toISOString(), cost_usd: 1.2 }], NOW, pol.budget_period).scope, "total");
  // Approaching at 90%.
  await f.service.evaluateFleetAlerts();
  const totalAlerts = () => f.delivered.filter((x) => x.agentId === a.agentId && x.scope === "total").map((x) => x.kind);
  assert.deepEqual(totalAlerts(), ["cap_approaching"]);
  await f.request("/v1/receipts", { receipts: [{ id: "z", ts: new Date(NOW - 1000).toISOString(), cost_usd: 1.2 }] }, null, a.token);
  await f.service.evaluateFleetAlerts();
  assert.deepEqual(totalAlerts(), ["cap_approaching", "cap_hit"]);
  budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body;
  assert.deepEqual([budget.verdict, budget.scope, budget.cap_usd, budget.message], ["budget_exceeded", "total", 10, TOTAL_NEVER_RESETS]);
  // Next month: still refused, nothing re-fires.
  clock.now = DEC;
  owner = await f.login("total-owner@example.invalid");
  await f.service.evaluateFleetAlerts();
  assert.deepEqual(totalAlerts(), ["cap_approaching", "cap_hit"]);
  assert.equal((await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body.scope, "total");
  // Retention sweep: a's ancient receipt survives, c's (no total cap) is deleted.
  clock.now = NOW + 40 * DAY;
  owner = await f.login("total-owner@example.invalid");
  assert.equal((await f.request("/v1/retention", undefined, owner)).body.eligible_count, 1);
  f.service.purgeExpiredReceipts();
  const fleet = (await f.request("/v1/fleet", undefined, owner)).body;
  assert.equal(fleet.agents.find((x) => x.id === a.agentId).spend.all.usd, 10.2);
  assert.equal(fleet.agents.find((x) => x.id === c.agentId).spend.all.usd, 0);
  // Raising the cap lifts the refusal and resolves the alert.
  assert.equal((await f.request(url, { caps: { total: 20, month: 100 }, warnFractions: [0.8] }, owner)).status, 200);
  assert.equal((await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body.ok, true);
  await f.service.evaluateFleetAlerts();
  // Removing the cap: the next sweep deletes a's ancient receipt.
  assert.equal((await f.request(url, { caps: { month: 100 } }, owner)).status, 200);
  f.service.purgeExpiredReceipts();
  assert.ok((await f.request("/v1/fleet", undefined, owner)).body.agents.find((x) => x.id === a.agentId).spend.all.usd < 10.2);
  // Team with only total: accepted, audited, refuses either member, survives a restart.
  const team = await f.request("/v1/teams", { name: "pilot", agents: [b.agentId], total: 15 }, owner);
  assert.equal(team.status, 200);
  assert.deepEqual([team.body.caps, team.body.spend.total_usd], [{ total: 15 }, 0]);
  const tchange = (await f.request("/v1/evidence.json", undefined, owner)).body.audit.filter((e) => e.action === "team.change").at(-1);
  assert.equal(tchange.detail.next.total, 15);
  await f.request("/v1/receipts", { receipts: [{ id: "t1", ts: OCT, cost_usd: 8 }, { id: "t2", ts: new Date(clock.now - 1000).toISOString(), cost_usd: 7.1 }] }, null, b.token);
  const bpol = (await f.request("/v1/policy", undefined, null, b.token)).body;
  assert.deepEqual([bpol.team.caps.total, bpol.team.spent.total], [15, 15.1]);
  assert.equal(cachedTeamVerdict(bpol.team, [], clock.now, bpol.budget_period).scope, "team:pilot:total");
  await f.service.evaluateFleetAlerts();
  assert.ok(f.delivered.some((x) => x.team === "pilot" && x.scope === "total" && x.kind === "cap_hit"));
  // Another org never sees it.
  const other = await f.login("total-other@example.invalid");
  assert.equal((await f.request(`/v1/agents/${b.agentId}/budget`, undefined, other)).status, 404);
  // Restart on the same store: caps.total and the team total persist.
  const g = await fixture(t, clock, f.storePath);
  const owner2 = await g.login("total-owner@example.invalid");
  const fleet2 = (await g.request("/v1/fleet", undefined, owner2)).body;
  assert.equal(fleet2.teams.find((x) => x.name === "pilot").caps.total, 15);
  const rb = (await g.request(`/v1/agents/${b.agentId}/budget`, undefined, owner2)).body;
  assert.equal(rb.scope, "team:pilot:total");
});
