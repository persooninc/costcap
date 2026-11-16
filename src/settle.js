// #176: one settle path for the running wrapper, used by both the hosted fleet
// poll (onSettle) and the shared ledger (onExternalSettle). A batch_pending
// receipt was never counted as unknown, so its settled cost is recorded on the
// cap engine (receipt's original ts) instead of decrementing the unknown count,
// which belongs to some other receipt. Each receipt id settles at most once.
// onSettled (#178) sees each applied settlement, e.g. for the run summary.
export function createSettler({ cap, agentBudgets, proxySettle, tagCaps = () => null, onSettled = () => {} } = {}) {
  const done = new Set();
  return (settlement, receipt = settlement) => {
    const id = settlement?.receipt_id ?? settlement?.id ?? receipt?.id;
    const cost = settlement?.settled_cost_usd ?? settlement?.cost_usd;
    if (typeof id !== "string" || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || done.has(id)) return false;
    done.add(id);
    const r = cap();
    // Fleet passes the receipt with its settled cost already merged, so test reason only.
    // #178: a settled batch of this wrapper's own run also counts toward run.
    if (receipt?.reason === "batch_pending") r?.resolvePending?.(id);
    if (receipt?.reason === "batch_pending") r?.record({ ts: receipt.ts, cost_usd: cost }, { external: !(r.runId != null && receipt.run_id === r.runId) });
    else r?.settle({ ...receipt, cost_usd: cost });
    tagCaps()?.settle(id, cost); // #191
    agentBudgets()?.settle?.({ receipt_id: id, cost_usd: cost });
    proxySettle()?.({ receipt_id: id, batch_id: receipt?.batch_id ?? null });
    onSettled({ event: "reconciliation", receipt_id: id, cost_usd: cost, run_id: receipt?.run_id ?? null });
    return true;
  };
}
