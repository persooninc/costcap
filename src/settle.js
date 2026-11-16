// #176: one settle path for the running wrapper, used by both the hosted fleet
// poll (onSettle) and the shared ledger (onExternalSettle). A batch_pending
// receipt was never counted as unknown, so its settled cost is recorded on the
// cap engine (receipt's original ts) instead of decrementing the unknown count,
// which belongs to some other receipt. Each receipt id settles at most once.
export function createSettler({ cap, agentBudgets, proxySettle } = {}) {
  const done = new Set();
  return (settlement, receipt = settlement) => {
    const id = settlement?.receipt_id ?? settlement?.id ?? receipt?.id;
    const cost = settlement?.settled_cost_usd ?? settlement?.cost_usd;
    if (typeof id !== "string" || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || done.has(id)) return false;
    done.add(id);
    const r = cap();
    // Fleet passes the receipt with its settled cost already merged, so test reason only.
    if (receipt?.reason === "batch_pending") r?.record({ ts: receipt.ts, cost_usd: cost }, { external: true });
    else r?.settle({ ...receipt, cost_usd: cost });
    agentBudgets()?.settle?.({ receipt_id: id, cost_usd: cost });
    proxySettle()?.({ receipt_id: id, batch_id: receipt?.batch_id ?? null });
    return true;
  };
}
