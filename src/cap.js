// Cap engine: tracks spend per run/day/month and decides whether the next
// upstream call may happen. Hard stop: when a cap is reached the proxy never
// forwards the call. Spend is measured from receipts, so it only covers
// traffic that flows through the proxy.

import { readFileSync, existsSync } from "node:fs";

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

export function applySettlements(lines) {
  const settle = new Map();
  for (const e of lines) if (isSettlement(e) && !settle.has(e.receipt_id)) settle.set(e.receipt_id, e);
  return lines.filter((r) => !r.event).map((r) => {
    const e = r.cost_usd === null && typeof r.id === "string" ? settle.get(r.id) : undefined;
    return e ? { ...r, cost_usd: e.cost_usd, settled: { source: e.source ?? null, provider_sha256: e.provider_sha256 ?? null, ts: e.ts ?? null } } : r;
  });
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

// A submitted batch whose results have not been metered yet (#160): unknown cost, never $0.
export const isPendingBatch = (r) => !!r && r.cost_usd === null && r.reason === "batch_pending";

// caps: { run, day, month } in USD; any may be undefined.
// pendingBatchesBlock: false lets `costcap wrap` keep serving synchronous calls while a
// batch is pending (#160); read-only checks keep the default and report it as unknown.
export function createCapEngine({ caps = {}, history = [], now = () => new Date(), pendingBatchesBlock = true } = {}) {
  for (const scope of ["run", "day", "month"]) {
    if (caps[scope] != null && (!Number.isFinite(caps[scope]) || caps[scope] <= 0)) throw new Error(`Invalid ${scope} cap`);
  }
  for (const r of history) {
    if (!Number.isFinite(Date.parse(r.ts)) || (r.cost_usd !== null && (!Number.isFinite(r.cost_usd) || r.cost_usd < 0))) throw new Error("Invalid receipt history; reconcile before running");
  }
  let run = 0;
  const blocksUnknown = (r) => r.cost_usd === null && (pendingBatchesBlock || !isPendingBatch(r));
  let unknown = history.filter(blocksUnknown).length;
  // Null cost is unknown. It is omitted from sums so it is not treated as $0.
  // Spend is bucketed by UTC day and month key once, at record time, so check()
  // stays O(1) per call instead of rescanning the whole ledger (stress suite).
  const byDay = new Map();
  const byMonth = new Map();
  const add = (ts, cost) => {
    const key = new Date(ts).toISOString();
    byDay.set(key.slice(0, 10), (byDay.get(key.slice(0, 10)) ?? 0) + cost);
    byMonth.set(key.slice(0, 7), (byMonth.get(key.slice(0, 7)) ?? 0) + cost);
  };
  for (const r of history) if (r.cost_usd !== null) add(r.ts, r.cost_usd);

  function spend() {
    const n = now().toISOString();
    return { run, day: byDay.get(n.slice(0, 10)) ?? 0, month: byMonth.get(n.slice(0, 7)) ?? 0, unknown };
  }

  return {
    spend,
    limits: () => ({ ...caps }),
    updateCaps(next) {
      for (const scope of ["run", "day", "month"]) if (next[scope] != null && (!Number.isFinite(next[scope]) || next[scope] <= 0)) throw new Error("Invalid updated caps");
      caps = { ...next };
    },
    // Remaining USD per capped scope (uncapped scopes omitted). Used by preflight (CC-9).
    remaining() {
      const s = spend();
      const out = {};
      for (const scope of ["run", "day", "month"]) if (caps[scope] != null) out[scope] = Number(Math.max(0, caps[scope] - s[scope]).toFixed(6));
      return out;
    },
    // Returns null if the call may proceed, else a budget-exceeded descriptor.
    check() {
      if (unknown > 0) return { scope: "accounting", cap: 0, spent: 0, reason: "unreconciled_receipt" };
      const s = spend();
      for (const scope of ["run", "day", "month"]) {
        const cap = caps[scope];
        if (cap != null && s[scope] >= cap) {
          return { scope, cap, spent: Number(s[scope].toFixed(6)) };
        }
      }
      return null;
    },
    // external: a receipt another wrapper sharing this ledger wrote. It counts
    // toward day/month (and unknown) but not toward this wrapper's run cap.
    record(receipt, { external = false } = {}) {
      if (receipt.cost_usd === null) { if (blocksUnknown(receipt)) unknown += 1; return; }
      if (!external) run += receipt.cost_usd;
      add(receipt.ts ?? now(), receipt.cost_usd);
    },
  };
}

export function budgetExceededBody(hit) {
  return {
    error: {
      type: "budget_exceeded",
      message: `CostCap: ${hit.scope} cap of $${hit.cap} reached ($${hit.spent} spent). The upstream call was not made.`,
      scope: hit.scope,
      cap_usd: hit.cap,
      spent_usd: hit.spent,
    },
  };
}
