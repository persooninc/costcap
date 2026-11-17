// Cap engine: tracks spend per run/day/month and decides whether the next
// upstream call may happen. Hard stop: when a cap is reached the proxy never
// forwards the call. Spend is measured from receipts, so it only covers
// traffic that flows through the proxy.

import { readFileSync, existsSync } from "node:fs";
import { utcWeekLabel, normalizeBudgetPeriod, periodKey as orgPeriodKey, periodBounds, localParts } from "./period.js";

function loadLines(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Event lines such as kill and resume share the ledger but are never spend.
export function loadReceipts(path) {
  return loadLines(path).filter((r) => !r.event);
}

// Settlement view (costcap#124): an append-only {"event":"reconciliation"} line
// gives a null-cost receipt its provider cost. The original line is never
// edited; the settled cost keeps the original receipt's ts, so it counts toward
// that run/day/month. Only the first valid settlement per receipt_id counts, and
// a settlement never overrides a receipt that already has a cost.
export function isSettlement(e) {
  return !!e && e.event === "reconciliation" && typeof e.receipt_id === "string" && !!e.receipt_id &&
    typeof e.cost_usd === "number" && Number.isFinite(e.cost_usd) && e.cost_usd >= 0;
}

// #196: a pending OpenAI Responses background job is treated exactly like a pending batch.
export const PENDING_REASONS = Object.freeze(["batch_pending", "background_pending"]);
export function isPendingBatch(r) {
  return !!r && PENDING_REASONS.includes(r.reason) && r.cost_usd === null;
}
export const isPending = isPendingBatch;

// #226: a settlement's optional per-model split ({ model: usd }). Kept only when every
// value is a finite non-negative number and the split sums to the settled cost.
export function settledByModel(e) {
  const b = e?.by_model;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const entries = Object.entries(b);
  if (!entries.length) return null;
  let sum = 0;
  for (const [m, v] of entries) {
    if (!m || typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    sum += v;
  }
  if (Math.abs(sum - e.cost_usd) > 1e-6 * Math.max(1, entries.length)) return null;
  return Object.fromEntries(entries);
}

export function applySettlements(lines) {
  const settle = new Map();
  const unpriced = new Set();
  for (const e of lines) if (isSettlement(e) && !settle.has(e.receipt_id)) settle.set(e.receipt_id, e);
  // #196: a background response that finished unpriced turns its pending receipt into an unknown.
  for (const e of lines) if (e?.event === "background_unpriced" && typeof e.receipt_id === "string" && !settle.has(e.receipt_id)) unpriced.add(e.receipt_id);
  return lines.filter((r) => !r.event).map((r) => {
    const e = r.cost_usd === null && typeof r.id === "string" ? settle.get(r.id) : undefined;
    if (!e && r.cost_usd === null && r.reason === "background_pending" && unpriced.has(r.id)) return { ...r, reason: "background_unpriced" };
    return e ? { ...r, cost_usd: e.cost_usd, settled: settledInfo(e) } : r;
  });
}

function settledInfo(e) {
  const s = { source: e.source ?? null, provider_sha256: e.provider_sha256 ?? null, ts: e.ts ?? null };
  const b = settledByModel(e);
  if (b) s.by_model = b;
  return s;
}

// Receipts with provider settlements applied: what spend and verdicts read.
export function loadSettledReceipts(path) {
  return applySettlements(loadLines(path));
}

export function loadLedgerLines(path) {
  return loadLines(path);
}

export function loadEvents(path) {
  return loadLines(path).filter((r) => r.event);
}

export const CAP_SCOPES = Object.freeze(["run", "hour", "day", "week", "month"]);
export const HOUR_MS = 60 * 60 * 1000;

// caps: { run, hour, day, week, month } in USD; week (#264) is the ISO week, UTC Monday start; any may be undefined.
// hour (#172) is a rolling window: spend with now - 60min < ts <= now. It never latches.
// runId (#178): this wrapper's run id; a settlement of a receipt with that run_id
// also counts toward the run cap.
// fleetWeek (#274): { cap, budgetPeriod } — an enrolled fleet caps.week, bucketed on the
// org budget-period timezone (Monday 00:00 there), enforced next to a local UTC week cap.
// fleetPeriod (#280): { caps: { day, week, month }, budgetPeriod } — the same for the fleet
// caps.day and caps.month (org timezone day, org monthStartDay month). Each fleet cap runs
// on the org clock next to the local UTC cap of the same scope; the stricter verdict wins.
export const FLEET_PERIOD_SCOPES = Object.freeze(["day", "week", "month"]);
const pad2 = (n) => String(n).padStart(2, "0");
export function createCapEngine({ caps = {}, history = [], now = () => new Date(), runId = null, fleetWeek = null, fleetPeriod = null } = {}) {
  for (const scope of CAP_SCOPES) {
    if (caps[scope] != null && (!Number.isFinite(caps[scope]) || caps[scope] <= 0)) throw new Error(`Invalid ${scope} cap`);
  }
  for (const r of history) {
    if (!Number.isFinite(Date.parse(r.ts)) || (r.cost_usd !== null && (!Number.isFinite(r.cost_usd) || r.cost_usd < 0))) throw new Error("Invalid receipt history; reconcile before running");
  }
  let run = 0;
  const settledIds = new Set();
  // A pending batch (#160) is unknown until its results settle it, but it does not
  // stop synchronous calls: its cost arrives through a batch_results settlement.
  let unknown = history.filter((r) => r.cost_usd === null && !isPendingBatch(r)).length;
  // #187: pending batches do not stop calls, but while any is open spend is a lower bound.
  const pendingBatches = new Set();
  let anonPending = 0;
  const notePending = (r) => { if (typeof r.id === "string" && r.id) pendingBatches.add(r.id); else anonPending += 1; };
  for (const r of history) if (isPendingBatch(r)) notePending(r);
  // Null cost is unknown. It is omitted from sums so it is not treated as $0.
  // Spend is bucketed by UTC day and month key once, at record time, so check()
  // stays O(1) per call instead of rescanning the whole ledger (stress suite).
  const byDay = new Map();
  const byWeek = new Map();
  const byMonth = new Map();
  // #274/#280: fleet day/week/month buckets on the org budget period; all priced entries
  // are kept so a budget_period change rebuckets them.
  let fleetCaps = {}, fleetBp = normalizeBudgetPeriod(null);
  const priced = [];
  let byFleet = { day: new Map(), week: new Map(), month: new Map() };
  // Only scopes with a fleet cap are bucketed (stress: 100k-receipt ledgers with no fleet cap).
  let fleetScopes = [];
  const addFleet = (ms, cost) => { for (const sc of fleetScopes) { const k = orgPeriodKey(sc, ms, fleetBp); byFleet[sc].set(k, (byFleet[sc].get(k) ?? 0) + cost); } };
  const rebucketFleet = () => { byFleet = { day: new Map(), week: new Map(), month: new Map() }; for (const [ms, c] of priced) addFleet(ms, c); };
  // Rolling hour window: time-ordered [ms, cost] entries, evicted from the front,
  // so check() stays amortised O(1). Entries stamped after now (clock skew) count
  // right away, which only errs toward stopping; out-of-order inserts (settlements)
  // use binary search.
  const win = [];
  let head = 0;
  let hourSum = 0;
  const addWindow = (ms, cost) => {
    if (cost <= 0) return;
    hourSum += cost;
    let lo = head, hi = win.length;
    if (hi > lo && win[hi - 1][0] > ms) {
      while (lo < hi) { const mid = (lo + hi) >> 1; if (win[mid][0] <= ms) lo = mid + 1; else hi = mid; }
      win.splice(lo, 0, [ms, cost]);
    } else win.push([ms, cost]);
  };
  const add = (ts, cost) => {
    const d = new Date(ts);
    const key = d.toISOString();
    byDay.set(key.slice(0, 10), (byDay.get(key.slice(0, 10)) ?? 0) + cost);
    const wk = utcWeekLabel(d.getTime());
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + cost);
    byMonth.set(key.slice(0, 7), (byMonth.get(key.slice(0, 7)) ?? 0) + cost);
    priced.push([d.getTime(), cost]);
    addFleet(d.getTime(), cost);
    addWindow(d.getTime(), cost);
  };
  const setFleetPeriod = (fp) => {
    const next = {};
    for (const sc of FLEET_PERIOD_SCOPES) {
      const c = fp?.caps?.[sc] ?? null;
      if (c != null && (!Number.isFinite(c) || c <= 0)) throw new Error(`Invalid fleet ${sc} cap`);
      if (c != null) next[sc] = c;
    }
    const bp = normalizeBudgetPeriod(fp?.budgetPeriod ?? null);
    fleetCaps = next;
    const scopes = FLEET_PERIOD_SCOPES.filter((sc) => next[sc] != null);
    const grew = scopes.some((sc) => !fleetScopes.includes(sc));
    fleetScopes = scopes;
    if (bp.timezone !== fleetBp.timezone || bp.monthStartDay !== fleetBp.monthStartDay || grew) { fleetBp = bp; rebucketFleet(); }
  };
  // #274 API: only the week cap changes; fleet day/month caps are kept.
  const setFleetWeek = (fw) => setFleetPeriod({ caps: { ...fleetCaps, week: fw?.cap ?? null }, budgetPeriod: fw?.budgetPeriod ?? null });
  setFleetPeriod({ caps: { ...(fleetPeriod?.caps ?? {}), ...(fleetWeek ? { week: fleetWeek.cap ?? null } : {}) }, budgetPeriod: fleetPeriod?.budgetPeriod ?? fleetWeek?.budgetPeriod ?? null });
  for (const r of history) if (r.cost_usd !== null) add(r.ts, r.cost_usd);
  // Entries with ts <= now - 60min are evicted; entries with ts > now are not counted yet.
  function hourSpend(nowMs) {
    while (head < win.length && win[head][0] <= nowMs - HOUR_MS) { hourSum -= win[head][1]; head += 1; }
    if (head > 1024 && head * 2 > win.length) { win.splice(0, head); head = 0; }
    if (head === win.length || hourSum < 0) hourSum = Math.max(0, head === win.length ? 0 : hourSum);
    return hourSum;
  }

  // #274/#280: day/week/month report whichever clock binds: the local UTC cap, the
  // fleet cap on the org clock, or (both set) the one closer to its cap.
  const utcKey = (sc, ms) => (sc === "week" ? utcWeekLabel(ms) : new Date(ms).toISOString().slice(0, sc === "day" ? 10 : 7));
  const localBucket = { day: byDay, week: byWeek, month: byMonth };
  const localView = (sc, ms) => ({ cap: caps[sc] ?? null, spent: localBucket[sc].get(utcKey(sc, ms)) ?? 0 });
  const fleetView = (sc, ms) => (fleetCaps[sc] != null ? { cap: fleetCaps[sc], spent: byFleet[sc].get(orgPeriodKey(sc, ms, fleetBp)) ?? 0, org: true } : null);
  function view(sc, ms) {
    const local = localView(sc, ms);
    const fleet = fleetView(sc, ms);
    if (!fleet) return local;
    if (local.cap == null) return fleet;
    return fleet.spent / fleet.cap > local.spent / local.cap ? fleet : local;
  }
  function spend() {
    const d = now();
    const ms = d.getTime();
    return { run, hour: Number(hourSpend(ms).toFixed(9)), day: view("day", ms).spent, week: view("week", ms).spent, month: view("month", ms).spent, unknown, pending_batches: pendingBatches.size + anonPending };
  }
  // #280: the org window of a scope when its fleet cap is the binding one, else null (UTC).
  // period is the dedupe key; label reads e.g. "2026-11-15..2026-12-14 org".
  function fleetWindow(sc, ms = now().getTime()) {
    if (!FLEET_PERIOD_SCOPES.includes(sc) || !view(sc, ms).org) return null;
    const ymd = (t) => { const p = localParts(t, fleetBp.timezone); return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`; };
    const b = periodBounds(sc, ms, fleetBp);
    const range = sc === "day" ? ymd(b.start) : `${ymd(b.start)}..${ymd(b.end - 1)}`;
    return { period: orgPeriodKey(sc, ms, fleetBp), label: `${range} org${fleetBp.timezone !== "UTC" ? ` ${fleetBp.timezone}` : ""}`, timezone: fleetBp.timezone, monthStartDay: fleetBp.monthStartDay };
  }

  // Seconds until hour spend falls below cap (spend ages out from the oldest entry).
  function retryAfter(cap, nowMs) {
    return retryAfterSeconds(win.slice(head), hourSpend(nowMs), cap, nowMs);
  }

  function limits() { const out = { ...caps }; const ms = now().getTime(); for (const sc of FLEET_PERIOD_SCOPES) { const c = view(sc, ms).cap; if (c != null) out[sc] = c; } return out; }

  return {
    runId,
    spend,
    limits,
    setFleetWeek,
    setFleetPeriod,
    fleetWindow,
    updateCaps(next) {
      for (const scope of CAP_SCOPES) if (next[scope] != null && (!Number.isFinite(next[scope]) || next[scope] <= 0)) throw new Error("Invalid updated caps");
      caps = { ...next };
    },
    // Remaining USD per capped scope (uncapped scopes omitted). Used by preflight (CC-9).
    remaining() {
      const s = spend();
      const lim = limits();
      const out = {};
      for (const scope of CAP_SCOPES) if (lim[scope] != null) out[scope] = Number(Math.max(0, lim[scope] - s[scope]).toFixed(6));
      return out;
    },
    // Returns null if the call may proceed, else a budget-exceeded descriptor.
    check() {
      if (unknown > 0) return { scope: "accounting", cap: 0, spent: 0, reason: "unreconciled_receipt" };
      const s = spend();
      const ms = now().getTime();
      for (const scope of CAP_SCOPES) {
        let cap = caps[scope];
        if (FLEET_PERIOD_SCOPES.includes(scope)) {
          // Each cap on its own clock (local UTC, fleet org period); either one hitting stops the call.
          const hitW = [cap != null ? localView(scope, ms) : null, fleetView(scope, ms)].find((w) => w && w.spent >= w.cap);
          if (hitW) return { scope, cap: hitW.cap, spent: Number(hitW.spent.toFixed(6)) };
          continue;
        }
        if (cap != null && s[scope] >= cap) {
          if (scope === "hour") return { scope, cap, spent: Number(s.hour.toFixed(6)), retry_after_s: retryAfter(cap, now().getTime()) };
          return { scope, cap, spent: Number(s[scope].toFixed(6)) };
        }
      }
      return null;
    },
    // Issue #162: a hosted settlement of an unknown-cost receipt this engine already
    // counted as unknown. The cost lands in the receipt's original day/month, and
    // in run when the receipt belongs to this wrapper's run (#178). Each receipt id
    // settles once.
    settle(receipt) {
      if (unknown <= 0 || typeof receipt?.cost_usd !== "number" || !Number.isFinite(receipt.cost_usd) || receipt.cost_usd < 0) return false;
      const id = receipt.receipt_id ?? receipt.id;
      if (typeof id === "string" && id) { if (settledIds.has(id)) return false; settledIds.add(id); }
      unknown -= 1;
      if (runId != null && receipt.run_id === runId) run += receipt.cost_usd;
      add(receipt.ts ?? now(), receipt.cost_usd);
      return true;
    },
    // #187: a pending batch's results were priced (or settled); spend is exact again for it.
    resolvePending(id) { return pendingBatches.delete(id); },
    // external: a receipt another wrapper sharing this ledger wrote. It counts
    // toward day/month (and unknown) but not toward this wrapper's run cap.
    record(receipt, { external = false } = {}) {
      if (isPendingBatch(receipt)) { notePending(receipt); return; }
      if (receipt.cost_usd === null) { unknown += 1; return; }
      if (!external) run += receipt.cost_usd;
      add(receipt.ts ?? now(), receipt.cost_usd);
    },
  };
}

// Seconds until rolling-hour spend falls below cap. entries: in-window [tsMs, cost]
// pairs, oldest first; spent: their total. Shared by the wrapper cap and agent policies (#177).
export function retryAfterSeconds(entries, spent, cap, nowMs) {
  let left = spent;
  for (const [tsMs, cost] of entries) {
    left -= cost;
    if (left < cap - 1e-9) return Math.max(1, Math.ceil((tsMs + HOUR_MS - nowMs) / 1000));
  }
  return Math.ceil(HOUR_MS / 1000);
}

export function budgetExceededBody(hit) {
  return {
    error: {
      type: "budget_exceeded",
      message: `CostCap: ${hit.scope} cap of $${hit.cap} reached ($${hit.spent} spent). The upstream call was not made.`,
      scope: hit.scope,
      cap_usd: hit.cap,
      spent_usd: hit.spent,
      ...(hit.retry_after_s != null ? { retry_after_s: hit.retry_after_s } : {}),
    },
  };
}

// #187: spend is a lower bound while any receipt has unknown cost, a pending batch included.
export function isLowerBound(spend) {
  return (spend?.unknown ?? 0) > 0 || (spend?.pending_batches ?? 0) > 0;
}
