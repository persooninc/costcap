// Per-model price overrides for built-in providers (#189), from the same --upstream-prices file
// as #186. Entries are absolute rates ({input, output, cached_input?, cache_write?, cache_write_1h?})
// or a discount ({discount: d}, 0 < d < 1) scaling every table component by 1-d.
// Never $0 and never silently lower: built-in rates must be > 0, a discount never touches a
// fallback-priced model, and an absolute entry prices only the standard text components it lists.
import { costForUsage, isPricedModel, lookupPrice, promptTokens, premiumTier } from "./pricing.js";

export const OVERRIDE_PROVIDERS = Object.freeze(["openai", "anthropic", "gemini", "openrouter"]);
const RATE_KEYS = ["input", "output", "cached_input", "cache_write", "cache_write_1h"];
const SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|20\d{6})$/;
const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Validates one built-in provider's model map. Throws with a clear message. */
export function validateBuiltinPrices(path, provider, models) {
  const where = (m) => `--upstream-prices ${path}: ${provider}/${m}`;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error(`--upstream-prices ${path}: upstreams.${provider} must be an object of models`);
  for (const [model, r] of Object.entries(models)) {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`${where(model)} must be an object`);
    const keys = Object.keys(r);
    const unknown = keys.find((k) => k !== "discount" && !RATE_KEYS.includes(k));
    if (unknown) throw new Error(`${where(model)}: unknown rate key "${unknown}" (allowed: discount, ${RATE_KEYS.join(", ")})`);
    if ("discount" in r) {
      if (keys.length > 1) throw new Error(`${where(model)}: use either {discount} or absolute rates, not both`);
      if (!(typeof r.discount === "number" && Number.isFinite(r.discount) && r.discount > 0 && r.discount < 1)) throw new Error(`${where(model)}: discount must be a number strictly between 0 and 1`);
      continue;
    }
    if (model === "*") throw new Error(`${where(model)}: "*" takes only {discount: d}, not absolute rates`);
    if (!("input" in r) || !("output" in r)) throw new Error(`${where(model)}: absolute rates need input and output`);
    for (const k of keys) if (!positive(r[k])) throw new Error(`${where(model)}: ${k} must be a finite rate > 0 USD per 1M tokens (never $0)`);
  }
}

/** The override entry for a built-in provider/model: {discount} | {absolute} | null. */
export function builtinOverride(prices, provider, model) {
  if (!prices || !OVERRIDE_PROVIDERS.includes(provider) || typeof model !== "string" || !model) return null;
  const table = prices.upstreams?.[provider];
  if (!table) return null;
  for (const id of [model, model.replace(SNAPSHOT_SUFFIX, "")]) {
    if (Object.hasOwn(table, id) && id !== "*") return "discount" in table[id] ? { discount: table[id].discount } : { absolute: table[id] };
  }
  // A provider-wide discount applies only to models with a table rate (never the fallback).
  if (Object.hasOwn(table, "*") && isPricedModel(model)) return { discount: table["*"].discount };
  return null;
}

const pin = (prices) => ({ cost_source: "user_prices", prices_version: prices.version, prices_sha256: prices.sha256 });

/** Receipt fields for a built-in route with overrides; identical to costForUsage when none apply. */
export function costWithOverrides(prices, provider, model, usage = {}, opts = {}) {
  const o = builtinOverride(prices, provider, model);
  if (!o) return costForUsage(model, usage, opts);
  if (o.discount !== undefined) {
    const c = costForUsage(model, usage, { ...opts, scale: 1 - o.discount });
    if (c.fallback) return costForUsage(model, usage, opts); // never discount a fallback rate
    return { ...c, ...pin(prices), discount: o.discount };
  }
  return costForAbsolute(prices, o.absolute, model, usage, opts);
}

function costForAbsolute(prices, rate, model, usage, { batch } = {}) {
  const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0, cache_write_1h_input_tokens = 0, speed, service_tier, modality_tokens } = usage;
  const table = lookupPrice(model);
  const lc = table.fallback ? null : table.long_context;
  const hasModality = modality_tokens && typeof modality_tokens === "object" &&
    Object.values(modality_tokens).some((s) => s && Object.values(s).some((n) => n > 0));
  const unpriced = batch || premiumTier({ speed, service_tier }) || hasModality ||
    (lc && Number.isFinite(lc.threshold_input_tokens) && promptTokens(usage) > lc.threshold_input_tokens) ||
    (cached_input_tokens > 0 && rate.cached_input === undefined) ||
    (cache_write_input_tokens > 0 && rate.cache_write === undefined) ||
    (cache_write_1h_input_tokens > 0 && rate.cache_write_1h === undefined);
  const cost = (input_tokens * rate.input + cached_input_tokens * (rate.cached_input ?? 0) + cache_write_input_tokens * (rate.cache_write ?? 0) +
    cache_write_1h_input_tokens * (rate.cache_write_1h ?? 0) + output_tokens * rate.output) / 1_000_000;
  return {
    model, cost_usd: unpriced ? null : Number(cost.toFixed(6)), ...(unpriced && { reason: "user_price_unpriced" }),
    input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens, pricing_tier: "standard",
    ...(modality_tokens && { modality_tokens }), ...(typeof speed === "string" && { speed }), ...(typeof service_tier === "string" && { service_tier }),
    table_version: table.table_version, table_sha256: table.table_sha256, fallback: false, ...pin(prices),
  };
}

/** Pre-call: true when a model is priced by the table or by an absolute/discount override. */
export function isPricedWithOverrides(prices, provider, model) {
  return builtinOverride(prices, provider, model) !== null || isPricedModel(model);
}

/** Effective price row for preflight / pricing show: absolute rows are standard-only. */
export function effectivePrice(prices, provider, model) {
  const o = builtinOverride(prices, provider, model);
  if (!o) return lookupPrice(model);
  if (o.absolute) return { model, ...o.absolute, fallback: false, user_prices: true };
  const m = 1 - o.discount;
  const scale = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" && k !== "threshold_input_tokens" ? v * m : v && typeof v === "object" && !Array.isArray(v) ? scale(v) : v]));
  return { ...scale(lookupPrice(model)), user_prices: true, discount: o.discount };
}
