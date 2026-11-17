// Hosted org-wide budget (issue #240). Pure, no I/O.
// One day/week/month cap across every agent of an org, including agents enrolled
// later and revoked agents' past spend. The verdict reuses teamVerdict (and so
// the local agent-budget engine): unknown cost (cost_usd: null) makes the
// verdict accounting_unavailable, never $0; pending batches are pending (#183).
import { teamVerdict, cachedTotals } from "./teams.js";
import { warnFractionsError, sortWarnFractions } from "./alerts.js";

const round6 = (n) => Number(n.toFixed(6));
// #268: week (ISO, Monday start, org timezone) joins day and month.
export const ORG_SCOPES = Object.freeze(["day", "week", "month"]);
// What a pre-#268 wrapper accepts in org_budget; week travels in org_budget_v2.
export const LEGACY_ORG_SCOPES = Object.freeze(["day", "month"]);
// #195 --preflight remainders: day/month always, week (#271) when an org week cap is set.
const REMAINING_SCOPES = ["day", "month"];
export const orgScope = (scope) => `org:${scope}`;
const FIELDS = ["day", "week", "month", "warnFractions"];

// The saved org budget, or null when no cap is set.
export function orgBudgetOf(org) {
  const b = org?.orgBudget;
  return b && ORG_SCOPES.some((s) => b[s] != null) ? b : null;
}

// Validates a PUT /v1/org-budget body and merges it onto the saved budget.
// undefined keeps a saved value, null clears it. Returns the next budget or
// null (no caps left). Throws Error with .status 400 on bad input.
export function parseOrgBudget(body, current = null) {
  const bad = (message) => { const err = new Error(message); err.status = 400; throw err; };
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("Org budget body required");
  for (const key of Object.keys(body)) if (!FIELDS.includes(key)) bad(`Unknown org budget field ${key}`);
  const next = { ...(current ?? {}) };
  for (const scope of ORG_SCOPES) {
    const v = body[scope];
    if (v === undefined) continue;
    if (v === null) { delete next[scope]; continue; }
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(`Org ${scope} cap must be a positive number of USD`);
    next[scope] = v;
  }
  if (body.warnFractions === null) delete next.warnFractions;
  else if (body.warnFractions !== undefined) {
    const err = warnFractionsError(body.warnFractions);
    if (err) bad(err);
    next.warnFractions = sortWarnFractions(body.warnFractions);
  }
  return ORG_SCOPES.some((s) => next[s] != null) ? next : null;
}

// budget: { day?, month?, warnFractions? }; agentIds: every agent of the org
// (revoked included, so their spend still counts); receiptsByAgent: settled-aware
// receipts of this org only.
export function orgBudgetVerdict({ budget, agentIds, receiptsByAgent, nowMs, budgetPeriod = null }) {
  if (!budget) return null;
  const caps = Object.fromEntries(ORG_SCOPES.filter((s) => budget[s] != null).map((s) => [s, budget[s]]));
  const extra = Array.isArray(budget.warnFractions) ? { warnFractions: [...budget.warnFractions] } : {};
  if (!agentIds.length) return { caps, spend: { day_usd: 0, week_usd: 0, month_usd: 0, unknown_count: 0, pending_batch_count: 0, cost_complete: true }, verdict: "ok", ...extra };
  const v = teamVerdict({ team: { name: "org", agents: agentIds, ...caps }, receiptsByAgent, nowMs, budgetPeriod });
  const scope = v.scope ? orgScope(v.scope.split(":").pop()) : null;
  return {
    caps, spend: v.spend, verdict: v.verdict,
    ...(scope ? { scope, cap_usd: v.cap_usd, spent_usd: v.spent_usd } : {}),
    ...(v.unknown_receipts ? { unknown_receipts: v.unknown_receipts } : {}),
    ...extra,
  };
}

// The /v1/policy payload: the verdict plus as_of for the wrapper's offline check.
// #268: the full payload (org_budget_v2, week included) is sent only when a week
// cap is set; org_budget keeps the day/month shape a pre-#268 wrapper accepts.
export function orgBudgetPolicy(verdict, nowMs) {
  if (!verdict) return null;
  return { caps: { ...verdict.caps }, spend: { day_usd: verdict.spend.day_usd, week_usd: verdict.spend.week_usd ?? 0, month_usd: verdict.spend.month_usd, unknown_count: verdict.spend.unknown_count }, verdict: verdict.verdict, as_of: new Date(nowMs).toISOString() };
}

/** The pre-#268 org_budget block: day/month caps only, null when only week is capped. */
export function legacyOrgBudgetPolicy(full) {
  if (!full || !LEGACY_ORG_SCOPES.some((s) => full.caps?.[s] != null)) return null;
  const caps = Object.fromEntries(LEGACY_ORG_SCOPES.filter((s) => full.caps[s] != null).map((s) => [s, full.caps[s]]));
  const verdict = full.verdict === "budget_exceeded" && !LEGACY_ORG_SCOPES.some((s) => caps[s] != null && full.spend[`${s}_usd`] >= caps[s]) ? "ok" : full.verdict;
  return { caps, spend: { day_usd: full.spend.day_usd, month_usd: full.spend.month_usd, unknown_count: full.spend.unknown_count }, verdict, as_of: full.as_of };
}

/** The additive org_budget_v2 block: present only when a week cap is set. */
export const weekOrgBudgetPolicy = (full) => (full?.caps?.week != null ? full : null);

export function validOrgBudgetPolicy(o) {
  if (o === null || o === undefined) return true;
  if (typeof o !== "object" || !Number.isFinite(Date.parse(o.as_of)) || typeof o.verdict !== "string") return false;
  if (!Number.isInteger(o.spend?.unknown_count) || o.spend.unknown_count < 0) return false;
  if (!ORG_SCOPES.some((s) => o.caps?.[s] != null)) return false;
  for (const s of ORG_SCOPES) {
    const cap = o.caps?.[s];
    if (cap != null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) return false;
    const spent = o.spend[`${s}_usd`];
    if (spent === undefined && !LEGACY_ORG_SCOPES.includes(s)) continue; // week spend is optional (missing = 0)
    if (!(typeof spent === "number" && Number.isFinite(spent) && spent >= 0)) return false;
  }
  return true;
}

const asEntry = (o) => ({ spent: { day: o.spend.day_usd, week: o.spend.week_usd ?? 0, month: o.spend.month_usd }, unknown: o.spend.unknown_count, as_of: o.as_of });

// Offline enforcement in the wrapper: the org's synced spend plus this host's
// unsynced receipts (same overshoot window as teams: one poll interval).
export function cachedOrgVerdict(org, pending, nowMs, budgetPeriod = null) {
  if (!org) return null;
  const { total, unknown } = cachedTotals(asEntry(org), pending, nowMs, budgetPeriod);
  if (unknown > 0) return { verdict: "accounting_unavailable", reason: "unreconciled_receipt", scope: "org", org: true, unknown_receipts: unknown };
  for (const s of ORG_SCOPES) {
    const cap = org.caps?.[s];
    if (cap != null && total[s] >= cap) return { verdict: "budget_exceeded", reason: "budget_exceeded", scope: orgScope(s), org: true, cap_usd: cap, spent_usd: round6(total[s]) };
  }
  return null;
}

// What is left of each capped org window for --preflight.
export function cachedOrgRemaining(org, pending, nowMs, budgetPeriod = null) {
  if (!org) return null;
  const { total } = cachedTotals(asEntry(org), pending, nowMs, budgetPeriod);
  const left = {};
  for (const s of REMAINING_SCOPES) left[s] = org.caps?.[s] == null ? null : round6(Math.max(0, org.caps[s] - total[s]));
  if (org.caps?.week != null) left.week = round6(Math.max(0, org.caps.week - (total.week ?? 0)));
  return left;
}
