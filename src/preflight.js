// Opt-in pre-flight budget estimate (CC-9). Off by default. It is an ESTIMATE:
// input tokens are bounded by request bytes / 4 (UTF-8 bytes; typical
// tokenizers average about 4 bytes per English token, fewer for some scripts
// and code), and output tokens by the request's max-output field or a
// conservative provider default when absent. It prices at the model's
// published rate and never at the fallback: an unknown model is refused as
// preflight_unpriced.
import { lookupPrice, TABLE_VERSION } from "./pricing.js";

// Conservative default output ceilings when the request sets no limit.
export const DEFAULT_MAX_OUTPUT = { openai: 16_384, openrouter: 16_384, anthropic: 64_000, gemini: 65_536 };

export function requestedOutputTokens(provider, req) {
  const n = provider === "gemini"
    ? req?.generationConfig?.maxOutputTokens ?? req?.generation_config?.max_output_tokens
    : req?.max_completion_tokens ?? req?.max_output_tokens ?? req?.max_tokens;
  return Number.isInteger(n) && n > 0 ? { tokens: n, defaulted: false } : { tokens: DEFAULT_MAX_OUTPUT[provider] ?? 65_536, defaulted: true };
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
  const out = requestedOutputTokens(provider, req);
  const estimate_usd = Number(((input_tokens * price.input + out.tokens * price.output) / 1_000_000).toFixed(6));
  return { ok: true, model, input_tokens, output_tokens: out.tokens, output_defaulted: out.defaulted, estimate_usd, table_version: TABLE_VERSION };
}

// Compares the estimate with the remaining run/day/month budget.
// Returns null when it fits, else the refusal detail.
export function preflightCheck(cap, provider, body, path) {
  const est = estimateWorstCase(provider, body, path);
  if (!est.ok) return { reason: "preflight_unpriced", estimate: true, model: est.model };
  const remaining = cap?.remaining?.() ?? {};
  for (const scope of ["run", "day", "month"]) {
    if (remaining[scope] != null && est.estimate_usd > remaining[scope]) {
      return { reason: "preflight_estimate", estimate: true, scope, estimate_usd: est.estimate_usd, remaining_usd: remaining, model: est.model,
        input_tokens_est: est.input_tokens, output_tokens_est: est.output_tokens };
    }
  }
  return null;
}
