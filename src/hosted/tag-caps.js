import { periodKey, samePeriod } from "../period.js";
// Issue #204: fleet-wide per-tag caps. An org sets `tagCaps` rules in the
// dashboard (GET/PUT /v1/tag-caps); GET /v1/policy ships the rules plus the
// org's synced per-value spend for this UTC month, and every enrolled wrapper
// enforces them against that spend plus its own unsynced receipts. Pure logic.
import { TAG_KEY } from "../tags.js";
import { UNTAGGED } from "../tag-cap.js";
import { isPendingBatch } from "../cap.js";
import { warnFractionsError, sortWarnFractions } from "./alerts.js";

export const FLEET_TAG_SCOPES = Object.freeze(["day", "month"]);
export const MAX_FLEET_TAG_RULES = 10;
export const MAX_TAG_VALUES = 1000;

const round6 = (n) => Number(n.toFixed(6));
const valueOf = (tags, key) => (tags && typeof tags === "object" && typeof tags[key] === "string" ? tags[key] : UNTAGGED);

/** Validate a PUT body's `tagCaps`; returns the normalized rules or an error string. */
export function parseFleetTagCaps(input) {
  if (!Array.isArray(input)) return { error: "tagCaps must be a list" };
  if (input.length > MAX_FLEET_TAG_RULES) return { error: `At most ${MAX_FLEET_TAG_RULES} tag cap rules` };
  const seen = new Set();
  const rules = [];
  for (const r of input) {
    if (!r || typeof r !== "object" || typeof r.key !== "string" || !TAG_KEY.test(r.key)) return { error: "Each rule key must match [a-z0-9_.-]{1,32}" };
    if (!FLEET_TAG_SCOPES.includes(r.scope)) return { error: "Each rule scope must be day or month" };
    if (!(typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd > 0)) return { error: "Each rule usd must be a positive number" };
    const id = `${r.key}:${r.scope}`;
    if (seen.has(id)) return { error: `Duplicate rule ${id}` };
    seen.add(id);
    // Issue #243: optional per-rule cap_approaching fractions (default [0.8] when absent).
    if (r.warnFractions !== undefined) {
      const err = warnFractionsError(r.warnFractions);
      if (err) return { error: `Rule ${id}: ${err}` };
    }
    rules.push({ key: r.key, scope: r.scope, usd: r.usd, ...(r.warnFractions !== undefined ? { warnFractions: sortWarnFractions(r.warnFractions) } : {}) });
  }
  return { rules };
}

/**
 * The tag_caps block of GET /v1/policy. receipts: settled-aware org receipts.
 * spend[key][value] = {day, month, unknown} for the current UTC month, at most
 * MAX_TAG_VALUES values per key (unknown-cost values first, then highest month).
 */
export function fleetTagCapsPolicy(rules, receipts, nowMs, max = MAX_TAG_VALUES, budgetPeriod = null) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const now = new Date(nowMs).toISOString();
  const month = periodKey("month", nowMs, budgetPeriod), day = periodKey("day", nowMs, budgetPeriod);
  const keys = [...new Set(rules.map((r) => r.key))];
  const acc = Object.fromEntries(keys.map((k) => [k, new Map()]));
  for (const r of receipts) {
    if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts))) continue;
    const tsMs = Date.parse(r.ts);
    if (periodKey("month", tsMs, budgetPeriod) !== month || isPendingBatch(r)) continue;
    for (const key of keys) {
      const v = valueOf(r.tags, key);
      const e = acc[key].get(v) ?? { day: 0, month: 0, unknown: 0 };
      acc[key].set(v, e);
      if (r.cost_usd === null || r.cost_usd === undefined) { e.unknown += 1; continue; }
      e.month += r.cost_usd;
      if (periodKey("day", tsMs, budgetPeriod) === day) e.day += r.cost_usd;
    }
  }
  let truncated = false;
  const spend = {};
  for (const key of keys) {
    const sorted = [...acc[key]].sort((a, b) => (b[1].unknown > 0) - (a[1].unknown > 0) || b[1].month - a[1].month || (a[0] < b[0] ? -1 : 1));
    if (sorted.length > max) truncated = true;
    spend[key] = Object.fromEntries(sorted.slice(0, max).map(([v, e]) => [v, { day: round6(e.day), month: round6(e.month), unknown: e.unknown }]));
  }
  return { rules: rules.map((r) => ({ ...r })), spend, truncated, as_of: now };
}

export function validFleetTagCaps(t) {
  if (t === null || t === undefined) return true;
  if (typeof t !== "object" || typeof t.truncated !== "boolean" || !Number.isFinite(Date.parse(t.as_of))) return false;
  if (!t.rules?.length || parseFleetTagCaps(t.rules).error || !t.spend || typeof t.spend !== "object") return false;
  for (const values of Object.values(t.spend)) {
    if (!values || typeof values !== "object") return false;
    for (const e of Object.values(values)) {
      if (!e || !Number.isInteger(e.unknown) || e.unknown < 0) return false;
      if (!FLEET_TAG_SCOPES.every((s) => typeof e[s] === "number" && Number.isFinite(e[s]) && e[s] >= 0)) return false;
    }
  }
  return true;
}

/** Fleet rules merged with local --tag-cap rules: for the same key:scope the lower cap wins. */
export function mergeTagCapRules(fleetRules = [], localRules = []) {
  return fleetRules.map((r) => {
    const local = localRules.find((l) => l.key === r.key && l.scope === r.scope);
    return { key: r.key, scope: r.scope, cap: local ? Math.min(local.cap, r.usd) : r.usd, fleetUsd: r.usd };
  });
}

// Synced spend for one value. A value missing from a truncated list counts at the
// lowest listed month spend, which is an upper bound for both its day and month.
function syncedEntry(policy, key, value) {
  const values = policy.spend?.[key] ?? {};
  if (values[value]) return values[value];
  if (!policy.truncated) return { day: 0, month: 0, unknown: 0 };
  // Values with unknown-cost receipts sort first and may show $0, so they never set
  // the floor. If every listed value has unknown cost, the unlisted one can't be bounded.
  const known = Object.values(values).filter((e) => e.unknown === 0);
  if (!known.length) return { day: 0, month: 0, unknown: Object.keys(values).length ? 1 : 0 };
  const floor = Math.min(...known.map((e) => e.month));
  return { day: floor, month: floor, unknown: 0 };
}

/**
 * Offline fleet tag verdict for one request's merged tags. pending: this host's
 * unsynced, settled-aware receipts. Returns null, a tag_budget_exceeded hit
 * (fleet: true, or fleet: false when a stricter local --tag-cap was the binding
 * cap, #248) or an accounting_unavailable verdict for that value only.
 */
export function cachedFleetTagVerdict(policy, localRules, tags, pending, nowMs, budgetPeriod = null) {
  if (!policy?.rules?.length) return null;
  const asOfMs = Date.parse(policy.as_of);
  for (const rule of mergeTagCapRules(policy.rules, localRules)) {
    const value = valueOf(tags, rule.key);
    const e = syncedEntry(policy, rule.key, value);
    const same = (s) => samePeriod(s, nowMs, asOfMs, budgetPeriod);
    let unknown = same("month") ? e.unknown : 0;
    let total = same(rule.scope) ? e[rule.scope] : 0;
    for (const r of pending) {
      if (r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r) || valueOf(r.tags, rule.key) !== value) continue;
      const tsMs = Date.parse(r.ts);
      if (!samePeriod("month", tsMs, nowMs, budgetPeriod)) continue;
      if (r.cost_usd === null || r.cost_usd === undefined) { unknown += 1; continue; }
      if (samePeriod(rule.scope, tsMs, nowMs, budgetPeriod)) total += r.cost_usd;
    }
    if (unknown > 0) return { verdict: "accounting_unavailable", reason: "accounting_unavailable", tag_key: rule.key, tag_value: value, unknown_receipts: unknown, fleet: true,
      message: `CostCap: ${rule.key}=${value} has ${unknown} receipt(s) with unknown cost, so its fleet tag cap cannot be enforced. The upstream call was not made.` };
    if (total >= rule.cap) return { verdict: "tag_budget_exceeded", tag_key: rule.key, tag_value: value, scope: rule.scope, spend_usd: round6(total), cap_usd: rule.cap, fleet: !(rule.cap < rule.fleetUsd) };
  }
  return null;
}
