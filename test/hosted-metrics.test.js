// Issue #220: Prometheus series builder for GET /v1/metrics.
import test from "node:test";
import assert from "node:assert/strict";
import { buildMetrics, escapeLabel, MAX_SERIES, render } from "../src/hosted/metrics.js";
import { ALERT_KINDS } from "../src/hosted/alerts.js";
import { spendBreakdown } from "../src/hosted/spend.js";
import { periodBounds } from "../src/period.js";
import { parseProm, value, find } from "./support/prom.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const H = 3600_000;

function fixture() {
  const agents = [
    { id: "ida", name: "a", policy: { caps: { day: 5 }, killed: false }, lastSeen: NOW - 1000, revoked: false },
    { id: "idb", name: "b", policy: { caps: {}, killed: false }, lastSeen: NOW - 5000, revoked: false },
  ];
  const teams = [{ name: "t", agents: ["ida", "idb"], day: 10 }];
  const receipts = [
    { agentId: "ida", receipt: { id: "1", ts: iso(NOW - H), cost_usd: 1, model: "m1" } },
    { agentId: "ida", receipt: { id: "2", ts: iso(NOW - 2 * H), cost_usd: 0.25, model: "m2" } },
    { agentId: "idb", receipt: { id: "3", ts: iso(NOW - H), cost_usd: 0.5, model: "m1" } },
    { agentId: "idb", receipt: { id: "4", ts: iso(NOW - H), cost_usd: null, model: "m1" } },
    // settled unknown counts at its settled cost
    { agentId: "idb", receipt: { id: "5", ts: iso(NOW - H), cost_usd: null, model: "m1" }, settlement: { cost_usd: 0.1 } },
  ];
  return { agents, teams, receipts };
}

test("AC1: spend, completeness, unknown, caps/remaining, frozen, last sync; body parses", () => {
  const f = fixture();
  const out = buildMetrics({ ...f, nowMs: NOW });
  const rows = parseProm(out.body);
  assert.equal(value(rows, "costcap_spend_usd", { agent: "a", team: "t", window: "day" }), 1.25);
  assert.equal(value(rows, "costcap_spend_usd", { agent: "b", team: "t", window: "day" }), 0.6);
  assert.equal(value(rows, "costcap_cap_usd", { scope: "agent", name: "a", window: "day" }), 5);
  assert.equal(value(rows, "costcap_cap_remaining_usd", { scope: "agent", name: "a", window: "day" }), 3.75);
  assert.equal(find(rows, "costcap_cap_usd", { scope: "agent", name: "b" }).length, 0, "no cap -> omitted");
  assert.equal(value(rows, "costcap_cap_remaining_usd", { scope: "team", name: "t", window: "day" }), 8.15);
  assert.equal(find(rows, "costcap_cap_usd", { scope: "team", window: "month" }).length, 0);
  assert.equal(value(rows, "costcap_spend_complete", { agent: "a", window: "day" }), 1);
  assert.equal(value(rows, "costcap_spend_complete", { agent: "b", window: "day" }), 0);
  assert.equal(value(rows, "costcap_unknown_cost_receipts", { agent: "b" }), 1);
  assert.equal(value(rows, "costcap_unknown_cost_receipts", { agent: "a" }), 0);
  assert.equal(value(rows, "costcap_agent_frozen", { agent: "a" }), 0);
  assert.equal(value(rows, "costcap_agent_last_sync_timestamp_seconds", { agent: "a" }), Math.floor((NOW - 1000) / 1000));
  assert.equal(value(rows, "costcap_metrics_truncated", {}), 0);
  for (const name of ["costcap_spend_usd", "costcap_alerts_open", "costcap_agent_frozen"]) {
    assert.ok(out.body.includes(`# HELP ${name} `) && out.body.includes(`# TYPE ${name} gauge`), name);
  }
});

test("AC4: alerts open per kind and scope; ack/resolve -> 0; fleet freeze and killed -> frozen", () => {
  const f = fixture();
  const alerts = [
    { kind: "cap_hit", agentId: "ida", active: true, acknowledged_at: null },
    { kind: "cap_hit", team: "t", active: true, acknowledged_at: null },
    { kind: "cap_approaching", agentId: "idb", active: true, acknowledged_at: "x" },
    { kind: "agent_silent", agentId: "idb", active: false, acknowledged_at: null },
  ];
  const rows = parseProm(buildMetrics({ ...f, alerts, nowMs: NOW }).body);
  assert.equal(value(rows, "costcap_alerts_open", { kind: "cap_hit", scope: "agent", scope_name: "a" }), 1);
  assert.equal(value(rows, "costcap_alerts_open", { kind: "cap_hit", scope: "team", scope_name: "t" }), 1);
  assert.equal(value(rows, "costcap_alerts_open", { kind: "cap_approaching", scope_name: "b" }), 0);
  assert.equal(value(rows, "costcap_alerts_open", { kind: "agent_silent", scope_name: "b" }), 0);
  assert.equal(find(rows, "costcap_alerts_open").length, ALERT_KINDS.length * 3);
  const frozen = parseProm(buildMetrics({ ...f, fleetFrozen: true, nowMs: NOW }).body);
  assert.deepEqual(find(frozen, "costcap_agent_frozen").map((r) => r.value), [1, 1]);
  f.agents[1].policy.killed = true;
  assert.equal(value(parseProm(buildMetrics({ ...f, nowMs: NOW }).body), "costcap_agent_frozen", { agent: "b" }), 1);
  f.agents[1].revoked = true;
  assert.equal(find(parseProm(buildMetrics({ ...f, nowMs: NOW }).body), "costcap_agent_frozen", { agent: "b" }).length, 0, "revoked agents are not exported");
});

test("AC5: label escaping round-trips through the parser", () => {
  assert.equal(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  const nasty = 'we"ird\\na\nme';
  const f = fixture();
  f.agents[0].name = nasty;
  const rows = parseProm(buildMetrics({ ...f, nowMs: NOW }).body);
  assert.equal(value(rows, "costcap_spend_usd", { agent: nasty, window: "day" }), 1.25);
  assert.throws(() => parseProm('x{a="b"} 1\n'), /HELP/);
  assert.throws(() => parseProm(render([{ name: "costcap_agent_frozen", labels: { agent: "a" }, value: 1 }]).replace('"a"', '"a')), /label/);
});

test("AC3: budget period shifts windows; retention cutoff excludes; matches spendBreakdown", () => {
  const f = fixture();
  // 01:00 UTC on Nov 16 is still Nov 15 in New York.
  f.receipts.push({ agentId: "ida", receipt: { id: "late", ts: "2026-11-16T01:00:00Z", cost_usd: 2, model: "m1" } });
  const utc = parseProm(buildMetrics({ ...f, nowMs: NOW }).body);
  assert.equal(value(utc, "costcap_spend_usd", { agent: "a", window: "day" }), 3.25);
  const bp = { timezone: "America/New_York", monthStartDay: 1 };
  const ny = parseProm(buildMetrics({ ...f, nowMs: NOW, budgetPeriod: bp }).body);
  assert.equal(value(ny, "costcap_spend_usd", { agent: "a", window: "day" }), 1.25);
  assert.equal(value(ny, "costcap_spend_usd", { agent: "a", window: "month" }), 3.25);
  // month start day 17 -> the month began Oct 17; a receipt on Oct 20 counts in month.
  f.receipts.push({ agentId: "ida", receipt: { id: "oct", ts: "2026-10-20T00:00:00Z", cost_usd: 4, model: "m1" } });
  const d17 = parseProm(buildMetrics({ ...f, nowMs: NOW, budgetPeriod: { timezone: "UTC", monthStartDay: 17 } }).body);
  assert.equal(value(d17, "costcap_spend_usd", { agent: "a", window: "month" }), 7.25);
  const { start, end } = periodBounds("month", NOW, { timezone: "UTC", monthStartDay: 17 });
  const ref = spendBreakdown(f.receipts.filter((r) => r.agentId === "ida"), { groupBy: "agent", since: start, until: end, untilExclusive: true, budgetPeriod: { timezone: "UTC", monthStartDay: 17 } });
  assert.equal(ref.total.usd_known, 7.25);
  // Retention cutoff: receipts before it are not counted.
  const cut = parseProm(buildMetrics({ ...f, nowMs: NOW, cutoff: NOW - 90 * 60_000 }).body);
  assert.equal(value(cut, "costcap_spend_usd", { agent: "a", window: "day" }), 1);
});

test("AC6: by=model sums to the agent total; truncation keeps every agent total", () => {
  const f = fixture();
  const rows = parseProm(buildMetrics({ ...f, nowMs: NOW, byModel: true }).body);
  const perModel = find(rows, "costcap_spend_usd", { agent: "a", window: "day" });
  assert.deepEqual(perModel.map((r) => r.labels.model).sort(), ["m1", "m2"]);
  assert.equal(perModel.reduce((s, r) => s + r.value, 0), 1.25);
  assert.equal(value(rows, "costcap_metrics_truncated", {}), 0);

  const many = { agents: [], teams: [], receipts: [] };
  for (let i = 0; i < 700; i += 1) {
    many.agents.push({ id: `id${i}`, name: `agent-${i}`, policy: { caps: { day: 1, month: 2 } }, lastSeen: NOW, revoked: false });
    for (const m of ["x", "y"]) many.receipts.push({ agentId: `id${i}`, receipt: { id: `${i}${m}`, ts: iso(NOW - H), cost_usd: 0.01, model: m } });
  }
  const out = buildMetrics({ ...many, nowMs: NOW, byModel: true });
  assert.equal(out.truncated, true);
  assert.ok(out.series <= MAX_SERIES, String(out.series));
  const big = parseProm(out.body);
  assert.equal(value(big, "costcap_metrics_truncated", {}), 1);
  const totals = find(big, "costcap_spend_usd", { window: "day" });
  assert.equal(totals.length, 700);
  assert.ok(totals.every((r) => r.value === 0.02 && !("model" in r.labels)));
  // A tiny cap still keeps all agent totals (core is never dropped).
  const tiny = parseProm(buildMetrics({ ...fixture(), nowMs: NOW, maxSeries: 2 }).body);
  assert.equal(find(tiny, "costcap_spend_usd").length, 4);
  assert.equal(value(tiny, "costcap_metrics_truncated", {}), 1);
});
