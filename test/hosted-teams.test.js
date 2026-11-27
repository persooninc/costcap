// Issue #123 (SRM #3017): hosted team budgets. Unit, regression and wrapper tests.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import { evaluateTeamAlerts } from "../src/hosted/alerts.js";
import { createAlertDelivery } from "../src/hosted/delivery.js";
import { teamVerdict, cachedTeamVerdict, parseTeamInput, teamPolicy, validTeamPolicy, teamScope } from "../src/hosted/teams.js";
import { hostedAgentVerdict } from "../src/hosted/agent-verdict.js";
import { buildEvidence } from "../src/hosted/evidence.js";
import { createAgentBudgets } from "../src/agent-budget.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const team = { name: "ops", agents: ["a", "b"], day: 30 };

test("unit: team verdict sums members and matches the local agent-budget engine", () => {
  const receiptsByAgent = { a: [{ id: "1", ts: "2026-11-15T01:00:00Z", cost_usd: 20 }], b: [{ id: "1", ts: "2026-11-15T02:00:00Z", cost_usd: 10 }, { id: "2", ts: "2026-10-01T00:00:00Z", cost_usd: 99 }] };
  const v = teamVerdict({ team, receiptsByAgent, nowMs: NOW });
  assert.equal(v.verdict, "budget_exceeded");
  assert.equal(v.scope, "team:ops:day");
  assert.equal(v.spent_usd, 30);
  assert.deepEqual(v.spend, { day_usd: 30, month_usd: 30, unknown_count: 0, pending_batch_count: 0, cost_complete: true });
  const local = createAgentBudgets({ policy: { teams: { ops: { agents: ["a", "b"], day: 30 } } }, now: () => new Date(NOW),
    history: [{ id: "x", ts: "2026-11-15T01:00:00Z", cost_usd: 20, agent_id: "a" }, { id: "y", ts: "2026-11-15T02:00:00Z", cost_usd: 10, agent_id: "b" }] }).check({ agent_id: "a" });
  assert.equal(teamScope(local.team, local.scope), v.scope);
  assert.equal(teamVerdict({ team, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-15T01:00:00Z", cost_usd: 29.99 }] }, nowMs: NOW }).verdict, "ok");
  assert.equal(teamVerdict({ team: { name: "m", agents: ["a"], month: 5 }, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-01T01:00:00Z", cost_usd: 5 }, { id: "z", ts: "bad" }] }, nowMs: NOW }).scope, "team:m:month");
});

test("unit: an unknown cost from any member is accounting_unavailable, never $0", () => {
  const v = teamVerdict({ team, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-15T01:00:00Z", cost_usd: 1 }], b: [{ id: "1", ts: "2026-11-15T02:00:00Z", cost_usd: null }] }, nowMs: NOW });
  assert.equal(v.verdict, "accounting_unavailable");
  assert.equal(v.spend.cost_complete, false);
  assert.equal(v.unknown_receipts, 1);
  const hosted = hostedAgentVerdict({ agent: { id: "a", policy: { caps: {} } }, receipts: [], nowMs: NOW, team: v });
  assert.equal(hosted.verdict, "accounting_unavailable");
  assert.equal(hosted.team.name, "ops");
});

test("unit: agent cap applies before the team cap", () => {
  const tv = teamVerdict({ team, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-15T01:00:00Z", cost_usd: 30 }] }, nowMs: NOW });
  const own = hostedAgentVerdict({ agent: { id: "a", policy: { caps: { day: 5 } } }, receipts: [{ id: "1", ts: "2026-11-15T01:00:00Z", cost_usd: 30 }], nowMs: NOW, team: tv });
  assert.equal(own.scope, "day");
  const shared = hostedAgentVerdict({ agent: { id: "b", policy: { caps: {} } }, receipts: [], nowMs: NOW, team: tv });
  assert.equal(shared.verdict, "budget_exceeded");
  assert.equal(shared.scope, "team:ops:day");
  assert.equal(shared.cap_usd, 30);
});

test("unit: team input validation", () => {
  const ctx = { orgId: "o", orgAgents: [{ id: "a", orgId: "o" }, { id: "b", orgId: "o" }, { id: "x", orgId: "other" }], teams: [{ orgId: "o", name: "dev", agents: ["b"] }] };
  assert.deepEqual(parseTeamInput({ name: "ops", agents: ["a", "a"], day: 30 }, ctx), { name: "ops", agents: ["a"], day: 30 });
  assert.deepEqual(parseTeamInput({ name: "ops", remove: true }, ctx), { name: "ops", remove: true });
  for (const bad of [null, { name: "" }, { name: "has space", agents: ["a"], day: 1 }, { name: "ops", agents: [] , day: 1 }, { name: "ops", agents: ["x"], day: 1 },
    { name: "ops", agents: ["b"], day: 1 }, { name: "ops", agents: ["a"] }, { name: "ops", agents: ["a"], day: -1 }, { name: "ops", agents: ["a"], run: 1 }]) {
    assert.throws(() => parseTeamInput(bad, ctx), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(parseTeamInput({ name: "dev", agents: ["b"], month: 2, day: null }, ctx), { name: "dev", agents: ["b"], month: 2 });
});

test("unit: cached team policy enforces offline with unsynced spend and window rollover", () => {
  const p = teamPolicy(teamVerdict({ team, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-15T01:00:00Z", cost_usd: 25 }] }, nowMs: NOW }), NOW);
  assert.ok(validTeamPolicy(p));
  assert.ok(validTeamPolicy(null));
  assert.equal(validTeamPolicy({ ...p, unknown: -1 }), false);
  assert.equal(validTeamPolicy({ ...p, caps: { day: 0 } }), false);
  assert.equal(validTeamPolicy({ ...p, spent: { day: 1 } }), false);
  assert.equal(validTeamPolicy("x"), false);
  assert.equal(cachedTeamVerdict(null, [], NOW), null);
  assert.equal(cachedTeamVerdict(p, [], NOW), null);
  const pending = [{ ts: "2026-11-15T12:00:00Z", cost_usd: 5 }, { ts: "2026-11-15T12:00:00Z", cost_usd: 9, blocked: true }];
  assert.deepEqual(cachedTeamVerdict(p, pending, NOW), { verdict: "budget_exceeded", reason: "budget_exceeded", scope: "team:ops:day", team: "ops", cap_usd: 30, spent_usd: 30 });
  assert.equal(cachedTeamVerdict(p, pending, NOW + 86_400_000), null); // next UTC day: synced day spend no longer counts
  assert.equal(cachedTeamVerdict(p, [{ ts: "2026-11-15T12:00:00Z", cost_usd: null }], NOW).verdict, "accounting_unavailable");
  assert.equal(cachedTeamVerdict({ ...p, unknown: 1 }, [], NOW).verdict, "accounting_unavailable");
});

test("unit: evidence lists teams and each agent's team", () => {
  const tv = teamVerdict({ team, receiptsByAgent: {}, nowMs: NOW });
  const doc = buildEvidence({ orgId: "o", nowMs: NOW, spendFor: () => ({ day: { usd: 0, unknown: 0 }, month: { usd: 0, unknown: 0 } }), agents: [{ id: "a" }, { id: "z" }], teams: [tv] });
  assert.deepEqual(doc.teams, [{ name: "ops", agents: ["a", "b"], caps: { day: 30 }, spend: { day_usd: 0, month_usd: 0, unknown_count: 0, pending_batch_count: 0, cost_complete: true }, verdict: "ok", scope: null }]);
  assert.deepEqual(doc.agents.map((a) => a.team), ["ops", null]);
});

async function fixture(t, { deliverAlert } = {}) {
  let code;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-teams-")), "store.json");
  let service, port = 0;
  const start = async () => {
    service = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, stripeEnv: {}, verifyChallenge: async (v) => v === "ok", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert });
    service.server.keepAliveTimeout = 60_000;
    await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
    port = service.server.address().port; // restarts keep the URL the wrapper cached
  };
  await start();
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const url = () => `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`${url()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "ok" });
    return request("/auth/verify", { challengeId: c.body.challengeId, code });
  };
  const agent = async (cookie, name) => {
    const e = await request("/v1/enrollment-tokens", { caps: {} }, cookie);
    return (await request("/v1/enroll", { name }, null, e.body.token)).body;
  };
  return { request, login, agent, url, sweep: () => service.evaluateFleetAlerts(), restart: async () => { service.server.closeAllConnections(); await new Promise((r) => service.server.close(r)); await start(); } };
}

test("regression: /v1/teams roles, isolation, enforcement, evidence, removal, audit and restart", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("teams-owner@example.invalid");
  const outsider = await f.login("teams-out@example.invalid");
  await f.request("/v1/invitations", { email: "teams-viewer@example.invalid", role: "viewer" }, owner.cookie);
  const viewer = await f.login("teams-viewer@example.invalid");
  const rb = await f.agent(owner.cookie, "release-bot"), tb = await f.agent(owner.cookie, "triage-bot");
  const foreign = await f.agent(outsider.cookie, "foreign");
  const body = { name: "ops", agents: [rb.agentId, tb.agentId], day: 30 };
  // Criterion 1: admin creates; viewer 403; agent from another org 400.
  assert.equal((await f.request("/v1/teams", body, viewer.cookie)).status, 403);
  assert.equal((await f.request("/v1/teams", { ...body, agents: [rb.agentId, foreign.agentId] }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/teams", body)).status, 401);
  const created = await f.request("/v1/teams", body, owner.cookie);
  assert.equal(created.status, 200);
  assert.equal(created.body.verdict, "ok");
  assert.equal((await f.request("/v1/teams", undefined, viewer.cookie)).body.teams.length, 1);
  assert.equal((await f.request("/v1/teams", undefined, viewer.cookie)).body.canEdit, false);
  assert.equal((await f.request("/v1/teams", undefined, outsider.cookie)).body.teams.length, 0);
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [foreign.agentId], day: 1 }, outsider.cookie)).status, 200); // same name, separate org
  // Criterion 2: synced team spend reaches $30 -> each member's policy poll carries the refusal.
  const ts = new Date().toISOString();
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 20 }] }, null, rb.token);
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 10 }] }, null, tb.token);
  const polled = await f.request("/v1/policy", undefined, null, tb.token);
  assert.equal(polled.body.team.name, "ops");
  assert.equal(polled.body.team.spent.day, 30);
  assert.deepEqual(cachedTeamVerdict(polled.body.team, [], Date.now()).scope, "team:ops:day");
  // Criterion 4: budget route and evidence include the team verdict.
  const v = await f.request(`/v1/agents/${tb.agentId}/budget`, undefined, owner.cookie);
  assert.equal(v.body.verdict, "budget_exceeded");
  assert.equal(v.body.scope, "team:ops:day");
  assert.deepEqual(v.body.team.caps, { day: 30 });
  const ev = await f.request("/v1/evidence.json", undefined, owner.cookie);
  assert.equal(ev.body.teams[0].verdict, "budget_exceeded");
  assert.equal(ev.body.teams[0].spend.day_usd, 30);
  assert.equal(ev.body.agents.find((a) => a.agent_id === rb.agentId).team, "ops");
  assert.equal((await f.request("/v1/fleet", undefined, owner.cookie)).body.teams[0].name, "ops");
  // Criterion 3: a null cost from a member makes the team unknown.
  await f.request("/v1/receipts", { receipts: [{ id: "r2", ts, cost_usd: null }] }, null, rb.token);
  assert.equal((await f.request(`/v1/agents/${tb.agentId}/budget`, undefined, owner.cookie)).body.verdict, "accounting_unavailable");
  // Criterion 5: removing an agent stops its team enforcement at its next poll.
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [rb.agentId], day: 30 }, owner.cookie)).status, 200);
  assert.equal((await f.request("/v1/policy", undefined, null, tb.token)).body.team, null);
  const after = (await f.request(`/v1/agents/${tb.agentId}/budget`, undefined, owner.cookie)).body;
  assert.equal(after.verdict, "no_budget_policy"); // no own caps and no team left
  assert.equal(after.team, undefined);
  // Criterion 6: survives restart; every change audited with previous and next.
  await f.restart();
  assert.deepEqual((await f.request("/v1/teams", undefined, owner.cookie)).body.teams.map((x) => x.agents), [[rb.agentId]]);
  assert.equal((await f.request("/v1/teams", { name: "nope", remove: true }, owner.cookie)).status, 404);
  assert.equal((await f.request("/v1/teams", { name: "ops", remove: true }, owner.cookie)).body.removed, true);
  const changes = (await f.request("/v1/fleet", undefined, owner.cookie)).body.audit.filter((e) => e.action === "team.change");
  assert.equal(changes.length, 3);
  assert.equal(changes[0].detail.previous, null);
  assert.deepEqual(changes[1].detail.previous.agents, [rb.agentId, tb.agentId]);
  assert.deepEqual(changes[1].detail.next.agents, [rb.agentId]);
  assert.equal(changes[2].detail.next, null);
});

test("regression: a wrapper client refuses from its cached team policy after the cap, offline too", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("teams-wrap@example.invalid");
  const other = await f.agent(owner.cookie, "triage-bot");
  const e = await f.request("/v1/enrollment-tokens", { caps: {} }, owner.cookie);
  const dir = mkdtempSync(join(tmpdir(), "cc-teams-wrap-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "receipts.jsonl");
  const { agentId } = await enroll({ url: f.url(), token: e.body.token, name: "release-bot", path });
  writeFileSync(receiptsPath, "");
  const client = createFleetClient({ path, receiptsPath });
  assert.equal(client.teamCheck(), null);
  await f.request("/v1/teams", { name: "ops", agents: [agentId, other.agentId], day: 30 }, owner.cookie);
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts: new Date().toISOString(), cost_usd: 25 }] }, null, other.token);
  await client.sync();
  assert.equal(client.team().name, "ops");
  assert.equal(client.teamCheck(), null);
  // Local unsynced spend tips the shared total over the cap without a server round trip.
  writeFileSync(receiptsPath, JSON.stringify({ id: "local-1", ts: new Date().toISOString(), cost_usd: 5, agent_id: agentId }) + "\n");
  assert.equal(client.teamCheck().scope, "team:ops:day");
  // Restarted offline client keeps enforcing the cached team policy.
  await f.restart();
  const cached = createFleetClient({ path, receiptsPath });
  assert.equal(cached.teamCheck().verdict, "budget_exceeded");
  // After sync the local receipt counts once (server side), still over cap.
  await cached.sync();
  assert.equal(cached.teamCheck().spent_usd, 30);
  // Removal reaches the wrapper at its next poll.
  await f.request("/v1/teams", { name: "ops", remove: true }, owner.cookie);
  assert.equal((await cached.sync()).online, true);
  assert.equal(cached.teamCheck(), null);
});

// Issue #139: team caps raise cap_approaching / cap_hit alerts.
test("unit: evaluateTeamAlerts thresholds, blocked receipts, unknown cost", () => {
  const v = (day, extra = {}) => teamVerdict({ team, nowMs: NOW, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-15T01:00:00Z", cost_usd: day, ...extra }] } });
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: v(10) }), []);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: v(24) }), [{ kind: "cap_approaching", key: "cap_approaching:team:o:ops:day", team: "ops", scope: "day", cap: 30, spent: 24 }]);
  assert.equal(evaluateTeamAlerts({ orgId: "o", verdict: v(30) })[0].key, "cap_hit:team:o:ops:day");
  assert.equal(evaluateTeamAlerts({ orgId: "o", verdict: v(1), blockedScopes: ["day"] })[0].kind, "cap_hit");
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: v(null), blockedScopes: ["day"] }), []);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: null }), []);
  const nan = v(24); nan.spend.day_usd = NaN;
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: nan }), []);
  const m = teamVerdict({ team: { name: "m", agents: ["a"], month: 10 }, nowMs: NOW, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-02T00:00:00Z", cost_usd: 9 }] } });
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: m }).map((x) => x.key), ["cap_approaching:team:o:m:month"]);
});

test("unit: alert text names the team, scope, spend and cap", async () => {
  let sent;
  const deliver = createAlertDelivery({ slackWebhook: "https://hooks.slack.com/services/x", fetchImpl: async (_u, o) => { sent = JSON.parse(o.body).text; return { ok: true, status: 200 }; } });
  await deliver({ kind: "cap_hit", team: "ops", scope: "day", cap: 30, spent: 31 });
  assert.match(sent, /team ops, day \(spent \$31 of \$30 cap\)/);
});

test("regression: a two-agent team alerts once at 80% and once at 100%, re-arms, ignores unknown cost, clears on delete", async (t) => {
  const delivered = [];
  const f = await fixture(t, { deliverAlert: async (a) => { /* #279: cost_unknown pages are covered in unknown-cost-alerts.test.js */ if (a.kind !== "cost_unknown") delivered.push(a); return [{ status: "accepted" }]; } });
  const owner = await f.login("team-alerts@example.invalid");
  const rb = await f.agent(owner.cookie, "release-bot"), tb = await f.agent(owner.cookie, "triage-bot");
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [rb.agentId, tb.agentId], day: 30 }, owner.cookie)).status, 200);
  const ts = new Date().toISOString();
  const teamAlerts = async () => (await f.request("/v1/fleet", undefined, owner.cookie)).body.alerts.filter((a) => a.team && a.kind !== "cost_unknown");
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 12 }] }, null, rb.token);
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 13 }] }, null, tb.token);
  await f.sweep(); await f.sweep();
  assert.deepEqual(delivered.map((a) => a.kind), ["cap_approaching"]);
  assert.equal(delivered[0].team, "ops");
  assert.equal(delivered[0].spent, 25);
  await f.request("/v1/receipts", { receipts: [{ id: "r2", ts, cost_usd: 5 }] }, null, tb.token);
  await f.sweep(); await f.sweep();
  assert.deepEqual(delivered.map((a) => a.kind), ["cap_approaching", "cap_hit"]);
  assert.deepEqual((await teamAlerts()).filter((a) => a.active).map((a) => a.key), [`cap_hit:team:${delivered[1].orgId}:ops:day`]);
  // Per-agent alerts unchanged: agents with no own caps raise no cap alerts.
  assert.equal((await f.request("/v1/fleet", undefined, owner.cookie)).body.alerts.filter((a) => !a.team && a.kind.startsWith("cap")).length, 0);
  // Condition clears (cap raised), then re-arms when crossed again.
  await f.request("/v1/teams", { name: "ops", agents: [rb.agentId, tb.agentId], day: 100 }, owner.cookie);
  await f.sweep();
  assert.equal((await teamAlerts()).filter((a) => a.active).length, 0);
  await f.request("/v1/teams", { name: "ops", agents: [rb.agentId, tb.agentId], day: 30 }, owner.cookie);
  await f.sweep();
  assert.deepEqual(delivered.map((a) => a.kind), ["cap_approaching", "cap_hit", "cap_hit"]);
  // Issue #143: team alerts carry lifecycle fields; the re-fire is a new occurrence and the first one keeps its resolved_at.
  const hits = (await teamAlerts()).filter((a) => a.kind === "cap_hit");
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0].id, hits[1].id);
  assert.equal(hits[0].active, true);
  assert.equal(hits[0].resolved_at, null);
  assert.ok(!Number.isNaN(Date.parse(hits[0].fired_at)));
  assert.ok(!Number.isNaN(Date.parse(hits[1].resolved_at)));
  assert.equal(hits[1].active, false);
  // Unknown cost: no cap alert, even with a fresh team-scope block.
  await f.request("/v1/receipts", { receipts: [{ id: "r3", ts, cost_usd: null }, { id: "b1", ts, cost_usd: 0, blocked: true, reason: "budget_exceeded", scope: "team:ops:day" }] }, null, rb.token);
  await f.sweep();
  assert.equal((await teamAlerts()).filter((a) => a.active).length, 0);
  assert.equal(delivered.length, 3);
  // Deleting the team deactivates its alerts.
  await f.request("/v1/teams", { name: "ops", agents: [rb.agentId], day: 1 }, owner.cookie);
  await f.sweep();
  assert.equal((await teamAlerts()).filter((a) => a.active).length, 0);
});

test("regression: a team-scope block in the last hour raises cap_hit even when synced totals lag; delete clears it", async (t) => {
  const delivered = [];
  const f = await fixture(t, { deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  const owner = await f.login("team-block@example.invalid");
  const rb = await f.agent(owner.cookie, "release-bot");
  await f.request("/v1/teams", { name: "ops", agents: [rb.agentId], day: 30 }, owner.cookie);
  const now = Date.now();
  await f.request("/v1/receipts", { receipts: [
    { id: "old", ts: new Date(now - 2 * 3600_000).toISOString(), cost_usd: 0, blocked: true, reason: "budget_exceeded", scope: "team:ops:month" },
    { id: "b1", ts: new Date(now).toISOString(), cost_usd: 0, blocked: true, reason: "budget_exceeded", scope: "team:ops:day" },
  ] }, null, rb.token);
  await f.sweep();
  assert.deepEqual(delivered.map((a) => [a.kind, a.scope, a.team]), [["cap_hit", "day", "ops"]]);
  await f.request("/v1/teams", { name: "ops", remove: true }, owner.cookie);
  await f.sweep();
  const alerts = (await f.request("/v1/fleet", undefined, owner.cookie)).body.alerts.filter((a) => a.team);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].active, false);
});

// Issue #209: hosted agent, team and tag caps follow the org budget period.
import { readFileSync as readFixture209 } from "node:fs";
import { agentSpendPolicy as agentSpend209, cachedAgentVerdict as cachedAgent209, cachedTeamRemaining as teamRemaining209 } from "../src/hosted/teams.js";
import { fleetTagCapsPolicy as tagPolicy209, cachedFleetTagVerdict as tagVerdict209 } from "../src/hosted/tag-caps.js";
const fx209 = JSON.parse(readFixture209(new URL("./fixtures/budget-period/utc-vs-local-day.json", import.meta.url), "utf8"));
const NOW209 = Date.parse(fx209.nowMs);
const rows209 = fx209.receipts.map(({ id, ts, cost_usd }) => ({ id, ts, cost_usd }));
const known209 = rows209.filter((r) => r.cost_usd !== null);

test("#209 AC1: hosted agent and team verdicts count a 23:30 PST receipt toward the 15th", () => {
  const LA = { timezone: "America/Los_Angeles" };
  const now = Date.parse("2026-11-16T09:00:00Z");
  const receipts = [{ id: "a", ts: "2026-11-16T07:30:00Z", cost_usd: 2 }, { id: "b", ts: "2026-11-16T08:30:00Z", cost_usd: 3 }];
  const agent = { id: "ag", policy: { caps: { day: 4 } }, revoked: false };
  // UTC: both receipts are on the 16th -> $5 >= $4.
  assert.equal(hostedAgentVerdict({ agent, receipts, nowMs: now }).verdict, "budget_exceeded");
  const la = hostedAgentVerdict({ agent, receipts, nowMs: now, budgetPeriod: LA });
  assert.equal(la.verdict, "ok");
  assert.equal(la.budget_remaining.day_usd, 1);
  const team = { name: "ops", agents: ["ag"], day: 4 };
  assert.equal(teamVerdict({ team, receiptsByAgent: { ag: receipts }, nowMs: now }).verdict, "budget_exceeded");
  const tv = teamVerdict({ team, receiptsByAgent: { ag: receipts }, nowMs: now, budgetPeriod: LA });
  assert.equal(tv.verdict, "ok");
  assert.equal(tv.spend.day_usd, 3);
  const rules = [{ key: "customer", scope: "day", usd: 4 }];
  const tagged = receipts.map((r) => ({ ...r, tags: { customer: "acme" } }));
  assert.equal(tagPolicy209(rules, tagged, now).spend.customer.acme.day, 5);
  assert.equal(tagPolicy209(rules, tagged, now, undefined, LA).spend.customer.acme.day, 3);
});

test("#209 regression fixture: UTC day differs from local day (agent, team, tag)", () => {
  const bp = fx209.budgetPeriod;
  const utc = agentSpend209(rows209, NOW209);
  const local = agentSpend209(rows209, NOW209, bp);
  assert.deepEqual({ day: utc.spent.day, month: utc.spent.month }, { day: fx209.expect.utc.day_usd, month: fx209.expect.utc.month_usd });
  assert.deepEqual({ day: local.spent.day, month: local.spent.month }, { day: fx209.expect.local.day_usd, month: fx209.expect.local.month_usd });
  assert.equal(local.unknown, 1); // unknown cost is never $0
  const tv = teamVerdict({ team: { name: "t", agents: ["x"], month: 100 }, receiptsByAgent: { x: known209 }, nowMs: NOW209, budgetPeriod: bp });
  assert.deepEqual([tv.spend.day_usd, tv.spend.month_usd], [fx209.expect.local.day_usd, fx209.expect.local.month_usd]);
  const tp = tagPolicy209([{ key: "k", scope: "month", usd: 9 }], known209.map((r) => ({ ...r, tags: { k: "v" } })), NOW209, undefined, bp);
  assert.deepEqual(tp.spend.k.v, { day: fx209.expect.local.day_usd, month: fx209.expect.local.month_usd, unknown: 0 });
});

test("#209 AC5: cached (offline) verdicts roll over at the configured period, not UTC", () => {
  const LA = { timezone: "America/Los_Angeles" };
  // Synced at 20:00 PST on the 15th (04:00Z on the 16th): $3 today.
  const spend = { spent: { day: 3, month: 3 }, unknown: 0, as_of: "2026-11-16T04:00:00.000Z" };
  const caps = { day: 3 };
  // 07:30Z: same LA day -> still blocked; UTC would agree (same UTC day too).
  assert.equal(cachedAgent209(spend, caps, [], Date.parse("2026-11-16T07:30:00Z"), LA).verdict, "budget_exceeded");
  // 08:30Z: LA midnight passed -> synced day spend zeroed; UTC would still block.
  assert.equal(cachedAgent209(spend, caps, [], Date.parse("2026-11-16T08:30:00Z"), LA), null);
  assert.equal(cachedAgent209(spend, caps, [], Date.parse("2026-11-16T08:30:00Z")).verdict, "budget_exceeded");
  // UTC rollover at 00:00Z on the 17th is not an LA rollover (16:00 PST on the 16th).
  const spend2 = { ...spend, as_of: "2026-11-16T23:00:00.000Z" };
  assert.equal(cachedAgent209(spend2, caps, [], Date.parse("2026-11-17T01:00:00Z"), LA).verdict, "budget_exceeded");
  assert.equal(cachedAgent209(spend2, caps, [], Date.parse("2026-11-17T01:00:00Z")), null);
  const team = { name: "t", caps: { day: 3 }, spent: { day: 3, month: 3 }, unknown: 0, as_of: spend.as_of };
  assert.equal(cachedTeamVerdict(team, [], Date.parse("2026-11-16T08:30:00Z"), LA), null);
  assert.equal(cachedTeamVerdict(team, [{ id: "p", ts: "2026-11-16T08:40:00Z", cost_usd: 3 }], Date.parse("2026-11-16T08:50:00Z"), LA).verdict, "budget_exceeded");
  assert.deepEqual(teamRemaining209(team, [], Date.parse("2026-11-16T08:30:00Z"), LA), { day: 3, month: null });
  const tag = { rules: [{ key: "c", scope: "day", usd: 1 }], spend: { c: { a: { day: 1, month: 1, unknown: 0 } } }, truncated: false, as_of: spend.as_of };
  assert.equal(tagVerdict209(tag, [], { c: "a" }, [], Date.parse("2026-11-16T07:30:00Z"), LA).verdict, "tag_budget_exceeded");
  assert.equal(tagVerdict209(tag, [], { c: "a" }, [], Date.parse("2026-11-16T08:30:00Z"), LA), null);
});

test("#209 AC2: monthStartDay 15 opens a new month window for team caps", () => {
  const bp = { monthStartDay: 15 };
  const team = { name: "m", agents: ["x"], month: 5 };
  const receipts = [{ id: "a", ts: "2026-11-14T12:00:00Z", cost_usd: 5 }];
  assert.equal(teamVerdict({ team, receiptsByAgent: { x: receipts }, nowMs: Date.parse("2026-11-14T13:00:00Z"), budgetPeriod: bp }).verdict, "budget_exceeded");
  const fresh = teamVerdict({ team, receiptsByAgent: { x: receipts }, nowMs: Date.parse("2026-11-15T00:00:01Z"), budgetPeriod: bp });
  assert.equal(fresh.verdict, "ok");
  assert.equal(fresh.spend.month_usd, 0);
  // UTC (day 1) would keep both in November.
  assert.equal(teamVerdict({ team, receiptsByAgent: { x: receipts }, nowMs: Date.parse("2026-11-15T00:00:01Z") }).verdict, "budget_exceeded");
});
