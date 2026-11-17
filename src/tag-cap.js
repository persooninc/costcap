// Issue #191: per-tag spend caps. `--tag-cap customer:day=5` gives every value
// of the `customer` tag its own $5 UTC-day cap. A request without the key counts
// in the "(untagged)" bucket, which has the same cap, so a missing header never
// bypasses it. A refusal never latches: other values (and this one, once its
// window rolls) keep going. Spend is bucketed at record time so check() is O(1)
// per rule, like cap.js.
import { TAG_KEY } from "./tags.js";
import { HOUR_MS, isPendingBatch, retryAfterSeconds } from "./cap.js";

export const TAG_CAP_SCOPES = Object.freeze(["hour", "day", "month"]);
export const UNTAGGED = "(untagged)";
export const TAG_CAP_RULE = "--tag-cap is KEY:SCOPE=USD with KEY matching [a-z0-9_.-]{1,32}, SCOPE hour|day|month and USD > 0, each KEY:SCOPE once";

const fail = (msg) => { const e = new Error(`${msg} (${TAG_CAP_RULE})`); e.code = "invalid_tag_cap"; throw e; };

/** Parse one "KEY:SCOPE=USD" rule. */
export function parseTagCap(text) {
  const s = String(text ?? "");
  const m = /^([^:=]*):([^=]*)=(.*)$/.exec(s);
  if (!m) fail(`invalid --tag-cap "${s}"`);
  const [, key, scope, usd] = m;
  if (!TAG_KEY.test(key)) fail(`invalid --tag-cap key "${key}"`);
  if (!TAG_CAP_SCOPES.includes(scope)) fail(`invalid --tag-cap scope "${scope}" in "${s}"`);
  const cap = usd.trim() === "" ? NaN : Number(usd);
  if (!Number.isFinite(cap) || cap <= 0) fail(`invalid --tag-cap amount "${usd}" in "${s}"`);
  return { key, scope, cap };
}

/** Parse repeated --tag-cap values; a duplicate KEY:SCOPE is an error. */
export function parseTagCaps(list) {
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const r = parseTagCap(t);
    const id = `${r.key}:${r.scope}`;
    if (seen.has(id)) fail(`duplicate --tag-cap ${id}`);
    seen.add(id);
    out.push(r);
  }
  return out;
}

const valueOf = (tags, key) => (tags && typeof tags === "object" && typeof tags[key] === "string" ? tags[key] : UNTAGGED);
const round = (n) => Number(n.toFixed(6));

export function createTagCaps({ rules = [], history = [], now = () => new Date() } = {}) {
  const byPeriod = new Map(); // key \0 value \0 period -> USD (day/month)
  const windows = new Map(); // key \0 value -> { win, head, sum } (hour)
  const pending = new Map(); // receipt id -> { tags, ts } for unknown-cost receipts
  const settled = new Set();
  const keys = [...new Set(rules.map((r) => r.key))];
  const hourKeys = new Set(rules.filter((r) => r.scope === "hour").map((r) => r.key));

  const windowFor = (id) => { let w = windows.get(id); if (!w) windows.set(id, (w = { win: [], head: 0, sum: 0 })); return w; };
  const evict = (w, nowMs) => {
    while (w.head < w.win.length && w.win[w.head][0] <= nowMs - HOUR_MS) { w.sum -= w.win[w.head][1]; w.head += 1; }
    if (w.head > 1024 && w.head * 2 > w.win.length) { w.win.splice(0, w.head); w.head = 0; }
    if (w.head === w.win.length || w.sum < 0) w.sum = w.head === w.win.length ? 0 : Math.max(0, w.sum);
    return w.sum;
  };
  const add = (tags, ts, cost) => {
    if (!(cost > 0) || !keys.length) return;
    const d = new Date(ts ?? now());
    const iso = d.toISOString();
    for (const key of keys) {
      const id = `${key}\0${valueOf(tags, key)}`;
      for (const p of [iso.slice(0, 10), iso.slice(0, 7)]) byPeriod.set(`${id}\0${p}`, (byPeriod.get(`${id}\0${p}`) ?? 0) + cost);
      if (!hourKeys.has(key)) continue;
      const w = windowFor(id);
      const ms = d.getTime();
      w.sum += cost;
      if (w.win.length > w.head && w.win[w.win.length - 1][0] > ms) {
        let lo = w.head, hi = w.win.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (w.win[mid][0] <= ms) lo = mid + 1; else hi = mid; }
        w.win.splice(lo, 0, [ms, cost]);
      } else w.win.push([ms, cost]);
    }
  };

  function spendOf(key, value, scope) {
    const d = now();
    const id = `${key}\0${value}`;
    if (scope === "hour") { const w = windows.get(id); return w ? evict(w, d.getTime()) : 0; }
    const iso = d.toISOString();
    return byPeriod.get(`${id}\0${scope === "day" ? iso.slice(0, 10) : iso.slice(0, 7)}`) ?? 0;
  }

  function verdict(rule, value) {
    const spent = spendOf(rule.key, value, rule.scope);
    if (spent < rule.cap) return null;
    const hit = { tag_key: rule.key, tag_value: value, scope: rule.scope, spend_usd: round(spent), cap_usd: rule.cap };
    if (rule.scope === "hour") {
      const w = windows.get(`${rule.key}\0${value}`);
      hit.retry_after_s = retryAfterSeconds(w.win.slice(w.head), spent, rule.cap, now().getTime());
    }
    return hit;
  }

  const engine = {
    rules: () => rules.map((r) => ({ ...r })),
    /** A receipt written to the ledger (own or sibling). Unknown cost waits for a settlement. */
    record(receipt) {
      if (!receipt) return;
      if (receipt.cost_usd === null || isPendingBatch(receipt)) {
        if (typeof receipt.id === "string" && receipt.id) pending.set(receipt.id, { tags: receipt.tags ?? null, ts: receipt.ts });
        return;
      }
      if (typeof receipt.cost_usd === "number" && Number.isFinite(receipt.cost_usd)) add(receipt.tags, receipt.ts, receipt.cost_usd);
    },
    /** A settlement of an unknown-cost receipt: its cost lands in that receipt's tag buckets once. */
    // Only receipts this engine saw with unknown cost settle, so a cost is never counted twice.
    settle(id, cost) {
      if (typeof id !== "string" || !id || settled.has(id) || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return false;
      const p = pending.get(id);
      if (!p) return false;
      settled.add(id);
      pending.delete(id);
      add(p.tags, p.ts, cost);
      return true;
    },
    /** First rule this request's merged tags are at or over, else null. */
    check(tags) {
      for (const rule of rules) {
        const hit = verdict(rule, valueOf(tags, rule.key));
        if (hit) return hit;
      }
      return null;
    },
    /** #193: remaining USD of every rule for this request's merged tags. */
    remaining(tags) {
      return rules.map((rule) => {
        const value = valueOf(tags, rule.key);
        return { tag_key: rule.key, tag_value: value, scope: rule.scope, cap_usd: rule.cap, remaining_usd: round(Math.max(rule.cap - spendOf(rule.key, value, rule.scope), 0)) };
      });
    },
    /** #193: first rule whose remainder cannot fit a preflight worst-case estimate, else null. */
    preflight(tags, estimateUsd, reservedFor = null) {
      // #255: in-flight worst cases on the same (key, value, scope) are reserved first.
      const left = (x) => { const res = reservedFor ? reservedFor(x) : 0; return res ? round(Math.max(x.remaining_usd - res, 0)) : x.remaining_usd; };
      const r = engine.remaining(tags).map((x) => ({ ...x, remaining_usd: left(x) })).find((x) => estimateUsd > x.remaining_usd);
      return r ? { reason: "preflight_estimate", estimate: true, estimate_usd: estimateUsd, ...r } : null;
    },
    /** Every (rule, value) at or over its cap in the current window, sorted. */
    over() {
      const out = [];
      const values = new Map();
      for (const k of byPeriod.keys()) { const [key, value] = k.split("\0"); if (!values.has(key)) values.set(key, new Set()); values.get(key).add(value); }
      for (const rule of rules) {
        for (const value of [...(values.get(rule.key) ?? [])].sort()) {
          const hit = verdict(rule, value);
          if (hit) out.push({ key: hit.tag_key, value: hit.tag_value, scope: hit.scope, spend_usd: hit.spend_usd, cap_usd: hit.cap_usd, verdict: "tag_budget_exceeded" });
        }
      }
      return out;
    },
  };
  for (const r of history) engine.record(r);
  return engine;
}

/**
 * #204: the local engine (may be null) plus an enrolled fleet's tag caps. Local
 * rules are checked against the local ledger first, then the fleet rules (each
 * tightened by a matching local rule) against fleet-wide synced spend.
 */
export function withFleetTagCaps(local, fleet, localRules = []) {
  return {
    rules: () => local?.rules() ?? [],
    record: (r) => local?.record(r),
    settle: (id, cost) => local?.settle(id, cost) ?? false,
    check: (tags) => local?.check(tags) ?? fleet.tagCheck(tags, localRules),
    remaining: (tags) => local?.remaining(tags) ?? [],
    preflight: (tags, est, reservedFor) => local?.preflight(tags, est, reservedFor) ?? null,
    over: () => local?.over() ?? [],
  };
}

export function tagBudgetExceededBody(hit) {
  if (hit.reason === "preflight_estimate") {
    return { error: "tag_budget_exceeded", ...hit,
      message: `CostCap preflight estimate: worst case $${hit.estimate_usd} does not fit ${hit.tag_key}=${hit.tag_value}'s remaining ${hit.scope} budget ($${hit.remaining_usd}). This is an estimate. The upstream call was not made.` };
  }
  return { error: "tag_budget_exceeded", ...hit,
    message: `CostCap: ${hit.tag_key}=${hit.tag_value} reached its ${hit.scope} cap of $${hit.cap_usd} ($${hit.spend_usd} spent). The upstream call was not made.` };
}
