// Issue #244: fleet-wide per-model caps. GET /v1/policy ships the agent's synced
// spend per capped model (agent_spend.models, every host, settlement-aware, in
// the org budget period); each enrolled wrapper adds its own unsynced receipts
// and refuses that model only. Hour rules stay local. Pure, no I/O.
import { periodKey, samePeriod } from "../period.js";
import { isPendingBatch } from "../cap.js";
import { normalizeModel } from "../model-cap.js";

export const FLEET_MODEL_SCOPES = Object.freeze(["day", "month"]);
export const MAX_FLEET_MODELS = 20;
const round6 = (n) => Number(n.toFixed(6));

/** Normalized model ids named by hosted modelCaps rules (at most 20). */
export function cappedModels(rules) {
  if (!Array.isArray(rules)) return [];
  return [...new Set(rules.map((r) => normalizeModel(r?.model)).filter(Boolean))].slice(0, MAX_FLEET_MODELS);
}

/** {<norm>: {day, month, unknown}} from settled-aware receipts; null when no model is capped. */
export function modelSpendPolicy(receipts, rules, nowMs, budgetPeriod = null) {
  const models = cappedModels(rules);
  if (!models.length) return null;
  const month = periodKey("month", nowMs, budgetPeriod), day = periodKey("day", nowMs, budgetPeriod);
  const acc = Object.fromEntries(models.map((m) => [m, { day: 0, month: 0, unknown: 0 }]));
  for (const r of receipts) {
    if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r)) continue;
    const e = acc[normalizeModel(r.model)];
    if (!e) continue;
    const tsMs = Date.parse(r.ts);
    if (periodKey("month", tsMs, budgetPeriod) !== month) continue;
    if (r.cost_usd === null || r.cost_usd === undefined) { e.unknown += 1; continue; }
    e.month += r.cost_usd;
    if (periodKey("day", tsMs, budgetPeriod) === day) e.day += r.cost_usd;
  }
  for (const e of Object.values(acc)) { e.day = round6(e.day); e.month = round6(e.month); }
  return acc;
}

export function validModelSpend(m) {
  if (m === undefined || m === null) return true;
  if (typeof m !== "object" || Array.isArray(m) || Object.keys(m).length > MAX_FLEET_MODELS) return false;
  return Object.values(m).every((e) => e && typeof e === "object" && Number.isInteger(e.unknown) && e.unknown >= 0
    && FLEET_MODEL_SCOPES.every((s) => typeof e[s] === "number" && Number.isFinite(e[s]) && e[s] >= 0));
}

/** Hosted rules the fleet verdict owns (day/month); hour rules stay in the local engine. */
export const fleetModelRules = (rules) => (rules ?? []).filter((r) => FLEET_MODEL_SCOPES.includes(r.scope));

/**
 * Offline fleet model verdict. spend: agent_spend ({as_of, models}); rules: hosted
 * modelCaps; models: the request's model ids; pending: unsynced settled-aware receipts.
 * Returns null, accounting_unavailable for that model, or a model_budget_exceeded hit (fleet: true).
 */
export function cachedFleetModelVerdict(spend, rules, models, pending, nowMs, budgetPeriod = null) {
  if (!spend?.models) return null;
  const fr = fleetModelRules(rules);
  if (!fr.length) return null;
  const asOfMs = Date.parse(spend.as_of);
  for (const m of models ?? []) {
    const norm = normalizeModel(m);
    const rs = fr.filter((r) => normalizeModel(r.model) === norm);
    if (!rs.length) continue;
    const e = spend.models[norm] ?? { day: 0, month: 0, unknown: 0 };
    let unknown = samePeriod("month", nowMs, asOfMs, budgetPeriod) ? e.unknown : 0;
    const total = {};
    for (const s of FLEET_MODEL_SCOPES) total[s] = samePeriod(s, nowMs, asOfMs, budgetPeriod) ? e[s] : 0;
    for (const r of pending) {
      if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r) || normalizeModel(r.model) !== norm) continue;
      const tsMs = Date.parse(r.ts);
      if (!samePeriod("month", tsMs, nowMs, budgetPeriod)) continue;
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
    const spent = r.scope === "hour" || !e ? null : e.unknown > 0 ? null : e[r.scope];
    return { model: r.model, scope: r.scope, usd: r.usd, spent, unknown: e?.unknown ?? 0 };
  });
}
