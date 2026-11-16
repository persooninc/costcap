// Hosted per-agent budget verdict (issue #112). Pure, no I/O. Reuses the local
// agent-budget engine so the hosted answer and `costcap agent-status` cannot
// drift. An unknown cost (cost_usd: null) is never treated as $0.
import { createAgentBudgets, budgetRemaining } from "../agent-budget.js";
import { effectiveCaps } from "./policy.js";
import { periodKey } from "../period.js";

const HOSTED_SCOPES = ["day", "month"];

// agent: { id, policy: { caps, killed }, revoked }
// receipts: stored receipt objects for that agent ({ id, ts, cost_usd, blocked? })
// runId (optional): count steps for that run against policy.maxSteps (issue #114).
// team (optional, issue #123): the teamVerdict() of the agent's team. The agent's own
// cap applies first, then the team's shared spend.
export function hostedAgentVerdict({ agent, receipts, nowMs, runId = null, team = null, budgetPeriod = null }) {
  const nowDate = new Date(nowMs);
  const month = periodKey("month", nowMs, budgetPeriod);
  const who = { agent_id: agent.id, run_id: runId };
  const limits = {};
  // #208: an active cap raise applies until its expires_at, then the base cap again.
  const caps = effectiveCaps(agent.policy, nowMs);
  for (const scope of HOSTED_SCOPES) if (caps[scope] != null) limits[scope] = caps[scope];
  const maxSteps = agent.policy?.maxSteps ?? null;
  if (maxSteps != null && runId) limits.maxSteps = maxSteps;
  const policy = Object.keys(limits).length ? { agents: { [agent.id]: limits } } : {};
  // Only receipts in the widest window (this budget-period month, #209) count, unknown ones included.
  const history = receipts
    .filter((r) => Number.isFinite(Date.parse(r?.ts)) && periodKey("month", Date.parse(r.ts), budgetPeriod) === month)
    .map((r) => ({ id: r.id, ts: r.ts, cost_usd: r.cost_usd ?? null, blocked: Boolean(r.blocked), agent_id: agent.id, run_id: r.run_id ?? null, ...(r.reason ? { reason: r.reason } : {}) }));
  const budgets = createAgentBudgets({ policy, history, now: () => nowDate, budgetPeriod });
  const remaining = budgetRemaining(budgets, who);
  const budget_remaining = remaining && { day_usd: remaining.day_usd, month_usd: remaining.month_usd };
  let hit;
  if (agent.revoked) hit = { verdict: "revoked", reason: "agent_revoked", ...who };
  else if (agent.policy?.killed) hit = { verdict: "killed", reason: "policy_killed", ...who };
  else hit = budgets.check(who);
  // A team cap is a budget policy on its own (same as the local engine).
  if (team && hit?.verdict === "no_budget_policy") hit = null;
  if (!hit && team && team.verdict !== "ok") {
    hit = { verdict: team.verdict, reason: team.verdict === "accounting_unavailable" ? "unreconciled_receipt" : "budget_exceeded", team: team.name, ...who,
      ...Object.fromEntries(["scope", "cap_usd", "spent_usd", "unknown_receipts"].filter((k) => k in team).map((k) => [k, team[k]])) };
  }
  return {
    ok: !hit, verdict: hit ? hit.verdict : "ok", reason: hit?.reason ?? null, hit: hit ?? null, ...who,
    budget_remaining, estimate_only: true,
    ...(team ? { team } : {}),
    ...(maxSteps != null || runId ? { max_steps: maxSteps } : {}),
    ...(runId ? { steps: history.filter((r) => r.run_id === runId && !r.blocked).length } : {}),
    ...(hit ? Object.fromEntries(["scope", "cap_usd", "spent_usd", "unknown_receipts"].filter((k) => k in hit).map((k) => [k, hit[k]])) : {}),
  };
}
