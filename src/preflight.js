// Opt-in pre-flight budget estimate (CC-9). Off by default. It is an ESTIMATE:
// input tokens are bounded by request bytes / 4 (UTF-8 bytes; typical
// tokenizers average about 4 bytes per English token, fewer for some scripts
// and code), and output tokens by the request's max-output field or a
// conservative provider default when absent. It prices at the model's
// published rate and never at the fallback: an unknown model is refused as
// preflight_unpriced.
import { lookupPrice, TABLE_VERSION, TABLE_SHA256 } from "./pricing.js";

// Conservative default output ceilings when the request sets no limit.
export const DEFAULT_MAX_OUTPUT = { openai: 16_384, openrouter: 16_384, anthropic: 64_000, gemini: 65_536 };

export function requestedOutputTokens(provider, req) {
  const n = provider === "gemini"
    ? req?.generationConfig?.maxOutputTokens ?? req?.generation_config?.max_output_tokens
    : req?.max_completion_tokens ?? req?.max_output_tokens ?? req?.max_tokens;
  return Number.isInteger(n) && n > 0 ? { tokens: n, defaulted: false } : { tokens: DEFAULT_MAX_OUTPUT[provider] ?? 65_536, defaulted: true };
}

// Max completions per request the provider accepts; larger values are clamped
// to it (the provider would reject them) and flagged output_multiplier_clamped.
export const MAX_OUTPUT_MULTIPLIER = { openai: 128, openrouter: 128, gemini: 8, anthropic: 1 };

// OpenAI-compatible n / best_of (best_of bills every candidate, so the larger
// wins) and Gemini candidateCount multiply billed output tokens. A missing
// value is 1; an invalid one (non-integer, <= 0, non-number) is treated as 1
// and flagged output_multiplier_defaulted.
export function outputMultiplier(provider, req) {
  const raw = provider === "gemini"
    ? [req?.generationConfig?.candidateCount ?? req?.generation_config?.candidate_count]
    : provider === "anthropic" ? [] : [req?.n, req?.best_of];
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
export function estimateWorstCase(provider, body, path = "") {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  let req = {};
  try { req = JSON.parse(text) ?? {}; } catch { /* malformed body: model unknown */ }
  let model = typeof req.model === "string" ? req.model : undefined;
  if (!model && provider === "gemini") model = /models\/([^/:]+)/.exec(path)?.[1];
  const price = model ? lookupPrice(model) : null;
  if (!price || price.fallback || !Number.isFinite(price.input) || !Number.isFinite(price.output)) {
    return { ok: false, reason: "preflight_unpriced", model: model ?? "unknown" };
  }
  const input_tokens = Math.ceil(Buffer.byteLength(text, "utf8") / 4);
  // OpenAI embeddings bill input only (#145): no output allowance.
  const pathname = String(path ?? "").split(/[?#]/, 1)[0];
  const embeddings = provider === "openai" && pathname === "/v1/embeddings";
  const out = embeddings ? { tokens: 0, defaulted: false } : requestedOutputTokens(provider, req);
  const mult = outputMultiplier(provider, req);
  const output_tokens = out.tokens * mult.multiplier;
  const estimate_usd = Number(((input_tokens * price.input + output_tokens * price.output) / 1_000_000).toFixed(6));
  const flags = { ...(mult.defaulted && { output_multiplier_defaulted: true }), ...(mult.clamped && { output_multiplier_clamped: true }) };
  return { ok: true, model, input_tokens, output_tokens, output_multiplier: mult.multiplier, ...flags, output_defaulted: out.defaulted, estimate_usd, table_version: TABLE_VERSION, table_sha256: TABLE_SHA256 };
}

// Compares the estimate with the remaining run/day/month budget.
// Returns null when it fits, else the refusal detail. When `onFit` is given it
// receives the estimate of a call that fits (for the allowed-call receipt).
export function preflightCheck(cap, provider, body, path, onFit) {
  const est = estimateWorstCase(provider, body, path);
  if (!est.ok) return { reason: "preflight_unpriced", estimate: true, model: est.model };
  const remaining = cap?.remaining?.() ?? {};
  for (const scope of ["run", "day", "month"]) {
    if (remaining[scope] != null && est.estimate_usd > remaining[scope]) {
      return { reason: "preflight_estimate", estimate: true, scope, estimate_usd: est.estimate_usd, remaining_usd: remaining, model: est.model,
        input_tokens_est: est.input_tokens, output_tokens_est: est.output_tokens, output_multiplier: est.output_multiplier };
    }
  }
  onFit?.(est);
  return null;
}
