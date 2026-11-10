// Read-only CI guard: rejects unknown cost rather than treating it as free.
import { loadReceipts, createCapEngine } from "./cap.js";
import { budgetRemaining, createAgentBudgets } from "./agent-budget.js";
export function checkBudget({ receiptsPath, caps = {}, now }) {
  const history = loadReceipts(receiptsPath);
  if (!history.length) throw new Error("No receipts found; a budget check needs evidence");
  const cap = createCapEngine({ caps: { day: caps.day, month: caps.month }, history, now });
  const s = cap.spend();
  const unknown_cost_count = history.filter((r) => r.cost_usd === null).length;
  const total = history.reduce((sum, r) => sum + (typeof r.cost_usd === "number" ? r.cost_usd : 0), 0);
  let hit = cap.check();
  if (!hit && caps.run != null) {
    if (!Number.isFinite(caps.run) || caps.run <= 0) throw new Error("Invalid run cap");
    if (total >= caps.run) hit = { scope: "run", cap: caps.run, spent: total };
  }
  return { ok: !hit, receipt_count: history.length, total_usd: Number(total.toFixed(6)), unknown_cost_count,
    unknown_cost_counted_as_zero: false, spend: s, hit,
    estimate_only: true, scope: "all receipts in selected ledger; run total is not a reconstructed process run" };
}

// The budget verdict one agent or a reviewer can read. A missing ledger is no
// spend yet, not a pass: the agent still needs a policy entry to be allowed.
export function agentBudgetStatus({ receiptsPath, policy, agent_id: agentId, run_id: runId = null, now }) {
  if (!policy) throw new Error("No agent policy configured");
  if (typeof agentId !== "string" || !agentId) throw new Error("agent_id is required");
  const budgets = createAgentBudgets({ policy, history: loadReceipts(receiptsPath), now });
  const who = { agent_id: agentId, run_id: runId };
  const hit = budgets.check(who);
  return { ok: !hit, verdict: hit ? hit.verdict : "allow", reason: hit?.reason ?? null, hit, ...who, budget_remaining: budgetRemaining(budgets, who), estimate_only: true };
}
