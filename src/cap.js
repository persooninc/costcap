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

export function loadEvents(path) {
  return loadLines(path).filter((r) => r.event);
}

// caps: { run, day, month } in USD; any may be undefined.
export function createCapEngine({ caps = {}, history = [], now = () => new Date() } = {}) {
  for (const scope of ["run", "day", "month"]) {
    if (caps[scope] != null && (!Number.isFinite(caps[scope]) || caps[scope] <= 0)) throw new Error(`Invalid ${scope} cap`);
  }
  for (const r of history) {
    if (!Number.isFinite(Date.parse(r.ts)) || (r.cost_usd !== null && (!Number.isFinite(r.cost_usd) || r.cost_usd < 0))) throw new Error("Invalid receipt history; reconcile before running");
  }
  let run = 0;
  let unknown = history.filter((r) => r.cost_usd === null).length;
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
      if (receipt.cost_usd === null) { unknown += 1; return; }
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
