// Hosted per-agent budget verdict (issue #112). Pure, no I/O. Reuses the local
// agent-budget engine so the hosted answer and `costcap agent-status` cannot
// drift. An unknown cost (cost_usd: null) is never treated as $0.
import { createAgentBudgets, budgetRemaining } from "../agent-budget.js";

const HOSTED_SCOPES = ["day", "month"];

// agent: { id, policy: { caps, killed }, revoked }
// receipts: stored receipt objects for that agent ({ id, ts, cost_usd, blocked? })
export function hostedAgentVerdict({ agent, receipts, nowMs }) {
  const nowDate = new Date(nowMs);
  const month = nowDate.toISOString().slice(0, 7);
  const who = { agent_id: agent.id, run_id: null };
  const limits = {};
  for (const scope of HOSTED_SCOPES) if (agent.policy?.caps?.[scope] != null) limits[scope] = agent.policy.caps[scope];
  const policy = Object.keys(limits).length ? { agents: { [agent.id]: limits } } : {};
  // Only receipts in the widest window (this UTC month) count, unknown ones included.
  const history = receipts
    .filter((r) => Number.isFinite(Date.parse(r?.ts)) && new Date(r.ts).toISOString().slice(0, 7) === month)
    .map((r) => ({ id: r.id, ts: r.ts, cost_usd: r.cost_usd ?? null, blocked: Boolean(r.blocked), agent_id: agent.id }));
  const budgets = createAgentBudgets({ policy, history, now: () => nowDate });
  const remaining = budgetRemaining(budgets, who);
  const budget_remaining = remaining && { day_usd: remaining.day_usd, month_usd: remaining.month_usd };
  let hit;
  if (agent.revoked) hit = { verdict: "revoked", reason: "agent_revoked", ...who };
  else if (agent.policy?.killed) hit = { verdict: "killed", reason: "policy_killed", ...who };
  else hit = budgets.check(who);
  return {
    ok: !hit, verdict: hit ? hit.verdict : "ok", reason: hit?.reason ?? null, hit: hit ?? null, ...who,
    budget_remaining, estimate_only: true,
    ...(hit ? Object.fromEntries(["scope", "cap_usd", "spent_usd", "unknown_receipts"].filter((k) => k in hit).map((k) => [k, hit[k]])) : {}),
  };
}
