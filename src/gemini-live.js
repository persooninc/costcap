// #277: Gemini Live API (BidiGenerateContent WebSocket) helpers. Pure functions, Node built-ins only.
// Live usageMetadata uses responseTokenCount / responseTokensDetails (not the HTTP API's
// candidatesTokenCount), so it gets its own mapper. Counts are per turn (one usageMetadata per
// completed model turn), so each one is billed as its own receipt.
import { geminiModalitySlice } from "./proxy.js";

export const GEMINI_LIVE_PATH = /^\/gemini\/ws\/google\.ai\.generativelanguage\.(v1alpha|v1beta)\.GenerativeService\.(BidiGenerateContent|BidiGenerateContentConstrained)\/?$/;

const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** `setup.model` with any `models/` prefix stripped, or null. */
export function setupModel(msg) {
  const m = msg?.setup?.model;
  if (typeof m !== "string" || !m) return null;
  return m.replace(/^models\//, "") || null;
}

/** True for a client message that asks the model for a turn (input that will be billed). */
export const isTurnInput = (msg) => !!msg && typeof msg === "object" && ("realtimeInput" in msg || "clientContent" in msg || "toolResponse" in msg);

/**
 * Live UsageMetadata -> the proxy's usage shape, or null when the required counters are missing.
 * Input = promptTokenCount + toolUsePromptTokenCount (cached share split out); output =
 * responseTokenCount + thoughtsTokenCount (thinking billed as text output).
 */
export function geminiLiveUsage(u) {
  if (!u || typeof u !== "object" || !isCount(u.promptTokenCount) || !isCount(u.responseTokenCount)) return null;
  const tool = isCount(u.toolUsePromptTokenCount) ? u.toolUsePromptTokenCount : 0;
  const thoughts = isCount(u.thoughtsTokenCount) ? u.thoughtsTokenCount : 0;
  const cached = isCount(u.cachedContentTokenCount) ? Math.min(u.cachedContentTokenCount, u.promptTokenCount) : 0;
  const usage = { input_tokens: u.promptTokenCount + tool - cached, cached_input_tokens: cached, output_tokens: u.responseTokenCount + thoughts };
  const prompt = geminiModalitySlice(u.promptTokensDetails);
  const cachedSlice = geminiModalitySlice(u.cacheTokensDetails);
  const input = prompt ? Object.fromEntries(Object.keys(prompt).map((k) => [k, Math.max(0, prompt[k] - (cachedSlice?.[k] ?? 0))])) : null;
  if (input) input.text += tool;
  const output = geminiModalitySlice(u.responseTokensDetails);
  if (output) output.text += thoughts;
  const nonText = (s) => (s ? s.image + s.audio + s.video : 0);
  if (nonText(input) + nonText(cachedSlice) + nonText(output) > 0) usage.modality_tokens = { input, cached_input: cachedSlice, output };
  return usage;
}
