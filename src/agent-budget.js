import { periodKey } from "./period.js";
import { isPendingBatch, retryAfterSeconds } from "./cap.js";
// Per-agent spend and step budgets. Follows the contract of the skills-library
// ai-cost-tracking skill (references/agent-budget.mjs). Pure module, no I/O.
// Separate from the wrapper's own caps: this answers "may this agent spend",
// using the shared ledger's rows for that agent.

export const UNKNOWN_AGENT = "unknown";
export const SCOPES = Object.freeze(["run", "hour", "day", "week", "month", "total"]);
// #265: a total cap never resets; its refusal says so and carries no retry hint.
export const TOTAL_NEVER_RESETS = "This total budget never resets; raise the cap to continue.";
const HOUR_MS = 60 * 60 * 1000;

const round6 = (n) => Number(n.toFixed(6));

// #265: a total (lifetime) cap refusal says it never resets; it has no retry hint.
export function totalCapMessage(scope, cap) {
  return scope === "total" || String(scope ?? "").endsWith(":total")
    ? { message: `CostCap: total budget of $${cap} is used up. A total budget does not reset; raise the cap to continue. The upstream call was not made.` }
    : {};
}

function assertLimits(limits, label) {
  for (const scope of SCOPES) {
    const cap = limits?.[scope];
    if (cap != null && (!Number.isFinite(cap) || cap <= 0)) throw new Error(`Invalid ${label} ${scope} cap`);
  }
  const steps = limits?.maxSteps;
  if (steps != null && (!Number.isInteger(steps) || steps <= 0)) throw new Error(`Invalid ${label} maxSteps`);
  // #192: requests/tokens per minute, positive integers.
  for (const k of ["rpm", "tpm"]) if (limits?.[k] != null && !(Number.isInteger(limits[k]) && limits[k] > 0)) throw new Error(`Invalid ${label} ${k}`);
  // #249: parallel upstream calls per wrapper, 1..64.
  if (limits?.maxConcurrent != null && !isMaxConcurrent(limits.maxConcurrent)) throw new Error(`Invalid ${label} maxConcurrent`);
  if (limits?.models !== undefined && !isModelList(limits.models)) throw new Error(`Invalid ${label} models`);
}

// #249: --max-concurrent / maxConcurrent is an integer from 1 to 64.
export const MAX_CONCURRENT_LIMIT = 64;
export function isMaxConcurrent(n) { return Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENT_LIMIT; }

// Model allowlist (#153): a non-empty array of non-empty model id strings (exact ids, no wildcards).
export function isModelList(models) {
  return Array.isArray(models) && models.length > 0 && models.every((m) => typeof m === "string" && m.trim() !== "" && m === m.trim());
}

// Intersection of allowlists; null/undefined entries mean "no restriction". Returns null when nothing restricts.
export function intersectModels(...lists) {
  let out = null;
  for (const list of lists) {
    if (list == null) continue;
    out = out == null ? [...new Set(list)] : out.filter((m) => list.includes(m));
  }
  return out;
}

function assertReceipt(r) {
  const badCost = r.cost_usd !== null && (!Number.isFinite(r.cost_usd) || r.cost_usd < 0);
  if (!Number.isFinite(Date.parse(r.ts)) || badCost) throw new Error("Invalid receipt history; reconcile before running");
}

const POLICY_KEYS = new Set(["default", "agents", "teams"]);
const TEAM_KEYS = new Set([...SCOPES, "agents", "models"]);
const LIMIT_KEYS = new Set([...SCOPES, "maxSteps", "models", "rpm", "tpm", "maxConcurrent"]);

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
  const members = new Set();
  for (const [team, def] of Object.entries(policy.teams ?? {})) {
    const label = `team ${team}`;
    if (!def || typeof def !== "object" || Array.isArray(def)) throw new Error(`Invalid ${label}`);
    for (const key of Object.keys(def)) if (!TEAM_KEYS.has(key)) throw new Error(`Unknown limit ${key} for ${label}`);
    assertLimits(def, label);
    if (!Array.isArray(def.agents) || !def.agents.length || def.agents.some((a) => typeof a !== "string" || !a)) throw new Error(`Invalid ${label} agents`);
    for (const agent of def.agents) {
      if (members.has(agent)) throw new Error(`Agent ${agent} is in more than one team`);
      members.add(agent);
    }
  }
  return policy;
}

// policy: { default?: Limits, agents?: { [agentId]: Limits } }
// Limits: { run?, hour? (rolling 60 min, #172), day?, month? (USD), maxSteps? (upstream calls per run), models? (allowlist, #153) }
// An agent with no entry and no default has no budget, which is a refusal.
export function createAgentBudgets({ policy = {}, history = [], now = () => new Date(), budgetPeriod = null } = {}) {
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
  const teamFor = (agentId) => {
    for (const [team, def] of Object.entries(policy.teams ?? {})) if (def.agents.includes(agentId)) return { team, ...def };
    return null;
  };

  function spend({ agent_id: agentId = UNKNOWN_AGENT, run_id: runId = null } = {}, agentIds = [agentId]) {
    const nowDate = now();
    const nowMs = nowDate.getTime();
    // #209: day/month windows follow the org budget period (UTC/day 1 by default).
    const today = { day: periodKey("day", nowMs, budgetPeriod), week: periodKey("week", nowMs, budgetPeriod), month: periodKey("month", nowMs, budgetPeriod) };
    const out = { run: 0, hour: 0, day: 0, week: 0, month: 0, total: 0, steps: 0, unknown: 0 };
    for (const r of rows) {
      if (!agentIds.includes(r.agent_id)) continue;
      if (r.cost_usd === null && !isPendingBatch(r)) out.unknown += 1;
      if (r.blocked) continue;
      const cost = r.cost_usd ?? 0;
      const tsMs = Date.parse(r.ts);
      out.total += cost; // #265: every receipt since the beginning
      if (tsMs > nowMs - HOUR_MS) out.hour += cost;
      if (periodKey("day", tsMs, budgetPeriod) === today.day) out.day += cost;
      if (periodKey("week", tsMs, budgetPeriod) === today.week) out.week += cost;
      if (periodKey("month", tsMs, budgetPeriod) === today.month) out.month += cost;
      out.total += cost;
      if (r.run_id === runId) { out.run += cost; out.steps += 1; }
    }
    return out;
  }

  // #177: seconds until the hour spend of agentIds falls below cap (same rule as the wrapper's --hour-cap).
  function hourRetryAfter(agentIds, spent, cap) {
    const nowMs = now().getTime();
    const entries = [];
    for (const r of rows) {
      if (!agentIds.includes(r.agent_id) || r.blocked || !r.cost_usd) continue;
      const tsMs = Date.parse(r.ts);
      if (tsMs > nowMs - HOUR_MS) entries.push([tsMs, r.cost_usd]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    return retryAfterSeconds(entries, spent, cap, nowMs);
  }
  const hourHint = (scope, agentIds, spent, cap) => (scope === "hour" ? { retry_after_s: hourRetryAfter(agentIds, spent, cap) } : scope === "total" ? { message: TOTAL_NEVER_RESETS } : {});

  // Effective model allowlist (#153): intersection of the agent's, its team's and the default lists.
  // null = unrestricted; [] = every model refused.
  const modelsFor = (agentId = UNKNOWN_AGENT) => intersectModels(policy.agents?.[agentId]?.models, teamFor(agentId)?.models, policy.default?.models);

  return {
    spend,
    limitsFor,
    teamFor,
    modelsFor,
    teamSpend(who) {
      const team = teamFor(who.agent_id ?? UNKNOWN_AGENT);
      return team ? spend(who, team.agents) : null;
    },
    // null when the next call may proceed, otherwise a verdict with a cited reason.
    check({ agent_id: agentId = UNKNOWN_AGENT, run_id: runId = null } = {}) {
      const who = { agent_id: agentId, run_id: runId };
      const limits = limitsFor(agentId);
      const team = teamFor(agentId);
      if (!limits && !team) return { verdict: "no_budget_policy", reason: "no_budget_policy", ...who };
      const s = spend(who);
      const ts = team ? spend(who, team.agents) : null;
      if (s.unknown > 0) return { verdict: "accounting_unavailable", reason: "unreconciled_receipt", unknown_receipts: s.unknown, ...who };
      // A teammate's unknown cost makes the shared total unknowable too.
      if (ts?.unknown > 0) return { verdict: "accounting_unavailable", reason: "unreconciled_receipt", unknown_receipts: ts.unknown, team: team.team, ...who };
      for (const scope of SCOPES) {
        const cap = limits?.[scope];
        if (cap != null && s[scope] >= cap) {
          return { verdict: "budget_exceeded", reason: "budget_exceeded", scope, cap_usd: cap, spent_usd: round6(s[scope]), ...hourHint(scope, [agentId], s[scope], cap), ...totalCapMessage(scope, cap), ...who };
        }
      }
      for (const scope of SCOPES) {
        const cap = team?.[scope];
        if (cap != null && ts[scope] >= cap) {
          return { verdict: "budget_exceeded", reason: "budget_exceeded", scope, team: team.team, cap_usd: cap, spent_usd: round6(ts[scope]), ...hourHint(scope, team.agents, ts[scope], cap), ...totalCapMessage(scope, cap), ...who };
        }
      }
      if (limits?.maxSteps != null && s.steps >= limits.maxSteps) {
        return { verdict: "breaker_open", reason: "step_budget", steps: s.steps, max_steps: limits.maxSteps, ...who };
      }
      return null;
    },
    // #173: a settlement (hosted or provider) of an unknown-cost receipt. Accepts a
    // reconciliation { receipt_id, settled_cost_usd | cost_usd } or the settled receipt
    // { id, cost_usd }. Idempotent: only a row still at null cost is updated.
    settle(s) {
      const id = s?.receipt_id ?? s?.id;
      const cost = s?.settled_cost_usd ?? s?.cost_usd;
      if (typeof id !== "string" || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return false;
      const row = rows.find((r) => r.id === id);
      if (!row || row.cost_usd !== null) return false;
      row.cost_usd = cost;
      return true;
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
  const team = budgets.teamFor?.(who.agent_id) ?? null;
  if (!limits && !team) return null;
  const s = budgets.spend(who);
  const ts = team ? budgets.teamSpend(who) : null;
  const left = (cap, used) => (cap == null ? null : round6(Math.max(cap - used, 0)));
  // The tighter of the agent's own remainder and the team's shared remainder.
  const tight = (scope) => {
    const own = left(limits?.[scope], s[scope]);
    const shared = left(team?.[scope], ts?.[scope]);
    if (own == null) return shared;
    return shared == null ? own : Math.min(own, shared);
  };
  const models = budgets.modelsFor?.(who.agent_id) ?? null;
  const hour = tight("hour");
  const week = tight("week");
  const total = tight("total");
  // hour_usd (#172) appears only when an hour cap applies, so existing consumers see no new null field.
  return { run_usd: tight("run"), ...(hour != null ? { hour_usd: hour } : {}), day_usd: tight("day"), ...(week != null ? { week_usd: week } : {}), month_usd: tight("month"), ...(total != null ? { total_usd: total } : {}), steps: left(limits?.maxSteps, s.steps), ...(models ? { models } : {}) };
}
