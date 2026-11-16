// Versioned model pricing with a declared fallback rate.
// Unknown models bill at the fallback, flagged and never free.
// The fallback is a floor for unknown models, not the highest published rate.
// The table version and SHA-256 digest are returned with every lookup so receipts can pin them.
// The table is checked against its committed digest sidecar (#122); a tampered
// table is never priced from: lookups throw and `costcap wrap` refuses to start.
// COSTCAP_PRICING_TABLE overrides the table path (its sidecar sits next to it).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { digestPathFor, verifyTableDigest } from "./pricing-digest.js";

export const DEFAULT_TABLE_PATH = fileURLToPath(new URL("./pricing-table.json", import.meta.url));

export function loadPricingTable(tablePath = process.env.COSTCAP_PRICING_TABLE || DEFAULT_TABLE_PATH) {
  const table = JSON.parse(readFileSync(tablePath, "utf8"));
  let recorded = null;
  try { recorded = JSON.parse(readFileSync(digestPathFor(tablePath), "utf8")); } catch { recorded = null; }
  const verification = verifyTableDigest(table, recorded);
  return { table, tablePath, digestPath: digestPathFor(tablePath), verification };
}

const loaded = loadPricingTable();
const table = loaded.table;

export const TABLE_VERSION = table.version;
export const TABLE_SHA256 = loaded.verification.actual;
export const TABLE_PATH = loaded.tablePath;

export function tableIntegrity() { return loaded.verification; }

export function integrityError(v = loaded.verification, path = loaded.tablePath) {
  return `pricing table ${path} failed verification (${v.reason}): sha256 ${v.actual}, expected ${v.expected ?? "none"}. Refusing to price from an unverified table; run \`costcap pricing verify\`.`;
}

export function assertTableIntegrity() {
  if (!loaded.verification.ok) throw new Error(integrityError());
}

export function lookupPrice(model) {
  assertTableIntegrity();
  // OpenAI returns dated snapshot ids (gpt-4o-mini-2024-07-18); price them as their base model.
  const base = typeof model === "string" ? model.replace(/-\d{4}-\d{2}-\d{2}$/, "") : model;
  const entry = table.models[model] ?? table.models[base];
  const pin = { table_version: table.version, table_sha256: TABLE_SHA256 };
  if (entry) return { model, ...entry, ...pin, fallback: false };
  return { model, ...table.fallback, ...pin, fallback: true };
}

// True when a model (or its dated snapshot base) has a published rate (#153: --unknown-models refuse).
export function isPricedModel(model) {
  return typeof model === "string" && model !== "" && !lookupPrice(model).fallback;
}

// Long-context tier (#151): a model may publish a higher rate set once the whole
// prompt (uncached input + cache read + cache writes) exceeds a threshold. Every
// component of that call is then priced at the long-context rates.
export function promptTokens({ input_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0, cache_write_1h_input_tokens = 0 } = {}) {
  return input_tokens + cached_input_tokens + cache_write_input_tokens + cache_write_1h_input_tokens;
}

export function selectTier(price, prompt_tokens) {
  const lc = price?.long_context;
  if (!price?.fallback && lc && Number.isFinite(lc.threshold_input_tokens) && prompt_tokens > lc.threshold_input_tokens) {
    return { pricing_tier: "long_context", rates: lc };
  }
  return { pricing_tier: "standard", rates: price };
}

// Premium speed / service tiers (#155): Anthropic fast mode reports usage.speed "fast";
// OpenAI priority processing reports service_tier "priority". Other values
// ("standard", "default", "flex", "auto", ...) price at standard and are only recorded.
export function premiumTier({ speed, service_tier } = {}) {
  if (speed === "fast") return "fast";
  if (service_tier === "priority") return "priority";
  return null;
}

// Rates for a call: a premium tier uses the model's published premium rate set and
// never falls back to standard; a model (or fallback) without one is unpriced.
export function selectRates(price, prompt_tokens, signal = {}) {
  const premium = premiumTier(signal);
  if (!premium) return selectTier(price, prompt_tokens);
  const rates = price?.fallback ? null : price?.[premium];
  if (!rates || !Number.isFinite(rates.input) || !Number.isFinite(rates.output)) return { pricing_tier: premium, rates: null };
  return { pricing_tier: premium, rates };
}

export function costForUsage(model, { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0, cache_write_1h_input_tokens = 0, speed, service_tier } = {}) {
  const price = lookupPrice(model);
  const signal = { ...(typeof speed === "string" && { speed }), ...(typeof service_tier === "string" && { service_tier }) };
  const { pricing_tier, rates: selected } = selectRates(price, promptTokens({ input_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens }), signal);
  const premium = pricing_tier === "fast" || pricing_tier === "priority";
  const rates = selected ?? {};
  // A premium tier, or a cache component of it, with no published rate is unpriced: never standard.
  const tierUnpriced = premium && (!selected || (cached_input_tokens > 0 && rates.cached_input == null) ||
    (cache_write_input_tokens > 0 && rates.cache_write == null) || (cache_write_1h_input_tokens > 0 && rates.cache_write_1h == null));
  // A cache write with no published rate is unpriced, not guessed at another rate.
  const unpriced = tierUnpriced || (cache_write_input_tokens > 0 && rates.cache_write == null) || (cache_write_1h_input_tokens > 0 && rates.cache_write_1h == null);
  const cost = unpriced ? 0 :
    (input_tokens * rates.input +
      cached_input_tokens * rates.cached_input +
      cache_write_input_tokens * (rates.cache_write ?? 0) +
      cache_write_1h_input_tokens * (rates.cache_write_1h ?? 0) +
      output_tokens * rates.output) / 1_000_000;
  return {
    model,
    cost_usd: unpriced ? null : Number(cost.toFixed(6)),
    ...(unpriced ? { reason: tierUnpriced ? "service_tier_unpriced" : pricing_tier === "long_context" ? "long_context_cache_write_unpriced" : "cache_write_unpriced" } : {}),
    input_tokens,
    output_tokens,
    cached_input_tokens,
    cache_write_input_tokens,
    cache_write_1h_input_tokens,
    pricing_tier,
    ...(signal.speed !== undefined && { speed: signal.speed }),
    ...(signal.service_tier !== undefined && { service_tier: signal.service_tier }),
    table_version: price.table_version,
    table_sha256: price.table_sha256,
    fallback: price.fallback,
    cost_source: price.fallback ? "fallback" : "table",
  };
}
