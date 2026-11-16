import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { parseSpendQuery, spendBreakdown } from "../src/hosted/spend.js";

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
  for (const q of ["group_by=team", "since=bad", "until=2026-13-40"]) assert.equal((await f.request(`/v1/spend?${q}`, undefined, owner)).status, 400, q);
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
