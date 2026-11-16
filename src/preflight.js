// Opt-in pre-flight budget estimate (CC-9). Off by default.
// Estimates a request's WORST-CASE cost before it is forwarded, so one large
// call cannot blow through a tight cap before post-call metering catches it.
// This is an estimate, not a tokenizer: input tokens are bounded by
// ceil(request bytes / 4); output tokens are the request's max-output field or,
// when absent, a conservative per-provider default maximum.
// An unknown model or a missing rate is refused (preflight_unpriced), never $0.

import { lookupPrice } from "./pricing.js";

// Used only when the request sets no max-output field.
export const DEFAULT_MAX_OUTPUT_TOKENS = { openai: 32_768, openrouter: 32_768, anthropic: 64_000, gemini: 65_536 };

const positiveInt = (v) => (Number.isInteger(v) && v > 0 ? v : undefined);

// body: raw request Buffer or string. path: provider-relative path (Gemini carries the model there).
export function estimateWorstCase(provider, body, path = "") {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  let json = {};
  try { json = JSON.parse(text) ?? {}; } catch { /* malformed body: no max field, model from path */ }
  let model = typeof json.model === "string" ? json.model : undefined;
  if (!model && provider === "gemini") model = /models\/([^/:?]+)/.exec(path)?.[1];
  let max;
  if (provider === "gemini") max = positiveInt(json.generationConfig?.maxOutputTokens);
  else if (provider === "openai" || provider === "openrouter") max = positiveInt(json.max_completion_tokens) ?? positiveInt(json.max_tokens) ?? positiveInt(json.max_output_tokens);
  else max = positiveInt(json.max_tokens);
  const output_tokens = max ?? DEFAULT_MAX_OUTPUT_TOKENS[provider] ?? 65_536;
  const input_tokens = Math.ceil(Buffer.byteLength(text, "utf8") / 4);
  return { model: model ?? "unknown", input_tokens, output_tokens, max_tokens_source: max ? "request" : "provider_default" };
}

// Returns { estimate_usd } or { unpriced: true } for unknown models / missing rates.
export function priceEstimate({ model, input_tokens, output_tokens }) {
  const price = lookupPrice(model);
  if (price.fallback || !Number.isFinite(price.input) || !Number.isFinite(price.output)) return { unpriced: true, model };
  const usd = (input_tokens * price.input + output_tokens * price.output) / 1_000_000;
  return { estimate_usd: Number(usd.toFixed(6)), table_version: price.table_version, model };
}

// cap: a cap engine with remaining(). Returns null when the call may proceed,
// else { reason, detail } describing the refusal.
export function preflightCheck({ provider, body, path, cap }) {
  const est = estimateWorstCase(provider, body, path);
  const priced = priceEstimate(est);
  const base = { estimate: true, model: est.model, estimate_input_tokens: est.input_tokens, estimate_output_tokens: est.output_tokens, max_tokens_source: est.max_tokens_source };
  if (priced.unpriced) return { reason: "preflight_unpriced", detail: { ...base, estimate_usd: null } };
  const remaining = cap?.remaining?.() ?? {};
  for (const scope of ["run", "day", "month"]) {
    if (remaining[scope] != null && priced.estimate_usd > remaining[scope]) {
      return { reason: "preflight_estimate", detail: { ...base, estimate_usd: priced.estimate_usd, table_version: priced.table_version, scope, remaining_usd: remaining } };
    }
  }
  return null;
}

export function preflightBody(reason, detail) {
  if (reason === "preflight_unpriced") {
    return { error: { type: "preflight_unpriced", reason, estimate: true, model: detail.model,
      message: `CostCap pre-flight: model "${detail.model}" has no published rate, so its worst case cannot be estimated. The upstream call was not made.` } };
  }
  return { error: { type: "budget_exceeded", reason, estimate: true, scope: detail.scope, estimate_usd: detail.estimate_usd, remaining_usd: detail.remaining_usd,
    message: `CostCap pre-flight: estimated worst case $${detail.estimate_usd} exceeds the remaining ${detail.scope} budget ($${detail.remaining_usd[detail.scope]}). This is an estimate. The upstream call was not made.` } };
}
