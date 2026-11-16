// Read-only CI guard: rejects unknown cost rather than treating it as free.
import { loadSettledReceipts as loadReceipts, createCapEngine } from "./cap.js";
import { budgetRemaining, createAgentBudgets } from "./agent-budget.js";
export function checkBudget({ receiptsPath, caps = {}, now, runId }) {
  const history = loadReceipts(receiptsPath);
  if (!history.length) throw new Error("No receipts found; a budget check needs evidence");
  if (runId != null) return checkRunBudget({ history, caps, now, runId });
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

// Run-scoped check: the run cap counts only receipts with this run_id, while
// day/month caps (and their unknown-cost rule) still cover the whole ledger.
function checkRunBudget({ history, caps, now, runId }) {
  if (typeof runId !== "string" || !runId) throw new Error("--run-id needs a non-empty value");
  const runRecs = history.filter((r) => r.run_id === runId);
  if (!runRecs.length) throw new Error(`No receipts for run_id ${JSON.stringify(runId)}; a budget check needs evidence (list runs with: costcap runs)`);
  const sum = (rs) => rs.reduce((t, r) => t + (typeof r.cost_usd === "number" ? r.cost_usd : 0), 0);
  const runUnknown = runRecs.filter((r) => r.cost_usd === null).length;
  const runTotal = sum(runRecs);
  if (caps.run != null && (!Number.isFinite(caps.run) || caps.run <= 0)) throw new Error("Invalid run cap");
  const ledgerCaps = caps.day != null || caps.month != null;
  const cap = createCapEngine({ caps: { day: caps.day, month: caps.month }, history, now });
  const s = cap.spend();
  let hit = null;
  if (runUnknown > 0) hit = { scope: "run", cap: caps.run ?? null, spent: null, reason: "accounting_unavailable" };
  else if (caps.run != null && runTotal >= caps.run) hit = { scope: "run", cap: caps.run, spent: Number(runTotal.toFixed(6)) };
  if (!hit && ledgerCaps) hit = cap.check();
  const ledgerUnknown = history.filter((r) => r.cost_usd === null).length;
  return { ok: !hit, run_id: runId, scope: "run", receipt_count: runRecs.length, total_usd: Number(runTotal.toFixed(6)),
    unknown_cost_count: runUnknown, unknown_cost_counted_as_zero: false,
    run: { receipt_count: runRecs.length, total_usd: Number(runTotal.toFixed(6)), unknown_cost_count: runUnknown, cap: caps.run ?? null },
    day: { spent_usd: Number(s.day.toFixed(6)), cap: caps.day ?? null, scope: "whole ledger, current UTC day" },
    month: { spent_usd: Number(s.month.toFixed(6)), cap: caps.month ?? null, scope: "whole ledger, current UTC month" },
    ledger_unknown_cost_count: ledgerUnknown, spend: s, hit, estimate_only: true };
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
