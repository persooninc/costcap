// Issue #204: fleet-wide per-tag caps. An org sets `tagCaps` rules in the
// dashboard (GET/PUT /v1/tag-caps); GET /v1/policy ships the rules plus the
// org's synced per-value spend for this UTC month, and every enrolled wrapper
// enforces them against that spend plus its own unsynced receipts. Pure logic.
import { TAG_KEY } from "../tags.js";
import { UNTAGGED } from "../tag-cap.js";
import { isPendingBatch } from "../cap.js";

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
    rules.push({ key: r.key, scope: r.scope, usd: r.usd });
  }
  return { rules };
}

/**
 * The tag_caps block of GET /v1/policy. receipts: settled-aware org receipts.
 * spend[key][value] = {day, month, unknown} for the current UTC month, at most
 * MAX_TAG_VALUES values per key (unknown-cost values first, then highest month).
 */
export function fleetTagCapsPolicy(rules, receipts, nowMs, max = MAX_TAG_VALUES) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const now = new Date(nowMs).toISOString();
  const keys = [...new Set(rules.map((r) => r.key))];
  const acc = Object.fromEntries(keys.map((k) => [k, new Map()]));
  for (const r of receipts) {
    if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts))) continue;
    const ts = new Date(r.ts).toISOString();
    if (ts.slice(0, 7) !== now.slice(0, 7) || isPendingBatch(r)) continue;
    for (const key of keys) {
      const v = valueOf(r.tags, key);
      const e = acc[key].get(v) ?? { day: 0, month: 0, unknown: 0 };
      acc[key].set(v, e);
      if (r.cost_usd === null || r.cost_usd === undefined) { e.unknown += 1; continue; }
      e.month += r.cost_usd;
      if (ts.slice(0, 10) === now.slice(0, 10)) e.day += r.cost_usd;
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
    return { key: r.key, scope: r.scope, cap: local ? Math.min(local.cap, r.usd) : r.usd };
  });
}

// Synced spend for one value. A value missing from a truncated list counts at the
// lowest listed month spend, which is an upper bound for both its day and month.
function syncedEntry(policy, key, value) {
  const values = policy.spend?.[key] ?? {};
  if (values[value]) return values[value];
  if (!policy.truncated) return { day: 0, month: 0, unknown: 0 };
  const floor = Math.min(...Object.values(values).map((e) => e.month));
  return Number.isFinite(floor) ? { day: floor, month: floor, unknown: 0 } : { day: 0, month: 0, unknown: 0 };
}

/**
 * Offline fleet tag verdict for one request's merged tags. pending: this host's
 * unsynced, settled-aware receipts. Returns null, a tag_budget_exceeded hit
 * (fleet: true) or an accounting_unavailable verdict for that value only.
 */
export function cachedFleetTagVerdict(policy, localRules, tags, pending, nowMs) {
  if (!policy?.rules?.length) return null;
  const now = new Date(nowMs).toISOString();
  const asOf = new Date(policy.as_of).toISOString();
  const win = { day: 10, month: 7 };
  for (const rule of mergeTagCapRules(policy.rules, localRules)) {
    const value = valueOf(tags, rule.key);
    const e = syncedEntry(policy, rule.key, value);
    const same = (s) => now.slice(0, win[s]) === asOf.slice(0, win[s]);
    let unknown = same("month") ? e.unknown : 0;
    let total = same(rule.scope) ? e[rule.scope] : 0;
    for (const r of pending) {
      if (r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r) || valueOf(r.tags, rule.key) !== value) continue;
      const ts = new Date(r.ts).toISOString();
      if (ts.slice(0, 7) !== now.slice(0, 7)) continue;
      if (r.cost_usd === null || r.cost_usd === undefined) { unknown += 1; continue; }
      if (ts.slice(0, win[rule.scope]) === now.slice(0, win[rule.scope])) total += r.cost_usd;
    }
    if (unknown > 0) return { verdict: "accounting_unavailable", reason: "accounting_unavailable", tag_key: rule.key, tag_value: value, unknown_receipts: unknown, fleet: true,
      message: `CostCap: ${rule.key}=${value} has ${unknown} receipt(s) with unknown cost, so its fleet tag cap cannot be enforced. The upstream call was not made.` };
    if (total >= rule.cap) return { verdict: "tag_budget_exceeded", tag_key: rule.key, tag_value: value, scope: rule.scope, spend_usd: round6(total), cap_usd: rule.cap, fleet: true };
  }
  return null;
}
