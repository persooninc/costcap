// Opt-in pre-flight budget estimate (CC-9). Off by default. It is an ESTIMATE:
// input tokens are bounded by request bytes / 4 (UTF-8 bytes; typical
// tokenizers average about 4 bytes per English token, fewer for some scripts
// and code), and output tokens by the request's max-output field or a
// conservative provider default when absent. It prices at the model's
// published rate and never at the fallback: an unknown model is refused as
// preflight_unpriced.
import { lookupPrice, selectRates, batchMultiplier, toolRate, TABLE_VERSION, TABLE_SHA256 } from "./pricing.js";

// #214: Anthropic web search with max_uses caps billed searches per request; the worst case adds
// max_uses x the per-search rate. Without max_uses the search count is unbounded and not added.
export function toolWorstCase(provider, req, model) {
  if (provider !== "anthropic" || !Array.isArray(req?.tools)) return { ok: true, usd: 0, calls: 0 };
  let calls = 0;
  for (const t of req.tools) if (typeof t?.type === "string" && t.type.startsWith("web_search_") && Number.isInteger(t.max_uses) && t.max_uses > 0) calls += t.max_uses;
  if (!calls) return { ok: true, usd: 0, calls: 0 };
  const rate = toolRate("anthropic", "web_search", model);
  return rate === null ? { ok: false } : { ok: true, usd: calls * rate, calls };
}

// Conservative default output ceilings when the request sets no limit.
export const DEFAULT_MAX_OUTPUT = { openai: 16_384, openrouter: 16_384, anthropic: 64_000, bedrock: 64_000, vertex: 64_000, gemini: 65_536 };

export function requestedOutputTokens(provider, req) {
  const n = provider === "gemini"
    ? req?.generationConfig?.maxOutputTokens ?? req?.generation_config?.max_output_tokens
    : req?.max_completion_tokens ?? req?.max_output_tokens ?? req?.max_tokens ?? req?.inferenceConfig?.maxTokens; // #216: Bedrock Converse
  return Number.isInteger(n) && n > 0 ? { tokens: n, defaulted: false } : { tokens: DEFAULT_MAX_OUTPUT[provider] ?? 65_536, defaulted: true };
}

// Max completions per request the provider accepts; larger values are clamped
// to it (the provider would reject them) and flagged output_multiplier_clamped.
export const MAX_OUTPUT_MULTIPLIER = { openai: 128, openrouter: 128, gemini: 8, anthropic: 1, bedrock: 1, vertex: 1 };

// OpenAI-compatible n / best_of (best_of bills every candidate, so the larger
// wins) and Gemini candidateCount multiply billed output tokens. A missing
// value is 1; an invalid one (non-integer, <= 0, non-number) is treated as 1
// and flagged output_multiplier_defaulted.
export function outputMultiplier(provider, req) {
  const raw = provider === "gemini"
    ? [req?.generationConfig?.candidateCount ?? req?.generation_config?.candidate_count]
    : ["anthropic", "bedrock", "vertex"].includes(provider) ? [] : [req?.n, req?.best_of];
  let multiplier = 1, defaulted = false;
  for (const v of raw) {
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v <= 0) { defaulted = true; continue; }
    multiplier = Math.max(multiplier, v);
  }
  const max = MAX_OUTPUT_MULTIPLIER[provider] ?? 128;
  const clamped = multiplier > max;
  return { multiplier: clamped ? max : multiplier, defaulted, clamped };
}

// Returns { ok: true, estimate_usd, ... } or { ok: false, reason: "preflight_unpriced", model }.
// #167: an OpenRouter `models` fallback list may route to any entry, so the
// worst case is the max over every candidate (any unpriced candidate refuses).
// #188: pathModel (cloud routes) is the model from the request path, used over the body.
export function estimateWorstCase(provider, body, path = "", priceFor, pathModel) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  let req = {};
  try { req = JSON.parse(text) ?? {}; } catch { /* malformed body: model unknown */ }
  const candidates = provider === "openrouter" ? openRouterModels(req) : null;
  if (pathModel !== undefined) return estimateOne(provider, req, text, path, pathModel ?? "unknown", priceFor);
  if (!candidates || candidates.length < 2) return estimateOne(provider, req, text, path, candidates?.[0], priceFor);
  let worst;
  for (const m of candidates) {
    const e = estimateOne(provider, req, text, path, m, priceFor);
    if (!e.ok) return e;
    if (!worst || e.estimate_usd > worst.estimate_usd) worst = e;
  }
  return { ...worst, candidate_models: candidates };
}

// De-duplicated union of `model` and a `models` array (OpenRouter fallbacks).
// Returns null when `models` is present but not an array of non-empty strings.
export function openRouterModels(req) {
  const out = [];
  if (typeof req?.model === "string" && req.model) out.push(req.model);
  if (req && req.models !== undefined) {
    if (!Array.isArray(req.models) || !req.models.every((m) => typeof m === "string" && m)) return null;
    for (const m of req.models) if (!out.includes(m)) out.push(m);
  }
  return out;
}

function estimateOne(provider, req, text, path, forcedModel, priceFor) {
  let model = forcedModel ?? (typeof req.model === "string" ? req.model : undefined);
  if (!model && provider === "gemini") model = /models\/([^/:]+)/.exec(path)?.[1];
  // #186: a custom upstream estimates only from user prices (priceFor), never the shipped table.
  const price = model ? (priceFor ? priceFor(model) : lookupPrice(model)) : null;
  if (!price || price.fallback || !Number.isFinite(price.input) || !Number.isFinite(price.output)) {
    return { ok: false, reason: "preflight_unpriced", model: model ?? "unknown" };
  }
  const input_tokens = Math.ceil(Buffer.byteLength(text, "utf8") / 4);
  // OpenAI (#145), OpenRouter (#202) and Gemini (#200) embeddings bill input only: no output allowance.
  const pathname = String(path ?? "").split(/[?#]/, 1)[0];
  const embeddings = ((provider === "openai" || provider === "openrouter") && pathname === "/v1/embeddings")
    || (provider === "gemini" && /^\/v1(?:beta|alpha)?\/models\/[A-Za-z0-9_.-]+:(?:embedContent|batchEmbedContents)$/.test(pathname));
  const out = embeddings ? { tokens: 0, defaulted: false } : requestedOutputTokens(provider, req);
  const mult = outputMultiplier(provider, req);
  const output_tokens = out.tokens * mult.multiplier;
  // Long-context tier (#151): a prompt estimated over the threshold budgets at the higher rates.
  // Premium speed / service tier (#155): fast or priority requests budget at premium rates.
  const signal = { ...(typeof req.speed === "string" && { speed: req.speed }), ...(typeof req.service_tier === "string" && { service_tier: req.service_tier }) };
  const { pricing_tier, rates } = selectRates(price, input_tokens, signal);
  if (!rates) return { ok: false, reason: "preflight_unpriced", model, pricing_tier };
  const tools = toolWorstCase(provider, req, model);
  if (!tools.ok) return { ok: false, reason: "preflight_unpriced", model, pricing_tier };
  const estimate_usd = Number(((input_tokens * rates.input + output_tokens * rates.output) / 1_000_000 + tools.usd).toFixed(6));
  const flags = { ...(mult.defaulted && { output_multiplier_defaulted: true }), ...(mult.clamped && { output_multiplier_clamped: true }) };
  return { ok: true, model, input_tokens, output_tokens, output_multiplier: mult.multiplier, ...flags, output_defaulted: out.defaulted, ...(tools.calls && { tool_calls_max: tools.calls, tool_usd_max: Number(tools.usd.toFixed(6)) }), estimate_usd, pricing_tier, ...(price.user_prices || (priceFor && !price.table_version) ? { cost_source: "user_prices" } : { cost_source: "table", table_version: TABLE_VERSION, table_sha256: TABLE_SHA256 }) };
}

// Compares the estimate with the remaining run/hour/day/month budget.
// Returns null when it fits, else the refusal detail. When `onFit` is given it
// receives the estimate of a call that fits (for the allowed-call receipt).
export function preflightCheck(cap, provider, body, path, onFit, priceFor, pathModel) {
  return checkEstimate(cap, estimateWorstCase(provider, body, path, priceFor, pathModel), onFit);
}

// #205: an Anthropic Message Batches create is estimated as the SUM of every
// entry's worst case (requests[].params, same bytes/4 + max_tokens maths as a
// single call) times the provider batch multiplier. Any unpriced or missing
// entry model refuses as preflight_unpriced naming that model.
export function estimateBatch(provider, body, priceFor) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  let reqs;
  try { reqs = JSON.parse(text)?.requests; } catch { /* unusable body */ }
  if (!Array.isArray(reqs) || !reqs.length) return { ok: false, reason: "preflight_unpriced", model: "unknown" };
  const mult = batchMultiplier(provider) ?? 1;
  let usd = 0, input_tokens = 0, output_tokens = 0, model;
  for (const r of reqs) {
    const params = r?.params && typeof r.params === "object" ? r.params : {};
    const e = estimateOne(provider, params, JSON.stringify(params), "/v1/messages", undefined, priceFor);
    if (!e.ok) return e;
    usd += e.estimate_usd; input_tokens += e.input_tokens; output_tokens += e.output_tokens; model ??= e.model;
  }
  return { ok: true, model, input_tokens, output_tokens, output_multiplier: 1, batch_entries: reqs.length, batch_multiplier: mult,
    estimate_usd: Number((usd * mult).toFixed(6)) };
}

// Compares a precomputed estimate (estimateWorstCase / estimateBatch) with the remaining budget.
export function checkEstimate(cap, est, onFit) {
  if (!est.ok) return { reason: "preflight_unpriced", estimate: true, model: est.model, ...(est.pricing_tier && { pricing_tier: est.pricing_tier }) };
  const remaining = cap?.remaining?.() ?? {};
  for (const scope of ["run", "hour", "day", "month"]) {
    if (remaining[scope] != null && est.estimate_usd > remaining[scope]) {
      return { reason: "preflight_estimate", estimate: true, scope, estimate_usd: est.estimate_usd, remaining_usd: remaining, model: est.model, pricing_tier: est.pricing_tier,
        input_tokens_est: est.input_tokens, output_tokens_est: est.output_tokens, output_multiplier: est.output_multiplier };
    }
  }
  onFit?.(est);
  return null;
}
