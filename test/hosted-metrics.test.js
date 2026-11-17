// Issue #220: Prometheus /v1/metrics scrape endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetrics, escapeLabel, validateExposition, METRICS_CONTENT_TYPE } from "../src/hosted/metrics.js";
import { ALERT_KINDS } from "../src/hosted/alerts.js";
import { createHostedServer } from "../src/hosted/server.js";
import { openStore } from "../src/hosted/store.js";
import { createApiKey } from "../src/hosted/api-keys.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600_000, DAY = 24 * HOUR;
const value = (body, series) => {
  const line = body.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

function fixture() {
  return {
    agents: [
      { id: "ag-a", name: "a", policy: { caps: { day: 5 }, killed: false }, lastSeen: NOW - 1000 },
      { id: "ag-b", name: "b", policy: { caps: {}, killed: true } },
    ],
    teams: [{ name: "t", agents: ["ag-a", "ag-b"], caps: { month: 10 }, spend: { day_usd: 1.75, month_usd: 1.75 } }],
    receipts: [
      { agentId: "ag-a", receipt: { id: "1", ts: iso(NOW - HOUR), cost_usd: 1, model: "m1" } },
      { agentId: "ag-a", receipt: { id: "2", ts: iso(NOW - 2 * HOUR), cost_usd: 0.25, model: "m2" } },
      { agentId: "ag-b", receipt: { id: "3", ts: iso(NOW - HOUR), cost_usd: null, model: "m1" }, settlement: { cost_usd: 0.5 } },
      { agentId: "ag-b", receipt: { id: "4", ts: iso(NOW - HOUR), cost_usd: null, model: "m1" } },
      { agentId: "ag-a", receipt: { id: "old", ts: iso(NOW - 3 * DAY), cost_usd: 7, model: "m1" } },
    ],
    alerts: [
      { kind: "cap_hit", agentId: "ag-a", active: true, acknowledged_at: null },
      { kind: "cap_hit", agentId: "ag-b", active: true, acknowledged_at: iso(NOW) },
      { kind: "agent_silent", agentId: "ag-b", active: false },
      { kind: "cap_approaching", team: "t", active: true },
    ],
  };
}

test("#220 unit: spend, completeness, caps/remaining, alerts, frozen, last sync", () => {
  const { body } = buildMetrics({ ...fixture(), nowMs: NOW });
  assert.deepEqual(validateExposition(body), []);
  assert.equal(value(body, 'costcap_spend_usd{agent="a",team="t",window="day"}'), 1.25);
  assert.equal(value(body, 'costcap_spend_usd{agent="a",team="t",window="month"}'), 8.25);
  assert.equal(value(body, 'costcap_cap_usd{scope="agent",name="a",window="day"}'), 5);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="agent",name="a",window="day"}'), 3.75);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="agent",name="a",window="month"}'), undefined, "no cap, no series");
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="team",name="t",window="month"}'), 8.25);
  assert.equal(value(body, 'costcap_spend_usd{agent="b",team="t",window="day"}'), 0.5);
  assert.equal(value(body, 'costcap_spend_complete{agent="b",window="day"}'), 0);
  assert.equal(value(body, 'costcap_spend_complete{agent="a",window="day"}'), 1);
  assert.equal(value(body, 'costcap_unknown_cost_receipts{agent="b"}'), 1);
  assert.equal(value(body, 'costcap_alerts_open{kind="cap_hit",scope_name="a"}'), 1);
  assert.equal(value(body, 'costcap_alerts_open{kind="cap_hit",scope_name="b"}'), 0, "acknowledged is not open");
  assert.equal(value(body, 'costcap_alerts_open{kind="agent_silent",scope_name="b"}'), 0, "resolved is not open");
  assert.equal(value(body, 'costcap_alerts_open{kind="cap_approaching",scope_name="t"}'), 1);
  for (const kind of ALERT_KINDS) assert.notEqual(value(body, `costcap_alerts_open{kind="${kind}",scope_name="a"}`), undefined);
  assert.equal(value(body, 'costcap_agent_frozen{agent="a"}'), 0);
  assert.equal(value(body, 'costcap_agent_frozen{agent="b"}'), 1);
  assert.equal(value(body, 'costcap_agent_last_sync_timestamp_seconds{agent="a"}'), Math.floor((NOW - 1000) / 1000));
  assert.equal(value(body, "costcap_metrics_truncated"), 0);
  for (const name of ["costcap_spend_usd", "costcap_alerts_open", "costcap_agent_frozen"]) {
    assert.ok(body.includes(`# HELP ${name} `) && body.includes(`# TYPE ${name} gauge`), name);
  }
});

test("#220 unit: budget period shifts windows and retention cutoff drops receipts", () => {
  // America/New_York day starts 05:00Z; a receipt at 03:00Z on the 16th is the 15th locally.
  const f = fixture();
  f.receipts = [{ agentId: "ag-a", receipt: { id: "x", ts: "2026-11-16T03:00:00Z", cost_usd: 2, model: "m" } }];
  const utc = buildMetrics({ ...f, nowMs: NOW }).body;
  const ny = buildMetrics({ ...f, nowMs: NOW, budgetPeriod: { timezone: "America/New_York", monthStartDay: 1 } }).body;
  assert.equal(value(utc, 'costcap_spend_usd{agent="a",team="t",window="day"}'), 2);
  assert.equal(value(ny, 'costcap_spend_usd{agent="a",team="t",window="day"}'), 0);
  // monthStartDay 17: the month window began Oct 17, so an Oct 20 receipt counts; the default (Nov 1) excludes it.
  f.receipts = [{ agentId: "ag-a", receipt: { id: "y", ts: "2026-10-20T00:00:00Z", cost_usd: 3, model: "m" } }];
  assert.equal(value(buildMetrics({ ...f, nowMs: NOW, budgetPeriod: { timezone: "UTC", monthStartDay: 17 } }).body, 'costcap_spend_usd{agent="a",team="t",window="month"}'), 3);
  assert.equal(value(buildMetrics({ ...f, nowMs: NOW }).body, 'costcap_spend_usd{agent="a",team="t",window="month"}'), 0);
  const clamped = buildMetrics({ ...fixture(), nowMs: NOW, cutoff: NOW - DAY }).body;
  assert.equal(value(clamped, 'costcap_spend_usd{agent="a",team="t",window="month"}'), 1.25);
});

test("#220 unit: label escaping parses", () => {
  assert.equal(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  const f = fixture();
  f.agents[0].name = 'we"ird\\na\nme';
  const { body } = buildMetrics({ ...f, nowMs: NOW });
  assert.deepEqual(validateExposition(body), []);
  assert.ok(body.includes('costcap_agent_frozen{agent="we\\"ird\\\\na\\nme"} 0'));
  assert.ok(validateExposition('# TYPE x gauge\nx{a="un"escaped"} 1\n').length > 0, "validator rejects bad escaping");
  assert.ok(validateExposition("x 1\n").length > 0, "validator wants TYPE first");
});

test("#220 unit: by=model sums to agent totals; truncation keeps totals", () => {
  const { body } = buildMetrics({ ...fixture(), nowMs: NOW, byModel: true });
  assert.deepEqual(validateExposition(body), []);
  const m1 = value(body, 'costcap_spend_usd{agent="a",team="t",window="day",model="m1"}');
  const m2 = value(body, 'costcap_spend_usd{agent="a",team="t",window="day",model="m2"}');
  assert.equal(m1 + m2, value(body, 'costcap_spend_usd{agent="a",team="t",window="day"}'));
  const agents = [], receipts = [];
  for (let i = 0; i < 300; i++) {
    agents.push({ id: `ag${i}`, name: `agent${i}`, policy: { caps: {} } });
    for (let j = 0; j < 10; j++) receipts.push({ agentId: `ag${i}`, receipt: { id: `${i}-${j}`, ts: iso(NOW - HOUR), cost_usd: 0.01, model: `model${j}` } });
  }
  const big = buildMetrics({ agents, receipts, nowMs: NOW, byModel: true });
  assert.equal(big.truncated, true);
  assert.equal(value(big.body, "costcap_metrics_truncated"), 1);
  assert.ok(!big.body.includes("model="), "model series dropped");
  for (let i = 0; i < 300; i++) assert.equal(value(big.body, `costcap_spend_usd{agent="agent${i}",team="(no team)",window="day"}`), 0.1);
  assert.equal(buildMetrics({ agents, receipts, nowMs: NOW }).truncated, false);
});

// --- HTTP, on the JSON store and the Postgres store (mock pool) ---
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b2";
function seed(store) {
  const keys = {};
  store.transaction((s) => {
    for (const org of [ORG_A, ORG_B]) s.orgs[org] = { id: org, name: org };
    s.agents["ag-a"] = { id: "ag-a", orgId: ORG_A, name: "a", hash: "h1", policy: { version: 1, caps: { day: 5 } }, lastSeen: NOW };
    s.agents["ag-b"] = { id: "ag-b", orgId: ORG_A, name: "b", hash: "h2", policy: { version: 1, caps: {} } };
    s.agents["ag-z"] = { id: "ag-z", orgId: ORG_B, name: "secret-agent", hash: "h3", policy: { version: 1, caps: {} } };
    s.teams[`${ORG_A}:t`] = { orgId: ORG_A, name: "t", agents: ["ag-a", "ag-b"] };
    s.receipts["ag-a:1"] = { orgId: ORG_A, agentId: "ag-a", receipt: { id: "1", ts: iso(NOW - HOUR), cost_usd: 1.25, model: "m" } };
    s.receipts["ag-b:2"] = { orgId: ORG_A, agentId: "ag-b", receipt: { id: "2", ts: iso(NOW - HOUR), cost_usd: 0.5, model: "m" } };
    s.receipts["ag-b:3"] = { orgId: ORG_A, agentId: "ag-b", receipt: { id: "3", ts: iso(NOW - HOUR), cost_usd: null, model: "m" } };
    s.receipts["ag-z:9"] = { orgId: ORG_B, agentId: "ag-z", receipt: { id: "9", ts: iso(NOW - HOUR), cost_usd: 99, model: "m" } };
    s.alerts.al1 = { orgId: ORG_A, kind: "cap_hit", agentId: "ag-a", key: "cap_hit:ag-a:day", active: true, fired_at: iso(NOW), acknowledged_at: null };
    keys.viewer = createApiKey(s, { orgId: ORG_A, createdBy: "u", name: "grafana", role: "viewer", expiresAt: null }, NOW).raw;
    keys.other = createApiKey(s, { orgId: ORG_B, createdBy: "u", name: "b", role: "viewer", expiresAt: null }, NOW).raw;
    keys.expiring = createApiKey(s, { orgId: ORG_A, createdBy: "u", name: "short", role: "viewer", expiresAt: iso(NOW + 1000) }, NOW).raw;
    const revoked = createApiKey(s, { orgId: ORG_A, createdBy: "u", name: "gone", role: "viewer", expiresAt: null }, NOW);
    revoked.record.revokedAt = iso(NOW);
    keys.revoked = revoked.raw;
  });
  return keys;
}

async function scenario(t, store) {
  let clock = NOW;
  const keys = seed(store);
  const service = createHostedServer({ store, origin: "http://localhost", secureCookies: false, now: () => clock, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async () => {} });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const get = async (path, key) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    return { status: r.status, type: r.headers.get("content-type"), text: await r.text() };
  };
  assert.equal((await get("/v1/metrics")).status, 401);
  assert.equal((await get("/v1/metrics", keys.revoked)).status, 401);
  const ok = await get("/v1/metrics", keys.viewer);
  assert.equal(ok.status, 200);
  assert.equal(ok.type, METRICS_CONTENT_TYPE);
  assert.match(ok.type, /^text\/plain; version=0\.0\.4/);
  assert.deepEqual(validateExposition(ok.text), []);
  assert.equal(value(ok.text, 'costcap_spend_usd{agent="a",team="t",window="day"}'), 1.25);
  assert.equal(value(ok.text, 'costcap_cap_remaining_usd{scope="agent",name="a",window="day"}'), 3.75);
  assert.equal(value(ok.text, 'costcap_spend_complete{agent="b",window="day"}'), 0);
  assert.equal(value(ok.text, 'costcap_unknown_cost_receipts{agent="b"}'), 1);
  assert.equal(value(ok.text, 'costcap_alerts_open{kind="cap_hit",scope_name="a"}'), 1);
  assert.ok(!ok.text.includes("secret-agent") && !ok.text.includes(" 99"), "no cross-org series");
  // Parity with /v1/spend for the current month.
  const spend = JSON.parse((await get("/v1/spend?group_by=agent&range=current_month", keys.viewer)).text);
  for (const b of spend.buckets) assert.equal(value(ok.text, `costcap_spend_usd{agent="${b.label}",team="t",window="month"}`), b.usd_known);
  const other = await get("/v1/metrics", keys.other);
  assert.ok(other.text.includes("secret-agent") && !other.text.includes('agent="a"'));
  assert.equal((await get("/v1/metrics?by=nope", keys.viewer)).status, 400);
  assert.match((await get("/v1/metrics?by=model", keys.viewer)).text, /model="m"/);
  // Acknowledge -> 0; freeze -> frozen 1.
  store.transaction((s) => { s.alerts.al1.acknowledged_at = iso(NOW); for (const a of Object.values(s.agents)) a.policy = { ...a.policy, killed: true }; });
  const after = await get("/v1/metrics", keys.viewer);
  assert.equal(value(after.text, 'costcap_alerts_open{kind="cap_hit",scope_name="a"}'), 0);
  assert.equal(value(after.text, 'costcap_agent_frozen{agent="a"}'), 1);
  assert.equal(value(after.text, 'costcap_agent_frozen{agent="b"}'), 1);
  clock = NOW + 2000;
  assert.equal((await get("/v1/metrics", keys.expiring)).status, 401, "expired key");
}

test("#220 HTTP on the JSON store: auth, isolation, parity, alerts, freeze", async (t) => {
  await scenario(t, openStore(join(mkdtempSync(join(tmpdir(), "cc-metrics-")), "store.json")));
});

test("#220 HTTP on the Postgres store: same isolation and values", async (t) => {
  const { openPostgresStore } = await import("../src/hosted/store-postgres.js");
  const pool = { async connect() { return { async query() { return { rows: [] }; }, release() {} }; } };
  await scenario(t, await openPostgresStore({ pool, log: () => {} }));
});

// --- #285: org budget, fleet tag caps, hosted model caps, total caps ---
import { orgBudgetVerdict } from "../src/hosted/org-budget.js";
import { fleetTagCapsPolicy } from "../src/hosted/tag-caps.js";
import { modelCapStatus } from "../src/hosted/model-caps.js";

const AC6_BODY = buildMetrics({ ...fixture(), nowMs: NOW }).body;

test("#285 AC6: no org budget, tag, model or total caps leaves the body byte-identical", () => {
  assert.equal(buildMetrics({ ...fixture(), nowMs: NOW, orgBudget: null, tagCaps: null }).body, AC6_BODY);
  assert.ok(!AC6_BODY.includes('scope="org"') && !AC6_BODY.includes('scope="tag"') && !AC6_BODY.includes('window="total"'));
});

test("#285 AC1: org budget series equal orgBudgetVerdict (revoked spend included), no unset windows", () => {
  const rx = (id, cost, agent) => ({ id, ts: iso(NOW - HOUR), cost_usd: cost, model: "m", agent });
  const receiptsByAgent = { "ag-a": [rx("1", 1)], "ag-b": [rx("2", 0.25)], "ag-rev": [rx("3", 0.5)] };
  const orgBudget = orgBudgetVerdict({ budget: { day: 5, month: 100 }, agentIds: ["ag-a", "ag-b", "ag-rev"], receiptsByAgent, nowMs: NOW });
  const { body } = buildMetrics({ ...fixture(), nowMs: NOW, orgBudget });
  assert.deepEqual(validateExposition(body), []);
  assert.equal(value(body, 'costcap_cap_usd{scope="org",name="org",window="day"}'), 5);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="org",name="org",window="day"}'), 3.25);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="org",name="org",window="month"}'), 98.25);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="org",name="org",window="day"}'), 5 - orgBudget.spend.day_usd, "parity");
  assert.equal(value(body, 'costcap_cap_usd{scope="org",name="org",window="week"}'), undefined);
  for (const kind of ALERT_KINDS) assert.equal(value(body, `costcap_alerts_open{kind="${kind}",scope_name="org",scope="org"}`), 0);
  const over = buildMetrics({ ...fixture(), nowMs: NOW, orgBudget: { caps: { day: 1 }, spend: { day_usd: 3 } } }).body;
  assert.equal(value(over, 'costcap_cap_remaining_usd{scope="org",name="org",window="day"}'), 0, "floored");
});

test("#285 AC2: tag cap series per value equal fleetTagCapsPolicy; unknown cost is not fully remaining", () => {
  const rules = [{ key: "customer", scope: "day", usd: 5 }];
  const receipts = [
    { id: "1", ts: iso(NOW - HOUR), cost_usd: 2, tags: { customer: "acme" } },
    { id: "2", ts: iso(NOW - HOUR), cost_usd: 0.4, tags: { customer: "beta" } },
    { id: "3", ts: iso(NOW - HOUR), cost_usd: null, tags: { customer: "gamma" } },
  ];
  const tagCaps = fleetTagCapsPolicy(rules, receipts, NOW, Infinity, null, { week: true });
  const f = fixture();
  f.alerts.push({ kind: "cap_hit", agentId: null, tag: { key: "customer", value: "acme" }, active: true, acknowledged_at: null });
  f.alerts.push({ kind: "cost_unknown", agentId: null, tag: { key: "customer", value: "gamma" }, active: true, acknowledged_at: null });
  const { body } = buildMetrics({ ...f, nowMs: NOW, tagCaps });
  assert.deepEqual(validateExposition(body), []);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="tag",name="customer=acme",tag_key="customer",tag_value="acme",window="day"}'), 3);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="tag",name="customer=beta",tag_key="customer",tag_value="beta",window="day"}'), 4.6);
  assert.equal(value(body, 'costcap_cap_usd{scope="tag",name="customer=acme",tag_key="customer",tag_value="acme",window="day"}'), 5);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="tag",name="customer=acme",tag_key="customer",tag_value="acme",window="day"}'), 5 - tagCaps.spend.customer.acme.day, "parity");
  assert.equal(value(body, 'costcap_alerts_open{kind="cap_hit",scope_name="customer=acme",scope="tag"}'), 1);
  assert.equal(value(body, 'costcap_alerts_open{kind="cost_unknown",scope_name="customer=gamma",scope="tag"}'), 1, "unknown-cost value's alert visible");
  assert.equal(value(body, 'costcap_alerts_open{kind="cap_hit",scope_name="customer=beta",scope="tag"}'), 0);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="tag",name="customer=acme",tag_key="customer",tag_value="acme",window="month"}'), undefined, "no month rule");
});

test("#285 AC3: model caps (parity with modelCapStatus) and total caps", () => {
  const rules = [{ model: "gpt-6", scope: "day", usd: 2 }, { model: "gpt-6", scope: "hour", usd: 1 }, { model: "mystery", scope: "day", usd: 3 }];
  const rs = [
    { id: "g", ts: iso(NOW - HOUR), cost_usd: 0.5, model: "gpt-6" },
    { id: "u", ts: iso(NOW - HOUR), cost_usd: null, model: "mystery" },
  ];
  const status = modelCapStatus(rs, rules, NOW);
  const f = fixture();
  f.agents[0] = { ...f.agents[0], modelCapStatus: status, policy: { caps: { day: 5, total: 10 } } };
  f.teams[0] = { ...f.teams[0], caps: { month: 10, total: 50 }, spend: { ...f.teams[0].spend, total_usd: 8.75 } };
  const { body } = buildMetrics({ ...f, nowMs: NOW });
  assert.deepEqual(validateExposition(body), []);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="model",name="a",model="gpt-6",window="day"}'), 1.5);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="model",name="a",model="gpt-6",window="day"}'), 2 - status[0].spent, "parity");
  assert.equal(value(body, 'costcap_cap_usd{scope="model",name="a",model="gpt-6",window="day"}'), 2);
  assert.ok(!body.includes('window="hour"'), "hour scope emits nothing");
  assert.ok(!body.includes('model="mystery"'), "unknown cost emits nothing, never $0");
  // Lifetime spend of a: 1 + 0.25 + 7 = 8.25 -> 1.75 remaining (computed when no verdict value is passed).
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="agent",name="a",window="total"}'), 1.75);
  assert.equal(value(body, 'costcap_cap_usd{scope="agent",name="a",window="total"}'), 10);
  f.agents[0].totalRemaining = 4;
  assert.equal(value(buildMetrics({ ...f, nowMs: NOW }).body, 'costcap_cap_remaining_usd{scope="agent",name="a",window="total"}'), 4, "verdict value wins");
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="team",name="t",window="total"}'), 41.25);
  assert.equal(value(body, 'costcap_cap_usd{scope="team",name="t",window="total"}'), 50);
});

test("#285 AC4: org alerts open/ack; existing agent and team alert lines unchanged", () => {
  const f = fixture();
  const orgBudget = { caps: { day: 1 }, spend: { day_usd: 2 } };
  const hit = { kind: "cap_hit", agentId: null, org: true, active: true, acknowledged_at: null };
  f.alerts.push(hit);
  const body = buildMetrics({ ...f, nowMs: NOW, orgBudget }).body;
  assert.equal(value(body, 'costcap_alerts_open{kind="cap_hit",scope_name="org",scope="org"}'), 1);
  hit.acknowledged_at = iso(NOW);
  assert.equal(value(buildMetrics({ ...f, nowMs: NOW, orgBudget }).body, 'costcap_alerts_open{kind="cap_hit",scope_name="org",scope="org"}'), 0);
  const legacy = (b) => b.split("\n").filter((l) => l.startsWith("costcap_alerts_open{") && !l.includes("scope="));
  assert.deepEqual(legacy(body), legacy(AC6_BODY));
});

test("#285 AC5: many tag values drop lowest spend first; org, agent and team series stay", () => {
  const rules = [{ key: "customer", scope: "day", usd: 100 }];
  const receipts = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, ts: iso(NOW - HOUR), cost_usd: i + 1, tags: { customer: `c${i}` } }));
  const tagCaps = fleetTagCapsPolicy(rules, receipts, NOW, Infinity, null, { week: true });
  const orgBudget = { caps: { day: 5 }, spend: { day_usd: 1 } };
  const full = buildMetrics({ ...fixture(), nowMs: NOW, orgBudget, tagCaps });
  assert.equal(full.truncated, false);
  const baseSeries = buildMetrics({ ...fixture(), nowMs: NOW, orgBudget }).series;
  const perValue = 2 + ALERT_KINDS.length;
  const small = buildMetrics({ ...fixture(), nowMs: NOW, orgBudget, tagCaps, maxSeries: baseSeries + 10 * perValue });
  assert.deepEqual(validateExposition(small.body), []);
  assert.equal(small.truncated, true);
  assert.equal(value(small.body, "costcap_metrics_truncated"), 1);
  assert.ok(small.body.includes('tag_value="c49"') && small.body.includes('tag_value="c40"'));
  assert.ok(!small.body.includes('tag_value="c39"') && !small.body.includes('tag_value="c0"'));
  assert.equal(value(small.body, 'costcap_cap_remaining_usd{scope="org",name="org",window="day"}'), 4);
  assert.equal(value(small.body, 'costcap_cap_remaining_usd{scope="agent",name="a",window="day"}'), 3.75);
  assert.equal(value(small.body, 'costcap_cap_remaining_usd{scope="team",name="t",window="month"}'), 8.25);
  // A tag rule with no day/week/month scope of its own key emits nothing.
  assert.ok(!buildMetrics({ ...fixture(), nowMs: NOW, tagCaps: { rules: [], spend: { customer: { x: { day: 1 } } } } }).body.includes('scope="tag"'));
});

async function scenario285(t, store) {
  store.transaction((s) => {
    for (const org of [ORG_A, ORG_B]) s.orgs[org] = { id: org, name: org };
    s.orgs[ORG_A].orgBudget = { day: 5, month: 100 };
    s.orgs[ORG_A].tagCaps = [{ key: "customer", scope: "day", usd: 5 }];
    s.orgs[ORG_B].orgBudget = { day: 777 };
    s.orgs[ORG_B].tagCaps = [{ key: "customer", scope: "day", usd: 9 }];
    s.agents["ag-a"] = { id: "ag-a", orgId: ORG_A, name: "a", hash: "h1", policy: { version: 1, caps: { day: 5, total: 10 }, modelCaps: [{ model: "gpt-6", scope: "day", usd: 2 }] } };
    s.agents["ag-r"] = { id: "ag-r", orgId: ORG_A, name: "r", hash: "h2", revoked: true, policy: { version: 1, caps: {} } };
    s.agents["ag-z"] = { id: "ag-z", orgId: ORG_B, name: "z", hash: "h3", policy: { version: 1, caps: {}, modelCaps: [{ model: "zz-model", scope: "day", usd: 9 }] } };
    s.teams[`${ORG_A}:t`] = { orgId: ORG_A, name: "t", agents: ["ag-a"], total: 50 };
    s.receipts["ag-a:1"] = { orgId: ORG_A, agentId: "ag-a", receipt: { id: "1", ts: iso(NOW - HOUR), cost_usd: 0.5, model: "gpt-6", tags: { customer: "acme" } } };
    s.receipts["ag-a:2"] = { orgId: ORG_A, agentId: "ag-a", receipt: { id: "2", ts: iso(NOW - HOUR), cost_usd: 0.75, model: "m", tags: { customer: "beta" } } };
    s.receipts["ag-a:old"] = { orgId: ORG_A, agentId: "ag-a", receipt: { id: "old", ts: "2026-01-01T00:00:00Z", cost_usd: 4.75, model: "m" } };
    s.receipts["ag-r:3"] = { orgId: ORG_A, agentId: "ag-r", receipt: { id: "3", ts: iso(NOW - HOUR), cost_usd: 0.5, model: "m", tags: { customer: "acme" } } };
    s.receipts["ag-z:9"] = { orgId: ORG_B, agentId: "ag-z", receipt: { id: "9", ts: iso(NOW - HOUR), cost_usd: 1, model: "zz-model", tags: { customer: "zcorp" } } };
    s.alerts.org1 = { orgId: ORG_A, kind: "cap_hit", agentId: null, org: true, key: `cap_hit:org:${ORG_A}:day`, active: true, fired_at: iso(NOW), acknowledged_at: null };
  });
  const keys = {};
  store.transaction((s) => {
    keys.a = createApiKey(s, { orgId: ORG_A, createdBy: "u", name: "g", role: "viewer", expiresAt: null }, NOW).raw;
    keys.b = createApiKey(s, { orgId: ORG_B, createdBy: "u", name: "g", role: "viewer", expiresAt: null }, NOW).raw;
  });
  const service = createHostedServer({ store, origin: "http://localhost", secureCookies: false, now: () => NOW, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async () => {} });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const get = async (path, key) => (await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { headers: { authorization: `Bearer ${key}` } })).text();
  const body = await get("/v1/metrics", keys.a);
  assert.deepEqual(validateExposition(body), []);
  const ob = JSON.parse(await get("/v1/org-budget", keys.a)).org_budget;
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="org",name="org",window="day"}'), 3.25);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="org",name="org",window="day"}'), 5 - ob.spend.day_usd, "parity with /v1/org-budget");
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="org",name="org",window="month"}'), 98.25);
  assert.equal(value(body, 'costcap_alerts_open{kind="cap_hit",scope_name="org",scope="org"}'), 1);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="tag",name="customer=acme",tag_key="customer",tag_value="acme",window="day"}'), 4);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="tag",name="customer=beta",tag_key="customer",tag_value="beta",window="day"}'), 4.25);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="model",name="a",model="gpt-6",window="day"}'), 1.5);
  const budget = JSON.parse(await get("/v1/agents/ag-a/budget", keys.a));
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="agent",name="a",window="total"}'), budget.budget_remaining.total_usd);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="agent",name="a",window="total"}'), 4);
  assert.equal(value(body, 'costcap_cap_remaining_usd{scope="team",name="t",window="total"}'), 44);
  assert.ok(!body.includes("zcorp") && !body.includes("zz-model") && !body.includes(" 777"), "no org B series");
  const other = await get("/v1/metrics", keys.b);
  assert.ok(other.includes("zcorp") && other.includes("zz-model") && other.includes('window="day"} 777'));
  assert.ok(!other.includes("acme") && !other.includes("gpt-6") && !other.includes('scope_name="org",scope="org"} 1'));
}

test("#285 HTTP on the JSON store: org, tag, model, total series and isolation", async (t) => {
  await scenario285(t, openStore(join(mkdtempSync(join(tmpdir(), "cc-metrics285-")), "store.json")));
});

test("#285 HTTP on the Postgres store: same series and isolation", async (t) => {
  const { openPostgresStore } = await import("../src/hosted/store-postgres.js");
  const pool = { async connect() { return { async query() { return { rows: [] }; }, release() {} }; } };
  await scenario285(t, await openPostgresStore({ pool, log: () => {} }));
});
