import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { parseSpendQuery, spendBreakdown, spendCsv, NO_TEAM, SPEND_CSV_COLUMNS } from "../src/hosted/spend.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
// 2 agents, 3 models, 3 UTC days, one unknown cost, one blocked call.
const FIXTURE = [
  { agentId: "a1", receipt: { id: "1", ts: "2026-11-14T23:59:59Z", model: "gpt-4.1", cost_usd: 0.123456 } },
  { agentId: "a1", receipt: { id: "2", ts: "2026-11-15T00:00:00Z", model: "gpt-4.1", cost_usd: 1.1 } },
  { agentId: "a2", receipt: { id: "3", ts: "2026-11-15T10:00:00Z", model: "claude-sonnet-4", cost_usd: 0.2 } },
  { agentId: "a2", receipt: { id: "4", ts: "2026-11-16T01:00:00+05:00", model: "o3", cost_usd: null } },
  { agentId: "a1", receipt: { id: "5", ts: "2026-11-16T08:00:00Z", model: "o3", cost_usd: 0, blocked: true } },
  { agentId: "a2", receipt: { id: "6", ts: "2026-11-16T09:00:00Z", model: "claude-sonnet-4", cost_usd: 0.000001 } },
];

test("spendBreakdown groups by UTC day, model and agent to 6 dp and buckets sum to the total", () => {
  const day = spendBreakdown(FIXTURE, { groupBy: "day" });
  assert.deepEqual(day.buckets.map((b) => [b.key, b.usd_known, b.calls, b.unknown_count, b.cost_complete]), [
    ["2026-11-14", 0.123456, 1, 0, true],
    ["2026-11-15", 1.3, 3, 1, false], // +05:00 local 16th is the 15th in UTC
    ["2026-11-16", 0.000001, 2, 0, true],
  ]);
  const model = spendBreakdown(FIXTURE, { groupBy: "model" });
  assert.deepEqual(Object.fromEntries(model.buckets.map((b) => [b.key, b.usd_known])), { "gpt-4.1": 1.223456, "claude-sonnet-4": 0.200001, o3: 0 });
  assert.equal(model.buckets.find((b) => b.key === "o3").blocked_count, 1);
  assert.equal(model.buckets.find((b) => b.key === "o3").cost_complete, false);
  const agent = spendBreakdown(FIXTURE, { groupBy: "agent", names: { a1: "worker" } });
  assert.deepEqual(agent.buckets.map((b) => [b.key, b.label, b.usd_known]), [["a1", "worker", 1.223456], ["a2", "a2", 0.200001]]);
  for (const r of [day, model, agent]) {
    assert.equal(r.total.usd_known, 1.423457);
    assert.equal(r.total.calls, 6);
    assert.equal(r.total.unknown_count, 1);
    assert.equal(r.total.blocked_count, 1);
    assert.equal(Math.round(r.buckets.reduce((n, b) => n + b.usd_known, 0) * 1e6) / 1e6, r.total.usd_known);
  }
});

test("settled unknown cost counts in its original day bucket; filters, clamp and bad input", () => {
  const settled = FIXTURE.map((x) => x.receipt.id === "4" ? { ...x, settlement: { cost_usd: 2 } } : x);
  const b = spendBreakdown(settled, { groupBy: "day" }).buckets.find((x) => x.key === "2026-11-15");
  assert.deepEqual([b.usd_known, b.unknown_count, b.cost_complete], [3.3, 0, true]);
  const q = parseSpendQuery(new URLSearchParams("group_by=model&since=2026-11-15&until=2026-11-15"));
  const r = spendBreakdown(FIXTURE, q);
  assert.equal(r.total.calls, 3);
  assert.equal(r.until, "2026-11-16T00:00:00.000Z");
  const instant = spendBreakdown(FIXTURE, parseSpendQuery(new URLSearchParams("until=2026-11-15T00:00:00Z")));
  assert.equal(instant.total.calls, 2);
  const clamped = spendBreakdown(FIXTURE, { since: Date.parse("2026-01-01"), cutoff: Date.parse("2026-11-15T00:00:00Z") });
  assert.equal(clamped.retention_clamped, true);
  assert.equal(clamped.since, "2026-11-15T00:00:00.000Z");
  assert.equal(clamped.total.calls, 5);
  assert.equal(spendBreakdown(FIXTURE, { since: Date.parse("2026-11-16"), cutoff: 0 }).retention_clamped, false);
  assert.equal(spendBreakdown([{ receipt: { ts: "nope" } }, { agentId: "x", receipt: { ts: "2026-11-16T00:00:00Z", cost_usd: 1 } }], { groupBy: "model" }).buckets[0].key, "unknown");
  for (const bad of ["group_by=run", "since=yesterday", "until=", "since=2026-11-16&until=2026-11-01", "since=12"]) assert.throws(() => parseSpendQuery(new URLSearchParams(bad)), (e) => e.status === 400, bad);
  assert.throws(() => spendBreakdown([], { groupBy: "x" }), (e) => e.status === 400);
  assert.equal(parseSpendQuery(new URLSearchParams("")).groupBy, "day");
});

async function serve(t, extra = {}) {
  let code;
  let clock = NOW;
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-spend-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {}, now: () => clock,
    verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, ...extra });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text(), cookie: r.headers.get("set-cookie")?.split(";")[0], get body() { return JSON.parse(this.text); } };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    return (await request("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  };
  const agent = async (cookie, name) => {
    const tok = await request("/v1/enrollment-tokens", {}, cookie);
    return (await request("/v1/enroll", { name }, null, tok.body.token)).body;
  };
  return { request, login, agent, setNow: (v) => { clock = v; } };
}

test("GET /v1/spend: session auth, viewer access, org isolation, 400s, settlement and regression of other endpoints", async (t) => {
  const f = await serve(t);
  assert.equal((await f.request("/v1/spend")).status, 401);
  const owner = await f.login("spend-owner@example.invalid");
  const outsider = await f.login("spend-outsider@example.invalid");
  const a1 = await f.agent(owner, "worker"), a2 = await f.agent(owner, "batch"), o = await f.agent(outsider, "theirs");
  const mine = { [a1.agentId]: a1, [a2.agentId]: a2 };
  const ids = { a1: a1.agentId, a2: a2.agentId };
  for (const x of FIXTURE) assert.equal((await f.request("/v1/receipts", { receipts: [x.receipt] }, null, mine[ids[x.agentId]].token)).status, 200);
  await f.request("/v1/receipts", { receipts: [{ id: "x", ts: "2026-11-15T00:00:00Z", cost_usd: 99, model: "gpt-4.1" }] }, null, o.token);
  const before = await Promise.all(["/v1/fleet", "/v1/receipts.csv", "/v1/evidence.json"].map((p) => f.request(p, undefined, owner)));
  const day = await f.request("/v1/spend?group_by=day", undefined, owner);
  assert.equal(day.status, 200);
  assert.equal(day.body.total.usd_known, 1.423457);
  assert.equal(day.body.retention_clamped, false);
  const agents = (await f.request("/v1/spend?group_by=agent", undefined, owner)).body;
  assert.deepEqual(agents.buckets.map((b) => b.label), ["worker", "batch"]);
  assert.equal((await f.request("/v1/spend?group_by=model", undefined, outsider)).body.total.usd_known, 99);
  for (const q of ["group_by=nope", "since=bad", "until=2026-13-40"]) assert.equal((await f.request(`/v1/spend?${q}`, undefined, owner)).status, 400, q);
  // Regression: the new route changes nothing in existing payloads.
  const after = await Promise.all(["/v1/fleet", "/v1/receipts.csv", "/v1/evidence.json"].map((p) => f.request(p, undefined, owner)));
  for (let i = 0; i < 3; i++) assert.equal(after[i].text, before[i].text);
  await f.request("/v1/invitations", { email: "spend-viewer@example.invalid", role: "viewer" }, owner);
  const viewer = await f.login("spend-viewer@example.invalid");
  assert.equal((await f.request("/v1/spend?group_by=model", undefined, viewer)).status, 200);
  const settled = await f.request("/v1/receipts/4/settle", { agent_id: ids.a2, cost_usd: 2, source: "manual_evidence", reason: "invoice" }, owner);
  assert.equal(settled.status, 200, settled.text);
  const d15 = (await f.request("/v1/spend?group_by=day&since=2026-11-15&until=2026-11-15", undefined, owner)).body.buckets;
  assert.deepEqual(d15.map((b) => [b.key, b.usd_known, b.unknown_count, b.cost_complete]), [["2026-11-15", 3.3, 0, true]]);
});

test("GET /v1/spend clamps to plan receipt retention when entitlements are enforced", async (t) => {
  const f = await serve(t, { enforceEntitlements: true, billingFactory: async () => ({ status: async () => ({ status: "free_beta" }), checkout: async () => ({}), portal: async () => ({}), webhook: async () => ({ received: true }) }) });
  const owner = await f.login("spend-ret@example.invalid");
  const a = await f.agent(owner, "old");
  await f.request("/v1/receipts", { receipts: [{ id: "old", ts: new Date(NOW - 40 * DAY).toISOString(), cost_usd: 5, model: "m" }, { id: "new", ts: new Date(NOW - DAY).toISOString(), cost_usd: 1, model: "m" }] }, null, a.token);
  const r = (await f.request("/v1/spend?since=2020-01-01", undefined, owner)).body;
  assert.equal(r.retention_clamped, true);
  assert.equal(r.since, new Date(NOW - 30 * DAY).toISOString());
  assert.equal(r.total.usd_known, 1);
});

// #184: cache hits and saved spend per bucket and in the total, for every group_by.
test("#184 spendBreakdown reports cache_hits and saved_usd; usd_known is unchanged by hits", () => {
  const ts = "2026-11-16T10:00:00Z";
  const items = [
    { agentId: "a1", receipt: { id: "m", ts, model: "gpt-4.1", cost_usd: 0.25, cache: "miss", tags: { env: "ci" } } },
    { agentId: "a1", receipt: { id: "h", ts, model: "gpt-4.1", cost_usd: 0, reason: "cache_hit", cache: "hit", saved_usd: 0.25, tags: { env: "ci" } } },
    { agentId: "a2", receipt: { id: "o", ts, model: "o3", cost_usd: 1 } },
  ];
  for (const groupBy of ["day", "model", "agent", "tag"]) {
    const r = spendBreakdown(items, { groupBy, tagKey: "env" });
    assert.equal(r.total.cache_hits, 1, groupBy);
    assert.equal(r.total.saved_usd, 0.25, groupBy);
    assert.equal(r.total.usd_known, 1.25, groupBy);
    assert.equal(r.buckets.reduce((n, b) => n + b.cache_hits, 0), 1);
    assert.equal(r.buckets.reduce((n, b) => n + b.saved_usd, 0), 0.25);
  }
  const model = spendBreakdown(items, { groupBy: "model" });
  assert.deepEqual(model.buckets.map((b) => [b.key, b.cache_hits, b.saved_usd]), [["o3", 0, 0], ["gpt-4.1", 1, 0.25]]);
});

test("#189 spendBreakdown splits user_prices spend; usd_known and cost_complete unchanged", () => {
  const ts = "2026-11-16T10:00:00Z";
  const items = [{ agentId: "a", receipt: { ts, model: "gpt-4.1", cost_usd: 0.5, cost_source: "table" } },
    { agentId: "a", receipt: { ts, model: "claude-sonnet-4-5", cost_usd: 0.24, cost_source: "user_prices" } },
    { agentId: "a", receipt: { ts, model: "o3", cost_usd: null, cost_source: "user_prices", reason: "user_price_unpriced" } }];
  const out = spendBreakdown(items, { groupBy: "day" });
  assert.equal(out.buckets[0].user_priced_count, 1);
  assert.equal(out.buckets[0].user_priced_usd, 0.24);
  assert.equal(out.total.usd_known, 0.74);
  assert.equal(out.total.cost_complete, false);
  assert.equal(out.total.unknown_count, 1);
  const byModel = spendBreakdown(items, { groupBy: "model" }).buckets.find((b) => b.key === "gpt-4.1");
  assert.equal(byModel.user_priced_count, 0);
});

// Issue #209: day buckets follow the org budget period and report it.
test("#209 spendBreakdown buckets by local date and reports budget_period", () => {
  const items = [
    { agentId: "a", receipt: { ts: "2026-11-16T07:30:00Z", cost_usd: 2, model: "m" } },
    { agentId: "a", receipt: { ts: "2026-11-16T08:30:00Z", cost_usd: null, model: "m" } },
  ];
  const utc = spendBreakdown(items, { groupBy: "day" });
  assert.deepEqual(utc.budget_period, { timezone: "UTC", monthStartDay: 1 });
  assert.deepEqual(utc.buckets.map((b) => b.key), ["2026-11-16"]);
  const la = spendBreakdown(items, { groupBy: "day", budgetPeriod: { timezone: "America/Los_Angeles" } });
  assert.deepEqual(la.budget_period, { timezone: "America/Los_Angeles", monthStartDay: 1 });
  assert.deepEqual(la.buckets.map((b) => [b.key, b.usd_known, b.unknown_count]), [["2026-11-15", 2, 0], ["2026-11-16", 0, 1]]);
  assert.equal(la.buckets[1].cost_complete, false); // unknown cost is never $0
});

// #213: team chargeback.
const TEAMS = [{ name: "core", agents: ["a1"] }, { name: "idle", agents: ["zz"] }];
test("#213 group_by=team: one bucket per team plus (no team), sum invariant, current membership", () => {
  const r = spendBreakdown(FIXTURE, { groupBy: "team", teams: TEAMS });
  assert.equal(r.team_membership, "current");
  assert.deepEqual(r.buckets.map((b) => [b.key, b.label, b.usd_known, b.calls, b.unknown_count, b.cost_complete]),
    [["core", "core", 1.223456, 3, 0, true], ["(no team)", "(no team)", 0.200001, 3, 1, false], ["idle", "idle", 0, 0, 0, true]]);
  for (const k of ["usd_known", "calls", "unknown_count", "blocked_count"]) assert.equal(Math.round(r.buckets.reduce((n, b) => n + b[k], 0) * 1e6) / 1e6, r.total[k], k);
  const none = spendBreakdown(FIXTURE, { groupBy: "team" });
  assert.deepEqual(none.buckets.map((b) => b.key), [NO_TEAM]);
  assert.equal(spendBreakdown(FIXTURE, { groupBy: "day" }).team_membership, undefined);
});

test("#213 team bucket: a settled unknown counts at its settled value, an unsettled one is never $0", () => {
  const items = FIXTURE.map((x) => x.receipt.id === "4" ? { ...x, settlement: { cost_usd: 2 } } : x);
  const b = spendBreakdown(items, { groupBy: "team", teams: [{ name: "batch", agents: ["a2"] }] }).buckets.find((x) => x.key === "batch");
  assert.deepEqual([b.usd_known, b.unknown_count, b.cost_complete], [2.200001, 0, true]);
});

test("#213 spendCsv: month and day periods follow the budget period, escaping, clamp and incomplete lines", () => {
  const items = [
    { agentId: "a1", receipt: { ts: "2026-10-31T23:30:00Z", cost_usd: 1, model: "m" } },
    { agentId: "a1", receipt: { ts: "2026-11-02T10:00:00Z", cost_usd: 2, model: "m" } },
    { agentId: "a2", receipt: { ts: "2026-11-03T10:00:00Z", cost_usd: null, model: "=cmd", blocked: true } },
  ];
  const utc = spendCsv(items, { groupBy: "team", period: "month", teams: [{ name: "core", agents: ["a1"] }] });
  const lines = utc.body.trim().split("\n");
  assert.match(lines[0], /^# cost_incomplete: 1 receipts/);
  assert.match(lines[1], /^# team_membership: current/);
  assert.equal(lines[2], SPEND_CSV_COLUMNS.join(","));
  assert.deepEqual(lines.slice(3), ["2026-10,team,core,core,1,1,0,true,0", "2026-10,team,(no team),(no team),0,0,0,true,0",
    "2026-11,team,core,core,2,1,0,true,0", "2026-11,team,(no team),(no team),0,1,1,false,1"]);
  // LA: Oct 31 23:30Z is Oct 31 local; a month starting on day 2 puts Nov 2 10:00Z in the Nov period, Oct 31 in the Oct one.
  const la = spendCsv(items, { groupBy: "model", period: "month", budgetPeriod: { timezone: "America/Los_Angeles", monthStartDay: 3 } });
  assert.deepEqual(la.body.trim().split("\n").filter((l) => !l.startsWith("#")).slice(1).map((l) => l.split(",").slice(0, 3).join(",")), ["2026-10,model,m", "2026-11,model,'=cmd"]);
  const day = spendCsv(items, { groupBy: "day", period: "day", cutoff: Date.parse("2026-11-01T00:00:00Z") });
  assert.match(day.body, /^# retention_clamped: since moved to 2026-11-01T00:00:00.000Z/);
  assert.equal(day.rows, 2);
  assert.throws(() => spendCsv(items, { period: "year" }), (e) => e.status === 400);
  assert.equal(parseSpendQuery(new URLSearchParams("group_by=team"), { csv: true }).period, "month");
  assert.throws(() => parseSpendQuery(new URLSearchParams("period=week"), { csv: true }), (e) => e.status === 400);
});

test("#213 GET /v1/spend?group_by=team and /v1/spend.csv: auth, viewer + viewer key, org isolation, 400s, other groups unchanged", async (t) => {
  const f = await serve(t);
  assert.equal((await f.request("/v1/spend.csv")).status, 401);
  const owner = await f.login("team-owner@example.invalid");
  const outsider = await f.login("team-outsider@example.invalid");
  const a1 = await f.agent(owner, "worker"), a2 = await f.agent(owner, "batch"), o = await f.agent(outsider, "theirs");
  const tok = { a1: a1.token, a2: a2.token };
  for (const x of FIXTURE) assert.equal((await f.request("/v1/receipts", { receipts: [x.receipt] }, null, tok[x.agentId])).status, 200);
  await f.request("/v1/receipts", { receipts: [{ id: "x", ts: "2026-11-15T00:00:00Z", cost_usd: 99, model: "gpt-4.1" }] }, null, o.token);
  const before = await Promise.all(["day", "model", "agent"].map((g) => f.request(`/v1/spend?group_by=${g}`, undefined, owner)));
  assert.equal((await f.request("/v1/teams", { name: "core", agents: [a1.agentId], day: 50 }, owner)).status, 200);
  assert.equal((await f.request("/v1/teams", { name: "spy", agents: [o.agentId], day: 50 }, outsider)).status, 200);
  const after = await Promise.all(["day", "model", "agent"].map((g) => f.request(`/v1/spend?group_by=${g}`, undefined, owner)));
  for (let i = 0; i < 3; i++) assert.equal(after[i].text, before[i].text);
  const team = (await f.request("/v1/spend?group_by=team", undefined, owner)).body;
  assert.equal(team.team_membership, "current");
  assert.deepEqual(team.buckets.map((b) => [b.key, b.usd_known, b.calls]), [["core", 1.223456, 3], ["(no team)", 0.200001, 3]]);
  const csv = await f.request("/v1/spend.csv?group_by=team&period=month&since=2026-11-01&until=2026-11-30", undefined, owner);
  assert.equal(csv.status, 200);
  assert.ok(!csv.text.includes("spy") && !csv.text.includes(",99,"));
  assert.ok(csv.text.includes("2026-11,team,core,core,1.223456,3,0,true,1"));
  await f.request("/v1/invitations", { email: "team-viewer@example.invalid", role: "viewer" }, owner);
  const viewer = await f.login("team-viewer@example.invalid");
  assert.equal((await f.request("/v1/spend.csv?group_by=team", undefined, viewer)).text, (await f.request("/v1/spend.csv?group_by=team", undefined, owner)).text);
  const key = (await f.request("/v1/api-keys", { name: "finance", role: "viewer" }, owner)).body.key;
  assert.equal((await f.request("/v1/spend.csv?group_by=team", undefined, null, key)).status, 200);
  assert.equal((await f.request("/v1/spend?group_by=team", undefined, null, key)).status, 200);
  for (const q of ["group_by=nope", "period=week", "since=bad", "until=2026-13-40"]) assert.equal((await f.request(`/v1/spend.csv?${q}`, undefined, owner)).status, 400, q);
});

// Issue #215: date-only since/until and range= follow the org budget period.
const LA = { timezone: "America/Los_Angeles", monthStartDay: 15 };
const LA_NOW = Date.parse("2026-11-20T12:00:00-08:00");
test("#215 parseSpendQuery: range=current_month|7d|30d and date-only since/until are local to the budget period (DST-safe)", () => {
  const q = (s, bp = LA, now = LA_NOW) => parseSpendQuery(new URLSearchParams(s), { budgetPeriod: bp, now });
  assert.equal(q("range=current_month").since, Date.parse("2026-11-15T00:00:00-08:00"));
  assert.equal(q("range=current_month").range, "current_month");
  // 7d: Nov 14..20 local; 30d: Oct 22 (PDT) .. Nov 20, spanning the Nov 1 fall-back.
  assert.equal(q("range=7d").since, Date.parse("2026-11-14T00:00:00-08:00"));
  assert.equal(q("range=30d").since, Date.parse("2026-10-22T00:00:00-07:00"));
  assert.equal(q("range=7d", null, Date.parse("2026-11-03T12:00:00-08:00")).since, Date.parse("2026-10-28T00:00:00Z"));
  assert.equal(q("range=7d", { timezone: "America/Los_Angeles" }, Date.parse("2026-11-03T12:00:00-08:00")).since, Date.parse("2026-10-28T00:00:00-07:00"));
  const d = q("since=2026-11-01&until=2026-11-01");
  assert.equal(d.since, Date.parse("2026-11-01T00:00:00-07:00"));
  assert.equal(d.until, Date.parse("2026-11-02T00:00:00-08:00")); // 25-hour fall-back day
  assert.equal(d.untilExclusive, true);
  // No budget period: identical to the old UTC behaviour.
  assert.deepEqual(q("since=2026-11-01&until=2026-11-01", null), parseSpendQuery(new URLSearchParams("since=2026-11-01&until=2026-11-01")));
  assert.equal(q("since=2026-11-01", null).since, Date.parse("2026-11-01T00:00:00Z"));
  // Previous behaviour with monthStartDay 1 at 18:00 PDT Oct 31: still October locally.
  assert.equal(q("range=current_month", { timezone: "America/Los_Angeles" }, Date.parse("2026-10-31T18:00:00-07:00")).since, Date.parse("2026-10-01T00:00:00-07:00"));
  for (const bad of ["range=week", "range=7d&since=2026-11-01"]) assert.throws(() => q(bad), (e) => e.status === 400, bad);
});

test("#215 /v1/spend and /v1/spend.csv with range=current_month under an LA/15th budget period", async (t) => {
  const f = await serve(t);
  f.setNow(LA_NOW);
  const owner = await f.login("range-owner@example.invalid");
  const a = await f.agent(owner, "solo");
  const receipts = [
    { id: "old", ts: "2026-11-10T12:00:00-08:00", cost_usd: 5, model: "gpt-4.1" },
    { id: "edge", ts: "2026-11-15T00:30:00-08:00", cost_usd: 1, model: "gpt-4.1" },
    { id: "late", ts: "2026-11-19T09:00:00-08:00", cost_usd: 2, model: "gpt-4.1" },
  ];
  assert.equal((await f.request("/v1/receipts", { receipts }, null, a.token)).status, 200);
  const utc = (await f.request("/v1/spend?since=2026-11-01", undefined, owner)).body;
  assert.equal(utc.since, "2026-11-01T00:00:00.000Z");
  assert.equal(utc.since_local, "2026-11-01");
  assert.equal(utc.range, undefined);
  assert.equal((await f.request("/v1/budget-period", LA, owner)).status, 200);
  const r = (await f.request("/v1/spend?range=current_month", undefined, owner)).body;
  assert.equal(r.range, "current_month");
  assert.equal(r.since, new Date(Date.parse("2026-11-15T00:00:00-08:00")).toISOString());
  assert.equal(r.since_local, "2026-11-15");
  assert.equal(r.total.usd_known, 3);
  assert.equal(r.total.calls, 2);
  const local = (await f.request("/v1/spend?since=2026-11-01", undefined, owner)).body;
  assert.equal(local.since, "2026-11-01T07:00:00.000Z");
  const csv = await f.request("/v1/spend.csv?group_by=team&period=month&range=current_month", undefined, owner);
  assert.equal(csv.status, 200);
  const rows = csv.text.split("\n").filter((l) => /^\d{4}-/.test(l));
  assert.deepEqual(rows, ["2026-11,team,(no team),(no team),3,2,0,true,0"]);
  assert.equal((await f.request("/v1/spend?range=bogus", undefined, owner)).status, 400);
  assert.equal((await f.request("/v1/spend.csv?range=7d&since=2026-11-01", undefined, owner)).status, 400);
});

// Issue #294: linear month-end forecast on /v1/spend for exactly the current budget month.
const D10 = Date.parse("2026-11-11T00:00:00.000Z"); // day 10 of 30: factor 3
const FC = [
  { agentId: "A", receipt: { id: "f1", ts: "2026-11-02T00:00:00Z", model: "m1", cost_usd: 30, tags: { customer: "acme" } } },
  { agentId: "B", receipt: { id: "f2", ts: "2026-11-05T00:00:00Z", model: "m2", cost_usd: 10 } },
  { agentId: "B", receipt: { id: "f0", ts: "2026-10-20T00:00:00Z", model: "m2", cost_usd: 500 } }, // last month
];
const fcOpts = (extra = {}) => ({ range: "current_month", since: Date.parse("2026-11-01T00:00:00Z"), now: D10, ...extra });
test("#294 AC1: forecast total and per-agent projections, unknown is a lower bound, settled counts", () => {
  const r = spendBreakdown(FC, { ...fcOpts(), groupBy: "agent" });
  assert.equal(r.forecast.method, "linear");
  assert.equal(r.forecast.period_end, "2026-12-01T00:00:00.000Z");
  assert.equal(r.forecast.period_end_local, "2026-12-01");
  assert.equal(r.forecast.period_start, "2026-11-01T00:00:00.000Z");
  assert.equal(r.forecast.elapsed_fraction, 0.333333);
  assert.deepEqual(r.forecast.total, { projected_usd: 120, lower_bound: false });
  assert.equal(r.forecast.reason, null);
  assert.deepEqual(r.buckets.map((b) => [b.key, b.projected_usd, b.lower_bound]), [["A", 90, false], ["B", 30, false]]);
  const unk = { agentId: "B", receipt: { id: "u", ts: "2026-11-06T00:00:00Z", model: "m2", cost_usd: null } };
  const lb = spendBreakdown([...FC, unk], { ...fcOpts(), groupBy: "agent" });
  assert.deepEqual(lb.forecast.total, { projected_usd: 120, lower_bound: true });
  assert.deepEqual(lb.buckets.map((b) => [b.key, b.projected_usd, b.lower_bound]), [["A", 90, false], ["B", 30, true]]);
  const settled = spendBreakdown([...FC, { ...unk, settlement: { cost_usd: 2 } }], { ...fcOpts(), groupBy: "agent" });
  assert.deepEqual(settled.forecast.total, { projected_usd: 126, lower_bound: false });
  assert.equal(settled.buckets.find((b) => b.key === "B").projected_usd, 36);
});
test("#294 AC2: too early, other windows null, retention clamp", () => {
  const early = spendBreakdown(FC, { ...fcOpts({ now: Date.parse("2026-11-01T12:00:00Z") }), groupBy: "agent" });
  assert.deepEqual(early.forecast.total, { projected_usd: null, lower_bound: false });
  assert.equal(early.forecast.reason, "too_early");
  assert.equal(early.buckets[0].projected_usd, null);
  for (const o of [{ range: "7d" }, { range: "30d" }, { range: null }, { until: D10 }]) assert.equal(spendBreakdown(FC, { ...fcOpts(o), groupBy: "agent" }).forecast, null);
  assert.equal(spendBreakdown(FC, { since: 0, groupBy: "agent", now: D10 }).forecast, null);
  assert.equal(spendBreakdown(FC, { ...fcOpts(), now: null }).forecast, null);
  const clamped = spendBreakdown(FC, { ...fcOpts(), groupBy: "agent", cutoff: Date.parse("2026-11-04T00:00:00Z") });
  assert.equal(clamped.forecast.reason, "retention_clamped");
  assert.equal(clamped.forecast.total, null);
  assert.equal(clamped.buckets[0].projected_usd, undefined);
  // A cutoff before the period start does not clamp the month.
  assert.deepEqual(spendBreakdown(FC, { ...fcOpts(), cutoff: Date.parse("2026-10-01T00:00:00Z") }).forecast.total, { projected_usd: 120, lower_bound: false });
});
test("#294 AC4: LA/15th period and which group_by values carry bucket projections", () => {
  const now = Date.parse("2026-11-25T00:00:00-08:00"); // 10 of 30 local days
  const items = [{ agentId: "A", receipt: { id: "1", ts: "2026-11-16T00:00:00-08:00", model: "m", cost_usd: 10, tags: { customer: "acme" } } }];
  const opts = { range: "current_month", since: Date.parse("2026-11-15T00:00:00-08:00"), now, budgetPeriod: LA, teams: [{ name: "core", agents: ["A"] }] };
  const team = spendBreakdown(items, { ...opts, groupBy: "team" });
  assert.equal(team.forecast.period_end_local, "2026-12-15");
  assert.equal(team.forecast.period_end, new Date(Date.parse("2026-12-15T00:00:00-08:00")).toISOString());
  assert.equal(team.forecast.total.projected_usd, 30);
  assert.equal(team.buckets.find((b) => b.key === "core").projected_usd, 30);
  assert.equal(spendBreakdown(items, { ...opts, groupBy: "tag", tagKey: "customer" }).buckets[0].projected_usd, 30);
  assert.equal(spendBreakdown(items, { ...opts, groupBy: "model" }).buckets[0].projected_usd, 30);
  for (const g of ["day", "outcome"]) {
    const r = spendBreakdown(items, { ...opts, groupBy: g });
    assert.equal(r.forecast.total.projected_usd, 30);
    assert.ok(r.buckets.every((b) => !("projected_usd" in b)), g);
  }
});
test("#294 GET /v1/spend forecast: viewer sees the same values, another org never changes them", async (t) => {
  const f = await serve(t);
  f.setNow(D10);
  const owner = await f.login("fc-owner@example.invalid"), outsider = await f.login("fc-out@example.invalid");
  const a = await f.agent(owner, "A"), b = await f.agent(owner, "B"), o = await f.agent(outsider, "O");
  await f.request("/v1/receipts", { receipts: [FC[0].receipt] }, null, a.token);
  await f.request("/v1/receipts", { receipts: [FC[1].receipt] }, null, b.token);
  await f.request("/v1/receipts", { receipts: [{ id: "x", ts: "2026-11-03T00:00:00Z", cost_usd: 99, model: "m" }] }, null, o.token);
  const r = (await f.request("/v1/spend?group_by=agent&range=current_month", undefined, owner)).body;
  assert.deepEqual(r.forecast.total, { projected_usd: 120, lower_bound: false });
  assert.deepEqual(r.buckets.map((x) => [x.label, x.projected_usd]), [["A", 90], ["B", 30]]);
  await f.request("/v1/invitations", { email: "fc-viewer@example.invalid", role: "viewer" }, owner);
  const viewer = await f.login("fc-viewer@example.invalid");
  assert.deepEqual((await f.request("/v1/spend?group_by=agent&range=current_month", undefined, viewer)).body.forecast, r.forecast);
  assert.equal((await f.request("/v1/spend?group_by=agent&range=7d", undefined, owner)).body.forecast, null);
  assert.equal((await f.request("/v1/spend?group_by=agent&since=2026-11-01", undefined, owner)).body.forecast, null);
});
