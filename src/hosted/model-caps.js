// Issue #244: fleet-wide per-model caps. GET /v1/policy ships the agent's synced
// spend per capped model (agent_spend.models, every host, settlement-aware, in
// the org budget period); each enrolled wrapper adds its own unsynced receipts
// and refuses that model only. Hour rules stay local. Pure, no I/O.
import { periodKey, samePeriod } from "../period.js";
import { isPendingBatch } from "../cap.js";
import { normalizeModel } from "../model-cap.js";
import { fleetPreflightHit } from "../tag-cap.js";

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
  // #286: a total rule adds lifetime total/unknown_total to the models it names (only then).
  const lifetime = new Set(rules.filter((r) => r?.scope === "total").map((r) => normalizeModel(r.model)));
  const acc = Object.fromEntries(models.map((m) => [m, { day: 0, week: 0, month: 0, unknown: 0, unknown_week: 0, ...(lifetime.has(m) ? { total: 0, unknown_total: 0 } : {}) }]));
  for (const r of receipts) {
    if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r)) continue;
    const e = acc[normalizeModel(r.model)];
    if (!e) continue;
    if (e.total !== undefined) { if (r.cost_usd === null || r.cost_usd === undefined) e.unknown_total += 1; else e.total += r.cost_usd; }
    const tsMs = Date.parse(r.ts);
    const inMonth = periodKey("month", tsMs, budgetPeriod) === month, inWeek = periodKey("week", tsMs, budgetPeriod) === week;
    if (!inMonth && !inWeek) continue;
    if (r.cost_usd === null || r.cost_usd === undefined) { if (inMonth) e.unknown += 1; if (inWeek) e.unknown_week += 1; continue; }
    if (inMonth) e.month += r.cost_usd;
    if (inWeek) e.week += r.cost_usd;
    if (periodKey("day", tsMs, budgetPeriod) === day) e.day += r.cost_usd;
  }
  for (const e of Object.values(acc)) { e.day = round6(e.day); e.week = round6(e.week); e.month = round6(e.month); if (e.total !== undefined) e.total = round6(e.total); }
  return acc;
}

/** #268: hosted modelCaps split into what a pre-#268 wrapper accepts and the week rules. */
export function splitWeekModelCaps(rules) {
  const list = Array.isArray(rules) ? rules : [];
  return { legacy: list.filter((r) => r.scope !== "week" && r.scope !== "total"), week: list.filter((r) => r.scope === "week"), total: list.filter((r) => r.scope === "total") };
}

/** #286: model_caps_total from GET /v1/policy: null/undefined or 1-20 total rules. */
export function validTotalModelCaps(list) {
  if (list === null || list === undefined) return true;
  return Array.isArray(list) && list.length > 0 && list.length <= MAX_FLEET_MODELS && list.every((r) => r && r.scope === "total" && typeof r.model === "string" && r.model
    && typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd > 0);
}

/**
 * #286: offline lifetime model verdict: agent_spend.models[norm].total plus every
 * unsynced receipt of that model on this host. Unknown cost refuses (never $0).
 */
// #291: lifetime model-total remainders for --preflight. Unknown cost is left out (its verdict refuses).
export function cachedFleetModelTotalRemaining(spend, rules, models, pending) {
  if (!spend?.models || !rules?.length) return [];
  const out = [];
  for (const m of models ?? []) {
    const norm = normalizeModel(m);
    const rs = rules.filter((r) => r.scope === "total" && normalizeModel(r.model) === norm);
    if (!rs.length) continue;
    const { total, unknown } = modelTotalSpend(spend, norm, pending);
    if (unknown > 0) continue;
    for (const r of rs) out.push({ model: m, rule_model: r.model, scope: "total", cap_usd: r.usd, remaining_usd: round6(Math.max(r.usd - total, 0)), fleet: true });
  }
  return out;
}

function modelTotalSpend(spend, norm, pending) {
  const e = spend.models[norm];
  // A server that did not send this model's lifetime spend cannot be enforced: refuse, never $0.
  let total = e?.total ?? 0, unknown = e && typeof e.total === "number" ? e.unknown_total ?? 0 : 1;
  for (const r of pending) {
    if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts)) || isPendingBatch(r) || normalizeModel(r.model) !== norm) continue;
    if (r.cost_usd === null || r.cost_usd === undefined) unknown += 1; else total += r.cost_usd;
  }
  return { total, unknown };
}

export function cachedFleetModelTotalVerdict(spend, rules, models, pending) {
  if (!spend?.models || !rules?.length) return null;
  for (const m of models ?? []) {
    const norm = normalizeModel(m);
    const rs = rules.filter((r) => r.scope === "total" && normalizeModel(r.model) === norm);
    if (!rs.length) continue;
    const { total, unknown } = modelTotalSpend(spend, norm, pending);
    if (unknown > 0) return { verdict: "accounting_unavailable", reason: "accounting_unavailable", model: m, scope: "total", unknown_receipts: unknown, fleet: true,
      message: `CostCap: model "${m}" has a fleet model cap and ${unknown} receipt(s) with unknown cost. Reconcile it before calling this model again.` };
    for (const r of rs) if (total >= r.usd) return { model: m, rule_model: r.model, scope: "total", spend_usd: round6(total), cap_usd: r.usd, fleet: true };
  }
  return null;
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
    && (e.unknown_week === undefined || (Number.isInteger(e.unknown_week) && e.unknown_week >= 0))
    && (e.total === undefined || (typeof e.total === "number" && Number.isFinite(e.total) && e.total >= 0))
    && (e.unknown_total === undefined || (Number.isInteger(e.unknown_total) && e.unknown_total >= 0)));
}

/** Hosted rules the local fallback engine covers (day/month); hour rules stay local, week is fleet-only. */
export const fleetModelRules = (rules) => (rules ?? []).filter((r) => FALLBACK_SCOPES.includes(r.scope));

// Per-model synced plus pending totals (and unknown count) for the rules naming it.
function modelTotals(spend, rs, norm, pending, nowMs, budgetPeriod) {
  const asOfMs = Date.parse(spend.as_of);
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
  return { total, unknown };
}

const fleetScoped = (rules) => (rules ?? []).filter((r) => FLEET_MODEL_SCOPES.includes(r.scope));

/**
 * Offline fleet model verdict. spend: agent_spend ({as_of, models}); rules: hosted
 * modelCaps; models: the request's model ids; pending: unsynced settled-aware receipts.
 * Returns null, accounting_unavailable for that model, or a model_budget_exceeded hit (fleet: true).
 */
export function cachedFleetModelVerdict(spend, rules, models, pending, nowMs, budgetPeriod = null) {
  if (!spend?.models) return null;
  const fr = fleetScoped(rules);
  if (!fr.length) return null;
  for (const m of models ?? []) {
    const norm = normalizeModel(m);
    const rs = fr.filter((r) => normalizeModel(r.model) === norm);
    if (!rs.length) continue;
    const { total, unknown } = modelTotals(spend, rs, norm, pending, nowMs, budgetPeriod);
    if (unknown > 0) return { verdict: "accounting_unavailable", reason: "accounting_unavailable", model: m, unknown_receipts: unknown, fleet: true,
      message: `CostCap: model "${m}" has a fleet model cap and ${unknown} receipt(s) with unknown cost. Reconcile it before calling this model again.` };
    for (const r of rs) if (total[r.scope] >= r.usd) return { model: m, rule_model: r.model, scope: r.scope, spend_usd: round6(total[r.scope]), cap_usd: r.usd, fleet: true };
  }
  return null;
}

/**
 * #272: remaining USD of every hosted day/week/month model rule naming one of the
 * request's models, for --preflight. [] before the first snapshot. A model with
 * unknown-cost receipts is left out (check() refuses it; never treated as $0).
 */
export function cachedFleetModelRemaining(spend, rules, models, pending, nowMs, budgetPeriod = null) {
  if (!spend?.models) return [];
  const fr = fleetScoped(rules);
  const out = [];
  for (const m of models ?? []) {
    const norm = normalizeModel(m);
    const rs = fr.filter((r) => normalizeModel(r.model) === norm);
    if (!rs.length) continue;
    const { total, unknown } = modelTotals(spend, rs, norm, pending, nowMs, budgetPeriod);
    if (unknown > 0) continue;
    for (const r of rs) out.push({ model: m, rule_model: r.model, scope: r.scope, cap_usd: r.usd, remaining_usd: round6(Math.max(r.usd - total[r.scope], 0)), fleet: true });
  }
  return out;
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
    remaining: (models) => [...local.remaining(models), ...(hasSnapshot() ? fleet.modelRemaining?.(models) ?? [] : fallback.remaining(models))],
    // #272: once fleet-wide spend arrives, preflight uses the fleet remainders instead of the fallback.
    preflight: (models, est, reservedFor = null) => local.preflight(models, est, reservedFor)
      ?? (hasSnapshot() ? fleetPreflightHit(fleet.modelRemaining?.(models), est, reservedFor) : fallback.preflight(models, est, reservedFor)),
    over: () => [...local.over(), ...(hasSnapshot() ? [] : fallback.over())],
  };
}

/** Dashboard rows for the agent card: each hosted rule with its fleet spend (null: hour scope or unknown cost). */
export function modelCapStatus(receipts, rules, nowMs, budgetPeriod = null) {
  const spend = modelSpendPolicy(receipts, rules, nowMs, budgetPeriod) ?? {};
  return (rules ?? []).map((r) => {
    const e = spend[normalizeModel(r.model)];
    const unknown = (r.scope === "week" ? e?.unknown_week : r.scope === "total" ? e?.unknown_total : e?.unknown) ?? 0;
    const spent = r.scope === "hour" || !e ? null : unknown > 0 ? null : e[r.scope] ?? null;
    return { model: r.model, scope: r.scope, usd: r.usd, spent, unknown };
  });
}
