// Issue #244: fleet-wide per-model caps. GET /v1/policy ships the agent's synced
// spend per capped model (agent_spend.models, every host, settlement-aware, in
// the org budget period); each enrolled wrapper adds its own unsynced receipts
// and refuses that model only. Hour rules stay local. Pure, no I/O.
import { periodKey, samePeriod } from "../period.js";
import { isPendingBatch } from "../cap.js";
import { normalizeModel } from "../model-cap.js";

// Fleet-enforced scopes. #268 adds week (ISO, Monday start, org timezone); week
// rules travel in the additive model_caps_week field so a pre-#268 wrapper never
// sees them, and agent_spend.models[*] adds week/unknown_week (optional).
export const FLEET_MODEL_SCOPES = Object.freeze(["day", "week", "month"]);
// Rules that also go to the local fallback engine (no week window there).
const FALLBACK_SCOPES = ["day", "month"];
const REQUIRED_SPEND = ["day", "month"];
export const MAX_FLEET_MODELS = 20;
const round6 = (n) => Number(n.toFixed(6));

/** Normalized model ids named by hosted modelCaps rules (at most 20). */
export function cappedModels(rules) {
  if (!Array.isArray(rules)) return [];
  return [...new Set(rules.map((r) => normalizeModel(r?.model)).filter(Boolean))].slice(0, MAX_FLEET_MODELS);
}

/**
 * {<norm>: {day, week, month, unknown, unknown_week}} from settled-aware receipts;
 * null when no model is capped. `unknown` counts the current month (pre-#268
 * meaning); `unknown_week` the current week, which can start in the previous month.
 */
export function modelSpendPolicy(receipts, rules, nowMs, budgetPeriod = null) {
  const models = cappedModels(rules);
  if (!models.length) return null;
  const month = periodKey("month", nowMs, budgetPeriod), day = periodKey("day", nowMs, budgetPeriod), week = periodKey("week", nowMs, budgetPeriod);
  const acc = Object.fromEntries(models.map((m) => [m, { day: 0, week: 0, month: 0, unknown: 0, unknown_week: 0 }]));
  for (const r of receipts) {
    if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r)) continue;
    const e = acc[normalizeModel(r.model)];
    if (!e) continue;
    const tsMs = Date.parse(r.ts);
    const inMonth = periodKey("month", tsMs, budgetPeriod) === month, inWeek = periodKey("week", tsMs, budgetPeriod) === week;
    if (!inMonth && !inWeek) continue;
    if (r.cost_usd === null || r.cost_usd === undefined) { if (inMonth) e.unknown += 1; if (inWeek) e.unknown_week += 1; continue; }
    if (inMonth) e.month += r.cost_usd;
    if (inWeek) e.week += r.cost_usd;
    if (periodKey("day", tsMs, budgetPeriod) === day) e.day += r.cost_usd;
  }
  for (const e of Object.values(acc)) { e.day = round6(e.day); e.week = round6(e.week); e.month = round6(e.month); }
  return acc;
}

/** #268: hosted modelCaps split into what a pre-#268 wrapper accepts and the week rules. */
export function splitWeekModelCaps(rules) {
  const list = Array.isArray(rules) ? rules : [];
  return { legacy: list.filter((r) => r.scope !== "week"), week: list.filter((r) => r.scope === "week") };
}

/** model_caps_week from GET /v1/policy: null/undefined or 1-20 week rules. */
export function validWeekModelCaps(list) {
  if (list === null || list === undefined) return true;
  return Array.isArray(list) && list.length <= MAX_FLEET_MODELS && list.every((r) => r && r.scope === "week" && typeof r.model === "string" && r.model
    && typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd > 0);
}

export function validModelSpend(m) {
  if (m === undefined || m === null) return true;
  if (typeof m !== "object" || Array.isArray(m) || Object.keys(m).length > MAX_FLEET_MODELS) return false;
  return Object.values(m).every((e) => e && typeof e === "object" && Number.isInteger(e.unknown) && e.unknown >= 0
    && REQUIRED_SPEND.every((s) => typeof e[s] === "number" && Number.isFinite(e[s]) && e[s] >= 0)
    && (e.week === undefined || (typeof e.week === "number" && Number.isFinite(e.week) && e.week >= 0))
    && (e.unknown_week === undefined || (Number.isInteger(e.unknown_week) && e.unknown_week >= 0)));
}

/** Hosted rules the local fallback engine covers (day/month); hour rules stay local, week is fleet-only. */
export const fleetModelRules = (rules) => (rules ?? []).filter((r) => FALLBACK_SCOPES.includes(r.scope));

/**
 * Offline fleet model verdict. spend: agent_spend ({as_of, models}); rules: hosted
 * modelCaps; models: the request's model ids; pending: unsynced settled-aware receipts.
 * Returns null, accounting_unavailable for that model, or a model_budget_exceeded hit (fleet: true).
 */
export function cachedFleetModelVerdict(spend, rules, models, pending, nowMs, budgetPeriod = null) {
  if (!spend?.models) return null;
  const fr = (rules ?? []).filter((r) => FLEET_MODEL_SCOPES.includes(r.scope));
  if (!fr.length) return null;
  const asOfMs = Date.parse(spend.as_of);
  for (const m of models ?? []) {
    const norm = normalizeModel(m);
    const rs = fr.filter((r) => normalizeModel(r.model) === norm);
    if (!rs.length) continue;
    const e = spend.models[norm] ?? { day: 0, week: 0, month: 0, unknown: 0, unknown_week: 0 };
    // #268: unknown cost counts in the windows this model actually caps (month for day/month rules, week for week rules).
    const wins = [...new Set(rs.map((r) => (r.scope === "week" ? "week" : "month")))];
    let unknown = 0;
    for (const w of wins) if (samePeriod(w, nowMs, asOfMs, budgetPeriod)) unknown += w === "week" ? e.unknown_week ?? 0 : e.unknown;
    const total = {};
    for (const s of FLEET_MODEL_SCOPES) total[s] = samePeriod(s, nowMs, asOfMs, budgetPeriod) ? e[s] ?? 0 : 0;
    for (const r of pending) {
      if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r) || normalizeModel(r.model) !== norm) continue;
      const tsMs = Date.parse(r.ts);
      if (!wins.some((w) => samePeriod(w, tsMs, nowMs, budgetPeriod))) continue;
      if (r.cost_usd === null || r.cost_usd === undefined) { unknown += 1; continue; }
      for (const s of FLEET_MODEL_SCOPES) if (samePeriod(s, tsMs, nowMs, budgetPeriod)) total[s] += r.cost_usd;
    }
    if (unknown > 0) return { verdict: "accounting_unavailable", reason: "accounting_unavailable", model: m, unknown_receipts: unknown, fleet: true,
      message: `CostCap: model "${m}" has a fleet model cap and ${unknown} receipt(s) with unknown cost. Reconcile it before calling this model again.` };
    for (const r of rs) if (total[r.scope] >= r.usd) return { model: m, rule_model: r.model, scope: r.scope, spend_usd: round6(total[r.scope]), cap_usd: r.usd, fleet: true };
  }
  return null;
}

/**
 * Proxy-facing model cap engine for an enrolled wrapper. `local` holds local
 * --model-cap rules plus hosted hour rules; `fallback` holds hosted day/month rules
 * and is used only until the server has sent agent_spend.models (old server, first run offline).
 * Either side refusing refuses.
 */
export function withFleetModelCaps(local, fallback, fleet) {
  const both = (fn) => { fn(local); fn(fallback); };
  const hasSnapshot = () => !!fleet.agentSpend()?.models;
  return {
    rules: () => [...local.rules(), ...fallback.rules()],
    setRules: (next) => local.setRules(next),
    record: (r) => both((e) => e.record(r)),
    settle: (id, cost) => { const a = local.settle(id, cost); const b = fallback.settle(id, cost); return a || b; },
    check: (models) => local.check(models) ?? (hasSnapshot() ? fleet.modelCheck(models) : fallback.check(models)),
    remaining: (models) => [...local.remaining(models), ...(hasSnapshot() ? [] : fallback.remaining(models))],
    preflight: (models, est) => local.preflight(models, est) ?? (hasSnapshot() ? null : fallback.preflight(models, est)),
    over: () => [...local.over(), ...(hasSnapshot() ? [] : fallback.over())],
  };
}

/** Dashboard rows for the agent card: each hosted rule with its fleet spend (null: hour scope or unknown cost). */
export function modelCapStatus(receipts, rules, nowMs, budgetPeriod = null) {
  const spend = modelSpendPolicy(receipts, rules, nowMs, budgetPeriod) ?? {};
  return (rules ?? []).map((r) => {
    const e = spend[normalizeModel(r.model)];
    const unknown = (r.scope === "week" ? e?.unknown_week : e?.unknown) ?? 0;
    const spent = r.scope === "hour" || !e ? null : unknown > 0 ? null : e[r.scope];
    return { model: r.model, scope: r.scope, usd: r.usd, spent, unknown };
  });
}
