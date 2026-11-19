// Issue #156: spend breakdown by UTC day, model or agent for the hosted dashboard.
// Pure: no store access. Unknown cost is counted, never added as $0. A settled
// unknown cost counts at its settled value in its original bucket.

import { TAG_KEY } from "../tags.js";
import { normalizeBudgetPeriod, periodKey, periodBounds, localParts, zonedMidnight } from "../period.js";
import { cell } from "./receipts-csv.js";
import { projectSpend } from "./alerts.js";

// #294: projections are kept on these groupings only.
export const FORECAST_GROUPS = ["agent", "team", "model", "tag"];

export const SPEND_GROUPS = ["day", "model", "agent", "tag", "team", "outcome"];
// #225: run outcome buckets, always all four, in this order.
export const OUTCOME_BUCKETS = ["success", "failure", "killed", "unknown"];
export const UNTAGGED = "(untagged)";
// #213: agents in no team. Membership is the current one, not history.
export const NO_TEAM = "(no team)";
export const CSV_PERIODS = ["day", "month"];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

const bad = (message) => { const err = new Error(message); err.status = 400; return err; };

export const SPEND_RANGES = ["current_month", "7d", "30d"];

// #215: start (UTC ms) of a named range in the org budget period: the current
// budget-month start, or local midnight N-1 days before today (DST-safe).
export function rangeStart(range, nowMs, budgetPeriod) {
  const bp = normalizeBudgetPeriod(budgetPeriod);
  if (range === "current_month") return periodBounds("month", nowMs, bp).start;
  const { year, month, day } = localParts(nowMs, bp.timezone);
  return zonedMidnight(year, month, day - (range === "30d" ? 29 : 6), bp.timezone);
}

// since/until are ISO instants or YYYY-MM-DD. A date-only value is local
// midnight in the org budget-period timezone (#215; UTC when unset), and a
// date-only until covers that whole local day. range= replaces since.
export function parseSpendQuery(params, { csv = false, budgetPeriod = null, now = Date.now() } = {}) {
  const groupBy = params.get("group_by") ?? "day";
  if (!SPEND_GROUPS.includes(groupBy)) throw bad(`group_by must be one of ${SPEND_GROUPS.join("|")}`);
  const out = { groupBy };
  if (groupBy === "tag") {
    const tagKey = params.get("tag_key");
    if (!tagKey || !TAG_KEY.test(tagKey)) throw bad("tag_key is required with group_by=tag and must match [a-z0-9_.-]{1,32}");
    out.tagKey = tagKey;
  }
  const tz = normalizeBudgetPeriod(budgetPeriod).timezone;
  const range = params.get("range");
  if (range !== null) {
    if (!SPEND_RANGES.includes(range)) throw bad(`range must be one of ${SPEND_RANGES.join("|")}`);
    if (params.get("since") !== null) throw bad("use either range or since, not both");
    out.range = range;
    out.since = rangeStart(range, now, budgetPeriod);
  }
  for (const key of ["since", "until"]) {
    const v = params.get(key);
    if (v === null) continue;
    const dateOnly = DATE_ONLY.test(v);
    let ms = Date.parse(dateOnly ? `${v}T00:00:00Z` : v);
    if (!v || !Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}/.test(v)) throw bad(`${key} must be an ISO date`);
    if (dateOnly) {
      const [y, m, d] = v.split("-").map(Number);
      ms = zonedMidnight(y, m, d + (key === "until" ? 1 : 0), tz);
    }
    out[key] = ms;
    if (key === "until") out.untilExclusive = dateOnly;
  }
  if (out.since !== undefined && out.until !== undefined && out.since > out.until) throw bad("since must be before until");
  if (csv) {
    const period = params.get("period") ?? "month";
    if (!CSV_PERIODS.includes(period)) throw bad(`period must be one of ${CSV_PERIODS.join("|")}`);
    out.period = period;
  }
  return out;
}

// items: [{ agentId, receipt, settlement? }]. names: { agentId: label }.
// teams (group_by=team): [{ name, agents }] of the caller's org only.
export function spendBreakdown(items, { groupBy = "day", range = null, since, until, untilExclusive = false, cutoff = null, names = {}, tagKey, budgetPeriod = null, teams = [], outcomeOf = () => "unknown", now = null } = {}) {
  if (!SPEND_GROUPS.includes(groupBy)) throw bad(`group_by must be one of ${SPEND_GROUPS.join("|")}`);
  if (groupBy === "tag" && (!tagKey || !TAG_KEY.test(tagKey))) throw bad("tag_key is required with group_by=tag");
  let from = since, clamped = false;
  if (cutoff !== null && cutoff !== undefined && (from === undefined || from < cutoff)) { from = cutoff; clamped = true; }
  const buckets = new Map();
  const newBucket = (key) => ({ key, usd_known: 0, calls: 0, unknown_count: 0, blocked_count: 0, cost_complete: true, cache_hits: 0, saved_usd: 0, user_priced_count: 0, user_priced_usd: 0 });
  const teamOf = new Map();
  if (groupBy === "team") {
    for (const t of teams) {
      for (const a of t.agents ?? []) teamOf.set(a, t.name);
      buckets.set(t.name, { ...newBucket(t.name), label: t.name });
    }
    buckets.set(NO_TEAM, { ...newBucket(NO_TEAM), label: NO_TEAM });
  }
  const runSets = new Map();
  if (groupBy === "outcome") for (const o of OUTCOME_BUCKETS) { buckets.set(o, { ...newBucket(o), label: o }); runSets.set(o, new Set()); }
  const total = { usd_known: 0, calls: 0, unknown_count: 0, blocked_count: 0, cost_complete: true, cache_hits: 0, saved_usd: 0, user_priced_count: 0, user_priced_usd: 0 };
  for (const item of items) {
    const r = item?.receipt;
    const ms = Date.parse(r?.ts);
    if (!Number.isFinite(ms)) continue;
    if (from !== undefined && ms < from) continue;
    if (until !== undefined && (untilExclusive ? ms >= until : ms > until)) continue;
    const key = groupBy === "day" ? periodKey("day", ms, budgetPeriod)
      : groupBy === "model" ? (typeof r.model === "string" && r.model ? r.model : "unknown")
      : groupBy === "tag" ? (typeof r.tags?.[tagKey] === "string" ? r.tags[tagKey] : UNTAGGED)
      : groupBy === "team" ? (teamOf.get(item.agentId) ?? NO_TEAM)
      : groupBy === "outcome" ? (typeof r.run_id === "string" && r.run_id ? outcomeOf(item.agentId, r.run_id) : "unknown")
      : String(item.agentId ?? "unknown");
    let b = buckets.get(key);
    if (!b) {
      b = newBucket(key);
      if (groupBy === "agent") b.label = names[key] ?? key;
      buckets.set(key, b);
    }
    if (groupBy === "outcome" && typeof r.run_id === "string" && r.run_id) runSets.get(key)?.add(`${item.agentId}:${r.run_id}`);
    const settled = item.settlement?.cost_usd;
    const cost = r.cost_usd == null ? (typeof settled === "number" && Number.isFinite(settled) ? settled : null) : r.cost_usd;
    for (const t of [b, total]) {
      t.calls += 1;
      if (r.blocked === true) t.blocked_count += 1;
      // #189: spend priced from the customer's own --upstream-prices, shown alongside.
      if (r.cost_source === "user_prices" && typeof r.cost_usd === "number" && Number.isFinite(r.cost_usd)) { t.user_priced_count += 1; t.user_priced_usd += r.cost_usd; }
      if (typeof cost === "number" && Number.isFinite(cost)) t.usd_known += cost;
      else { t.unknown_count += 1; t.cost_complete = false; }
      // #184: savings are reported alongside, never counted as spend.
      if (r.reason === "cache_hit") { t.cache_hits += 1; if (Number.isFinite(r.saved_usd)) t.saved_usd += r.saved_usd; }
    }
  }
  const rows = [...buckets.values()].map((b) => ({ ...b, usd_known: round6(b.usd_known), saved_usd: round6(b.saved_usd), user_priced_usd: round6(b.user_priced_usd),
    ...(groupBy === "outcome" ? { runs: runSets.get(b.key)?.size ?? 0, lower_bound: !b.cost_complete } : {}) }));
  if (groupBy === "outcome") rows.sort((a, b) => OUTCOME_BUCKETS.indexOf(a.key) - OUTCOME_BUCKETS.indexOf(b.key));
  else rows.sort(groupBy === "day" ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.usd_known - a.usd_known || b.unknown_count - a.unknown_count || a.key.localeCompare(b.key));
  // #294: linear month-end forecast, only for exactly the current budget month.
  let forecast = null;
  if (range === "current_month" && until === undefined && Number.isFinite(now)) {
    const { start, end } = periodBounds("month", now, budgetPeriod);
    const base = { method: "linear", period_start: new Date(start).toISOString(), period_end: new Date(end).toISOString(),
      period_end_local: periodKey("day", end, budgetPeriod), elapsed_fraction: Math.max(0, Math.min(1, round6((now - start) / (end - start)))) };
    const project = (usd) => { const p = projectSpend("month", usd, now, { budgetPeriod }); return p === null ? null : round6(p); };
    if (clamped && from > start) forecast = { ...base, total: null, reason: "retention_clamped" };
    else {
      const projected = project(round6(total.usd_known));
      forecast = { ...base, total: { projected_usd: projected, lower_bound: !total.cost_complete }, reason: projected === null ? "too_early" : null };
      if (FORECAST_GROUPS.includes(groupBy)) for (const r of rows) { r.projected_usd = project(r.usd_known); r.lower_bound = !r.cost_complete; }
    }
  }
  return {
    group_by: groupBy,
    ...(groupBy === "tag" ? { tag_key: tagKey } : {}),
    ...(groupBy === "team" ? { team_membership: "current" } : {}),
    budget_period: { ...normalizeBudgetPeriod(budgetPeriod) },
    ...(range ? { range } : {}),
    since: from === undefined ? null : new Date(from).toISOString(),
    // #215: the local start date in the budget-period timezone, for "Total since".
    since_local: from === undefined ? null : periodKey("day", from, budgetPeriod),
    until: until === undefined ? null : new Date(until).toISOString(),
    retention_clamped: clamped,
    total: { ...total, usd_known: round6(total.usd_known), saved_usd: round6(total.saved_usd), user_priced_usd: round6(total.user_priced_usd) },
    buckets: rows,
    forecast,
  };
}

// #213: finance summary CSV. One row per budget period (day|month) and group,
// computed with spendBreakdown so the CSV and /v1/spend can't drift. In-band
// "#" lines say when retention clamped the range or cost is incomplete.
export const SPEND_CSV_COLUMNS = ["period", "group_by", "key", "label", "usd_known", "calls", "unknown_count", "cost_complete", "blocked_count"];
export const OUTCOME_CSV_COLUMNS = ["runs", "lower_bound"];
export function spendCsv(items, { period = "month", budgetPeriod = null, ...opts } = {}) {
  if (!CSV_PERIODS.includes(period)) throw bad(`period must be one of ${CSV_PERIODS.join("|")}`);
  const whole = spendBreakdown(items, { ...opts, budgetPeriod });
  const parts = new Map();
  for (const item of items) {
    const ms = Date.parse(item?.receipt?.ts);
    if (!Number.isFinite(ms)) continue;
    const k = periodKey(period, ms, budgetPeriod);
    if (!parts.has(k)) parts.set(k, []);
    parts.get(k).push(item);
  }
  const rows = [];
  for (const k of [...parts.keys()].sort()) {
    const b = spendBreakdown(parts.get(k), { ...opts, budgetPeriod });
    if (!b.total.calls) continue;
    for (const r of b.buckets) {
      const row = [k, b.group_by, r.key, r.label ?? r.key, r.usd_known, r.calls, r.unknown_count, r.cost_complete, r.blocked_count];
      // #225: outcome rows also carry runs and lower_bound, like /v1/spend.
      if (b.group_by === "outcome") row.push(r.runs, r.lower_bound);
      rows.push(row);
    }
  }
  const lines = [];
  if (whole.retention_clamped) lines.push(`# retention_clamped: since moved to ${whole.since} by your plan's receipt retention`);
  if (!whole.total.cost_complete) lines.push(`# cost_incomplete: ${whole.total.unknown_count} receipts have unknown cost; usd_known excludes them`);
  if (whole.group_by === "team") lines.push("# team_membership: current (spend is allocated by today's team membership)");
  lines.push((whole.group_by === "outcome" ? [...SPEND_CSV_COLUMNS, ...OUTCOME_CSV_COLUMNS] : SPEND_CSV_COLUMNS).join(","));
  for (const r of rows) lines.push(r.map(cell).join(","));
  return { body: `${lines.join("\n")}\n`, rows: rows.length, total: whole.total, retention_clamped: whole.retention_clamped };
}
