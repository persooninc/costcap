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
import { dayOf, datedRow } from "./pricing-schedule.js";

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

export { dayOf, datedRow, validateSchedules, pricingAt } from "./pricing-schedule.js";

// opts.undated: price from the base row only (Claude on Bedrock/Vertex stays undated).
// opts.vertex (#256): Gemini on Vertex AI is dated (rate-only `effective` entries apply at `at`),
// but `billed_as` entries never do: Vertex keeps its own rows for retired Gemini API ids.
export function lookupPrice(model, at, { undated = false, vertex = false } = {}) {
  assertTableIntegrity();
  const id = resolveModelId(model);
  const pin = { table_version: table.version, table_sha256: TABLE_SHA256 };
  if (id === null) return { model, ...table.fallback, ...pin, fallback: true };
  if (undated) { const { effective, ...base } = table.models[id]; return { model, ...base, ...pin, fallback: false }; }
  const d = datedRow(vertex ? vertexView(id) : table, id, dayOf(at));
  return { model, ...d.row, ...(d.rates_effective_from && { rates_effective_from: d.rates_effective_from }), ...(d.billed_as && { billed_as: d.billed_as }), ...pin, fallback: false };
}

// A one-row table view of id without its billed_as effective entries (#256).
function vertexView(id) {
  const { effective, ...base } = table.models[id];
  const kept = Array.isArray(effective) ? effective.filter((e) => e.billed_as === undefined) : [];
  return { models: { [id]: kept.length ? { ...base, effective: kept } : base } };
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

// Premium speed / service tiers (#155, #232): Anthropic fast mode reports usage.speed "fast";
// OpenAI Fast (renamed from Priority on 2026-07-30) reports service_tier "fast" (GPT-6) or
// "priority" (GPT-5.6 and earlier); both price at the model's `priority` set. "ultrafast"
// uses the model's `ultrafast` set. Known standard values are only recorded; any other
// value is "unrecognised" and unpriced, never standard.
// #235: "on_demand" is Groq's default (standard) tier, also passed through by OpenRouter
// and OpenAI-compatible gateways; it is never a premium tier.
export const STANDARD_SERVICE_TIERS = Object.freeze(["default", "auto", "flex", "scale", "standard", "batch", "on_demand"]);
export const PREMIUM_TIERS = Object.freeze(["fast", "priority", "ultrafast", "unrecognised"]);
export function premiumTier({ speed, service_tier } = {}) {
  if (speed === "fast") return "fast";
  if (typeof service_tier !== "string") return null;
  if (service_tier === "priority" || service_tier === "fast") return "priority";
  if (service_tier === "ultrafast") return "ultrafast";
  return STANDARD_SERVICE_TIERS.includes(service_tier) ? null : "unrecognised";
}

const validRates = (r) => !!r && Number.isFinite(r.input) && Number.isFinite(r.output);

// Rates for a call: a premium tier uses the model's published premium rate set and
// never falls back to standard; a model (or fallback) without one is unpriced.
// Over the long-context threshold a premium tier is priced only where the model page
// states it is a fixed multiple of the applicable rates (premium_long_context_multiplier,
// "Fast" only); otherwise it is unpriced.
export function selectRates(price, prompt_tokens, signal = {}) {
  const premium = premiumTier(signal);
  if (!premium) return selectTier(price, prompt_tokens);
  const rates = price?.fallback || premium === "unrecognised" ? null : price?.[premium];
  if (!validRates(rates)) return { pricing_tier: premium, rates: null };
  if (selectTier(price, prompt_tokens).pricing_tier === "long_context") {
    const m = price.premium_long_context_multiplier;
    if (premium !== "priority" || !(typeof m === "number" && Number.isFinite(m) && m > 0)) return { pricing_tier: premium, rates: null };
    return { pricing_tier: premium, rates: scaleRates(price.long_context, m), long_context: true };
  }
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

// #256: Vertex non-global premium for GA Gemini 3+ (vertex_gemini.regional). null when none applies.
export function vertexGeminiRegionalMultiplier(model) {
  const r = table.vertex_gemini?.regional;
  const id = resolveModelId(model);
  if (!r || id === null || !Array.isArray(r.models) || !r.models.includes(id)) return null;
  return typeof r.multiplier === "number" && Number.isFinite(r.multiplier) && r.multiplier > 0 ? r.multiplier : null;
}

// #217: Gemini models with a published Vertex AI rate (same per-token rates as the table entry).
export function vertexGeminiModels() {
  const list = table.vertex_gemini?.models;
  return Array.isArray(list) ? list.filter((id) => Object.hasOwn(table.models, id)) : [];
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

export function costForUsage(model, { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0, cache_write_1h_input_tokens = 0, speed, service_tier, modality_tokens } = {}, { batch, regional = false, scale, at, undated = false, vertex = false } = {}) {
  const price = lookupPrice(model, at, { undated, vertex });
  // #198: a per-minute / per-character model (whisper-1, tts-1) has no token rate: unknown, never NaN or $0.
  if (!price.fallback && !(Number.isFinite(price.input) && Number.isFinite(price.output))) {
    return { model, cost_usd: null, reason: "unit_unpriced", input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens,
      pricing_tier: "standard", table_version: price.table_version, table_sha256: price.table_sha256, fallback: false, cost_source: "table" };
  }
  const signal = { ...(typeof speed === "string" && { speed }), ...(typeof service_tier === "string" && { service_tier }) };
  // #262: Vertex Priority PayGo has no verified published rate: unpriced, never the Gemini API set or standard.
  const tierPrice = vertex && price.priority ? { ...price, priority: undefined } : price;
  const tiered = selectRates(tierPrice, promptTokens({ input_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens }), signal);
  const batchM = batch ? batchMultiplier(batch) : null;
  if (batch && batchM === null) throw new Error(`no batch rate for provider ${batch}`);
  // Regional premium stacks with batch and long-context like batch_multiplier (#188).
  const regionalM = regional && !price.fallback ? (vertex ? vertexGeminiRegionalMultiplier(model) : regionalMultiplier(model)) : null;
  // #189: a user discount (scale = 1 - d) stacks like batch/regional; never on the fallback rate.
  const userM = scale !== undefined && !price.fallback ? scale : null;
  const multiplier = batchM === null && regionalM === null && userM === null ? null : (batchM ?? 1) * (regionalM ?? 1) * (userM ?? 1);
  const pricing_tier = tiered.pricing_tier;
  const selected = tiered.rates && multiplier !== null ? scaleRates(tiered.rates, multiplier) : tiered.rates;
  const premium = PREMIUM_TIERS.includes(pricing_tier);
  const rates = selected ?? {};
  // A premium tier, or a cache component of it, with no published rate is unpriced: never standard.
  const tierUnpriced = premium && (!selected || (cached_input_tokens > 0 && rates.cached_input == null) ||
    (cache_write_input_tokens > 0 && rates.cache_write == null) || (cache_write_1h_input_tokens > 0 && rates.cache_write_1h == null));
  // A cache write with no published rate is unpriced, not guessed at another rate.
  // #262: a premium set prices non-text slices from its own `modalities` (Gemini Priority audio), never the standard ones.
  const modalPrice = premium && tiered.rates?.modalities ? { ...price, modalities: tiered.rates.modalities } : price;
  const modal = selected ? modalityAdjustment(modalPrice, rates, modality_tokens, multiplier ?? 1) : { delta: 0, unpriced: false };
  // #269: a model with no published cached-input rate (Gemini image models) leaves cache reads unknown.
  const cacheReadUnpriced = !tierUnpriced && cached_input_tokens > 0 && !Number.isFinite(rates.cached_input);
  const unpriced = tierUnpriced || modal.unpriced || cacheReadUnpriced || (cache_write_input_tokens > 0 && rates.cache_write == null) || (cache_write_1h_input_tokens > 0 && rates.cache_write_1h == null);
  const cost = unpriced ? 0 :
    (input_tokens * rates.input +
      (cached_input_tokens ? cached_input_tokens * rates.cached_input : 0) +
      cache_write_input_tokens * (rates.cache_write ?? 0) +
      cache_write_1h_input_tokens * (rates.cache_write_1h ?? 0) +
      output_tokens * rates.output + modal.delta) / 1_000_000;
  return {
    model,
    cost_usd: unpriced ? null : Number(cost.toFixed(6)),
    ...(unpriced ? { reason: tierUnpriced ? "service_tier_unpriced" : modal.unpriced ? "modality_unpriced" : cacheReadUnpriced ? "cache_read_unpriced" : pricing_tier === "long_context" ? "long_context_cache_write_unpriced" : "cache_write_unpriced" } : {}),
    input_tokens,
    output_tokens,
    cached_input_tokens,
    cache_write_input_tokens,
    cache_write_1h_input_tokens,
    pricing_tier,
    ...(tiered.long_context && { long_context: true }),
    ...(modality_tokens && { modality_tokens }),
    ...(batchM !== null && { batch_multiplier: batchM }),
    ...(regionalM !== null && { regional_multiplier: regionalM }),
    ...(signal.speed !== undefined && { speed: signal.speed }),
    ...(signal.service_tier !== undefined && { service_tier: signal.service_tier }),
    ...(price.rates_effective_from && { rates_effective_from: price.rates_effective_from }),
    ...(price.billed_as && { billed_as: price.billed_as }),
    table_version: price.table_version,
    table_sha256: price.table_sha256,
    fallback: price.fallback,
    cost_source: price.fallback ? "fallback" : "table",
  };
}

// #214: provider-side tools billed per call (Anthropic server_tool_use web_search_requests,
// OpenAI Responses web_search_call / file_search_call), from the table's `tools` section.
// A tool, tool variant or model family the table does not list is unpriced, never $0.
// toolCalls: { web_search?: n, file_search?: n, <other>?: n }. For OpenAI, web_search is
// priced by the request's tool type (webSearchType "web_search" | "web_search_preview");
// when that is unknown (e.g. a batch line) the higher of the two rates is used.
// userTools ({tool: usd_per_call}) overrides the table rate for that tool key.
// #254: a row flagged `free: true` with usd_per_call 0 is $0 (a bare 0 stays unpriced). A free row with
// `free_with_tools` is free only when the request's tools[] has one of those types dated >= `free_since`.
export function toolRate(provider, tool, model, opts = {}) {
  return toolRowRate(table.tools?.[provider]?.[tool], model, opts);
}

export function toolRowRate(row, model, { requestTools } = {}) {
  if (!row || typeof row !== "object") return null;
  if (row.free === true && row.usd_per_call === 0) {
    if (!Array.isArray(row.free_with_tools)) return 0;
    const types = (Array.isArray(requestTools) ? requestTools : []).map((t) => t?.type);
    return types.some((t) => {
      const m = typeof t === "string" ? /^([a-z_]+)_(\d{8})$/.exec(t) : null;
      return m && row.free_with_tools.includes(m[1]) && m[2] >= row.free_since;
    }) ? 0 : null;
  }
  const ok = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  if (row.families && typeof row.families === "object") {
    const best = familyOf(row.families, model);
    return best === null ? null : ok(row.families[best]);
  }
  return ok(row.usd_per_call);
}

function familyOf(families, model) {
  const id = (resolveModelId(model) ?? (typeof model === "string" ? model.replace(SNAPSHOT_SUFFIX, "") : "")).replace(FIRST_PARTY_PREFIX, "");
  let best = null;
  for (const fam of Object.keys(families)) {
    if ((id === fam || id.startsWith(`${fam}-`) || id.startsWith(`${fam}.`)) && (!best || fam.length > best.length)) best = fam;
  }
  return best;
}

/**
 * #250: how Grounding with Google Search bills for a Gemini model: "query" (Gemini 3+, per
 * unique non-empty search query) or "prompt" (Gemini 2.x, once per grounded prompt).
 * null when the table has no row for the model family (then grounding is unpriced, never $0).
 * The Gemini API row decides the unit; the rate comes from the route's own table row.
 */
export function googleSearchBilling(model, provider = "gemini") {
  const billing = table.tools?.[provider]?.google_search?.billing;
  if (!billing || typeof billing !== "object") return null;
  const fam = familyOf(billing, model);
  const unit = fam === null ? null : billing[fam];
  return unit === "query" || unit === "prompt" ? unit : null;
}

export function toolCallCost(provider, model, toolCalls, { webSearchType, userTools, requestTools } = {}) {
  assertTableIntegrity();
  let usd = 0, user = false;
  const rateFor = (key) => {
    const u = userTools?.[key];
    if (typeof u === "number" && Number.isFinite(u) && u > 0) { user = true; return u; }
    return toolRate(provider, key, model, { requestTools });
  };
  for (const [tool, n] of Object.entries(toolCalls ?? {})) {
    if (!(n > 0)) continue;
    let rate;
    if (provider === "openai" && tool === "web_search") {
      const keys = webSearchType ? [webSearchType] : ["web_search", "web_search_preview"];
      const rates = keys.map(rateFor);
      rate = rates.some((r) => r === null) ? null : Math.max(...rates);
    } else rate = rateFor(tool);
    if (rate === null) return { unpriced: true, tool };
    usd += n * rate;
  }
  return { unpriced: false, tool_cost_usd: Number(usd.toFixed(6)), user_prices: user };
}

// The OpenAI web search tool type a Responses request declares, or undefined.
export function requestWebSearchType(req) {
  const tools = Array.isArray(req?.tools) ? req.tools : [];
  const types = tools.map((t) => t?.type).filter((t) => typeof t === "string" && t.startsWith("web_search"));
  if (!types.length) return undefined;
  return types.some((t) => t.startsWith("web_search_preview")) ? (types.every((t) => t.startsWith("web_search_preview")) ? "web_search_preview" : undefined) : "web_search";
}

// #257: Gemini context caching storage, USD per 1M tokens per hour (`cache_storage`, dated via #236).
// Priced over [start, end) from the provider's own timestamps; a span over a dated change is split at
// 00:00 UTC of each `from` day. Returns { cost_usd, storage_hours } or null (unknown model, no rate, bad times).
export function cacheStorageCost(model, tokens, start, end) {
  assertTableIntegrity();
  const id = resolveModelId(model);
  const s = Date.parse(start), e = Date.parse(end);
  if (id === null || !Number.isInteger(tokens) || tokens < 0 || !Number.isFinite(s) || !Number.isFinite(e)) return null;
  const pin = { table_version: table.version, table_sha256: TABLE_SHA256 };
  if (e <= s) {
    const r = datedRow(table, id, dayOf(new Date(s).toISOString())).row;
    return Number.isFinite(r.cache_storage) ? { cost_usd: 0, storage_hours: 0, ...pin } : null;
  }
  const cuts = new Set([s, e]);
  for (const row of Object.values(table.models)) for (const x of row.effective ?? []) {
    const t = Date.parse(`${x.from}T00:00:00Z`);
    if (t > s && t < e) cuts.add(t);
  }
  const pts = [...cuts].sort((a, b) => a - b);
  let cost = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const rate = datedRow(table, id, new Date(pts[i]).toISOString().slice(0, 10)).row.cache_storage;
    if (!Number.isFinite(rate)) return null;
    cost += (tokens * rate * (pts[i + 1] - pts[i])) / 3.6e6 / 1e6;
  }
  return { cost_usd: Number(cost.toFixed(6)), storage_hours: Number(((e - s) / 3.6e6).toFixed(6)), ...pin };
}

// #278: non-Anthropic Bedrock rows ({id: {usagetype, regions: {region: rates}, source}}).
export function bedrockModels() {
  assertTableIntegrity();
  return table.bedrock_models?.models ?? {};
}
