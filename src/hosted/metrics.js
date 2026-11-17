// Issue #220: Prometheus text exposition (version 0.0.4) for GET /v1/metrics.
// Pure: the caller passes one org's agents, teams, visible receipts and alerts.
// Values are gauges for the current budget period (#209), not counters: retention
// (#211) deletes old receipts, so a counter would go backwards.

import { periodBounds, normalizeBudgetPeriod } from "../period.js";
import { spendBreakdown, NO_TEAM } from "./spend.js";
import { ALERT_KINDS } from "./alerts.js";

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export const MAX_SERIES = 5000;
// #271: week (ISO, org timezone) appended last so the day/month series keep their order.
export const METRIC_WINDOWS = ["day", "month", "week"];

const HELP = {
  costcap_spend_usd: "Known spend in USD for the current budget period window (settled unknown costs at their settled value).",
  costcap_spend_complete: "1 when every receipt in the window has a known or settled cost; 0 means costcap_spend_usd is a lower bound.",
  costcap_unknown_cost_receipts: "Unsettled unknown-cost receipts in the current budget month.",
  costcap_cap_usd: "Configured cap in USD (omitted when no cap is set).",
  costcap_cap_remaining_usd: "Cap minus known spend in USD, floored at 0 (omitted when no cap is set).",
  costcap_alerts_open: "Open (active, unacknowledged) alerts by kind and agent or team name.",
  costcap_agent_frozen: "1 when the agent is killed or frozen, else 0.",
  costcap_agent_last_sync_timestamp_seconds: "Unix time of the agent's last policy fetch or receipt sync.",
  costcap_metrics_truncated: "1 when per-model series were dropped to stay under the series cap; agent totals stay complete.",
};

// Exposition-format label value escaping: backslash, double quote, newline.
export function escapeLabel(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
const fmt = (n) => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "NaN");
const labels = (l) => {
  const parts = Object.entries(l).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};

// agents: [{ id, name, policy:{caps,killed}, lastSeen }] with caps already effective (raises applied).
// teams: [{ name, agents, caps:{day,month}, spend:{day_usd,month_usd} }] (team verdicts).
// receipts: [{ agentId, receipt, settlement? }] already retention-filtered.
// alerts: alert occurrences of this org.
export function buildMetrics({ agents = [], teams = [], receipts = [], alerts = [], nowMs, budgetPeriod = null, cutoff = null, byModel = false, maxSeries = MAX_SERIES }) {
  const bp = normalizeBudgetPeriod(budgetPeriod);
  const series = new Map(Object.keys(HELP).map((k) => [k, []]));
  const add = (name, l, v) => series.get(name).push(`${name}${labels(l)} ${fmt(v)}`);
  const nameOf = new Map(agents.map((a) => [a.id, a.name ?? a.id]));
  const teamOf = new Map();
  for (const t of teams) for (const id of t.agents ?? []) teamOf.set(id, t.name);
  const byAgent = new Map(agents.map((a) => [a.id, []]));
  for (const r of receipts) byAgent.get(r.agentId)?.push(r);
  const modelLines = [];
  for (const a of agents) {
    const agent = nameOf.get(a.id);
    const team = teamOf.get(a.id) ?? NO_TEAM;
    const items = byAgent.get(a.id) ?? [];
    const caps = a.caps ?? a.policy?.caps ?? {};
    for (const window of METRIC_WINDOWS) {
      const since = periodBounds(window, nowMs, bp).start;
      const b = spendBreakdown(items, { groupBy: "model", since, cutoff, budgetPeriod: bp });
      add("costcap_spend_usd", { agent, team, window }, b.total.usd_known);
      add("costcap_spend_complete", { agent, window }, b.total.cost_complete ? 1 : 0);
      if (window === "month") add("costcap_unknown_cost_receipts", { agent }, b.total.unknown_count);
      if (caps[window] != null) {
        add("costcap_cap_usd", { scope: "agent", name: agent, window }, caps[window]);
        add("costcap_cap_remaining_usd", { scope: "agent", name: agent, window }, Math.max(0, caps[window] - b.total.usd_known));
      }
      if (byModel) for (const m of b.buckets) modelLines.push(`costcap_spend_usd${labels({ agent, team, window, model: m.key })} ${fmt(m.usd_known)}`);
    }
    add("costcap_agent_frozen", { agent }, a.policy?.killed || a.frozen ? 1 : 0);
    const seen = Number(a.lastSeen);
    if (Number.isFinite(seen) && seen > 0) add("costcap_agent_last_sync_timestamp_seconds", { agent }, Math.floor(seen / 1000));
  }
  for (const t of teams) {
    for (const window of METRIC_WINDOWS) {
      const cap = t.caps?.[window];
      if (cap == null) continue;
      add("costcap_cap_usd", { scope: "team", name: t.name, window }, cap);
      add("costcap_cap_remaining_usd", { scope: "team", name: t.name, window }, Math.max(0, cap - (t.spend?.[`${window}_usd`] ?? 0)));
    }
  }
  // Every kind is emitted per agent/team (0 when none open) so a resolved alert reads 0, not "absent".
  const open = new Map();
  for (const al of alerts) {
    if (!al.active || al.acknowledged_at) continue;
    const scopeName = al.team ?? nameOf.get(al.agentId);
    if (scopeName === undefined) continue;
    const k = `${al.kind}\u0000${scopeName}`;
    open.set(k, (open.get(k) ?? 0) + 1);
  }
  const scopes = [...agents.map((a) => nameOf.get(a.id)), ...teams.map((t) => t.name)];
  for (const kind of ALERT_KINDS) for (const scope_name of scopes) add("costcap_alerts_open", { kind, scope_name }, open.get(`${kind}\u0000${scope_name}`) ?? 0);
  const base = [...series.values()].reduce((n, l) => n + l.length, 0);
  const truncated = byModel && base + modelLines.length > maxSeries;
  if (byModel && !truncated) series.get("costcap_spend_usd").push(...modelLines);
  add("costcap_metrics_truncated", {}, truncated ? 1 : 0);
  const out = [];
  for (const [name, lines] of series) {
    out.push(`# HELP ${name} ${HELP[name]}`, `# TYPE ${name} gauge`, ...lines);
  }
  return { body: `${out.join("\n")}\n`, truncated, series: out.filter((l) => !l.startsWith("#")).length };
}

// Minimal text-format validator (used by tests): returns [] when the body parses.
export function validateExposition(body) {
  const errors = [];
  const typed = new Set();
  const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(?:[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\[\\"n])*"(?:,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\[\\"n])*")*)?\})? (-?[0-9.e+-]+|NaN|[+-]Inf)$/;
  if (!body.endsWith("\n")) errors.push("body must end with a newline");
  body.split("\n").slice(0, -1).forEach((line, i) => {
    if (line.startsWith("# HELP ")) return;
    const t = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (gauge|counter|untyped|summary|histogram)$/.exec(line);
    if (t) { if (typed.has(t[1])) errors.push(`line ${i + 1}: duplicate TYPE`); typed.add(t[1]); return; }
    const m = sample.exec(line);
    if (!m) errors.push(`line ${i + 1}: bad sample: ${line}`);
    else if (!typed.has(m[1])) errors.push(`line ${i + 1}: sample before TYPE`);
  });
  return errors;
}
