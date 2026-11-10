// Per-agent spend and step budgets. Follows the contract of the skills-library
// ai-cost-tracking skill (references/agent-budget.mjs). Pure module, no I/O.
// Separate from the wrapper's own caps: this answers "may this agent spend",
// using the shared ledger's rows for that agent.

export const UNKNOWN_AGENT = "unknown";
export const SCOPES = Object.freeze(["run", "day", "month"]);

const round6 = (n) => Number(n.toFixed(6));

function assertLimits(limits, label) {
  for (const scope of SCOPES) {
    const cap = limits?.[scope];
    if (cap != null && (!Number.isFinite(cap) || cap <= 0)) throw new Error(`Invalid ${label} ${scope} cap`);
  }
  const steps = limits?.maxSteps;
  if (steps != null && (!Number.isInteger(steps) || steps <= 0)) throw new Error(`Invalid ${label} maxSteps`);
}

function assertReceipt(r) {
  const badCost = r.cost_usd !== null && (!Number.isFinite(r.cost_usd) || r.cost_usd < 0);
  if (!Number.isFinite(Date.parse(r.ts)) || badCost) throw new Error("Invalid receipt history; reconcile before running");
}

const POLICY_KEYS = new Set(["default", "agents"]);
const LIMIT_KEYS = new Set([...SCOPES, "maxSteps"]);

// Unknown keys are refused: a misspelled limit must not silently mean "no limit".
export function assertAgentPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("Agent policy must be an object");
  for (const key of Object.keys(policy)) if (!POLICY_KEYS.has(key)) throw new Error(`Unknown agent policy key ${key}`);
  const check = (limits, label) => {
    for (const key of Object.keys(limits ?? {})) if (!LIMIT_KEYS.has(key)) throw new Error(`Unknown limit ${key} for ${label}`);
    assertLimits(limits, label);
  };
  if (policy.default) check(policy.default, "default");
  for (const [agent, limits] of Object.entries(policy.agents ?? {})) check(limits, agent);
  return policy;
}

// policy: { default?: Limits, agents?: { [agentId]: Limits } }
// Limits: { run?, day?, month? (USD), maxSteps? (upstream calls per run) }
// An agent with no entry and no default has no budget, which is a refusal.
export function createAgentBudgets({ policy = {}, history = [], now = () => new Date() } = {}) {
  assertAgentPolicy(policy);
  history.forEach(assertReceipt);

  const seen = new Set();
  const rows = [];
  const add = (receipt) => {
    // Idempotent by id: replaying a receipt never double-counts.
    if (receipt.id != null) {
      if (seen.has(receipt.id)) return;
      seen.add(receipt.id);
    }
    rows.push({ ...receipt, agent_id: receipt.agent_id ?? UNKNOWN_AGENT, run_id: receipt.run_id ?? null });
  };
  history.forEach(add);

  const limitsFor = (agentId) => policy.agents?.[agentId] ?? policy.default ?? null;

  function spend({ agent_id: agentId = UNKNOWN_AGENT, run_id: runId = null } = {}) {
    const today = now().toISOString();
    const out = { run: 0, day: 0, month: 0, steps: 0, unknown: 0 };
    for (const r of rows) {
      if (r.agent_id !== agentId) continue;
      if (r.cost_usd === null) out.unknown += 1;
      if (r.blocked) continue;
      const cost = r.cost_usd ?? 0;
      const ts = new Date(r.ts).toISOString();
      if (ts.slice(0, 10) === today.slice(0, 10)) out.day += cost;
      if (ts.slice(0, 7) === today.slice(0, 7)) out.month += cost;
      if (r.run_id === runId) { out.run += cost; out.steps += 1; }
    }
    return out;
  }

  return {
    spend,
    limitsFor,
    // null when the next call may proceed, otherwise a verdict with a cited reason.
    check({ agent_id: agentId = UNKNOWN_AGENT, run_id: runId = null } = {}) {
      const who = { agent_id: agentId, run_id: runId };
      const limits = limitsFor(agentId);
      if (!limits) return { verdict: "no_budget_policy", reason: "no_budget_policy", ...who };
      const s = spend(who);
      if (s.unknown > 0) return { verdict: "accounting_unavailable", reason: "unreconciled_receipt", unknown_receipts: s.unknown, ...who };
      for (const scope of SCOPES) {
        const cap = limits[scope];
        if (cap != null && s[scope] >= cap) {
          return { verdict: "budget_exceeded", reason: "budget_exceeded", scope, cap_usd: cap, spent_usd: round6(s[scope]), ...who };
        }
      }
      if (limits.maxSteps != null && s.steps >= limits.maxSteps) {
        return { verdict: "breaker_open", reason: "step_budget", steps: s.steps, max_steps: limits.maxSteps, ...who };
      }
      return null;
    },
    record(receipt) {
      assertReceipt(receipt);
      add(receipt);
    },
  };
}

// Remaining budget for a verdict or MCP response. Numbers are estimates.
export function budgetRemaining(budgets, who) {
  const limits = budgets.limitsFor(who.agent_id);
  if (!limits) return null;
  const s = budgets.spend(who);
  const left = (cap, used) => (cap == null ? null : round6(Math.max(cap - used, 0)));
  return { run_usd: left(limits.run, s.run), day_usd: left(limits.day, s.day), month_usd: left(limits.month, s.month), steps: left(limits.maxSteps, s.steps) };
}
