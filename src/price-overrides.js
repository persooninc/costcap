// Per-model price overrides for built-in providers (#189), from the same --upstream-prices file
// as #186. Entries are absolute rates ({input, output, cached_input?, cache_write?, cache_write_1h?})
// or a discount ({discount: d}, 0 < d < 1) scaling every table component by 1-d.
// Never $0 and never silently lower: built-in rates must be > 0, a discount never touches a
// fallback-priced model, and an absolute entry prices only the standard text components it lists.
import { bedrockModels, costForUsage, isPricedModel, lookupPrice, promptTokens, premiumTier, scalePrice, toolCallCost, requestWebSearchType } from "./pricing.js";

// #278: bedrock keys are base model ids without the geo prefix (amazon.nova-pro-v1:0); vertex keys
// are the mapped table ids (gemini-2.5-pro, claude-sonnet-4-5).
export const OVERRIDE_PROVIDERS = Object.freeze(["openai", "anthropic", "gemini", "openrouter", "bedrock", "vertex"]);
// A table rate exists for this provider/model (any Bedrock region for a listed non-Anthropic id).
const tablePriced = (provider, model) => isPricedModel(model) || (provider === "bedrock" && bedrockModels().includes(model));
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
// opts.priced: whether the table prices this call (cloud routes know it per region); default: the table lookup.
export function builtinOverride(prices, provider, model, { priced } = {}) {
  if (!prices || !OVERRIDE_PROVIDERS.includes(provider) || typeof model !== "string" || !model) return null;
  const table = prices.upstreams?.[provider];
  if (!table) return null;
  for (const id of [model, model.replace(SNAPSHOT_SUFFIX, "")]) {
    if (!Object.hasOwn(table, id) || id === "*") continue;
    if (!("discount" in table[id])) return { absolute: table[id] };
    // #197: a discount needs a table rate to scale; on an unpriced model it is ignored (never priced, never lower).
    return (priced ?? isPricedModel(model)) ? { discount: table[id].discount } : null;
  }
  // A provider-wide discount applies only to models with a table rate (never the fallback).
  if (Object.hasOwn(table, "*") && (priced ?? isPricedModel(model))) return { discount: table["*"].discount };
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

function costForAbsolute(prices, rate, model, usage, { batch, at, undated } = {}) {
  const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0, cache_write_1h_input_tokens = 0, speed, service_tier, modality_tokens } = usage;
  const table = lookupPrice(model, at, { undated });
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

/** #197: one warning per {discount} entry whose model the pricing table doesn't price (ignored). */
export function unpricedDiscountWarnings(prices) {
  const out = [];
  for (const p of OVERRIDE_PROVIDERS) {
    for (const [m, r] of Object.entries(prices?.upstreams?.[p] ?? {})) {
      if (m !== "*" && r && "discount" in r && !tablePriced(p, m)) out.push(`costcap: warning: discount ignored: ${p}/${m} is not in the pricing table; add absolute rates`);
    }
  }
  return out;
}

/** Pre-call: true when a model is priced by the table or by an absolute/discount override. */
export function isPricedWithOverrides(prices, provider, model) {
  return builtinOverride(prices, provider, model) !== null || isPricedModel(model);
}

/** Effective price row for preflight / pricing show: absolute rows are standard-only. */
export function effectivePrice(prices, provider, model, at) {
  const o = builtinOverride(prices, provider, model);
  if (!o) return lookupPrice(model, at);
  if (o.absolute) return { model, ...o.absolute, fallback: false, user_prices: true };
  const m = 1 - o.discount;
  const scale = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" && k !== "threshold_input_tokens" ? v * m : v && typeof v === "object" && !Array.isArray(v) ? scale(v) : v]));
  return { ...scale(lookupPrice(model, at)), user_prices: true, discount: o.discount };
}

/**
 * #214: adds per-call provider tool spend (metered.toolCalls) to a priced receipt.
 * Tokens keep their own pricing (batch discount included); tools always bill at the full
 * per-call rate. An unpriced tool / model family makes the receipt tool_use_unpriced, never $0.
 * #219: when the request names no web_search type (background GET, batch line), the
 * response object's echoed `tools` decides; the max-rate fallback applies only if neither does.
 * A `tools` entry in --prices overrides the table rate and pins the receipt as user_prices.
 */
export function withToolCost(c, prices, provider, metered, req, res = null) {
  const toolCalls = metered?.toolCalls;
  if (!toolCalls || !Object.keys(toolCalls).length) return c;
  if (c.cost_usd === null || c.cost_usd === undefined) return { ...c, tool_calls: toolCalls };
  const t = toolCallCost(provider, metered.model, toolCalls, { webSearchType: requestWebSearchType(req) ?? requestWebSearchType(res), userTools: prices?.tools, requestTools: req?.tools });
  if (t.unpriced) return { ...c, cost_usd: null, reason: "tool_use_unpriced", tool_calls: toolCalls, unpriced_tool: t.tool };
  return { ...c, cost_usd: Number((c.cost_usd + t.tool_cost_usd).toFixed(6)), tool_calls: toolCalls, tool_cost_usd: t.tool_cost_usd,
    ...(t.user_prices && pin(prices)) };
}

export const TOOL_OVERRIDE_KEYS = Object.freeze(["web_search", "web_search_preview", "file_search", "code_execution", "google_search"]);

/** Validates the optional top-level `tools` map of a prices file: {tool: usd_per_call > 0}. */
export function validateToolPrices(path, tools) {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) throw new Error(`--upstream-prices ${path}: tools must be an object of {tool: USD per call}`);
  for (const [k, v] of Object.entries(tools)) {
    if (!TOOL_OVERRIDE_KEYS.includes(k)) throw new Error(`--upstream-prices ${path}: tools: unknown tool "${k}" (allowed: ${TOOL_OVERRIDE_KEYS.join(", ")})`);
    if (!positive(v)) throw new Error(`--upstream-prices ${path}: tools.${k} must be a finite USD per call > 0 (never $0)`);
  }
}

/**
 * #278: receipt fields for a Bedrock/Vertex call. `model` is the mapped id, or a Bedrock base id
 * priced only by an absolute override (tablePriced false). costOpts are costForUsage's cloud
 * options ({bedrock: region} | {regional, vertex, at} | {regional, undated}). With no override
 * entry the result is exactly costForUsage's (Claude on Bedrock/Vertex receipts are unchanged).
 */
export function costForCloud(prices, provider, model, usage, costOpts, { tablePriced: priced = true } = {}) {
  const o = builtinOverride(prices, provider, model, { priced });
  if (!o) return costForUsage(model, usage, costOpts);
  if (o.absolute) return costForAbsolute(prices, o.absolute, model, usage, costOpts.bedrock !== undefined ? { undated: true } : { at: costOpts.at, undated: costOpts.undated });
  return { ...costForUsage(model, usage, { ...costOpts, scale: 1 - o.discount }), ...pin(prices), discount: o.discount };
}

/** #278: a cloud override's effect on a preflight price row (base: the table row, or null when unlisted). */
export function cloudOverridePrice(prices, provider, model, base) {
  const o = builtinOverride(prices, provider, model, { priced: base !== null });
  if (!o) return base;
  if (o.absolute) return { model, ...o.absolute, fallback: false, user_prices: true };
  return { ...scalePrice(base, 1 - o.discount), user_prices: true, discount: o.discount };
}

/** #278: true when an unlisted cloud model has an absolute --upstream-prices rate. */
export function hasAbsoluteCloudPrice(prices, provider, model) {
  return Boolean(model && builtinOverride(prices, provider, model, { priced: false })?.absolute);
}
