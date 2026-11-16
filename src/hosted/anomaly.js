// Issue #223: spend anomaly alerts. Pure. Pages when today's spend for an
// agent or team is far above its own 14-day median, with no cap needed.
// Days follow the org budget period timezone (#209). Unknown cost is never
// $0: it is counted separately and the alert carries lower_bound.

import { localParts, normalizeBudgetPeriod, periodKey, zonedMidnight } from "../period.js";

export const DEFAULT_ANOMALY = Object.freeze({ enabled: true, multiplier: 3, min_usd: 5 });
export const ANOMALY_BASELINE_DAYS = 14;
export const ANOMALY_MIN_HISTORY_DAYS = 7;
export const ANOMALY_MULTIPLIER_RANGE = Object.freeze([1.5, 20]);
const FIELDS = ["enabled", "multiplier", "min_usd"];
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Error message, or null when v is a valid anomaly override ({} allowed).
export function anomalyError(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "anomaly must be an object";
  for (const k of Object.keys(v)) if (!FIELDS.includes(k)) return `Unknown anomaly field ${k}`;
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") return "anomaly.enabled must be boolean";
  const [lo, hi] = ANOMALY_MULTIPLIER_RANGE;
  if (v.multiplier !== undefined && !(typeof v.multiplier === "number" && Number.isFinite(v.multiplier) && v.multiplier >= lo && v.multiplier <= hi)) return `anomaly.multiplier must be a number from ${lo} to ${hi}`;
  if (v.min_usd !== undefined && !(typeof v.min_usd === "number" && Number.isFinite(v.min_usd) && v.min_usd >= 0)) return "anomaly.min_usd must be a number >= 0";
  return null;
}

// Defaults <- org default <- per-agent/team override. Invalid layers are ignored.
export function resolveAnomaly(...layers) {
  const out = { ...DEFAULT_ANOMALY };
  for (const l of layers) {
    if (!l || anomalyError(l)) continue;
    for (const k of FIELDS) if (l[k] !== undefined) out[k] = l[k];
  }
  return out;
}

const costOf = (r) => (typeof r?.cost_usd === "number" && Number.isFinite(r.cost_usd) ? r.cost_usd : null);

// Local day keys of the previous `days` complete days, oldest first.
export function previousDays(nowMs, budgetPeriod, days = ANOMALY_BASELINE_DAYS) {
  const tz = normalizeBudgetPeriod(budgetPeriod).timezone;
  const { year, month, day } = localParts(nowMs, tz);
  const out = [];
  // Noon avoids DST edges when mapping a local date back to its key.
  for (let i = days; i >= 1; i -= 1) out.push(periodKey("day", zonedMidnight(year, month, day - i, tz) + 12 * 3600_000, budgetPeriod));
  return out;
}

export function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// receipts: [{ ts, cost_usd, model }] (settlements already applied).
// Returns today's spend, top models, and the per-day baseline window.
export function dailySpend(receipts, nowMs, budgetPeriod = null) {
  const today = periodKey("day", nowMs, budgetPeriod);
  const window = previousDays(nowMs, budgetPeriod);
  const days = new Map(window.map((k) => [k, { day: k, usd: 0, unknown: 0, calls: 0 }]));
  const t = { day: today, usd: 0, unknown: 0, calls: 0 };
  const models = new Map();
  for (const r of receipts) {
    const ms = Date.parse(r?.ts);
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    const key = periodKey("day", ms, budgetPeriod);
    const bucket = key === today ? t : days.get(key);
    if (!bucket) continue;
    const c = costOf(r);
    bucket.calls += 1;
    if (c === null) bucket.unknown += 1;
    else bucket.usd += c;
    if (bucket === t && c !== null) {
      const m = typeof r.model === "string" && r.model ? r.model : "unknown";
      models.set(m, (models.get(m) ?? 0) + c);
    }
  }
  const history = [...days.values()];
  const first = history.findIndex((d) => d.calls > 0);
  // Days before the first observed receipt are not history; zero-spend days after it are.
  const observed = first < 0 ? [] : history.slice(first);
  const top = [...models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([model, usd]) => ({ model, usd: round6(usd) }));
  return { today: { ...t, usd: round6(t.usd) }, history: observed.map((d) => ({ ...d, usd: round6(d.usd) })), top_models: top };
}

// id: agent id or "team:<orgId>:<name>". Returns one alert or null.
export function evaluateAnomaly({ id, receipts = [], nowMs, budgetPeriod = null, settings = DEFAULT_ANOMALY, minHistoryDays = ANOMALY_MIN_HISTORY_DAYS }) {
  const cfg = resolveAnomaly(settings);
  if (!cfg.enabled) return null;
  const { today, history, top_models } = dailySpend(receipts, nowMs, budgetPeriod);
  if (history.length < minHistoryDays) return null;
  const baseline = round6(median(history.map((d) => d.usd)));
  const threshold = round6(Math.max(cfg.min_usd, cfg.multiplier * baseline));
  if (!(today.usd >= threshold) || today.usd <= 0) return null;
  return {
    kind: "spend_anomaly", key: `spend_anomaly:${id}:${today.day}`, scope: "day", date: today.day,
    today: today.usd, baseline, multiplier: cfg.multiplier, min_usd: cfg.min_usd, threshold,
    spent: today.usd, history_days: history.length, top_models,
    unknown_count: today.unknown, lower_bound: today.unknown > 0,
    baseline_lower_bound: history.some((d) => d.unknown > 0),
  };
}
