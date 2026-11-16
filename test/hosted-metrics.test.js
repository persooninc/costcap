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
