// Read-only CI guard: rejects unknown cost rather than treating it as free.
import { loadSettledReceipts as loadReceipts, createCapEngine, isPendingBatch } from "./cap.js";
import { budgetRemaining, createAgentBudgets, intersectModels } from "./agent-budget.js";
import { createKillCheck } from "./kill.js";
import { DEFAULT_WARN_AT, currentWarnings } from "./cap-warn.js";
import { createFleetClient } from "./hosted/client.js";
import { createTagCaps } from "./tag-cap.js";

// #191: --tag-cap lists every tag value at or over its cap; any one fails the check.
export function checkBudget({ tagCaps, ...options }) {
  const history = loadReceipts(options.receiptsPath);
  if (!history.length) throw new Error("No receipts found; a budget check needs evidence");
  const base = options.runId != null ? checkRunBudget({ ...options, history, warnAt: options.warnAt ?? DEFAULT_WARN_AT }) : checkLedgerBudget({ ...options, history });
  if (!tagCaps?.length) return base;
  const over = createTagCaps({ rules: tagCaps, history, now: options.now }).over();
  const first = over[0];
  const hit = base.hit ?? (first ? { scope: first.scope, reason: "tag_budget_exceeded", tag_key: first.key, tag_value: first.value, cap: first.cap_usd, spent: first.spend_usd } : null);
  return { ...base, ok: base.ok && !over.length, hit, tag_caps: over };
}

function checkLedgerBudget({ history, caps = {}, now, warnAt = DEFAULT_WARN_AT }) {
  const cap = createCapEngine({ caps: { hour: caps.hour, day: caps.day, month: caps.month }, history, now });
  const s = cap.spend();
  const unknown_cost_count = history.filter((r) => r.cost_usd === null).length;
  const total = history.reduce((sum, r) => sum + (typeof r.cost_usd === "number" ? r.cost_usd : 0), 0);
  let hit = cap.check();
  // #160: a pending batch does not stop the proxy, but a check never passes on unknown cost.
  if (!hit && history.some(isPendingBatch)) hit = { scope: "accounting", cap: 0, spent: 0, reason: "batch_pending" };
  if (!hit && caps.run != null) {
    if (!Number.isFinite(caps.run) || caps.run <= 0) throw new Error("Invalid run cap");
    if (total >= caps.run) hit = { scope: "run", cap: caps.run, spent: total };
  }
  // #164: soft warnings never change ok. Unknown cost makes the spend a lower bound.
  const lb = unknown_cost_count > 0;
  const warnings = currentWarnings({ caps, spend: { run: total, day: s.day, month: s.month }, fractions: warnAt, lowerBound: { run: lb, day: lb, month: lb } });
  return { ok: !hit, receipt_count: history.length, total_usd: Number(total.toFixed(6)), unknown_cost_count,
    hour: { spent_usd: Number(s.hour.toFixed(6)), cap: caps.hour ?? null, scope: "whole ledger, last 60 minutes" },
    blocked_model_count: history.filter((r) => r.outcome === "blocked_model").length,
    unknown_cost_counted_as_zero: false, spend: s, hit, warnings,
    estimate_only: true, scope: "all receipts in selected ledger; run total is not a reconstructed process run" };
}

// Run-scoped check: the run cap counts only receipts with this run_id, while
// day/month caps (and their unknown-cost rule) still cover the whole ledger.
function checkRunBudget({ history, caps = {}, now, runId, warnAt }) {
  if (typeof runId !== "string" || !runId) throw new Error("--run-id needs a non-empty value");
  const runRecs = history.filter((r) => r.run_id === runId);
  if (!runRecs.length) throw new Error(`No receipts for run_id ${JSON.stringify(runId)}; a budget check needs evidence (list runs with: costcap runs)`);
  const sum = (rs) => rs.reduce((t, r) => t + (typeof r.cost_usd === "number" ? r.cost_usd : 0), 0);
  const runUnknown = runRecs.filter((r) => r.cost_usd === null).length;
  const runTotal = sum(runRecs);
  if (caps.run != null && (!Number.isFinite(caps.run) || caps.run <= 0)) throw new Error("Invalid run cap");
  const ledgerCaps = caps.hour != null || caps.day != null || caps.month != null;
  const cap = createCapEngine({ caps: { hour: caps.hour, day: caps.day, month: caps.month }, history, now });
  const s = cap.spend();
  let hit = null;
  if (runUnknown > 0) hit = { scope: "run", cap: caps.run ?? null, spent: null, reason: "accounting_unavailable" };
  else if (caps.run != null && runTotal >= caps.run) hit = { scope: "run", cap: caps.run, spent: Number(runTotal.toFixed(6)) };
  if (!hit && ledgerCaps) hit = cap.check();
  // #185: a pending batch in any run makes ledger-wide spend unknown, so hour/day/month never pass on it.
  const ledgerPendingBatches = history.filter(isPendingBatch).length;
  if (!hit && ledgerCaps && ledgerPendingBatches > 0) hit = { scope: "accounting", cap: 0, spent: 0, reason: "batch_pending" };
  const ledgerUnknown = history.filter((r) => r.cost_usd === null).length;
  const warnings = currentWarnings({ caps, spend: { run: runTotal, day: s.day, month: s.month }, fractions: warnAt,
    lowerBound: { run: runUnknown > 0, day: ledgerUnknown > 0, month: ledgerUnknown > 0 } });
  return { ok: !hit, run_id: runId, scope: "run", receipt_count: runRecs.length, total_usd: Number(runTotal.toFixed(6)),
    unknown_cost_count: runUnknown, unknown_cost_counted_as_zero: false,
    run: { receipt_count: runRecs.length, total_usd: Number(runTotal.toFixed(6)), unknown_cost_count: runUnknown, cap: caps.run ?? null },
    hour: { spent_usd: Number(s.hour.toFixed(6)), cap: caps.hour ?? null, scope: "whole ledger, last 60 minutes" },
    day: { spent_usd: Number(s.day.toFixed(6)), cap: caps.day ?? null, scope: "whole ledger, current UTC day" },
    month: { spent_usd: Number(s.month.toFixed(6)), cap: caps.month ?? null, scope: "whole ledger, current UTC month" },
    ledger_unknown_cost_count: ledgerUnknown, ledger_pending_batch_count: ledgerPendingBatches, spend: s, hit, warnings, estimate_only: true };
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

// Issue #140: the self-check must match what the wrapper enforces on the next
// call. Same order as the proxy: kill switch (local file or cached fleet kill /
// revoked credentials), then the agent policy, then the cached fleet per-agent
// caps and team caps, then min(local, fleet) day/month caps. Read-only: the
// enrollment cache is read, never synced or rewritten. With no kill file (host or project)
// present nor an enrollment, the base result is returned unchanged.
export function fleetGuard({ killFile, enrollmentPath, receiptsPath, now }) {
  // The host kill file ($COSTCAP_HOME/KILL) is always checked, ahead of the project file.
  const killed = createKillCheck(killFile ?? null)();
  if (killed) return { killed };
  if (!enrollmentPath) return {};
  const fleet = createFleetClient({ path: enrollmentPath, receiptsPath });
  const policy = fleet.policy();
  if (policy.killed || fleet.revoked()) return { killed: { reason: "killed", note: "fleet policy or revoked credentials", enrollment: enrollmentPath } };
  const nowMs = now ? now().getTime() : Date.now();
  return { fleetCaps: policy.caps, fleetModels: policy.models ?? null, fleetHit: fleet.agentCheck(nowMs) ?? fleet.teamCheck(nowMs) };
}

const killedResult = (killed, extra = {}) => ({ ok: false, verdict: "killed", reason: "killed", kill: killed, hit: { verdict: "killed", ...killed }, ...extra, estimate_only: true });
const applyFleetHit = (result, hit) => (hit ? { ...result, ok: false, verdict: hit.verdict, reason: hit.reason, hit, ...(hit.scope ? { scope: hit.scope } : {}) } : result);

// Effective model allowlist (#153): local --models ∩ cached fleet models (∩ agent policy models).
const withModels = (result, models) => (models ? { ...result, allowed_models: models } : result);

export function guardedBudgetStatus(options) {
  const g = fleetGuard(options);
  if (g.killed) return killedResult(g.killed);
  return withModels(guardedBudgetBase(options, g), intersectModels(options.models ?? null, g.fleetModels ?? null));
}

function guardedBudgetBase(options, g) {
  if (!options.enrollmentPath) return checkBudget(options);
  const caps = { ...(options.caps ?? {}) };
  for (const k of ["hour", "day", "month"]) {
    const vals = [caps[k], g.fleetCaps?.[k]].filter((v) => v != null);
    if (vals.length) caps[k] = Math.min(...vals);
  }
  let base;
  try { base = checkBudget({ ...options, caps }); }
  catch (err) { if (!g.fleetHit || !/No receipts/.test(err.message)) throw err; base = { ok: true }; }
  if (g.fleetHit) return applyFleetHit(base, g.fleetHit);
  if (!base.ok && base.hit) return { ...base, verdict: base.unknown_cost_count ? "accounting_unavailable" : "budget_exceeded" };
  return base;
}

export function guardedAgentStatus(options) {
  const g = fleetGuard(options);
  if (g.killed) return killedResult(g.killed, { agent_id: options.agent_id, run_id: options.run_id ?? null });
  const base = agentBudgetStatus(options);
  const models = intersectModels(options.models ?? null, g.fleetModels ?? null, base.budget_remaining?.models ?? null);
  if (!base.ok || !options.enrollmentPath) return withModels(base, models);
  return withModels(applyFleetHit(base, g.fleetHit), models);
}
