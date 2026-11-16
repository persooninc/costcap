// Issue #238: per-model spend caps. `--model-cap claude-opus-4-8:day=20` refuses
// Opus once its UTC-day spend reaches $20 while every other model keeps going.
// A refusal never latches. Models are normalized the way pricing resolves them
// (dated snapshots, OpenRouter `anthropic/…`, Bedrock/Vertex ids); an id with no
// table row matches exactly. Spend is bucketed per normalized model at record
// time, so rules can change (fleet sync) without re-reading the ledger.
import { HOUR_MS, isPendingBatch, retryAfterSeconds } from "./cap.js";
import { resolveModelId } from "./pricing.js";
import { mapCloudModel } from "./cloud.js";

export const MODEL_CAP_SCOPES = Object.freeze(["hour", "day", "month"]);
export const MODEL_CAP_RULE = "--model-cap is MODEL:SCOPE=USD with SCOPE hour|day|month and USD > 0, each MODEL:SCOPE once";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

const fail = (msg) => { const e = new Error(`${msg} (${MODEL_CAP_RULE})`); e.code = "invalid_model_cap"; throw e; };

/** The model id a cap rule and a receipt are compared on. */
export function normalizeModel(model) {
  if (typeof model !== "string" || !model) return null;
  const direct = resolveModelId(model);
  if (direct) return direct;
  for (const p of ["bedrock", "vertex"]) { const m = mapCloudModel(p, model); if (m) return m; }
  const slash = model.indexOf("/");
  if (slash > 0) { const r = resolveModelId(model.slice(slash + 1)); if (r) return r; }
  return model;
}

/** Parse one "MODEL:SCOPE=USD" rule; the split is on the last ":" so Bedrock ids keep their ":0". */
export function parseModelCap(text) {
  const s = String(text ?? "");
  const eq = s.lastIndexOf("=");
  const left = eq === -1 ? "" : s.slice(0, eq);
  const colon = left.lastIndexOf(":");
  if (eq === -1 || colon === -1) fail(`invalid --model-cap "${s}"`);
  const model = left.slice(0, colon), scope = left.slice(colon + 1), usd = s.slice(eq + 1);
  if (!MODEL_ID.test(model)) fail(`invalid --model-cap model "${model}" in "${s}"`);
  if (!MODEL_CAP_SCOPES.includes(scope)) fail(`invalid --model-cap scope "${scope}" in "${s}"`);
  const cap = usd.trim() === "" ? NaN : Number(usd);
  if (!Number.isFinite(cap) || cap <= 0) fail(`invalid --model-cap amount "${usd}" in "${s}"`);
  return { model, scope, cap };
}

/** Parse repeated --model-cap values; a duplicate MODEL:SCOPE (after normalization) is an error. */
export function parseModelCaps(list) {
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const r = parseModelCap(t);
    const id = `${normalizeModel(r.model)}:${r.scope}`;
    if (seen.has(id)) fail(`duplicate --model-cap ${r.model}:${r.scope}`);
    seen.add(id);
    out.push(r);
  }
  return out;
}

/** Hosted `modelCaps: [{model, scope, usd}]`: an error string or null. */
export function modelCapsError(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20) return "modelCaps must be a list of 1-20 {model, scope, usd} rules";
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => !["model", "scope", "usd"].includes(k))) return "modelCaps entries are {model, scope, usd}";
    if (typeof r.model !== "string" || !MODEL_ID.test(r.model)) return "modelCaps model must be a model id";
    if (!MODEL_CAP_SCOPES.includes(r.scope)) return "modelCaps scope must be hour, day or month";
    if (!(typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd > 0)) return "modelCaps usd must be a positive number";
    const id = `${normalizeModel(r.model)}:${r.scope}`;
    if (seen.has(id)) return `duplicate modelCaps rule ${r.model}:${r.scope}`;
    seen.add(id);
  }
  return null;
}

/** Fleet `modelCaps` ({usd}) merged with local rules ({cap}); for the same model:scope the lower cap wins. */
export function mergeModelCapRules(fleet = [], local = []) {
  const out = new Map();
  for (const r of [...(fleet ?? []).map((x) => ({ model: x.model, scope: x.scope, cap: x.usd ?? x.cap })), ...(local ?? [])]) {
    const id = `${normalizeModel(r.model)}:${r.scope}`;
    const prev = out.get(id);
    if (!prev || r.cap < prev.cap) out.set(id, { model: r.model, scope: r.scope, cap: r.cap });
  }
  return [...out.values()];
}

const round = (n) => Number(n.toFixed(6));

export function createModelCaps({ rules = [], history = [], now = () => new Date() } = {}) {
  let active = rules.map((r) => ({ ...r, norm: normalizeModel(r.model) }));
  const byPeriod = new Map(); // model \0 period -> USD
  const windows = new Map(); // model -> { win, head, sum }
  const unknown = new Map(); // receipt id -> { model, ts, batch }
  const settled = new Set();
  const unknownCount = (model) => { let n = 0; for (const u of unknown.values()) if (u.model === model && !u.batch) n += 1; return n; };

  const evict = (w, nowMs) => {
    while (w.head < w.win.length && w.win[w.head][0] <= nowMs - HOUR_MS) { w.sum -= w.win[w.head][1]; w.head += 1; }
    if (w.head > 1024 && w.head * 2 > w.win.length) { w.win.splice(0, w.head); w.head = 0; }
    if (w.head === w.win.length) w.sum = 0;
    else if (w.sum < 0) w.sum = 0;
    return w.sum;
  };
  const add = (model, ts, cost) => {
    if (!(cost > 0) || !model) return;
    const d = new Date(ts ?? now());
    const iso = d.toISOString();
    for (const p of [iso.slice(0, 10), iso.slice(0, 7)]) byPeriod.set(`${model}\0${p}`, (byPeriod.get(`${model}\0${p}`) ?? 0) + cost);
    let w = windows.get(model);
    if (!w) windows.set(model, (w = { win: [], head: 0, sum: 0 }));
    const ms = d.getTime();
    w.sum += cost;
    let i = w.win.length;
    while (i > w.head && w.win[i - 1][0] > ms) i -= 1;
    w.win.splice(i, 0, [ms, cost]);
  };
  const spendOf = (model, scope) => {
    const d = now();
    if (scope === "hour") { const w = windows.get(model); return w ? evict(w, d.getTime()) : 0; }
    const iso = d.toISOString();
    return byPeriod.get(`${model}\0${scope === "day" ? iso.slice(0, 10) : iso.slice(0, 7)}`) ?? 0;
  };
  const verdict = (rule) => {
    const spent = spendOf(rule.norm, rule.scope);
    if (spent < rule.cap) return null;
    const hit = { model: rule.model, scope: rule.scope, spend_usd: round(spent), cap_usd: rule.cap };
    if (rule.scope === "hour") {
      const w = windows.get(rule.norm);
      hit.retry_after_s = retryAfterSeconds(w.win.slice(w.head), spent, rule.cap, now().getTime());
    }
    return hit;
  };
  const rulesFor = (model) => { const n = normalizeModel(model); return n ? active.filter((r) => r.norm === n) : []; };

  const engine = {
    rules: () => active.map(({ norm, ...r }) => ({ ...r })),
    /** #238: fleet sync replaces the rule set; buckets are kept. */
    setRules(next = []) { active = next.map((r) => ({ ...r, norm: normalizeModel(r.model) })); },
    record(receipt) {
      if (!receipt) return;
      const model = normalizeModel(receipt.model);
      if (receipt.cost_usd === null) {
        if (typeof receipt.id === "string" && receipt.id && model) unknown.set(receipt.id, { model, ts: receipt.ts, batch: isPendingBatch(receipt) });
        return;
      }
      if (typeof receipt.cost_usd === "number" && Number.isFinite(receipt.cost_usd)) add(model, receipt.ts, receipt.cost_usd);
    },
    /** A settlement of an unknown-cost receipt lands once in that receipt's model bucket. */
    settle(id, cost) {
      if (typeof id !== "string" || !id || settled.has(id) || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return false;
      const u = unknown.get(id);
      if (!u) return false;
      settled.add(id);
      unknown.delete(id);
      add(u.model, u.ts, cost);
      return true;
    },
    /** First capped model in `models` that is over (or has unknown cost), else null. */
    check(models) {
      for (const m of models ?? []) {
        const rs = rulesFor(m);
        if (!rs.length) continue;
        if (unknownCount(rs[0].norm)) {
          return { verdict: "accounting_unavailable", model: m, message: `CostCap: model "${m}" has a model cap and a receipt with unknown cost. Reconcile it before calling this model again.` };
        }
        for (const r of rs) { const hit = verdict(r); if (hit) return { ...hit, model: m, rule_model: r.model }; }
      }
      return null;
    },
    remaining(models) {
      const out = [];
      for (const m of models ?? []) for (const r of rulesFor(m)) out.push({ model: m, scope: r.scope, cap_usd: r.cap, remaining_usd: round(Math.max(r.cap - spendOf(r.norm, r.scope), 0)) });
      return out;
    },
    /** First rule whose remainder cannot fit a preflight worst-case estimate, else null. */
    preflight(models, estimateUsd) {
      const r = engine.remaining(models).find((x) => estimateUsd > x.remaining_usd);
      return r ? { reason: "preflight_estimate", estimate: true, estimate_usd: estimateUsd, ...r } : null;
    },
    /** Every rule at or over its cap in the current window. */
    over() {
      return active.map(verdict).filter(Boolean).map((h) => ({ model: h.model, scope: h.scope, spend_usd: h.spend_usd, cap_usd: h.cap_usd, verdict: "model_budget_exceeded" }));
    },
  };
  for (const r of history) engine.record(r);
  return engine;
}

export function modelBudgetExceededBody(hit) {
  const { rule_model: _r, ...rest } = hit;
  if (hit.reason === "preflight_estimate") {
    return { error: "model_budget_exceeded", ...rest,
      message: `CostCap preflight estimate: worst case $${hit.estimate_usd} does not fit model ${hit.model}'s remaining ${hit.scope} budget ($${hit.remaining_usd}). This is an estimate. The upstream call was not made.` };
  }
  return { error: "model_budget_exceeded", ...rest,
    message: `CostCap: model ${hit.model} reached its ${hit.scope} cap of $${hit.cap_usd} ($${hit.spend_usd} spent). Other models keep working. The upstream call was not made.` };
}
