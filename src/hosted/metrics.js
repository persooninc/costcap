// Issue #220: Prometheus text exposition (version 0.0.4) for GET /v1/metrics.
// Pure: the caller passes one org's agents, teams, visible receipts, alerts and
// freeze state. Spend comes from spendBreakdown so it matches /v1/spend to the
// cent. Every value is a gauge for the current budget period (#209): retention
// (#211) deletes old receipts, so nothing here is a monotonic counter.
import { spendBreakdown } from "./spend.js";
import { ALERT_KINDS, alertStatus } from "./alerts.js";
import { effectiveCaps } from "./policy.js";
import { periodBounds } from "../period.js";

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export const MAX_SERIES = 5000;
export const METRIC_WINDOWS = Object.freeze(["day", "month"]);

const FAMILIES = {
  costcap_spend_usd: "Known spend in USD for the current budget period window (estimate; unknown-cost receipts are not counted as $0).",
  costcap_spend_complete: "1 when every receipt in the window has a known or settled cost, 0 when spend is a lower bound.",
  costcap_unknown_cost_receipts: "Unsettled unknown-cost receipts in the current month period.",
  costcap_cap_usd: "Configured cap in USD (omitted when there is no cap).",
  costcap_cap_remaining_usd: "Cap minus known spend in USD, floored at 0 (omitted when there is no cap).",
  costcap_alerts_open: "Open (fired, unresolved and unacknowledged) alerts by kind and scope.",
  costcap_agent_frozen: "1 when the agent is killed or the fleet is frozen.",
  costcap_agent_last_sync_timestamp_seconds: "Unix time the agent last polled policy or synced receipts.",
  costcap_metrics_truncated: "1 when the series cap was reached and per-model or optional series were dropped.",
};

// Exposition-format label escaping: backslash, double quote and newline.
export function escapeLabel(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// Every value is a finite number (spend is rounded; caps are validated positive).
const fmt = (n) => String(Number(n.toFixed(6)));

const round6 = (n) => Number(n.toFixed(6));
const series = (name, labels, value) => ({ name, labels, value });

// agents: [{ id, name, policy, lastSeen, revoked }]; teams: [{ name, agents, day?, month? }]
// receipts: visible [{ agentId, receipt, settlement? }]; alerts: alertOccurrences() of this org.
export function buildMetrics({ agents = [], teams = [], receipts = [], alerts = [], fleetFrozen = false, nowMs, budgetPeriod = null, cutoff = null, byModel = false, maxSeries = MAX_SERIES }) {
  const live = agents.filter((a) => !a.revoked).sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
  const teamOf = new Map();
  for (const t of teams) for (const id of t.agents ?? []) teamOf.set(id, t.name);
  const byAgent = new Map(live.map((a) => [a.id, []]));
  for (const item of receipts) byAgent.get(item.agentId)?.push(item);

  const windowSpend = (items, window, groupBy) => {
    const { start, end } = periodBounds(window, nowMs, budgetPeriod);
    return spendBreakdown(items, { groupBy, since: start, until: end, untilExclusive: true, cutoff, budgetPeriod });
  };

  const core = [], models = [], optional = [];
  const agentSpend = new Map();
  for (const a of live) {
    const items = byAgent.get(a.id);
    const team = teamOf.get(a.id) ?? "";
    const w = {};
    for (const window of METRIC_WINDOWS) {
      const { total } = windowSpend(items, window, "agent");
      w[window] = total;
      core.push(series("costcap_spend_usd", { agent: a.name, team, window }, total.usd_known));
      if (byModel) {
        for (const b of windowSpend(items, window, "model").buckets) models.push(series("costcap_spend_usd", { agent: a.name, team, window, model: b.key }, b.usd_known));
      }
    }
    agentSpend.set(a.id, w);
  }
  for (const a of live) {
    const w = agentSpend.get(a.id);
    for (const window of METRIC_WINDOWS) optional.push(series("costcap_spend_complete", { agent: a.name, window }, w[window].cost_complete ? 1 : 0));
    optional.push(series("costcap_unknown_cost_receipts", { agent: a.name }, w.month.unknown_count));
    const caps = effectiveCaps(a.policy, nowMs);
    for (const window of METRIC_WINDOWS) {
      const cap = caps[window];
      if (typeof cap !== "number" || !Number.isFinite(cap)) continue;
      optional.push(series("costcap_cap_usd", { scope: "agent", name: a.name, window }, cap));
      optional.push(series("costcap_cap_remaining_usd", { scope: "agent", name: a.name, window }, round6(Math.max(0, cap - w[window].usd_known))));
    }
  }
  for (const t of [...teams].sort((x, y) => x.name.localeCompare(y.name))) {
    for (const window of METRIC_WINDOWS) {
      const cap = t[window];
      if (typeof cap !== "number" || !Number.isFinite(cap)) continue;
      const spent = (t.agents ?? []).reduce((sum, id) => sum + (agentSpend.get(id)?.[window].usd_known ?? 0), 0);
      optional.push(series("costcap_cap_usd", { scope: "team", name: t.name, window }, cap));
      optional.push(series("costcap_cap_remaining_usd", { scope: "team", name: t.name, window }, round6(Math.max(0, cap - spent))));
    }
  }
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const open = new Map();
  for (const al of alerts) {
    if (alertStatus(al) !== "active" || !ALERT_KINDS.includes(al.kind)) continue;
    const scope = al.team ? "team" : "agent";
    const name = al.team ?? names.get(al.agentId);
    if (name === undefined) continue;
    const k = `${al.kind}\u0000${scope}\u0000${name}`;
    open.set(k, (open.get(k) ?? 0) + 1);
  }
  const scopes = [...live.map((a) => ["agent", a.name]), ...teams.map((t) => ["team", t.name]).sort((x, y) => x[1].localeCompare(y[1]))];
  for (const [scope, name] of scopes) {
    for (const kind of ALERT_KINDS) optional.push(series("costcap_alerts_open", { kind, scope, scope_name: name }, open.get(`${kind}\u0000${scope}\u0000${name}`) ?? 0));
  }
  for (const a of live) optional.push(series("costcap_agent_frozen", { agent: a.name }, fleetFrozen || a.policy?.killed ? 1 : 0));
  for (const a of live) {
    if (Number.isFinite(a.lastSeen)) optional.push(series("costcap_agent_last_sync_timestamp_seconds", { agent: a.name }, Math.floor(a.lastSeen / 1000)));
  }

  // Cap: per-model series go first, then optional series; agent totals always stay.
  const budget = Math.max(0, maxSeries - 1);
  let truncated = false;
  let spendRows = byModel ? models : core;
  if (byModel && models.length + optional.length > budget) { spendRows = core; truncated = true; }
  let rest = optional;
  if (spendRows.length + rest.length > budget) { rest = optional.slice(0, Math.max(0, budget - spendRows.length)); truncated = true; }
  // With ?by=model the per-model rows replace the totals (they sum to them), so sum() never double counts.
  const all = [...spendRows, ...rest, series("costcap_metrics_truncated", {}, truncated ? 1 : 0)];
  return { body: render(all), truncated, series: all.length };
}

export function render(rows) {
  const grouped = new Map();
  for (const r of rows) {
    if (!grouped.has(r.name)) grouped.set(r.name, []);
    grouped.get(r.name).push(r);
  }
  const out = [];
  for (const [name, list] of grouped) {
    out.push(`# HELP ${name} ${FAMILIES[name]}`, `# TYPE ${name} gauge`);
    for (const r of list) {
      const labels = Object.entries(r.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",");
      out.push(`${name}${labels ? `{${labels}}` : ""} ${fmt(r.value)}`);
    }
  }
  return out.join("\n") + "\n";
}
