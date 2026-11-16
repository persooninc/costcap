// SRM evidence export (costcap.evidence/v1). A versioned, org-scoped document
// that ShipReady Metrics can ingest: per-agent caps, spend, unknown-cost counts,
// open alerts and receipts. Null cost stays null and is never summed as $0.
export const EVIDENCE_SCHEMA = "costcap.evidence/v1";

const known = (unknown) => unknown === 0;

export function buildEvidence({ orgId, agents = [], receipts = [], alerts = [], audit = [], nowMs, spendFor, teams = [] }) {
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
      team: teams.find((t) => t.agents.includes(a.id))?.name ?? null,
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
    settled_cost_usd: typeof item.settlement?.cost_usd === "number" ? item.settlement.cost_usd : null,
    settled_at: item.settlement?.at ?? null,
    settled_by: item.settlement?.by ?? null,
    settle_source: item.settlement?.source ?? null,
    settle_reason: item.settlement?.reason ?? null,
    blocked: Boolean(item.receipt?.blocked),
    reason: item.receipt?.reason ?? null,
    scope: item.receipt?.scope ?? null,
  }));
  // Audit trail (#118): org-scoped, oldest first. Fleet freeze/resume detail is
  // normalized to snake_case agent_ids; policy.change carries previous + policy.
  const trail = audit.filter((e) => e && e.org_id === orgId)
    .map((e, i) => ({ e, i })).sort((x, y) => String(x.e.ts).localeCompare(String(y.e.ts)) || x.i - y.i)
    .map(({ e }) => {
      const { agentIds, ...rest } = e.detail ?? {};
      const detail = agentIds !== undefined ? { ...rest, agent_ids: agentIds } : rest;
      return { ts: e.ts ?? null, actor: e.actor ?? null, action: e.action, target: e.target ?? null, detail };
    });
  const unknownTotal = rows.filter((r) => r.cost_usd === null && r.settled_cost_usd === null).length;
  return {
    schema: EVIDENCE_SCHEMA,
    generated_at: new Date(nowMs).toISOString(),
    org_id: orgId,
    agents: out,
    alerts: alerts.map((a) => ({ kind: a.kind ?? null, key: a.key ?? null, agent_id: a.agentId ?? null, scope: a.scope ?? null })),
    // Team budgets (#123): shared cap, synced spend and verdict per team.
    teams: teams.map((t) => ({ name: t.name, agents: [...t.agents], caps: { ...t.caps }, spend: { ...t.spend }, verdict: t.verdict, scope: t.scope ?? null })),
    receipts: rows,
    audit: trail,
    totals: { agents: out.length, receipts: rows.length, unknown_cost_receipts: unknownTotal, cost_complete: known(unknownTotal) },
  };
}
