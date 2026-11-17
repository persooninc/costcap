// Issue #271: week caps work like month caps everywhere: cap_projected, cap raises,
// --preflight remainders, Prometheus series and digest headroom.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAlerts, evaluateTeamAlerts, evaluateOrgAlerts, projectSpend, projectMonthSpend } from "../src/hosted/alerts.js";
import { validatePolicy, resolvePolicy, splitWeekRaise, raiseWeekError, LEGACY_RAISE_KEYS, RAISE_KEYS, effectiveCaps } from "../src/hosted/policy.js";
import { validatePolicy as legacyValidatePolicy, resolvePolicy as legacyResolvePolicy } from "./fixtures/policy-20194db.js";
import { parseCapRequest } from "../src/hosted/cap-requests.js";
import { cachedAgentRemaining, cachedTeamRemaining, cachedAgentVerdict } from "../src/hosted/teams.js";
import { cachedOrgRemaining } from "../src/hosted/org-budget.js";
import { buildMetrics, validateExposition } from "../src/hosted/metrics.js";
import { createAgentBudgets } from "../src/agent-budget.js";
import { startMeteringProxy } from "../src/proxy.js";
import { createHostedServer } from "../src/hosted/server.js";

const WED_NOON = Date.parse("2026-11-18T12:00:00Z"); // Wednesday, ISO 2026-W47 (week started Mon 11-16)
const NEXT_MON = Date.parse("2026-11-23T12:00:00Z");

test("AC1 unit: projectSpend over the ISO week; month projection unchanged", () => {
  // 2.5 of 7 days elapsed: $40 -> $112.
  assert.equal(Number(projectSpend("week", 40, WED_NOON).toFixed(6)), 112);
  assert.equal(projectSpend("week", 40, Date.parse("2026-11-16T12:00:00Z")), null); // under the 24 h floor
  assert.equal(projectMonthSpend(40, WED_NOON), projectSpend("month", 40, WED_NOON));
  assert.equal(projectSpend("week", "x", WED_NOON), null);
});

test("AC1 unit: agent, team and org week cap_projected; none under the cap; hit suppresses", () => {
  const agent = evaluateAlerts({ agentId: "a", caps: { week: 70 }, spend: { week: 40 }, unknown: { week: 1 }, nowMs: WED_NOON });
  const p = agent.find((x) => x.kind === "cap_projected");
  assert.deepEqual([p.scope, p.key, p.cap, p.spent, p.lowerBound], ["week", "cap_projected:a:week", 70, 40, true]);
  assert.ok(p.projected > 70);
  assert.equal(evaluateAlerts({ agentId: "a", caps: { week: 200 }, spend: { week: 40 }, nowMs: WED_NOON }).some((x) => x.kind === "cap_projected"), false);
  assert.equal(evaluateAlerts({ agentId: "a", caps: { week: 30 }, spend: { week: 40 }, nowMs: WED_NOON }).some((x) => x.kind === "cap_projected"), false);
  // Month-only output is unchanged by #271.
  const month = evaluateAlerts({ agentId: "a", caps: { month: 60 }, spend: { month: 40 }, nowMs: WED_NOON });
  assert.deepEqual(month.map((x) => [x.kind, x.scope]), [["cap_projected", "month"]]);
  const verdict = (caps, week) => ({ name: "ops", caps, spend: { day_usd: 0, week_usd: week, month_usd: week, unknown_count: 0 }, verdict: "ok" });
  const team = evaluateTeamAlerts({ orgId: "o", verdict: verdict({ week: 70 }, 40), nowMs: WED_NOON }).find((x) => x.kind === "cap_projected");
  assert.deepEqual([team.key, team.scope, team.team], ["cap_projected:team:o:ops:week", "week", "ops"]);
  assert.equal(evaluateTeamAlerts({ orgId: "o", verdict: verdict({ week: 200 }, 40), nowMs: WED_NOON }).length, 0);
  const org = evaluateOrgAlerts({ orgId: "o", verdict: verdict({ week: 70 }, 40), nowMs: WED_NOON }).find((x) => x.kind === "cap_projected");
  assert.deepEqual([org.key, org.scope, org.org], ["cap_projected:org:o:week", "week", true]);
  assert.equal(evaluateOrgAlerts({ orgId: "o", verdict: verdict({ week: 200 }, 40), nowMs: WED_NOON }).length, 0);
});

test("AC2 unit: week raises parse, stack onto caps.week and need a base week cap", () => {
  assert.deepEqual(RAISE_KEYS, ["run", "hour", "day", "week", "month"]);
  assert.equal(parseCapRequest({ scope: "week", amount_usd: 20, duration_hours: 24, reason: "big job" }).scope, "week");
  assert.throws(() => parseCapRequest({ scope: "total", amount_usd: 20, duration_hours: 24, reason: "x" }), /scope must be one of run\|hour\|day\|week\|month/);
  const policy = { version: 2, caps: { week: 10 }, raise: { week: [{ amount_usd: 20, expires_at: "2026-11-19T12:00:00Z", request_id: "r" }] } };
  assert.equal(effectiveCaps(policy, WED_NOON).week, 30);
  assert.equal(effectiveCaps(policy, Date.parse("2026-11-19T12:00:00Z")).week, 10);
  assert.equal(effectiveCaps({ ...policy, caps: {} }, WED_NOON).week, undefined);
  assert.equal(raiseWeekError(null), null);
  assert.equal(raiseWeekError(policy.raise.week), null);
  assert.ok(raiseWeekError([{ amount_usd: -1, expires_at: "x", request_id: "r" }]));
});

test("AC3 unit: splitWeekRaise keeps raise.week out of the legacy body; old validators accept it", () => {
  const stored = { version: 3, caps: { day: 5, week: 10 }, killed: false, raise: { day: [{ amount_usd: 1, expires_at: "2026-11-19T00:00:00Z", request_id: "d" }], week: [{ amount_usd: 20, expires_at: "2026-11-19T12:00:00Z", request_id: "w" }] } };
  const { policy, raise_week } = splitWeekRaise(stored);
  assert.equal("week" in policy.raise, false);
  assert.deepEqual(Object.keys(policy.raise), ["day"]);
  assert.deepEqual(raise_week, stored.raise.week);
  assert.deepEqual(legacyValidatePolicy(policy), []);
  assert.match(legacyValidatePolicy(stored).join(), /raise.week is not a cap scope/); // the trap the split avoids
  assert.deepEqual(validatePolicy(stored), []);
  // Week-only raise: the raise key disappears entirely.
  const only = splitWeekRaise({ version: 1, caps: { week: 10 }, raise: { week: stored.raise.week } });
  assert.equal("raise" in only.policy, false);
  assert.deepEqual(splitWeekRaise({ version: 1, caps: {} }), { policy: { version: 1, caps: {} }, raise_week: null });
  assert.ok(Object.keys(policy.raise).every((k) => LEGACY_RAISE_KEYS.includes(k)));
  // An old wrapper resolves the body with the base week cap and still applies a later kill.
  assert.equal(legacyResolvePolicy({ fetched: policy, nowMs: WED_NOON }).caps.week, 10);
  assert.equal(legacyResolvePolicy({ lastKnown: policy, fetched: { ...policy, version: 4, killed: true }, nowMs: WED_NOON }).killed, true);
  // A new wrapper folds raise_week back and enforces the raised cap until expiry.
  assert.equal(resolvePolicy({ fetched: { ...policy, raise: { ...policy.raise, week: raise_week } }, nowMs: WED_NOON }).caps.week, 30);
});

test("AC4 unit: cached remainders include week only when a week cap applies", () => {
  const as_of = "2026-11-18T08:00:00Z";
  assert.deepEqual(cachedAgentRemaining({ spent: { day: 0, week: 9, month: 9 }, unknown: 0, as_of }, { week: 10 }, [], WED_NOON), { day: null, month: null, week: 1 });
  assert.deepEqual(cachedAgentRemaining({ spent: { day: 0, week: 9, month: 9 }, unknown: 0, as_of }, { week: 10, month: 100 }, [], WED_NOON), { day: null, month: 91, week: 1 });
  assert.deepEqual(cachedAgentRemaining({ spent: { day: 0, week: 9, month: 9 }, unknown: 0, as_of }, { month: 100 }, [], WED_NOON), { day: null, month: 91 });
  // Unsynced receipts reduce the week remainder too.
  assert.deepEqual(cachedAgentRemaining({ spent: { day: 0, week: 8, month: 8 }, unknown: 0, as_of }, { week: 10 }, [{ id: "u", ts: "2026-11-18T09:00:00Z", cost_usd: 0.5 }], WED_NOON), { day: null, month: null, week: 1.5 });
  assert.deepEqual(cachedTeamRemaining({ name: "ops", caps: { week: 5 }, spent: { day: 0, week: 4, month: 4 }, unknown: 0, as_of }, [], WED_NOON), { day: null, month: null, week: 1 });
  assert.deepEqual(cachedOrgRemaining({ caps: { week: 20 }, spend: { day_usd: 0, week_usd: 19, month_usd: 19, unknown_count: 0 }, as_of }, [], WED_NOON), { day: null, month: null, week: 1 });
  assert.deepEqual(cachedOrgRemaining({ caps: { day: 20 }, spend: { day_usd: 0, week_usd: 19, month_usd: 19, unknown_count: 0 }, as_of }, [], WED_NOON), { day: 20, month: null });
  // Week raise is respected by the cached verdict.
  assert.equal(cachedAgentVerdict({ spent: { day: 0, week: 9.5, month: 9.5 }, unknown: 0, as_of }, { week: 30 }, [], WED_NOON), null);
});

// ---- AC4 proxy: week preflight refusal before the upstream ----
const COMPLETION = JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 10 } });
const BIG = JSON.stringify({ model: "gpt-4o", max_tokens: 300_000, messages: [{ role: "user", content: "hi" }] }); // ~$3 worst case

async function proxy(t, opts) {
  const up = { hits: 0 };
  await new Promise((res) => {
    up.server = http.createServer((q, s) => { up.hits += 1; q.resume(); q.on("end", () => s.writeHead(200, { "content-type": "application/json" }).end(COMPLETION)); });
    up.server.listen(0, "127.0.0.1", res);
  });
  t.after(() => up.server.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.server.address().port}` }, onReceipt: (x) => receipts.push(x), preflight: true, ...opts });
  t.after(() => server.close());
  const call = () => fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", body: BIG });
  return { up, call, receipts };
}

for (const [kind, fr, scope, extra] of [
  ["fleet agent", { agent: { day: null, month: null, week: 1 }, team: null, teamName: null, org: null }, "week", {}],
  ["hosted team", { agent: null, team: { day: null, month: null, week: 1 }, teamName: "ops", org: null }, "team:ops:week", { team: "ops" }],
  ["org", { agent: null, team: null, teamName: null, org: { day: null, month: null, week: 1 } }, "org:week", { org: true }],
]) {
  test(`AC4 proxy: ${kind} week remainder $1 refuses a $3 worst case before the upstream`, async (t) => {
    const { up, call, receipts } = await proxy(t, { fleetRemaining: () => fr });
    const r = await call();
    assert.equal(r.status, 429);
    const b = await r.json();
    assert.deepEqual([b.error, b.reason, b.fleet, b.scope, b.remaining_usd], ["budget_exceeded", "preflight_estimate", true, scope, 1]);
    for (const [k, v] of Object.entries(extra)) assert.equal(b[k], v);
    assert.equal(up.hits, 0);
    assert.deepEqual([receipts.length, receipts[0].blocked, receipts[0].cost_usd], [1, true, 0]);
  });
}

test("AC4 proxy: fleet week with room lets the call through", async (t) => {
  const { up, call } = await proxy(t, { fleetRemaining: () => ({ agent: { day: null, month: null, week: 50 }, team: null, teamName: null, org: null }) });
  assert.equal((await call()).status, 200);
  assert.equal(up.hits, 1);
});

test("AC4 proxy: --policy agent week_usd is checked (no fleet flag)", async (t) => {
  const now = new Date().toISOString();
  const agentBudgets = createAgentBudgets({ policy: { agents: { a1: { week: 10 } } }, history: [{ id: "h", ts: now, cost_usd: 9, agent_id: "a1" }] });
  const { up, call } = await proxy(t, { who: { agent_id: "a1" }, agentBudgets });
  const r = await call();
  assert.equal(r.status, 429);
  const b = await r.json();
  assert.deepEqual([b.reason, b.scope, b.remaining_usd, b.fleet], ["preflight_estimate", "week", 1, undefined]);
  assert.equal(up.hits, 0);
});

test("AC4 proxy: --max-concurrent 2 in-flight estimates reduce the fleet week remainder", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const up = { hits: 0 };
  await new Promise((res) => {
    up.server = http.createServer(async (q, s) => { up.hits += 1; q.resume(); await gate; s.writeHead(200, { "content-type": "application/json" }).end(COMPLETION); });
    up.server.listen(0, "127.0.0.1", res);
  });
  t.after(() => up.server.close());
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.server.address().port}` }, onReceipt: () => {}, preflight: true, maxConcurrent: 2,
    fleetRemaining: () => ({ agent: { day: null, month: null, week: 5 }, team: null, teamName: null, org: null }) });
  t.after(() => server.close());
  const call = () => fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", body: BIG });
  const first = call();
  while (up.hits < 1) await new Promise((r) => setTimeout(r, 5));
  const second = await call(); // $5 week - ~$3 in flight = ~$2 left < $3
  assert.equal(second.status, 429);
  assert.equal((await second.json()).scope, "week");
  release();
  assert.equal((await first).status, 200);
});

test("AC5 unit: /v1/metrics adds window=week spend and week cap series", () => {
  const agents = [{ id: "a", name: "wk", caps: { week: 10 }, policy: { caps: { week: 10 } }, lastSeen: WED_NOON }, { id: "b", name: "mo", caps: { month: 50 }, policy: { caps: { month: 50 } }, lastSeen: WED_NOON }];
  const teams = [{ name: "ops", agents: ["a"], caps: { week: 5 }, spend: { day_usd: 1, week_usd: 4, month_usd: 4 } }];
  const receipts = [{ agentId: "a", receipt: { id: "1", ts: "2026-11-17T10:00:00Z", cost_usd: 3 } }];
  const { body } = buildMetrics({ agents, teams, receipts, nowMs: WED_NOON });
  assert.deepEqual(validateExposition(body), []);
  assert.match(body, /costcap_spend_usd\{agent="wk",team="ops",window="week"\} 3/);
  assert.match(body, /costcap_spend_usd\{agent="mo",team="\(no team\)",window="week"\} 0/);
  assert.match(body, /costcap_spend_complete\{agent="wk",window="week"\} 1/);
  assert.match(body, /costcap_cap_usd\{scope="agent",name="wk",window="week"\} 10/);
  assert.match(body, /costcap_cap_remaining_usd\{scope="agent",name="wk",window="week"\} 7/);
  assert.match(body, /costcap_cap_usd\{scope="team",name="ops",window="week"\} 5/);
  assert.match(body, /costcap_cap_remaining_usd\{scope="team",name="ops",window="week"\} 1/);
  assert.doesNotMatch(body, /costcap_cap_usd\{scope="agent",name="mo",window="week"\}/);
});

// ---- Hosted end to end: projection dedupe/rollover, week raise lifecycle, policy body, digest ----
async function fixture(t, clock) {
  const codes = {}, delivered = [];
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-271-")), "store.json");
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

test("AC1 hosted: agent week cap_projected fires once per ISO week and re-arms next Monday", async (t) => {
  const clock = { now: WED_NOON };
  const f = await fixture(t, clock);
  const owner = await f.login("w271-proj@example.invalid");
  const tok = (await f.request("/v1/enrollment-tokens", { caps: { week: 70 } }, owner)).body.token;
  const a = (await f.request("/v1/enroll", { name: "proj-bot" }, null, tok)).body;
  await f.request("/v1/receipts", { receipts: [{ id: "1", ts: "2026-11-17T10:00:00Z", cost_usd: 40 }] }, null, a.token);
  await f.service.evaluateFleetAlerts();
  await f.service.evaluateFleetAlerts();
  const proj = () => f.delivered.filter((x) => x.kind === "cap_projected" && x.scope === "week");
  assert.equal(proj().length, 1);
  assert.ok(proj()[0].projected > 70);
  assert.equal(proj()[0].period, "2026-W47");
  clock.now = NEXT_MON;
  await f.request("/v1/receipts", { receipts: [{ id: "2", ts: "2026-11-23T01:00:00Z", cost_usd: 20 }] }, null, a.token);
  await f.service.evaluateFleetAlerts(); // 12 h into the week: under the 24 h floor, resolves last week's
  clock.now = Date.parse("2026-11-24T12:00:00Z");
  await f.service.evaluateFleetAlerts();
  await f.service.evaluateFleetAlerts();
  assert.equal(proj().length, 2);
  assert.equal(proj()[1].period, "2026-W48");
});

test("AC2/AC3/AC5 hosted: week raise approve, policy body split, budget, expiry audit, metrics and digest", async (t) => {
  const clock = { now: WED_NOON };
  const f = await fixture(t, clock);
  let owner = await f.login("w271-raise@example.invalid");
  const tok = (await f.request("/v1/enrollment-tokens", { caps: { week: 10 } }, owner)).body.token;
  const a = (await f.request("/v1/enroll", { name: "raise-bot" }, null, tok)).body;
  const noWeek = (await f.request("/v1/enroll", { name: "noweek-bot" }, null, (await f.request("/v1/enrollment-tokens", { caps: { day: 10 } }, owner)).body.token)).body;
  await f.request("/v1/receipts", { receipts: [{ id: "1", ts: "2026-11-17T10:00:00Z", cost_usd: 9.5 }] }, null, a.token);
  const ask = { scope: "week", amount_usd: 20, duration_hours: 24, reason: "big batch" };
  assert.equal((await f.request(`/v1/agents/${noWeek.agentId}/cap-requests`, ask, null, noWeek.token)).status, 400);
  const created = await f.request(`/v1/agents/${a.agentId}/cap-requests`, ask, null, a.token);
  assert.equal(created.status, 201);
  assert.equal((await f.request(`/v1/cap-requests/${created.body.id}/approve`, {}, owner)).status, 200);
  const budget = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body;
  assert.equal(budget.ok, true);
  assert.equal(budget.budget_remaining.week_usd, 20.5);
  // AC3: the policy body never carries raise.week and passes the 20194db validator.
  const pol = (await f.request("/v1/policy", undefined, null, a.token)).body;
  assert.equal(pol.raise?.week, undefined);
  assert.equal(pol.raise_week.length, 1);
  const { team, agent_spend, settlements, tag_caps, tag_caps_v2, budget_period, org_budget, org_budget_v2, model_caps_week, raise_week, ...legacyBody } = pol;
  assert.deepEqual(legacyValidatePolicy(legacyBody), []);
  assert.equal(resolvePolicy({ fetched: { ...legacyBody, raise: { ...(legacyBody.raise ?? {}), week: raise_week } }, nowMs: clock.now }).caps.week, 30);
  let ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
  assert.ok(ev.audit.some((e) => e.action === "cap_request.approve"));
  // AC5: metrics show the raised week cap; the digest headroom row is week.
  const metrics = await f.request("/v1/metrics", undefined, owner);
  assert.equal(metrics.status, 200);
  assert.match(metrics.body, /costcap_cap_usd\{scope="agent",name="raise-bot",window="week"\} 30/);
  const digest = await f.request("/v1/digest/preview", undefined, owner);
  assert.equal(digest.status, 200);
  assert.deepEqual([digest.body.digest.headroom.find((h) => h.name === "raise-bot").scope, digest.body.digest.headroom.find((h) => h.name === "raise-bot").cap_usd], ["week", 30]);
  // Expiry: back to the base cap, refused at week scope, audited.
  clock.now = WED_NOON + 25 * 3600_000;
  await f.service.evaluateFleetAlerts();
  owner = await f.login("w271-raise@example.invalid");
  const after = (await f.request(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body;
  assert.equal(after.budget_remaining.week_usd, 0.5);
  const verdict = cachedAgentVerdict({ spent: { day: 0, week: 9.5, month: 9.5 }, unknown: 0, as_of: new Date(clock.now).toISOString() }, resolvePolicy({ fetched: legacyBody, nowMs: clock.now }).caps, [{ id: "x", ts: new Date(clock.now).toISOString(), cost_usd: 5 }], clock.now);
  assert.deepEqual([verdict.verdict, verdict.scope], ["budget_exceeded", "week"]);
  ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
  assert.ok(ev.audit.some((e) => e.action === "cap_request.expire" && e.detail.scope === "week"));
  assert.equal((await f.request("/v1/policy", undefined, null, a.token)).body.raise_week, undefined);
});
