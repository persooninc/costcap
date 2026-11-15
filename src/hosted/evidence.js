// SRM evidence export (costcap.evidence/v1). A versioned, org-scoped document
// that ShipReady Metrics can ingest: per-agent caps, spend, unknown-cost counts,
// open alerts and receipts. Null cost stays null and is never summed as $0.
export const EVIDENCE_SCHEMA = "costcap.evidence/v1";

const known = (unknown) => unknown === 0;

export function buildEvidence({ orgId, agents = [], receipts = [], alerts = [], nowMs, spendFor }) {
  if (typeof orgId !== "string" || !orgId) throw new Error("orgId required");
  if (!Number.isFinite(nowMs)) throw new Error("nowMs required");
  if (typeof spendFor !== "function") throw new Error("spendFor required");
  const out = agents.map((a) => {
    const spend = spendFor(receipts.filter((r) => r.agentId === a.id));
    return {
      agent_id: a.id,
      name: a.name ?? null,
      revoked: Boolean(a.revoked),
      killed: Boolean(a.policy?.killed),
      caps: { ...(a.policy?.caps ?? {}) },
      spend: Object.fromEntries(["day", "month"].map((w) => [w, {
        usd_known: Number(spend[w].usd.toFixed(6)),
        unknown_count: spend[w].unknown,
        cost_complete: known(spend[w].unknown),
      }])),
    };
  });
  const rows = receipts.map((item) => ({
    agent_id: item.agentId,
    receipt_id: item.receipt?.id ?? null,
    ts: item.receipt?.ts ?? null,
    model: item.receipt?.model ?? null,
    cost_usd: typeof item.receipt?.cost_usd === "number" ? item.receipt.cost_usd : null,
  }));
  const unknownTotal = rows.filter((r) => r.cost_usd === null).length;
  return {
    schema: EVIDENCE_SCHEMA,
    generated_at: new Date(nowMs).toISOString(),
    org_id: orgId,
    agents: out,
    alerts: alerts.map((a) => ({ kind: a.kind ?? null, key: a.key ?? null, agent_id: a.agentId ?? null, scope: a.scope ?? null })),
    receipts: rows,
    totals: { agents: out.length, receipts: rows.length, unknown_cost_receipts: unknownTotal, cost_complete: known(unknownTotal) },
  };
}
