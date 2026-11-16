// Issue #156: spend breakdown by UTC day, model or agent for the hosted dashboard.
// Pure: no store access. Unknown cost is counted, never added as $0. A settled
// unknown cost counts at its settled value in its original bucket.

export const SPEND_GROUPS = ["day", "model", "agent"];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

const bad = (message) => { const err = new Error(message); err.status = 400; return err; };

// since/until are ISO instants or YYYY-MM-DD (UTC). A date-only until covers that whole day.
export function parseSpendQuery(params) {
  const groupBy = params.get("group_by") ?? "day";
  if (!SPEND_GROUPS.includes(groupBy)) throw bad(`group_by must be one of ${SPEND_GROUPS.join("|")}`);
  const out = { groupBy };
  for (const key of ["since", "until"]) {
    const v = params.get(key);
    if (v === null) continue;
    const ms = Date.parse(DATE_ONLY.test(v) ? `${v}T00:00:00Z` : v);
    if (!v || !Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}/.test(v)) throw bad(`${key} must be an ISO date`);
    out[key] = key === "until" && DATE_ONLY.test(v) ? ms + DAY_MS : ms;
    if (key === "until") out.untilExclusive = DATE_ONLY.test(v);
  }
  if (out.since !== undefined && out.until !== undefined && out.since > out.until) throw bad("since must be before until");
  return out;
}

// items: [{ agentId, receipt, settlement? }]. names: { agentId: label }.
export function spendBreakdown(items, { groupBy = "day", since, until, untilExclusive = false, cutoff = null, names = {} } = {}) {
  if (!SPEND_GROUPS.includes(groupBy)) throw bad(`group_by must be one of ${SPEND_GROUPS.join("|")}`);
  let from = since, clamped = false;
  if (cutoff !== null && cutoff !== undefined && (from === undefined || from < cutoff)) { from = cutoff; clamped = true; }
  const buckets = new Map();
  const total = { usd_known: 0, calls: 0, unknown_count: 0, blocked_count: 0, cost_complete: true };
  for (const item of items) {
    const r = item?.receipt;
    const ms = Date.parse(r?.ts);
    if (!Number.isFinite(ms)) continue;
    if (from !== undefined && ms < from) continue;
    if (until !== undefined && (untilExclusive ? ms >= until : ms > until)) continue;
    const key = groupBy === "day" ? new Date(ms).toISOString().slice(0, 10)
      : groupBy === "model" ? (typeof r.model === "string" && r.model ? r.model : "unknown")
      : String(item.agentId ?? "unknown");
    let b = buckets.get(key);
    if (!b) {
      b = { key, usd_known: 0, calls: 0, unknown_count: 0, blocked_count: 0, cost_complete: true };
      if (groupBy === "agent") b.label = names[key] ?? key;
      buckets.set(key, b);
    }
    const settled = item.settlement?.cost_usd;
    const cost = r.cost_usd == null ? (typeof settled === "number" && Number.isFinite(settled) ? settled : null) : r.cost_usd;
    for (const t of [b, total]) {
      t.calls += 1;
      if (r.blocked === true) t.blocked_count += 1;
      if (typeof cost === "number" && Number.isFinite(cost)) t.usd_known += cost;
      else { t.unknown_count += 1; t.cost_complete = false; }
    }
  }
  const rows = [...buckets.values()].map((b) => ({ ...b, usd_known: round6(b.usd_known) }));
  rows.sort(groupBy === "day" ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.usd_known - a.usd_known || b.unknown_count - a.unknown_count || a.key.localeCompare(b.key));
  return {
    group_by: groupBy,
    since: from === undefined ? null : new Date(from).toISOString(),
    until: until === undefined ? null : new Date(until).toISOString(),
    retention_clamped: clamped,
    total: { ...total, usd_known: round6(total.usd_known) },
    buckets: rows,
  };
}
