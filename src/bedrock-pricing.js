// #278: pricing for non-Anthropic Bedrock models (Amazon Nova, Meta Llama, Mistral, DeepSeek,
// OpenAI gpt-oss, Qwen). Rates are per region (the request's AWS region, which is also the
// source region of a geo inference profile). Fail-safe: an unlisted id, a region without a row,
// a global./ARN id or a usage component without a rate is unpriced, never the fallback and never $0.
// --upstream-prices `bedrock` entries (#189 semantics) are keyed by the base id without geo prefix.
import { bedrockModels, TABLE_SHA256, TABLE_VERSION } from "./pricing.js";

const GEO = /^(?:us|eu|apac|jp|au|ca|us-gov)\./;
const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** True for a Bedrock id that is not an Anthropic model (after any geo prefix). */
export function isBedrockThirdParty(rawId) {
  return typeof rawId === "string" && !!rawId && !rawId.startsWith("arn:") && !rawId.replace(/^global\./, "").replace(GEO, "").startsWith("anthropic.");
}

/**
 * Base model id for pricing: geo prefix (us./eu./apac./...) stripped. A global. profile keeps its
 * prefix (priced only if the table lists it literally). ARNs and empty ids: null.
 */
export function bedrockBaseId(rawId) {
  if (typeof rawId !== "string" || !rawId || rawId.startsWith("arn:")) return null;
  return rawId.replace(GEO, "");
}

/** The table row for a base id in a region, or null. */
export function bedrockTableRate(baseId, region) {
  if (!baseId || typeof region !== "string") return null;
  const m = bedrockModels();
  if (!Object.hasOwn(m, baseId)) return null;
  const r = m[baseId].regions?.[region];
  return r && positive(r.input) && positive(r.output) ? r : null;
}

/** True when the table lists the base id in any region (mapping for caps / allowlists). */
export function isListedBedrockModel(baseId) {
  return typeof baseId === "string" && Object.hasOwn(bedrockModels(), baseId);
}

function override(prices, baseId) {
  const t = prices?.upstreams?.bedrock;
  if (!t || !baseId) return null;
  if (Object.hasOwn(t, baseId) && baseId !== "*") return "discount" in t[baseId] ? { discount: t[baseId].discount } : { absolute: t[baseId] };
  if (Object.hasOwn(t, "*")) return { discount: t["*"].discount };
  return null;
}

/**
 * Effective rate for a call: an absolute user entry (any region), else the region's table row
 * (scaled by a {discount}), else null. Returns {rates, user_prices?, discount?}.
 */
export function bedrockRate(prices, baseId, region) {
  const o = override(prices, baseId);
  if (o?.absolute) return { rates: o.absolute, user_prices: true };
  const row = bedrockTableRate(baseId, region);
  if (!row) return null;
  if (o?.discount !== undefined) {
    const k = 1 - o.discount;
    return { rates: Object.fromEntries(Object.entries(row).map(([c, v]) => [c, v * k])), user_prices: true, discount: o.discount };
  }
  return { rates: row };
}

/** A price row in lookupPrice shape for preflight (standard text rates only). */
export function bedrockPriceRow(rate, model) {
  return { model, ...rate.rates, fallback: false, table_version: TABLE_VERSION, table_sha256: TABLE_SHA256 };
}

/** Receipt fields for a metered non-Anthropic Bedrock call priced by `rate` (from bedrockRate). */
export function bedrockCost(prices, rate, model, usage = {}) {
  const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0 } = usage;
  const r = rate.rates;
  const base = { model, input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens: 0, pricing_tier: "standard",
    table_version: TABLE_VERSION, table_sha256: TABLE_SHA256, fallback: false,
    ...(rate.user_prices && { cost_source: "user_prices", prices_version: prices.version, prices_sha256: prices.sha256 }), ...(rate.discount !== undefined && { discount: rate.discount }) };
  const missing = (cached_input_tokens > 0 && !positive(r.cached_input)) || (cache_write_input_tokens > 0 && !positive(r.cache_write));
  if (missing) return { ...base, cost_usd: null, reason: "cloud_model_unpriced" };
  const cost = (input_tokens * r.input + cached_input_tokens * (r.cached_input ?? 0) + cache_write_input_tokens * (r.cache_write ?? 0) + output_tokens * r.output) / 1_000_000;
  return { ...base, cost_usd: Number(cost.toFixed(6)) };
}

/** #278: a Converse serviceTier other than default (flex / priority / reserved) has no rate. */
export function converseServiceTier(body) {
  const t = body?.serviceTier?.type;
  return typeof t === "string" && t !== "default" ? t : null;
}
