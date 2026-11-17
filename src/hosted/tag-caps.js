import { periodKey, samePeriod } from "../period.js";
// Issue #204: fleet-wide per-tag caps. An org sets `tagCaps` rules in the
// dashboard (GET/PUT /v1/tag-caps); GET /v1/policy ships the rules plus the
// org's synced per-value spend for this UTC month, and every enrolled wrapper
// enforces them against that spend plus its own unsynced receipts. Pure logic.
import { TAG_KEY } from "../tags.js";
import { UNTAGGED } from "../tag-cap.js";
import { isPendingBatch } from "../cap.js";
import { warnFractionsError, sortWarnFractions } from "./alerts.js";

// #268: week rules (ISO week, Monday start, org timezone). Spend entries always
// carry day and month; week and unknown_week are optional (an old server omits them).
export const FLEET_TAG_SCOPES = Object.freeze(["day", "week", "month"]);
// What a pre-#268 wrapper accepts in tag_caps; week rules travel in tag_caps_v2.
export const LEGACY_TAG_SCOPES = Object.freeze(["day", "month"]);
const REQUIRED_SPEND = ["day", "month"];
export const MAX_FLEET_TAG_RULES = 10;
export const MAX_TAG_VALUES = 1000;

const round6 = (n) => Number(n.toFixed(6));
const valueOf = (tags, key) => (tags && typeof tags === "object" && typeof tags[key] === "string" ? tags[key] : UNTAGGED);

/** Validate a PUT body's `tagCaps`; returns the normalized rules or an error string. */
// #286: what PUT /v1/tag-caps accepts; total rules travel only in tag_caps_total.
export const STORED_TAG_SCOPES = Object.freeze([...FLEET_TAG_SCOPES, "total"]);

export function parseFleetTagCaps(input, { total = false } = {}) {
  if (!Array.isArray(input)) return { error: "tagCaps must be a list" };
  if (input.length > MAX_FLEET_TAG_RULES) return { error: `At most ${MAX_FLEET_TAG_RULES} tag cap rules` };
  const seen = new Set();
  const rules = [];
  for (const r of input) {
    if (!r || typeof r !== "object" || typeof r.key !== "string" || !TAG_KEY.test(r.key)) return { error: "Each rule key must match [a-z0-9_.-]{1,32}" };
    if (!(total ? STORED_TAG_SCOPES : FLEET_TAG_SCOPES).includes(r.scope)) return { error: total ? "Each rule scope must be day, week, month or total" : "Each rule scope must be day, week or month" };
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
 * spend[key][value] = {day, month, unknown} for the current period, at most
 * MAX_TAG_VALUES values per key (unknown-cost values first, then highest spend).
 * #268: with { week: true } each entry adds week and unknown_week, and receipts
 * count back to min(month start, week start) so a week that began last month is
 * not under-counted. Without it the output is the pre-#268 shape, unchanged.
 */
export function fleetTagCapsPolicy(rules, receipts, nowMs, max = MAX_TAG_VALUES, budgetPeriod = null, { week = false } = {}) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const now = new Date(nowMs).toISOString();
  const month = periodKey("month", nowMs, budgetPeriod), day = periodKey("day", nowMs, budgetPeriod), wk = periodKey("week", nowMs, budgetPeriod);
  const keys = [...new Set(rules.map((r) => r.key))];
  const acc = Object.fromEntries(keys.map((k) => [k, new Map()]));
  for (const r of receipts) {
    if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts))) continue;
    const tsMs = Date.parse(r.ts);
    if (isPendingBatch(r)) continue;
    const inMonth = periodKey("month", tsMs, budgetPeriod) === month;
    const inWeek = week && periodKey("week", tsMs, budgetPeriod) === wk;
    if (!inMonth && !inWeek) continue;
    for (const key of keys) {
      const v = valueOf(r.tags, key);
      const e = acc[key].get(v) ?? { day: 0, week: 0, month: 0, unknown: 0, unknown_week: 0 };
      acc[key].set(v, e);
      if (r.cost_usd === null || r.cost_usd === undefined) { if (inMonth) e.unknown += 1; if (inWeek) e.unknown_week += 1; continue; }
      if (inMonth) e.month += r.cost_usd;
      if (inWeek) e.week += r.cost_usd;
      if (periodKey("day", tsMs, budgetPeriod) === day) e.day += r.cost_usd;
    }
  }
  let truncated = false;
  const spend = {};
  const top = (e) => (week ? Math.max(e.month, e.week) : e.month);
  const anyUnknown = (e) => e.unknown > 0 || e.unknown_week > 0;
  for (const key of keys) {
    const sorted = [...acc[key]].sort((a, b) => anyUnknown(b[1]) - anyUnknown(a[1]) || top(b[1]) - top(a[1]) || (a[0] < b[0] ? -1 : 1));
    if (sorted.length > max) truncated = true;
    spend[key] = Object.fromEntries(sorted.slice(0, max).map(([v, e]) => [v, week
      ? { day: round6(e.day), week: round6(e.week), month: round6(e.month), unknown: e.unknown, unknown_week: e.unknown_week }
      : { day: round6(e.day), month: round6(e.month), unknown: e.unknown }]));
  }
  return { rules: rules.map((r) => ({ ...r })), spend, truncated, as_of: now };
}

/**
 * #268: the two GET /v1/policy blocks. tag_caps keeps the pre-#268 shape (day and
 * month rules only, null when every rule is week); tag_caps_v2 carries every rule
 * plus week spend and is present only when a week rule exists.
 */
export function fleetTagCapsPayload(rules, receipts, nowMs, budgetPeriod = null) {
  const stored = Array.isArray(rules) ? rules : [];
  const all = stored.filter((r) => r.scope !== "total");
  const totals = stored.filter((r) => r.scope === "total");
  const legacy = all.filter((r) => LEGACY_TAG_SCOPES.includes(r.scope));
  return {
    tag_caps: fleetTagCapsPolicy(legacy, receipts, nowMs, MAX_TAG_VALUES, budgetPeriod),
    tag_caps_v2: all.some((r) => r.scope === "week") ? fleetTagCapsPolicy(all, receipts, nowMs, MAX_TAG_VALUES, budgetPeriod, { week: true }) : null,
    // #286: lifetime rules in an additive block, only when one exists (byte-identical otherwise).
    ...(totals.length ? { tag_caps_total: fleetTagTotalPolicy(totals, receipts, nowMs) } : {}),
  };
}

/**
 * #286: lifetime per-value spend for total rules. spend[key][value] = {total, unknown}
 * over every receipt ever; at most `max` values per key (unknown first, then highest).
 */
export function fleetTagTotalPolicy(rules, receipts, nowMs, max = MAX_TAG_VALUES) {
  const totals = (rules ?? []).filter((r) => r.scope === "total");
  if (!totals.length) return null;
  const keys = [...new Set(totals.map((r) => r.key))];
  const acc = Object.fromEntries(keys.map((k) => [k, new Map()]));
  for (const r of receipts) {
    if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r)) continue;
    for (const key of keys) {
      const v = valueOf(r.tags, key);
      const e = acc[key].get(v) ?? { total: 0, unknown: 0 };
      acc[key].set(v, e);
      if (r.cost_usd === null || r.cost_usd === undefined) e.unknown += 1; else e.total += r.cost_usd;
    }
  }
  let truncated = false;
  const spend = {};
  for (const key of keys) {
    const sorted = [...acc[key]].sort((a, b) => (b[1].unknown > 0) - (a[1].unknown > 0) || b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1));
    if (sorted.length > max) truncated = true;
    spend[key] = Object.fromEntries(sorted.slice(0, max).map(([v, e]) => [v, { total: round6(e.total), unknown: e.unknown }]));
  }
  return { rules: totals.map((r) => ({ ...r })), spend, truncated, as_of: new Date(nowMs).toISOString() };
}

export function validFleetTagTotal(t) {
  if (t === null || t === undefined) return true;
  if (typeof t !== "object" || typeof t.truncated !== "boolean" || !Number.isFinite(Date.parse(t.as_of))) return false;
  if (!Array.isArray(t.rules) || !t.rules.length || t.rules.some((r) => r?.scope !== "total") || parseFleetTagCaps(t.rules, { total: true }).error) return false;
  if (!t.spend || typeof t.spend !== "object") return false;
  for (const values of Object.values(t.spend)) {
    if (!values || typeof values !== "object") return false;
    for (const e of Object.values(values)) if (!e || !Number.isInteger(e.unknown) || e.unknown < 0 || !(typeof e.total === "number" && Number.isFinite(e.total) && e.total >= 0)) return false;
  }
  return true;
}

/**
 * #286: offline lifetime tag verdict. Synced lifetime spend of the request's value
 * (an unlisted value of a truncated list counts at the lowest listed known total)
 * plus every unsynced receipt on this host with that value.
 */
export function cachedFleetTagTotalVerdict(policy, tags, pending) {
  if (!policy?.rules?.length) return null;
  for (const rule of policy.rules) {
    const value = valueOf(tags, rule.key);
    const values = policy.spend?.[rule.key] ?? {};
    let e = values[value];
    if (!e) {
      const known = Object.values(values).filter((x) => x.unknown === 0);
      e = !policy.truncated ? { total: 0, unknown: 0 } : known.length ? { total: Math.min(...known.map((x) => x.total)), unknown: 0 } : { total: 0, unknown: Object.keys(values).length ? 1 : 0 };
    }
    let total = e.total, unknown = e.unknown;
    for (const r of pending) {
      if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r) || valueOf(r.tags, rule.key) !== value) continue;
      if (r.cost_usd === null || r.cost_usd === undefined) unknown += 1; else total += r.cost_usd;
    }
    if (unknown > 0) return { verdict: "accounting_unavailable", reason: "accounting_unavailable", tag_key: rule.key, tag_value: value, scope: "total", unknown_receipts: unknown, fleet: true,
      message: `CostCap: ${rule.key}=${value} has ${unknown} receipt(s) with unknown cost, so its fleet tag cap cannot be enforced. The upstream call was not made.` };
    if (total >= rule.usd) return { verdict: "tag_budget_exceeded", tag_key: rule.key, tag_value: value, scope: "total", spend_usd: round6(total), cap_usd: rule.usd, fleet: true };
  }
  return null;
}

export function validFleetTagCaps(t) {
  if (t === null || t === undefined) return true;
  if (typeof t !== "object" || typeof t.truncated !== "boolean" || !Number.isFinite(Date.parse(t.as_of))) return false;
  if (!t.rules?.length || parseFleetTagCaps(t.rules).error || !t.spend || typeof t.spend !== "object") return false;
  for (const values of Object.values(t.spend)) {
    if (!values || typeof values !== "object") return false;
    for (const e of Object.values(values)) {
      if (!e || !Number.isInteger(e.unknown) || e.unknown < 0) return false;
      if (!REQUIRED_SPEND.every((s) => typeof e[s] === "number" && Number.isFinite(e[s]) && e[s] >= 0)) return false;
      if (e.week !== undefined && !(typeof e.week === "number" && Number.isFinite(e.week) && e.week >= 0)) return false;
      if (e.unknown_week !== undefined && !(Number.isInteger(e.unknown_week) && e.unknown_week >= 0)) return false;
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
  if (!policy.truncated) return { day: 0, week: 0, month: 0, unknown: 0, unknown_week: 0 };
  // Values with unknown-cost receipts sort first and may show $0, so they never set
  // the floor. If every listed value has unknown cost, the unlisted one can't be bounded.
  // #268: a week payload sorts on max(month, week), which bounds day, week and month.
  const known = Object.values(values).filter((e) => e.unknown === 0 && !(e.unknown_week > 0));
  if (!known.length) { const u = Object.keys(values).length ? 1 : 0; return { day: 0, week: 0, month: 0, unknown: u, unknown_week: u }; }
  const floor = Math.min(...known.map((e) => Math.max(e.month, e.week ?? 0)));
  return { day: floor, week: floor, month: floor, unknown: 0, unknown_week: 0 };
}

// Synced plus pending spend (and unknown-cost count) of one merged rule for one value.
function ruleTotals(policy, rule, value, pending, nowMs, budgetPeriod) {
  const asOfMs = Date.parse(policy.as_of);
  const e = syncedEntry(policy, rule.key, value);
  const same = (s) => samePeriod(s, nowMs, asOfMs, budgetPeriod);
  // #268: a week rule counts unknown cost inside the current week (which can start last month).
  const win = rule.scope === "week" ? "week" : "month";
  let unknown = same(win) ? (win === "week" ? e.unknown_week ?? 0 : e.unknown) : 0;
  let total = same(rule.scope) ? e[rule.scope] ?? 0 : 0;
  for (const r of pending) {
    if (r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r) || valueOf(r.tags, rule.key) !== value) continue;
    const tsMs = Date.parse(r.ts);
    if (!samePeriod(win, tsMs, nowMs, budgetPeriod)) continue;
    if (r.cost_usd === null || r.cost_usd === undefined) { unknown += 1; continue; }
    if (samePeriod(rule.scope, tsMs, nowMs, budgetPeriod)) total += r.cost_usd;
  }
  return { total, unknown };
}

/**
 * Offline fleet tag verdict for one request's merged tags. pending: this host's
 * unsynced, settled-aware receipts. Returns null, a tag_budget_exceeded hit
 * (fleet: true, or fleet: false when a stricter local --tag-cap was the binding
 * cap, #248) or an accounting_unavailable verdict for that value only.
 */
export function cachedFleetTagVerdict(policy, localRules, tags, pending, nowMs, budgetPeriod = null) {
  if (!policy?.rules?.length) return null;
  for (const rule of mergeTagCapRules(policy.rules, localRules)) {
    const value = valueOf(tags, rule.key);
    const { total, unknown } = ruleTotals(policy, rule, value, pending, nowMs, budgetPeriod);
    if (unknown > 0) return { verdict: "accounting_unavailable", reason: "accounting_unavailable", tag_key: rule.key, tag_value: value, unknown_receipts: unknown, fleet: true,
      message: `CostCap: ${rule.key}=${value} has ${unknown} receipt(s) with unknown cost, so its fleet tag cap cannot be enforced. The upstream call was not made.` };
    if (total >= rule.cap) return { verdict: "tag_budget_exceeded", tag_key: rule.key, tag_value: value, scope: rule.scope, spend_usd: round6(total), cap_usd: rule.cap, fleet: !(rule.cap < rule.fleetUsd) };
  }
  return null;
}

/**
 * #272: remaining USD of every fleet tag rule (merged with local rules) for one
 * request's merged tags, for --preflight. A rule whose value has unknown-cost
 * receipts is left out: check() already refuses it, and it is never treated as $0.
 */
export function cachedFleetTagRemaining(policy, localRules, tags, pending, nowMs, budgetPeriod = null) {
  if (!policy?.rules?.length) return [];
  const out = [];
  for (const rule of mergeTagCapRules(policy.rules, localRules)) {
    const value = valueOf(tags, rule.key);
    const { total, unknown } = ruleTotals(policy, rule, value, pending, nowMs, budgetPeriod);
    if (unknown > 0) continue;
    out.push({ tag_key: rule.key, tag_value: value, scope: rule.scope, cap_usd: rule.cap, remaining_usd: round6(Math.max(rule.cap - total, 0)), fleet: !(rule.cap < rule.fleetUsd) });
  }
  return out;
}
