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

// Snapshot suffixes: OpenAI -YYYY-MM-DD (gpt-4.1-2025-04-14), Anthropic -YYYYMMDD
// (claude-sonnet-4-5-20250929). Only the date suffix is stripped and the remaining
// id must match exactly, so gpt-5-mini-<date> resolves to gpt-5-mini, never gpt-5.
const SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|20\d{6})$/;
// Provider-prefixed ids (OpenRouter style) not in the table fall back to the
// first-party id, which carries the same list rates for these providers.
const FIRST_PARTY_PREFIX = /^(?:anthropic|openai)\//;

// The table key a model id resolves to (exact, dated snapshot base or first-party id), or null.
export function resolveModelId(model) {
  if (typeof model !== "string" || !model) return null;
  const base = model.replace(SNAPSHOT_SUFFIX, "");
  const candidates = [model, base];
  if (FIRST_PARTY_PREFIX.test(base)) candidates.push(base.replace(FIRST_PARTY_PREFIX, ""));
  for (const id of candidates) if (Object.hasOwn(table.models, id)) return id;
  return null;
}

function resolveEntry(model) {
  const id = resolveModelId(model);
  return id === null ? undefined : table.models[id];
}

export function lookupPrice(model) {
  assertTableIntegrity();
  const entry = resolveEntry(model);
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

// Batch APIs (#160): a provider-level multiplier applied to every rate component,
// on top of the long_context tier. null when the provider publishes no batch rate.
export function batchMultiplier(provider) {
  const m = table.batch?.[provider];
  return typeof m === "number" && Number.isFinite(m) && m > 0 ? m : null;
}

// #188: Claude 4.5+ on Bedrock/Vertex regional (non-global) endpoints costs a published
// premium over global. Returns the multiplier for a model, or null when none applies.
export function regionalMultiplier(model) {
  const r = table.regional_endpoint;
  const id = resolveModelId(model);
  if (!r || id === null || !Array.isArray(r.models) || !r.models.includes(id)) return null;
  return typeof r.multiplier === "number" && Number.isFinite(r.multiplier) && r.multiplier > 0 ? r.multiplier : null;
}

// Every numeric rate (including the long-context set) times m; thresholds unchanged.
export function scalePrice(price, m) {
  const out = scaleRates(price, m);
  if (price.long_context) out.long_context = scaleRates(price.long_context, m);
  return out;
}

const scaleRates = (rates, m) => Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, typeof v === "number" && k !== "threshold_input_tokens" ? v * m : v]));

// #163: non-text modality slices. Returns { delta, unpriced } where delta is the extra USD
// (vs pricing the slice at the text rate) for slices with a published modality rate.
// uniform_modalities: one price for all inputs. text_rate_modalities: listed at the text rate.
// Anything else non-text (including every fallback model) is unpriced, never text-priced.
const BUCKET_RATE = { input: "input", cached_input: "cached_input", output: "output" };
export function modalityAdjustment(price, rates, modality_tokens, multiplier = 1) {
  if (!modality_tokens || typeof modality_tokens !== "object") return { delta: 0, unpriced: false };
  let delta = 0;
  for (const [bucket, rateKey] of Object.entries(BUCKET_RATE)) {
    const slice = modality_tokens[bucket];
    if (!slice) continue;
    for (const m of ["image", "audio", "video"]) {
      const n = slice[m] ?? 0;
      if (!(n > 0)) continue;
      if (price.fallback) return { delta: 0, unpriced: true };
      if (price.uniform_modalities === true) continue;
      if (bucket !== "output" && Array.isArray(price.text_rate_modalities) && price.text_rate_modalities.includes(m)) continue;
      const r = price.modalities?.[m]?.[rateKey];
      if (!Number.isFinite(r)) return { delta: 0, unpriced: true };
      delta += n * (r * multiplier - rates[rateKey]);
    }
  }
  return { delta, unpriced: false };
}

export function costForUsage(model, { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0, cache_write_1h_input_tokens = 0, speed, service_tier, modality_tokens } = {}, { batch, regional = false } = {}) {
  const price = lookupPrice(model);
  const signal = { ...(typeof speed === "string" && { speed }), ...(typeof service_tier === "string" && { service_tier }) };
  const tiered = selectRates(price, promptTokens({ input_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens }), signal);
  const batchM = batch ? batchMultiplier(batch) : null;
  if (batch && batchM === null) throw new Error(`no batch rate for provider ${batch}`);
  // Regional premium stacks with batch and long-context like batch_multiplier (#188).
  const regionalM = regional && !price.fallback ? regionalMultiplier(model) : null;
  const multiplier = batchM === null && regionalM === null ? null : (batchM ?? 1) * (regionalM ?? 1);
  const pricing_tier = tiered.pricing_tier;
  const selected = tiered.rates && multiplier !== null ? scaleRates(tiered.rates, multiplier) : tiered.rates;
  const premium = pricing_tier === "fast" || pricing_tier === "priority";
  const rates = selected ?? {};
  // A premium tier, or a cache component of it, with no published rate is unpriced: never standard.
  const tierUnpriced = premium && (!selected || (cached_input_tokens > 0 && rates.cached_input == null) ||
    (cache_write_input_tokens > 0 && rates.cache_write == null) || (cache_write_1h_input_tokens > 0 && rates.cache_write_1h == null));
  // A cache write with no published rate is unpriced, not guessed at another rate.
  const modal = selected ? modalityAdjustment(price, rates, modality_tokens, multiplier ?? 1) : { delta: 0, unpriced: false };
  const unpriced = tierUnpriced || modal.unpriced || (cache_write_input_tokens > 0 && rates.cache_write == null) || (cache_write_1h_input_tokens > 0 && rates.cache_write_1h == null);
  const cost = unpriced ? 0 :
    (input_tokens * rates.input +
      cached_input_tokens * rates.cached_input +
      cache_write_input_tokens * (rates.cache_write ?? 0) +
      cache_write_1h_input_tokens * (rates.cache_write_1h ?? 0) +
      output_tokens * rates.output + modal.delta) / 1_000_000;
  return {
    model,
    cost_usd: unpriced ? null : Number(cost.toFixed(6)),
    ...(unpriced ? { reason: tierUnpriced ? "service_tier_unpriced" : modal.unpriced ? "modality_unpriced" : pricing_tier === "long_context" ? "long_context_cache_write_unpriced" : "cache_write_unpriced" } : {}),
    input_tokens,
    output_tokens,
    cached_input_tokens,
    cache_write_input_tokens,
    cache_write_1h_input_tokens,
    pricing_tier,
    ...(modality_tokens && { modality_tokens }),
    ...(batchM !== null && { batch_multiplier: batchM }),
    ...(regionalM !== null && { regional_multiplier: regionalM }),
    ...(signal.speed !== undefined && { speed: signal.speed }),
    ...(signal.service_tier !== undefined && { service_tier: signal.service_tier }),
    table_version: price.table_version,
    table_sha256: price.table_sha256,
    fallback: price.fallback,
    cost_source: price.fallback ? "fallback" : "table",
  };
}
