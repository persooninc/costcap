import { teamScope } from "./hosted/teams.js";
// Local, post-response metering. Only proxy-routed traffic is covered.
// Admission decisions are serialized per proxy, so the next decision sees prior usage.
// #249: with maxConcurrent N > 1, up to N admitted calls are forwarded at once; each
// decision still sees every completed receipt, and recording stays serialized (sync).
// A request already accepted by a provider can exceed the remaining budget: at most
// N in-flight calls per wrapper (N = 1 by default).
import http from "node:http";
import https from "node:https";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { receiptPath } from "./receipt-path.js";
import { mergeTags, parseTagHeader, TAG_HEADER } from "./tags.js";
import { randomUUID } from "node:crypto";
import { costForUsage, isPricedModel, lookupPrice, regionalMultiplier, vertexGeminiRegionalMultiplier, scalePrice, requestWebSearchType, pricingAt, googleSearchBilling, cacheStorageCost } from "./pricing.js";
import { budgetExceededBody, isLowerBound } from "./cap.js";
import { tagBudgetExceededBody } from "./tag-cap.js";
import { budgetRemaining } from "./agent-budget.js";
import { warningLine } from "./cap-warn.js";
import { modelBudgetExceededBody } from "./model-cap.js";
import { DOWNGRADE_HEADER, downgradeLine, downgradeRoute, rewriteModel } from "./downgrade.js";
import { createSpiralDetector } from "./spiral.js";
import { preflightCheck, checkEstimate, estimateBatch, openRouterModels } from "./preflight.js";
import { rateLimitedBody, usageTokens } from "./rate-limit.js";
import { anthropicBatchModels, batchCreateProvider, batchReadPath, foldBatchResults, geminiBatchId, geminiBatchOutput, geminiBatchRequests, isGeminiBatchFreeCall } from "./batch.js";
import { loadLedgerLines, isSettlement } from "./cap.js";
import { PENDING_STATUSES, TERMINAL_STATUSES, createResponsesStreamTracker, isResponsesCreate, requestsBackground, responseState, responsesReadPath } from "./background.js";
import { CACHE_HEADER, cacheKey, isCacheable, isStreamRequest } from "./response-cache.js";
import { costForUserPrices, isCustomProvider, userPrice } from "./upstreams.js";
import { cloudCostWithOverrides, costWithOverrides, effectivePrice, isPricedWithOverrides, withToolCost } from "./price-overrides.js";
import { bedrockBaseId, bedrockCost, bedrockPriceRow, bedrockRate, converseServiceTier, isBedrockThirdParty } from "./bedrock-pricing.js";
import { BEDROCK_UPSTREAM, VERTEX_UPSTREAM, bedrockHeaderUsage, bedrockHost, bedrockInvokeBodyUsage, classifyCloudRoute, converseUsage, invocationMetricsUsage, createEventStreamDecoder, isCloudProvider, mapCloudModel, vertexHost } from "./cloud.js";
import { REALTIME_PATH, closePayload, createFrameParser, encodeFrame, realtimeUsage, writeHttpJson } from "./realtime.js";
import { GEMINI_LIVE_PATH, geminiLiveUsage, isExplicitTurn, isTurnInput, setupModel } from "./gemini-live.js";
import { LIVE_PATH, backendResponse, createSnapshotMeter, durationCost, liveRate, sessionSeconds } from "./live.js";
import { audioRoute, audioUnitCost, parseMultipartFields } from "./audio.js";
import { awsCredentials, getHeader, isSigV4, signRequest, verifyRequest } from "./sigv4.js";

const PROVIDERS = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api",
  gemini: "https://generativelanguage.googleapis.com",
  // #188: the real host is derived per request (Bedrock region, Vertex path location).
  bedrock: BEDROCK_UPSTREAM,
  vertex: VERTEX_UPSTREAM,
};

const safeJson = (b) => { try { return JSON.parse(b.toString("utf8")); } catch { return null; } };

export function baseUrlOverrides(port, providers = Object.keys(PROVIDERS)) {
  const lines = [];
  if (providers.includes("openai")) {
    lines.push(`OPENAI_BASE_URL=http://127.0.0.1:${port}/openai/v1`);
    // #194: raw-socket Realtime clients (the Python SDK derives ws:// from OPENAI_BASE_URL).
    lines.push(`COSTCAP_OPENAI_REALTIME_URL=ws://127.0.0.1:${port}/openai/v1/realtime`);
    // #273: GPT-Live sessions (gpt-live-1) over WebSocket.
    lines.push(`COSTCAP_OPENAI_LIVE_URL=ws://127.0.0.1:${port}/openai/v1/live/sessions`);
  }
  if (providers.includes("anthropic")) lines.push(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port}/anthropic`);
  if (providers.includes("openrouter")) lines.push(`OPENROUTER_BASE_URL=http://127.0.0.1:${port}/openrouter`);
  if (providers.includes("gemini")) {
    // Google's SDKs (go-genai, @google/genai) and Gemini CLI read GOOGLE_GEMINI_BASE_URL;
    // GEMINI_BASE_URL is kept for backward compatibility.
    lines.push(`GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:${port}/gemini`);
    lines.push(`GEMINI_BASE_URL=http://127.0.0.1:${port}/gemini`);
    // #277: Gemini Live API (BidiGenerateContent) over WebSocket.
    lines.push(`COSTCAP_GEMINI_LIVE_URL=ws://127.0.0.1:${port}/gemini/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`);
  }
  // #188: read by Claude Code (CLAUDE_CODE_USE_BEDROCK / _VERTEX) and the Anthropic Bedrock/Vertex SDKs.
  if (providers.includes("bedrock")) lines.push(`ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:${port}/bedrock`);
  if (providers.includes("vertex")) {
    lines.push(`ANTHROPIC_VERTEX_BASE_URL=http://127.0.0.1:${port}/vertex/v1`);
    // #217: Google's genai SDKs read GOOGLE_VERTEX_BASE_URL in Vertex mode (Gemini on Vertex).
    lines.push(`GOOGLE_VERTEX_BASE_URL=http://127.0.0.1:${port}/vertex`);
  }
  return lines;
}

// #214: Responses output items billed per call, mapped to their pricing-table tool key.
const RESPONSES_TOOL_ITEMS = { web_search_call: "web_search", file_search_call: "file_search" };

// Free token-count endpoints (exact paths only). Checked against the raw request
// path so dot segments or percent-encoding can never reach the allowlist.
const COUNT_TOKENS_PATHS = [
  /^\/anthropic\/v1\/messages\/count_tokens$/,
  /^\/openai\/v1\/responses\/input_tokens$/,
  /^\/gemini\/v1(?:beta|alpha)?\/models\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*:countTokens$/,
];
export function isCountTokensPath(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  if (/%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname)) return false;
  return COUNT_TOKENS_PATHS.some((re) => re.test(pathname));
}

// Files API management (#158): upload and delete are free on Anthropic and OpenAI
// (https://platform.claude.com/docs/en/build-with-claude/files#usage-and-billing).
// Exact paths only, same hardening as count_tokens. GET is covered by the GET/HEAD rule.
// #233: Gemini Files API upload (incl. resumable chunks) and delete are free too, as are
// batch cancel/delete on all three providers (management calls that stop spend).
const FILES_UPLOAD_PATHS = [/^\/anthropic\/v1\/files$/, /^\/openai\/v1\/files$/, /^\/gemini\/upload\/v1(?:beta|alpha)?\/files$/,
  /^\/openai\/v1\/batches\/[A-Za-z0-9_-]+\/cancel$/, /^\/anthropic\/v1\/messages\/batches\/[A-Za-z0-9_-]+\/cancel$/,
  /^\/gemini\/v1(?:beta|alpha)?\/batches\/[A-Za-z0-9_-]+:cancel$/];
const FILES_DELETE_PATHS = [/^\/anthropic\/v1\/files\/[A-Za-z0-9_-]+$/, /^\/openai\/v1\/files\/[A-Za-z0-9_-]+$/,
  /^\/gemini\/v1(?:beta|alpha)?\/files\/[A-Za-z0-9_-]+$/, /^\/anthropic\/v1\/messages\/batches\/[A-Za-z0-9_-]+$/,
  /^\/gemini\/v1(?:beta|alpha)?\/batches\/[A-Za-z0-9_-]+$/, /^\/gemini\/v1(?:beta|alpha)?\/cachedContents\/[A-Za-z0-9_-]+$/];
export function isNonBillableFilesRequest(method, rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  if (/%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname)) return false;
  if (method === "POST") return FILES_UPLOAD_PATHS.some((re) => re.test(pathname));
  if (method === "DELETE") return FILES_DELETE_PATHS.some((re) => re.test(pathname));
  return false;
}

// #257: Gemini context caching. Create (POST) and TTL update (PATCH) bill storage; DELETE is free
// (FILES_DELETE_PATHS). Exact paths only, same hardening as count_tokens. Returns "create" | "patch" | null.
export function geminiCacheRoute(method, rawUrl) {
  if (typeof rawUrl !== "string") return null;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  if (/%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname)) return null;
  if (method === "POST" && /^\/gemini\/v1(?:beta|alpha)?\/cachedContents$/.test(pathname)) return "create";
  if (method === "PATCH" && /^\/gemini\/v1(?:beta|alpha)?\/cachedContents\/[A-Za-z0-9_-]+$/.test(pathname)) return "patch";
  return null;
}
const isGeminiCacheRead = (method, rawUrl) => method === "GET" && typeof rawUrl === "string"
  && /^\/gemini\/v1(?:beta|alpha)?\/cachedContents(?:\/[A-Za-z0-9_-]+)?$/.test(rawUrl.split(/[?#]/, 1)[0]);
const stripModelsPrefix = (m) => (typeof m === "string" ? m.replace(/^models\//, "") : m);

// OpenAI (#145) and OpenRouter (#202) embeddings: billed on input only. Exact path, same hardening as count_tokens.
export function isEmbeddingsPath(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  if (/%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname)) return false;
  return /^\/(?:openai|openrouter)\/v1\/embeddings$/.test(pathname) || GEMINI_EMBED_PATH.test(pathname);
}
// #275: OpenAI / OpenRouter image generations and edits: output tokens are image tokens.
export function isImagesPath(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  if (/%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname)) return false;
  return /^\/(?:openai|openrouter)\/v1\/images\/(?:generations|edits)$/.test(pathname);
}
// Gemini embeddings (#200): :embedContent / :batchEmbedContents, billed on input only.
const GEMINI_EMBED_PATH = /^\/gemini\/v1(?:beta|alpha)?\/models\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*:(?:embedContent|batchEmbedContents)$/;

const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

// #163: per-modality token breakdown. Totals are unchanged; the breakdown lets
// costForUsage price audio/image/video slices at their own rates (or mark them unknown).
const MODALITIES = ["image", "audio", "video"];
const emptySlice = () => ({ text: 0, image: 0, audio: 0, video: 0 });
// Gemini ModalityTokenCount[] -> { text, image, audio, video } (null when absent).
export function geminiModalitySlice(details) {
  if (!Array.isArray(details) || !details.length) return null;
  const out = emptySlice();
  for (const d of details) {
    const m = typeof d?.modality === "string" ? d.modality.toLowerCase() : "";
    if (Object.hasOwn(out, m) && isCount(d.tokenCount)) out[m] += d.tokenCount;
    else if (isCount(d?.tokenCount)) out.text += d.tokenCount; // DOCUMENT etc. bill as text
  }
  return out;
}
// OpenAI *_tokens_details -> slice of a known total (text = remainder), null when no non-text tokens reported.
export function openaiModalitySlice(details, total) {
  if (!details || typeof details !== "object") return null;
  const image = isCount(details.image_tokens) ? details.image_tokens : 0;
  const audio = isCount(details.audio_tokens) ? details.audio_tokens : 0;
  if (image + audio === 0) return null;
  return { text: Math.max(0, total - image - audio), image, audio, video: 0 };
}
const nonText = (slice) => (slice ? MODALITIES.reduce((n, m) => n + slice[m], 0) : 0);
// Keep the breakdown only when some bucket carries non-text tokens.
function modalityTokens(buckets) {
  if (!Object.values(buckets).some((b) => nonText(b) > 0)) return undefined;
  return Object.fromEntries(Object.entries(buckets).map(([k, b]) => [k, b ?? null]));
}

// #214/#254: Anthropic server_tool_use counters CostCap meters; any other counter is unpriced.
const ANTHROPIC_TOOL_COUNTERS = Object.freeze({ web_search_requests: "web_search", web_fetch_requests: "web_fetch", code_execution_requests: "code_execution" });

/**
 * #250: billed Grounding with Google Search units from Gemini groundingMetadata (one per candidate).
 * Per-query families (Gemini 3+) count unique non-empty webSearchQueries across candidates;
 * per-prompt families (Gemini 2.x) count 1 when any query ran. Never $0: web groundingChunks with
 * no webSearchQueries, any non-web grounding (Google Maps, enterprise web search, retrieval), or a
 * model family with no table row is { unpriced: true }.
 */
export function geminiGroundingCalls(metadatas, model) {
  const q = groundingQueries(metadatas);
  if (q.unpriced) return { unpriced: true };
  if (!q.queries) return q.webChunks ? { unpriced: true } : { unpriced: false, calls: 0 };
  const unit = googleSearchBilling(model);
  if (!unit) return { unpriced: true };
  return { unpriced: false, calls: unit === "query" ? q.queries : 1 };
}

// Unique non-empty webSearchQueries across candidates; { unpriced: true } on any non-web grounding.
function groundingQueries(metadatas) {
  const queries = new Set();
  let webChunks = false;
  for (const m of metadatas) {
    if (!m || typeof m !== "object") continue;
    if (Array.isArray(m.webSearchQueries)) for (const q of m.webSearchQueries) if (typeof q === "string" && q.trim()) queries.add(q);
    if (Array.isArray(m.groundingChunks)) for (const c of m.groundingChunks) {
      if (!c || typeof c !== "object") continue;
      const kinds = Object.keys(c);
      if (kinds.some((k) => k !== "web")) return { unpriced: true };
      if (c.web) webChunks = true;
    }
    if ((Array.isArray(m.retrievalQueries) && m.retrievalQueries.length) || m.googleMapsWidgetContextToken) return { unpriced: true };
  }
  return { unpriced: false, queries: queries.size, webChunks };
}

/**
 * #260: on the Gemini API, a request whose dated row is `billed_as` another model (e.g. gemini-2.5-pro
 * -> gemini-3.8-flash from 2026-12-01) bills grounding at that model's unit and rate. Vertex keeps its
 * own rows (#256), so cloud routes are returned unchanged.
 */
export function billedAsGrounding(provider, cloud, receipt, metered) {
  if (cloud || provider !== "gemini" || !receipt?.billed_as || !metered?.groundingQueries || !metered.toolCalls?.google_search) return metered;
  const unit = googleSearchBilling(receipt.billed_as);
  if (!unit) return metered;
  return { ...metered, model: receipt.billed_as, toolCalls: { ...metered.toolCalls, google_search: unit === "query" ? metered.groundingQueries : 1 } };
}

/**
 * #262: the Gemini tier a call was served at. Priority when Vertex reports trafficType
 * ON_DEMAND_PRIORITY, when the Gemini API x-gemini-service-tier header says "priority", or when the
 * request asked for service_tier "priority" and the header does not say "standard" (a missing
 * header counts as Priority). A header of "standard" is a downgrade: standard rates, with
 * requested_service_tier recorded. Returns usage with service_tier set (or unchanged).
 */
export function geminiServedTier(usage, requestBody, header, { vertex = false } = {}) {
  if (!usage || typeof usage !== "object") return usage;
  const out = { ...usage };
  delete out.service_tier;
  if (vertex) {
    if (out.traffic_type === "ON_DEMAND_PRIORITY") out.service_tier = "priority";
    return out;
  }
  const req = requestBody && typeof requestBody === "object" ? requestBody.service_tier ?? requestBody.serviceTier : undefined;
  const requested = typeof req === "string" ? req.toLowerCase() : null;
  const served = typeof header === "string" ? header.trim().toLowerCase() : null;
  if (served === "priority" || (requested === "priority" && served !== "standard")) out.service_tier = "priority";
  else if (requested === "priority") out.requested_service_tier = "priority";
  return out;
}

// Folds provider usage shapes from parsed JSON chunks (whole body or SSE events).
export function createUsageAccumulator(provider, requestedModel, { embeddings = false, images = false } = {}) {
  let model = requestedModel ?? "unknown";
  let usage = {};
  const signal = {};
  // OpenAI Responses API streams nest model/usage under `response` and end with
  // a terminal event (response.completed / response.incomplete / response.failed).
  let responsesStream = false, responsesTerminal = false;
  // #166: Anthropic streams carry placeholder usage on message_start; only message_stop (with no
  // prior `error` event) means message_delta's final usage was seen. Gemini streams send cumulative
  // usageMetadata on every chunk; only a candidate finishReason (or a prompt block) ends them.
  let anthropicStream = false, anthropicStopped = false, anthropicErrored = false;
  let geminiStream = false, geminiFinished = false;
  // Provider-side tools billed per request/call have no published rate in the table: never priced as $0.
  let toolUseUnpriced = false;
  // #214: per-call tool counts priced from the table's `tools` section (Responses items by id; Anthropic counters).
  const responsesTools = new Map();
  let anthropicTools = {};
  // #250: Gemini candidates[].groundingMetadata by candidate index (Grounding with Google Search).
  const grounding = new Map();
  let groundingUnpriced = false;
  // #275: Gemini candidates counted without candidatesTokensDetails (modality unknown).
  let geminiUndetailed = null;
  // OpenRouter only (#148): the provider-reported usage.cost (USD) is the exact charge for any routed model.
  // Absent/invalid values are ignored so pricing falls back to the table; it is never trusted on other routes.
  let providerCost;
  // #269: Responses image_generation_call items by id (latest status wins). The image tool's
  // usage has no verified field, so a non-failed call makes the receipt tool_use_unpriced, never text-only.
  const imageCalls = new Map();
  const noteResponsesItems = (items) => {
    if (!Array.isArray(items)) return;
    items.forEach((it, i) => {
      if (it && it.type === "image_generation_call") imageCalls.set(typeof it.id === "string" && it.id ? it.id : `#${items.length}:${i}`, it.status);
      const tool = it && Object.hasOwn(RESPONSES_TOOL_ITEMS, it.type) ? RESPONSES_TOOL_ITEMS[it.type] : null;
      if (!tool) return;
      // A failed tool call is not billed; items are de-duplicated by id across stream events.
      if (it.status === "failed") return;
      responsesTools.set(typeof it.id === "string" && it.id ? it.id : `#${items.length}:${i}`, tool);
    });
  };
  const add = (chunk) => {
    if (!chunk || typeof chunk !== "object") return;
    if (provider !== "anthropic" && provider !== "gemini") {
      noteResponsesItems(chunk.output);
      if (chunk.item && typeof chunk.item.id === "string") noteResponsesItems([chunk.item]);
    }
    if (provider !== "anthropic" && provider !== "gemini" && typeof chunk.type === "string" && chunk.type.startsWith("response.")) {
      responsesStream = true;
      if (/^response\.(completed|incomplete|failed)$/.test(chunk.type)) responsesTerminal = true;
      if (chunk.response && typeof chunk.response === "object") { chunk = chunk.response; noteResponsesItems(chunk.output); }
      else return;
    }
    if (chunk.model || chunk.modelVersion || chunk.message?.model) model = chunk.model ?? chunk.modelVersion ?? chunk.message.model;
    if (provider === "anthropic" && typeof chunk.type === "string") {
      if (chunk.type === "message_start") anthropicStream = true;
      else if (chunk.type === "message_stop") anthropicStopped = true;
      else if (chunk.type === "error" && anthropicStream && !anthropicStopped) anthropicErrored = true;
    }
    if (provider === "gemini" && Array.isArray(chunk.candidates)) {
      geminiStream = true;
      // #250: streams repeat or update groundingMetadata; the last one seen per candidate wins.
      chunk.candidates.forEach((c, i) => {
        if (c && c.groundingMetadata && typeof c.groundingMetadata === "object") grounding.set(Number.isInteger(c.index) ? c.index : i, c.groundingMetadata);
      });
      if (chunk.candidates.some((c) => c && typeof c.finishReason === "string")) geminiFinished = true;
    }
    if (provider === "gemini" && chunk.promptFeedback?.blockReason) geminiFinished = true;
    if (provider === "gemini" && embeddings) {
      // #200: embed responses carry only promptTokenCount (+ promptTokenDetails); anything else is unknown.
      const u = chunk.usageMetadata;
      if (!u || !isCount(u.promptTokenCount)) { usage = { unpriceable: NaN }; return; }
      usage = { input_tokens: u.promptTokenCount, output_tokens: 0, cached_input_tokens: 0 };
      const input = geminiModalitySlice(u.promptTokenDetails ?? u.promptTokensDetails);
      const mt = modalityTokens({ input, cached_input: null, output: null });
      if (mt) usage.modality_tokens = mt;
      return;
    }
    if (provider === "gemini") {
      const u = chunk.usageMetadata;
      // #262: Vertex reports the served tier as usageMetadata.trafficType (ON_DEMAND_PRIORITY = Priority PayGo).
      if (typeof u?.trafficType === "string") signal.traffic_type = u.trafficType;
      // Known only with both required counters; {} or partial shapes are unpriceable (never $0).
      if (u && !(isCount(u.promptTokenCount) && isCount(u.candidatesTokenCount))) usage = { unpriceable: NaN };
      // toolUsePromptTokenCount (tool results fed back to the model) is billed as input.
      else if (u) usage = { input_tokens: (u.promptTokenCount ?? 0) + (isCount(u.toolUsePromptTokenCount) ? u.toolUsePromptTokenCount : 0) - (u.cachedContentTokenCount ?? 0),
        cached_input_tokens: u.cachedContentTokenCount ?? 0,
        output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
      if (u && usage.input_tokens !== undefined) {
        // promptTokensDetails includes cached tokens; cacheTokensDetails is the cached share.
        const prompt = geminiModalitySlice(u.promptTokensDetails);
        const cached = geminiModalitySlice(u.cacheTokensDetails);
        const input = prompt ? Object.fromEntries(Object.keys(prompt).map((k) => [k, Math.max(0, prompt[k] - (cached?.[k] ?? 0))])) : null;
        if (input && isCount(u.toolUsePromptTokenCount)) input.text += u.toolUsePromptTokenCount;
        const output = geminiModalitySlice(u.candidatesTokensDetails);
        if (output && isCount(u.thoughtsTokenCount)) output.text += u.thoughtsTokenCount;
        geminiUndetailed = !output && u.candidatesTokenCount > 0
          ? { input, cached_input: cached, candidates: u.candidatesTokenCount, thoughts: isCount(u.thoughtsTokenCount) ? u.thoughtsTokenCount : 0 } : null;
        const mt = modalityTokens({ input, cached_input: cached, output });
        if (mt) usage.modality_tokens = mt;
      }
    } else if (provider === "anthropic") {
      // message_start contains input usage; message_delta carries final output.
      const u = chunk.usage ?? chunk.message?.usage;
      if (u) {
        const stu = u.server_tool_use;
        if (stu && typeof stu === "object") {
          // Counters are cumulative per message (message_delta repeats them); the latest wins.
          const next = {};
          for (const [k, v] of Object.entries(stu)) {
            if (!k.endsWith("_requests") || typeof v !== "number" || !(v > 0)) continue;
            const key = Number.isInteger(v) ? ANTHROPIC_TOOL_COUNTERS[k] : undefined;
            if (key) next[key] = v; // #254: web_fetch / code_execution are priced (or refused) by the table
            else toolUseUnpriced = true; // an unknown per-call tool (or a non-integer count) is never $0
          }
          anthropicTools = next;
        }
        if (u.input_tokens != null) usage.input_tokens = u.input_tokens;
        if (u.cache_creation_input_tokens != null) {
          // Without the 5m/1h breakdown every write is priced at the 5-minute rate.
          const longLived = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          usage.cache_write_input_tokens = u.cache_creation_input_tokens - longLived;
          usage.cache_write_1h_input_tokens = longLived;
        }
        if (u.output_tokens != null) usage.output_tokens = u.output_tokens;
        if (u.cache_read_input_tokens != null) usage.cached_input_tokens = u.cache_read_input_tokens;
        // Fast mode (#155): usage.speed may arrive on message_start or message_delta.
        if (typeof u.speed === "string") signal.speed = u.speed;
      }
    } else {
      const u = chunk.usage;
      // Priority processing (#155): top-level service_tier on chat bodies, stream chunks and Responses objects.
      if (typeof chunk.service_tier === "string") signal.service_tier = chunk.service_tier;
      if (provider === "openrouter" && u && typeof u === "object") {
        providerCost = typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : undefined;
      }
      if (embeddings && (provider === "openai" || provider === "openrouter")) {
        // Embeddings carry only prompt_tokens (input-only billing); anything else is unknown.
        usage = u && isCount(u.prompt_tokens) && u.completion_tokens == null ? { input_tokens: u.prompt_tokens, output_tokens: 0, cached_input_tokens: 0 } : { unpriceable: NaN };
        return;
      }
      // Both prompt/input and completion/output counters are required; duration-billed or empty shapes are unknown.
      if (u && !(isCount(u.prompt_tokens ?? u.input_tokens) && isCount(u.completion_tokens ?? u.output_tokens))) usage = { unpriceable: NaN };
      else if (u) usage = openaiTextUsage(u);
      if (u && usage.input_tokens !== undefined) {
        // #198: transcription usage spells it input_token_details.
        const inDetails = u.prompt_tokens_details ?? u.input_tokens_details ?? u.input_token_details;
        const cachedDetails = inDetails?.cached_tokens_details;
        const cached = openaiModalitySlice(cachedDetails, usage.cached_input_tokens);
        const all = openaiModalitySlice(inDetails, usage.input_tokens + usage.cached_input_tokens + (usage.cache_write_input_tokens ?? 0) + (usage.cache_write_1h_input_tokens ?? 0));
        const input = all ? Object.fromEntries(Object.keys(all).map((k) => [k, Math.max(0, all[k] - (cached?.[k] ?? (k === "text" ? usage.cached_input_tokens : 0)))])) : null;
        let output = openaiModalitySlice(u.completion_tokens_details ?? u.output_tokens_details, usage.output_tokens);
        // #275: /v1/images/{generations,edits} output is image tokens even without output_tokens_details,
        // so an unlisted image model is modality_unpriced, never text-priced at the fallback.
        if (images && !output && usage.output_tokens > 0) output = { ...emptySlice(), image: usage.output_tokens };
        const mt = modalityTokens({ input, cached_input: cached, output });
        if (mt) usage.modality_tokens = mt;
      }
    }
  };
  const result = () => {
    if (!Object.keys(usage).length) return null;
    // Anthropic: input and output counters are both required (e.g. a stream missing message_start is unknown).
    if (provider === "anthropic" && !(isCount(usage.input_tokens) && isCount(usage.output_tokens))) return null;
    for (const [k, value] of Object.entries(usage)) if (k !== "modality_tokens" && (!Number.isFinite(value) || value < 0)) return null;
    // #275: on a row with an image output rate, candidates of unknown modality are priced as image
    // output (thoughts stay text), never at the text output rate.
    if (provider === "gemini" && geminiUndetailed) {
      const p = lookupPrice(model);
      if (!p.fallback && Number.isFinite(p.modalities?.image?.output)) {
        const g = geminiUndetailed;
        usage = { ...usage, modality_tokens: modalityTokens({ input: g.input, cached_input: g.cached_input, output: { ...emptySlice(), text: g.thoughts, image: g.candidates } }) };
      }
    }
    const toolCalls = provider === "anthropic" ? { ...anthropicTools } : {};
    for (const tool of responsesTools.values()) toolCalls[tool] = (toolCalls[tool] ?? 0) + 1;
    const imageUnpriced = [...imageCalls.values()].some((st) => st !== "failed");
    if (imageUnpriced) toolUseUnpriced = true;
    let queryCount = 0;
    if (provider === "gemini" && grounding.size) {
      const g = geminiGroundingCalls([...grounding.values()], model);
      if (g.unpriced) toolUseUnpriced = groundingUnpriced = true;
      else if (g.calls > 0) { toolCalls.google_search = g.calls; queryCount = groundingQueries([...grounding.values()]).queries; }
    }
    return { ...(groundingUnpriced && { unpricedTool: "Gemini grounding" }), ...(imageUnpriced && !groundingUnpriced && { unpricedTool: "Responses image_generation" }), model, usage: { ...usage, ...signal }, ...(Object.keys(toolCalls).length && { toolCalls }), ...(queryCount && { groundingQueries: queryCount }), ...(toolUseUnpriced && { toolUseUnpriced: true }), ...(providerCost !== undefined && { providerCost }) };
  };
  // A stream that never reached its provider's terminal event (or errored first) is incomplete.
  return { add, result, get incomplete() {
    return (responsesStream && !responsesTerminal) || (anthropicStream && (!anthropicStopped || anthropicErrored))
      || (geminiStream && !geminiFinished);
  } };
}

// #232: OpenAI prompt-cache writes. input_tokens_details / prompt_tokens_details carry
// cache_write_tokens with an optional cache_write_tokens_details { ttl_30m_tokens, ttl_12h_tokens }.
// 30m -> cache_write_input_tokens, 12h -> cache_write_1h_input_tokens; no breakdown -> all 30m.
// A breakdown that does not sum, or cached + writes over the total, is unknown, never guessed.
const PROVIDER_COST_SETTLES = new Set(["cache_write_unpriced", "long_context_cache_write_unpriced", "service_tier_unpriced", "modality_unpriced", "user_price_unpriced"]);

export function openaiTextUsage(u) {
  const total = u.prompt_tokens ?? u.input_tokens ?? 0;
  const d = u.prompt_tokens_details ?? u.input_tokens_details ?? u.input_token_details;
  const cached = d?.cached_tokens ?? 0;
  const out = { output_tokens: u.completion_tokens ?? u.output_tokens ?? 0, cached_input_tokens: cached };
  const writes = d?.cache_write_tokens;
  if (writes == null) return { input_tokens: total - cached, ...out };
  const bd = d.cache_write_tokens_details;
  let w30 = writes, w12 = 0;
  if (bd != null) {
    w30 = bd.ttl_30m_tokens ?? 0; w12 = bd.ttl_12h_tokens ?? 0;
    if (!isCount(w30) || !isCount(w12) || w30 + w12 !== writes) return { unpriceable: NaN };
  }
  if (!isCount(writes) || cached + writes > total) return { unpriceable: NaN };
  return { input_tokens: total - cached - writes, ...out, cache_write_input_tokens: w30, cache_write_1h_input_tokens: w12 };
}

export function extractUsage(provider, text, requestedModel, opts = {}) {
  let chunks;
  try { const parsed = JSON.parse(text); chunks = Array.isArray(parsed) ? parsed : [parsed]; }
  catch {
    const parser = createSseUsageParser(provider, requestedModel, opts);
    parser.push(text);
    return parser.end();
  }
  const acc = createUsageAccumulator(provider, requestedModel, opts);
  for (const chunk of chunks) acc.add(chunk);
  return acc.result();
}

// Incremental SSE parser: accepts arbitrary text fragments (lines may be split
// across network chunks), joins multi-line `data:` fields per event, and
// ignores `[DONE]` and non-JSON payloads.
export function createSseUsageParser(provider, requestedModel, opts = {}) {
  const acc = createUsageAccumulator(provider, requestedModel, opts);
  let pending = "";
  let data = [];
  let done = false;
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join("\n");
    data = [];
    if (payload.trim() === "[DONE]") { done = true; return; }
    try { acc.add(JSON.parse(payload)); } catch { /* non-JSON event data is passed through unmetered */ }
  };
  const line = (raw) => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text === "") return dispatch();
    if (!text.startsWith("data:")) return;
    const value = text.slice(5);
    // Lenient: some providers/fixtures omit the blank line between events, so a
    // new data line after an already-complete JSON payload starts a new event.
    if (data.length) { try { JSON.parse(data.join("\n")); dispatch(); } catch { if (data.join("\n").trim() === "[DONE]") dispatch(); } }
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  };
  return {
    push(fragment) {
      pending += fragment;
      let i;
      while ((i = pending.indexOf("\n")) !== -1) { line(pending.slice(0, i)); pending = pending.slice(i + 1); }
    },
    end() { if (pending) { line(pending); pending = ""; } dispatch(); return acc.result(); },
    usage: () => acc.result(),
    get incomplete() { return acc.incomplete; },
    get done() { return done; },
  };
}

// #188: Bedrock eventstream -> Anthropic usage accumulator. A bad CRC, an exception frame or
// trailing partial bytes make the stream incomplete (never priced).
export function createEventStreamUsageParser(requestedModel) {
  const acc = createUsageAccumulator("anthropic", requestedModel);
  const decoder = createEventStreamDecoder((event) => acc.add(event));
  return {
    push(bytes) { decoder.push(bytes); },
    end() { return acc.result(); },
    get incomplete() { return decoder.corrupt || decoder.partial || acc.incomplete || !acc.result(); },
  };
}

// #216: ConverseStream -> usage. Only the final `metadata` event carries usage; a stream
// cut before it (or with a bad frame / exception) is incomplete, never $0.
export function createConverseStreamUsageParser(requestedModel) {
  const acc = createUsageAccumulator("anthropic", requestedModel);
  let seen = false, bad = false;
  const decoder = createEventStreamDecoder((event, type) => {
    if (type !== "metadata") return;
    const u = converseUsage(event?.usage);
    if (!u) { bad = true; return; }
    seen = true;
    acc.add({ usage: u });
  }, { converse: true });
  return {
    push(bytes) { decoder.push(bytes); },
    end() { return seen && !bad ? acc.result() : null; },
    get incomplete() { return decoder.corrupt || decoder.partial || !seen || bad || !acc.result(); },
  };
}

/** #216: a non-stream Converse response's usage, in the accumulator's result shape. */
export function extractConverseUsage(text, requestedModel) {
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  const u = converseUsage(body?.usage);
  if (!u) return null;
  const acc = createUsageAccumulator("anthropic", requestedModel);
  acc.add({ usage: u });
  return acc.result();
}

/**
 * #288: a non-Anthropic Bedrock InvokeModel response. Native body usage first, else the
 * X-Amzn-Bedrock token-count headers; neither is null (usage_unavailable).
 */
export function extractBedrockInvokeUsage(text, headers, requestedModel) {
  let body = null;
  try { body = JSON.parse(text); } catch { /* fall through to headers */ }
  const u = bedrockInvokeBodyUsage(body) ?? bedrockHeaderUsage(headers);
  if (!u) return null;
  const acc = createUsageAccumulator("anthropic", requestedModel);
  acc.add({ usage: u });
  return acc.result();
}

/** #288: invoke-with-response-stream for a non-Anthropic model, priced from the final chunk's invocationMetrics. */
export function createBedrockInvokeStreamUsageParser(requestedModel) {
  const acc = createUsageAccumulator("anthropic", requestedModel);
  let seen = false, bad = false;
  const decoder = createEventStreamDecoder((event) => {
    const m = event?.["amazon-bedrock-invocationMetrics"];
    if (m === undefined) return;
    const u = invocationMetricsUsage(m);
    if (!u || seen) { bad = true; return; }
    seen = true;
    acc.add({ usage: u });
  });
  return {
    push(bytes) { decoder.push(bytes); },
    end() { return seen && !bad ? acc.result() : null; },
    get incomplete() { return decoder.corrupt || decoder.partial || !seen || bad || !acc.result(); },
  };
}

// Bedrock/Vertex errors are {message} or {error:{...}} objects with no usage.
export function isCloudError(raw) {
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return false; }
  if (Array.isArray(body) && body.length === 1) body = body[0];
  return Boolean(body) && typeof body === "object" && !Array.isArray(body) && !body.usage && (typeof body.message === "string" || typeof body.Message === "string" || (body.error && typeof body.error === "object"));
}

const REJECTED_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422, 429]);

/**
 * #190: a custom upstream's 404 for an unserved route (vLLM/FastAPI `{"detail":"Not Found"}`, a
 * plain-text or HTML page) generated nothing. Any body that mentions usage stays unknown.
 */
export function isRouteNotFound(raw) {
  const text = raw.toString("utf8");
  try {
    const body = JSON.parse(text);
    return !!body && typeof body === "object" && !Array.isArray(body) && !Object.hasOwn(body, "usage") && !Object.hasOwn(body, "usageMetadata");
  } catch { return !/usage/i.test(text); }
}

/** True when a body is a provider error object ({error:{...}}, Gemini may wrap it in an array) with no usage. */
export function isProviderError(raw) {
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return false; }
  if (Array.isArray(body) && body.length === 1) body = body[0];
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body.usage || body.usageMetadata) return false;
  return Boolean(body.error) && typeof body.error === "object";
}

// #154: SDK-matching defaults. timeoutMs bounds time to the response headers (and a
// non-streamed body); streamIdleMs bounds the gap between SSE chunks, not total length.
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000;
export const DEFAULT_STREAM_IDLE_MS = 300_000;
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

const CHAT_STREAM_PROVIDERS = new Set(["openai", "openrouter"]);

// #152: OpenAI-compatible chat streams carry no usage unless stream_options.include_usage is set.
// Returns the rewritten body when costcap had to inject it, else null (forward byte-identical).
export function injectStreamUsage(provider, method, pathname, body) {
  if (!(CHAT_STREAM_PROVIDERS.has(provider) || isCustomProvider(provider)) || method !== "POST" || !/\/chat\/completions\/?$/.test(pathname)) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.stream !== true) return null;
  const opts = parsed.stream_options;
  if (opts && typeof opts === "object" && !Array.isArray(opts) && opts.include_usage === true) return null;
  if (opts !== undefined && opts !== null && (typeof opts !== "object" || Array.isArray(opts))) return null;
  parsed.stream_options = { ...(opts ?? {}), include_usage: true };
  return Buffer.from(JSON.stringify(parsed));
}

// Drops the usage-only chunk (choices: [] plus usage) that only exists because costcap asked for it.
export function createUsageChunkFilter() {
  let buf = "";
  const keep = (event) => {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return true;
    try {
      const j = JSON.parse(data);
      return !(j && Array.isArray(j.choices) && j.choices.length === 0 && j.usage);
    } catch { return true; }
  };
  return {
    push(text) {
      buf += text;
      let out = "";
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const event = buf.slice(0, m.index + m[0].length);
        buf = buf.slice(m.index + m[0].length);
        if (keep(event)) out += event;
      }
      return out;
    },
    end() { const rest = buf; buf = ""; return rest && keep(rest) ? rest : ""; },
  };
}

function batchIdOf(raw) {
  try {
    const b = JSON.parse(raw.toString("utf8"));
    if (typeof b?.id === "string" && /^[A-Za-z0-9_-]+$/.test(b.id)) return b.id;
    // #230: a Gemini batch create returns an Operation named "batches/<id>".
    return geminiBatchId(b);
  } catch { return null; }
}

// #249: subtract in-flight preflight worst cases from an agent's remaining budgets.
function reserveLeft(left, reserved) {
  if (!left || !reserved) return left;
  const out = { ...left };
  for (const k of ["run_usd", "hour_usd", "day_usd", "week_usd", "month_usd"]) if (typeof out[k] === "number") out[k] = Number(Math.max(out[k] - reserved, 0).toFixed(6));
  return out;
}

export function createMeteringProxy({ receiptsPath, upstreams = PROVIDERS, onReceipt, cap,
  spiral = createSpiralDetector(), velocity, allowedModels, unknownModels = "fallback", killCheck, who = {}, agentBudgets, teamCheck, sharedLedger, capWarner, onWarning = (line) => console.error(line), preflight = false, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, streamIdleMs = DEFAULT_STREAM_IDLE_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, tags: wrapperTags = null, cache = null, customUpstreams = {}, userPrices = null, cloudEnv = process.env, tagCaps = null, modelCaps = null, rateLimit = null, fleetRemaining = null, downgrader = null, maxConcurrent = 1, now, liveTickMs = 1000, liveCloseWaitMs = 5000 } = {}) {
  // #237: the COSTCAP_PRICING_CLOCK pin applies only when the caller did not inject a clock.
  const pinPrices = now === undefined;
  if (now === undefined) now = Date.now;
  if (receiptsPath) mkdirSync(dirname(receiptsPath), { recursive: true });
  let queue = Promise.resolve();
  // #249: concurrency slots. A number or a getter (fleet sync can lower it live).
  const concurrency = () => { const n = typeof maxConcurrent === "function" ? maxConcurrent() : maxConcurrent; return Number.isInteger(n) && n > 1 ? n : 1; };
  let inFlight = 0;
  const inFlightEstimates = new Map(); // token -> preflight estimate_usd of an in-flight call
  let slotWaiter = null;
  // #255: re-check periodically so a raised ceiling admits queued calls without a release.
  const acquireSlot = async () => {
    while (inFlight >= concurrency()) {
      await new Promise((resolve) => { slotWaiter = resolve; const t = setTimeout(resolve, 25); t.unref?.(); });
    }
  };
  const releaseSlot = () => { const w = slotWaiter; slotWaiter = null; w?.(); };
  const reservedUsd = () => { let t = 0; for (const v of inFlightEstimates.values()) t += v.est; return t; };
  // #255: in-flight reservations for one tag-cap or model-cap remaining entry.
  const reservedTag = (x) => {
    let t = 0;
    for (const v of inFlightEstimates.values()) if (tagCaps?.remaining?.(v.tags)?.some((y) => y.tag_key === x.tag_key && y.tag_value === x.tag_value && y.scope === x.scope)) t += v.est;
    return t;
  };
  const reservedModel = (x) => { let t = 0; for (const v of inFlightEstimates.values()) if (v.models.includes(x.model)) t += v.est; return t; };
  // #171: unknown-cost failures keyed by the receipt id that caused them; a settlement
  // of that receipt clears it. Failures with no receipt (ledger/persistence) never clear.
  const failures = new Map();
  let hardFailure = null;
  const accountingFailureNow = () => hardFailure ?? (failures.size ? failures.values().next().value : null);
  // Shared ledger (CC-5): decide and append inside the cross-process critical section.
  // Reentrant: emit() inside an already-guarded decision reuses the held section.
  let held = false;
  const guarded = (fn) => {
    if (!sharedLedger || held) return fn();
    return sharedLedger.withLock(() => { held = true; try { return fn(); } finally { held = false; } });
  };
  const emitBase = (receipt, startMs) => guarded(() => {
    const complete = { id: randomUUID(), ts: new Date(now()).toISOString(), ...who, ...receipt };
    agentBudgets?.record(complete);
    tagCaps?.record(complete);
    modelCaps?.record(complete);
    // Persist before invoking integrations. Callback failures must not break metering.
    if (receiptsPath) appendFileSync(receiptsPath, JSON.stringify(complete) + "\n", { mode: 0o600 });
    sharedLedger?.track?.(complete);
    // #239: request-arrival time is passed in memory only (span start); the ledger shape is unchanged.
    try { Promise.resolve(onReceipt?.(complete, { startMs })).catch(() => {}); } catch { /* delivery is outside the local ledger */ }
    return complete;
  });
  // Batch state (#160): pending batch_id -> receipt, OpenAI output_file_id -> batch_id.
  const pendingBatches = new Map();
  const batchFiles = new Map();
  const resolvedBatches = new Set();
  const findPending = (batchId) => {
    if (pendingBatches.has(batchId)) return pendingBatches.get(batchId);
    if (!receiptsPath) return null;
    // After a restart, the pending receipt (and any settlement) is read back from the ledger.
    let lines;
    try { lines = loadLedgerLines(receiptsPath); } catch { return null; }
    const r = lines.find((l) => !l.event && l.reason === "batch_pending" && l.batch_id === batchId && l.cost_usd === null);
    if (!r) return null;
    const entry = { id: r.id, ts: r.ts, provider: r.provider, batch_id: batchId, run_id: r.run_id ?? null, model: r.model ?? null };
    pendingBatches.set(batchId, entry);
    if (lines.some((l) => isSettlement(l) && l.receipt_id === r.id)) resolvedBatches.add(batchId);
    return entry;
  };
  // #196: pending background Responses, response_id -> receipt; restart reads the ledger.
  const pendingBackground = new Map();
  const resolvedBackground = new Set();
  const findPendingBackground = (responseId) => {
    if (pendingBackground.has(responseId)) return pendingBackground.get(responseId);
    if (!receiptsPath) return null;
    let lines;
    try { lines = loadLedgerLines(receiptsPath); } catch { return null; }
    const r = lines.find((l) => !l.event && l.reason === "background_pending" && l.response_id === responseId && l.cost_usd === null);
    if (!r) return null;
    const entry = { id: r.id, ts: r.ts, response_id: responseId, run_id: r.run_id ?? null, ...(r.web_search_type && { web_search_type: r.web_search_type }) };
    pendingBackground.set(responseId, entry);
    if (lines.some((l) => (isSettlement(l) || l.event === "background_unpriced") && l.receipt_id === r.id)) resolvedBackground.add(responseId);
    return entry;
  };
  const emitEvent = (event) => guarded(() => {
    const complete = { ts: new Date(now()).toISOString(), ...event };
    if (receiptsPath) appendFileSync(receiptsPath, JSON.stringify(complete) + "\n", { mode: 0o600 });
    try { Promise.resolve(onReceipt?.(complete)).catch(() => {}); } catch { /* delivery is outside the local ledger */ }
    return complete;
  });
  // #164: record spend and queue one cap_warning per newly crossed fraction.
  // flushWarnings() appends them after the receipt that caused them.
  let pendingWarnings = [];
  const recordSpend = (receipt, opts) => {
    if (!cap) return;
    const before = cap.spend();
    cap.record(receipt, opts);
    if (!capWarner) return;
    const after = cap.spend();
    pendingWarnings.push(...capWarner.observe({ caps: cap.limits(), before, after, lowerBound: isLowerBound(after) }));
  };
  const flushWarnings = () => {
    const evs = pendingWarnings;
    pendingWarnings = [];
    for (const ev of evs) {
      const done = emitEvent(ev);
      try { onWarning(warningLine(done)); } catch { /* stderr is best effort */ }
    }
  };
  // #190: one stderr hint when a custom upstream's first response is a 404 (usually a missing /v1).
  const customFirstSeen = new Set();
  // #257: latest Gemini cachedContents expireTime (ms) this wrapper saw, by cache name.
  const cacheExpiry = new Map();
  const noteCacheExpiry = (c) => {
    const t = Date.parse(c?.expireTime);
    if (typeof c?.name === "string" && Number.isFinite(t)) cacheExpiry.set(c.name, Math.max(t, cacheExpiry.get(c.name) ?? -Infinity));
  };
  const server = http.createServer((req, res) => {
    // #236: an interactive call is priced at the instant the proxy received the request.
    const reqAt = now();
    const priceAt = pinPrices ? pricingAt(reqAt) : reqAt; // #237: the pinned pricing clock, if any
    const url = new URL(req.url, "http://localhost");
    let [, provider, ...rest] = url.pathname.split("/");
    let upstream = upstreams[provider];
    // #186: /u/<NAME>/<rest> -> custom upstream URL/<rest>, receipts record provider "u/<NAME>".
    const custom = provider === "u" && rest.length > 0;
    if (custom) {
      const name = rest.shift();
      upstream = Object.hasOwn(customUpstreams, name) ? customUpstreams[name] : undefined;
      provider = `u/${name}`;
    }
    // Custom upstreams price only from --upstream-prices, never the shipped table or fallback.
    // #189: built-in routes use per-model overrides/discounts from the same file when present.
    const priced = (m) => (custom ? userPrice(userPrices, provider, m) !== null : userPrices ? isPricedWithOverrides(userPrices, provider, m) : isPricedModel(m));
    const priceFor = custom ? (m) => { const r = userPrice(userPrices, provider, m); return r && { model: m, ...r, fallback: false }; }
      : userPrices ? (m) => effectivePrice(userPrices, provider, m, priceAt) : undefined;
    const send = (status, body, headers = {}) => { if (!res.writableEnded && !res.destroyed) res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body)); };
    if (!upstream || !rest.length) { send(404, { error: "unknown provider path" }); return; }
    // #188: Bedrock/Vertex serve only the Anthropic Messages routes. Anything else is answered
    // locally (never forwarded, never unmetered), including Claude Code's inference-profile probe.
    const cloud = isCloudProvider(provider);
    const rawPathname = req.url.split(/[?#]/, 1)[0];
    const cloudPath = cloud ? rawPathname.slice(provider.length + 1) : null;
    const cloudRoute = cloud ? classifyCloudRoute(provider, req.method, cloudPath) : null;
    if (cloud && !cloudRoute) {
      req.resume();
      send(404, { error: "cloud_route_unsupported", message: `CostCap meters only Claude Messages${provider === "vertex" ? " and Gemini generateContent / streamGenerateContent / countTokens" : " and Converse"} routes on ${provider}. The upstream call was not made.` });
      return;
    }
    // #169: x-costcap-tag is CostCap's, never the provider's. Wrapper tags win on a clash.
    let reqTags = null, tagError = null;
    try { reqTags = mergeTags(wrapperTags, parseTagHeader(req.headers[TAG_HEADER])); } catch (e) { tagError = e.message; }
    delete req.headers[TAG_HEADER];
    // #184: x-costcap-cache is CostCap's; never forwarded.
    const cacheBypass = String(req.headers[CACHE_HEADER] ?? "").toLowerCase() === "bypass";
    delete req.headers[CACHE_HEADER];
    const emit = (receipt) => emitBase(reqTags ? { ...receipt, tags: reqTags } : receipt, reqAt);
    if (tagError) {
      reqTags = wrapperTags && Object.keys(wrapperTags).length ? wrapperTags : null;
      req.resume();
      queue = queue.then(() => {
        emit({ provider, path: receiptPath(`/${rest.join("/")}`, url.search), blocked: false, status: 400, reason: "invalid_tags", cost_usd: 0 });
        send(400, { error: "invalid_tags", message: `CostCap: ${tagError}. The upstream call was not made.` });
      }).catch(() => { send(503, { error: "receipt_ledger_unavailable" }); });
      return;
    }
    const chunks = [];
    let size = 0, tooLarge = false;
    req.on("data", (chunk) => { size += chunk.length; if (size > maxBodyBytes) { tooLarge = true; chunks.length = 0; } else if (!tooLarge) chunks.push(chunk); });
    req.on("error", () => {});
    req.on("end", () => {
      if (tooLarge) {
        // #154: refused before forwarding, nothing billed. Recorded, never latched.
        queue = queue.then(() => {
          emit({ provider, path: receiptPath(`/${rest.join("/")}`, url.search), blocked: true, reason: "request_too_large", cost_usd: 0, bytes_limit: maxBodyBytes });
          send(413, { error: "request_too_large", bytes_limit: maxBodyBytes,
            message: `CostCap: request body is over the ${Number((maxBodyBytes / 1048576).toFixed(2))} MB proxy limit. Raise it with COSTCAP_MAX_REQUEST_MB. The upstream call was not made.` });
        }).catch(() => { send(503, { error: "receipt_ledger_unavailable" }); });
        return;
      }
      let body = Buffer.concat(chunks);
      const run = async () => {
        let failMsg = null;
        if (res.destroyed) return;
        const path = `/${rest.join("/")}${url.search}`;
        const storedPath = receiptPath(`/${rest.join("/")}`, url.search);
        const block = (reason, detail, response) => {
          emit({ provider, path: storedPath, blocked: true, reason, cost_usd: 0, ...detail });
          // #172: an hour-cap refusal says when enough spend ages out of the window.
          send(429, response, detail?.retry_after_s != null ? { "retry-after": String(detail.retry_after_s) } : {});
          return "blocked";
        };
        let requestedModel, parsedBody;
        try { parsedBody = JSON.parse(body); requestedModel = parsedBody?.model; } catch { /* provider handles malformed JSON */ }
        // #167: OpenRouter routes to `models` fallbacks, so every entry is a candidate.
        const routerModels = provider === "openrouter" && parsedBody && typeof parsedBody === "object" ? openRouterModels(parsedBody) : undefined;
        if (typeof requestedModel !== "string" || !requestedModel) requestedModel = undefined;
        if (!requestedModel && provider === "gemini") requestedModel = /models\/([^/:]+)/.exec(path)?.[1];
        // #257: a cachedContents create names its model as models/{id}; caps and receipts see {id}.
        const cacheOp = provider === "gemini" && !custom ? geminiCacheRoute(req.method, req.url) : null;
        if (cacheOp === "create") requestedModel = stripModelsPrefix(requestedModel) || undefined;
        // #198: transcriptions/translations are multipart; read only the model field (bounded).
        const audio = provider === "openai" ? audioRoute(req.method, req.url) : null;
        if (audio && audio !== "speech" && !requestedModel) {
          const mp = parseMultipartFields(body, getHeader(req.headers, "content-type"));
          if (mp?.duplicateModel) {
            emit({ provider, path: storedPath, blocked: true, reason: "invalid_model", outcome: "blocked_model", model: "unknown", cost_usd: 0 });
            send(400, { error: "invalid_model", model: null, message: "CostCap: the multipart body has more than one `model` part. The upstream call was not made." });
            return;
          }
          if (typeof mp?.fields.model === "string" && mp.fields.model) requestedModel = mp.fields.model;
        }
        // #188: cloud routes carry the model in the path (Vertex count-tokens: in the body).
        let cloudModel = null, providerModel = null;
        if (cloud) {
          providerModel = cloudRoute.modelId ?? requestedModel ?? null;
          cloudModel = mapCloudModel(provider, providerModel);
          requestedModel = cloudModel ?? providerModel ?? undefined;
        }
        // #188: SigV4 requests are verified with wrap's static credentials, then re-signed for the real host.
        let cloudAuth = null;
        if (provider === "bedrock") {
          const authz = getHeader(req.headers, "authorization");
          if (isSigV4(authz)) {
            const creds = awsCredentials(cloudEnv);
            if (!creds) {
              send(502, { error: "bedrock_credentials_unavailable", message: "CostCap re-signs Bedrock requests and needs AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN) in wrap's environment. Try: eval \"$(aws configure export-credentials --format env)\". The upstream call was not made." });
              return;
            }
            const v = verifyRequest({ method: req.method, path: rawPathname, search: url.search, headers: req.headers, body }, creds);
            if (!v.ok) { send(403, { error: "bedrock_signature_invalid", message: "CostCap could not verify this request's AWS signature against wrap's credentials. The upstream call was not made." }); return; }
            cloudAuth = { creds, region: v.region };
          } else {
            const region = cloudEnv.AWS_REGION || cloudEnv.AWS_DEFAULT_REGION;
            if (!region && upstream === BEDROCK_UPSTREAM) { send(502, { error: "bedrock_region_unavailable", message: "Set AWS_REGION for Bedrock. The upstream call was not made." }); return; }
            cloudAuth = { region };
          }
        }
        // #278: a non-Anthropic Bedrock model is priced from the request region's row (or a
        // --upstream-prices `bedrock` entry); without one it stays unmapped (cloud_model_unpriced).
        let bedrock3p = null;
        if (provider === "bedrock" && isBedrockThirdParty(providerModel)) {
          const baseId = bedrockBaseId(providerModel);
          const rate = baseId ? bedrockRate(userPrices, baseId, cloudAuth?.region) : null;
          bedrock3p = rate ? { baseId, rate } : null;
          cloudModel = rate ? baseId : null;
          requestedModel = cloudModel ?? providerModel ?? undefined;
        }
        const batchCreate = batchCreateProvider(req.method, req.url);
        // #160: an Anthropic batch names its models per request; every one is checked.
        const batchModels = batchCreate === "anthropic" ? anthropicBatchModels(body) : null;
        if (batchModels && !requestedModel) requestedModel = batchModels.find(Boolean);
        // #230: a Gemini batch names one model in its path; inline requests are counted (file input: []).
        const geminiReqs = batchCreate === "gemini" ? geminiBatchRequests(body) : null;
        // Model allowlist (#153): refused before forwarding; zero-cost receipt, the run is not frozen.
        const modelRefusal = (status, error, message) => {
          emit({ provider, path: storedPath, blocked: true, reason: error, outcome: "blocked_model", model: requestedModel ?? "unknown", cost_usd: 0 });
          send(status, { error, model: requestedModel ?? null, message });
          return "blocked";
        };
        let preflightEst, reserveModels = [];
        // #207: budget-triggered downgrade; dg is the applied decision, dgReceipt the receipt fields.
        let dg = null, dgReceipt = {};
        const verdict = guarded(() => {
          const killed = killCheck?.();
          if (killed) return block("killed", killed, { error: "killed", ...killed });
          const accountingFailure = accountingFailureNow();
          if (accountingFailure) return block("accounting_unavailable", {}, { error: "accounting_unavailable", message: accountingFailure });
          // #233: free management calls (files, batch cancel/delete) skip allowlist, unpriced and preflight checks.
          const generates = !["GET", "HEAD"].includes(req.method);
          // #257: a cache TTL update names no model; it is billed from the response like a create.
          const freeMgmt = generates && (isNonBillableFilesRequest(req.method, req.url) || cacheOp === "patch");
          // #207: decided before the allowlist, unpriced check, preflight and cache key, so all of them see TO.
          if (downgrader && generates) {
            const candidates = routerModels?.length ? routerModels : batchModels ?? [requestedModel];
            const decision = candidates.map((m) => downgrader.decide(m)).find(Boolean) ?? null;
            if (decision) {
              const multipart = Boolean(audio && audio !== "speech");
              if (cacheOp || !downgradeRoute({ provider, custom, cloud, batch: Boolean(batchCreate), multipart, routerModels, parsedBody })) dgReceipt = { downgrade: "unsupported_route" };
              else {
                dg = decision;
                body = rewriteModel(parsedBody, dg.to);
                parsedBody = JSON.parse(body);
                requestedModel = dg.to;
                dgReceipt = { requested_model: dg.from, downgrade: { scope: dg.scope, fraction: dg.fraction } };
              }
            }
          }
          const allow = generates && !freeMgmt ? allowedModels?.() ?? null : null;
          if (generates && routerModels === null) {
            emit({ provider, path: storedPath, blocked: true, reason: "invalid_models", outcome: "blocked_model", model: requestedModel ?? "unknown", cost_usd: 0 });
            send(400, { error: "invalid_models", model: requestedModel ?? null, message: "CostCap: `models` must be an array of model id strings. The upstream call was not made." });
            return "blocked";
          }
          const checkModels = batchModels ?? (generates && routerModels?.length ? routerModels : [requestedModel]);
          // Index of the first missing or refused model (-1: every model passes).
          const offending = (ok) => checkModels.findIndex((m) => !m || !ok(m));
          const refuse = (i) => { requestedModel = checkModels[i] ?? undefined; };
          if (allow && offending((m) => allow.includes(m)) !== -1) {
            refuse(offending((m) => allow.includes(m)));
            return modelRefusal(403, "model_not_allowed", allow.length
              ? `CostCap: model "${requestedModel ?? "(none)"}" is not in this agent's allowlist (${allow.join(", ")}). The upstream call was not made.`
              : "CostCap: this agent's model allowlists do not overlap, so every model is refused. The upstream call was not made.");
          }
          if (generates && !freeMgmt && unknownModels === "refuse" && offending(cloud ? () => cloudModel !== null : priced) !== -1) {
            refuse(offending(cloud ? () => cloudModel !== null : priced));
            return modelRefusal(403, "model_unpriced", `CostCap: model "${requestedModel ?? "(none)"}" has no published rate and --unknown-models refuse is set. The upstream call was not made.`);
          }
          const agentHit = agentBudgets?.check(who);
          if (agentHit) return block(agentHit.reason, agentHit, { error: agentHit.verdict, ...agentHit });
          const teamHit = teamCheck?.();
          if (teamHit) return block(teamHit.reason, teamHit, { error: teamHit.verdict, ...teamHit });
          const hit = cap?.check();
          if (hit) return block("budget_exceeded", hit, budgetExceededBody(hit));
          // #191: per-tag caps refuse one tag value without latching the run.
          const tagHit = tagCaps?.check(reqTags);
          if (tagHit?.verdict === "accounting_unavailable") return block("accounting_unavailable", tagHit, { error: "accounting_unavailable", ...tagHit });
          if (tagHit) return block("tag_budget_exceeded", tagHit, tagBudgetExceededBody(tagHit));
          // #238: per-model caps, checked after any #207 rewrite; never latch the run.
          const capModels = generates && !freeMgmt ? checkModels.filter(Boolean) : [];
          reserveModels = capModels;
          const modelHit = capModels.length ? modelCaps?.check(capModels) : null;
          if (modelHit?.verdict === "accounting_unavailable") { requestedModel = modelHit.model; return block("accounting_unavailable", modelHit, { error: "accounting_unavailable", ...modelHit }); }
          if (modelHit) { requestedModel = modelHit.model; const { rule_model: _rm, ...d } = modelHit; return block("model_budget_exceeded", d, modelBudgetExceededBody(modelHit)); }
          // #205: preflight estimates generating calls only. GET/HEAD (polls, retrieves,
          // model lists), file uploads and OpenAI batch creates (models live in an
          // uploaded file) pass through; audio checks only that the model is priced.
          const pfMode = !preflight || !generates ? null
            : freeMgmt || cacheOp ? "pass"
            : batchCreate === "anthropic" && !cloud ? "batch"
            : batchCreate === "gemini" ? (geminiReqs?.length ? "batch" : "pass")
            : batchCreate === "openai" || /^\/v1\/(?:files|uploads)(?:\/|$|\?)/.test(path) ? "pass"
            : audio ? "audio" : "estimate";
          if (pfMode === "pass") preflightEst = { pass: true };
          if (pfMode === "audio" && requestedModel && priced(requestedModel)) preflightEst = { pass: true };
          if (pfMode === "audio" && !preflightEst) {
            const pf = { reason: "preflight_unpriced", estimate: true, model: requestedModel ?? "unknown" };
            return block("preflight_unpriced", pf, { error: { type: "preflight_unpriced", model: pf.model,
              message: `CostCap preflight: model "${pf.model}" has no published rate, so its worst case cannot be estimated. The upstream call was not made.` } });
          }
          if (pfMode === "batch" || pfMode === "estimate") {
            // #188: cloud preflight prices the mapped path model, with the regional premium.
            const cloudPrice = cloud ? () => {
              if (!cloudModel) return null;
              if (bedrock3p) return bedrockPriceRow(bedrock3p.rate, cloudModel);
              // #256: Gemini on Vertex is priced at the (pinned) request instant, with its own non-global premium.
              const g = cloudRoute.gemini === true;
              const rm = cloudRoute.scope === "regional" ? (g ? vertexGeminiRegionalMultiplier(cloudModel) : regionalMultiplier(cloudModel)) : null;
              const base = g ? lookupPrice(cloudModel, priceAt, { vertex: true }) : lookupPrice(cloudModel, undefined, { undated: true });
              return rm ? scalePrice(base, rm) : base;
            } : undefined;
            const onFit = (est) => { preflightEst = est; };
            const reserved = reservedUsd(); // #249: in-flight worst cases are already spoken for
            const pf = pfMode === "batch" ? checkEstimate(cap, estimateBatch(provider, body, priceFor, requestedModel, priceAt), onFit, reserved)
              : preflightCheck(cap, cloudRoute?.gemini ? "gemini" : provider, body, path, onFit, cloud ? cloudPrice : priceFor, cloud ? requestedModel ?? null : undefined, cloud ? undefined : priceAt, reserved);
            if (pf?.reason === "preflight_unpriced") return block("preflight_unpriced", pf, { error: { type: "preflight_unpriced", model: pf.model,
              message: `CostCap preflight: model "${pf.model}" has no published rate, so its worst case cannot be estimated. The upstream call was not made.` } });
            if (pf) return block("budget_exceeded", pf, { error: { type: "budget_exceeded", reason: "preflight_estimate", estimate: true,
              message: `CostCap preflight estimate: worst case $${pf.estimate_usd} does not fit the remaining ${pf.scope} budget ($${pf.remaining_usd[pf.scope]}). This is an estimate. The upstream call was not made.`,
              scope: pf.scope, estimate_usd: pf.estimate_usd, remaining_usd: pf.remaining_usd } });
            // #193: the estimate must also fit the agent/team remainder and every matching tag cap.
            if (preflightEst && !preflightEst.pass) {
              const est = preflightEst.estimate_usd;
              const left = agentBudgets?.limitsFor ? reserveLeft(budgetRemaining(agentBudgets, who), reservedUsd()) : null;
              const agentScope = left && ["run", "hour", "day", "week", "month"].find((sc) => left[`${sc}_usd`] != null && est > left[`${sc}_usd`]);
              if (agentScope) {
                const detail = { verdict: "budget_exceeded", reason: "preflight_estimate", estimate: true, scope: agentScope, estimate_usd: est, remaining_usd: left[`${agentScope}_usd`], ...who };
                return block("budget_exceeded", detail, { error: "budget_exceeded", ...detail,
                  message: `CostCap preflight estimate: worst case $${est} does not fit this agent's remaining ${agentScope} budget ($${detail.remaining_usd}). This is an estimate. The upstream call was not made.` });
              }
              // #195: enrolled fleet agent caps and hosted team budgets (fleet-wide synced spend).
              const fr = fleetRemaining?.();
              const resv = reservedUsd();
              const fleetLeft = (l) => { if (!l || !resv) return l; const o = { ...l }; for (const x of ["day", "week", "month"]) if (typeof o[x] === "number") o[x] = Number(Math.max(o[x] - resv, 0).toFixed(6)); return o; };
              for (const [kind, left] of [["agent", fleetLeft(fr?.agent)], ["team", fleetLeft(fr?.team)], ["org", fleetLeft(fr?.org)]]) {
                const sc = left && ["day", "week", "month"].find((x) => left[x] != null && est > left[x]);
                if (!sc) continue;
                const isTeam = kind === "team", isOrg = kind === "org";
                const detail = { verdict: "budget_exceeded", reason: "preflight_estimate", estimate: true, fleet: true,
                  scope: isTeam ? teamScope(fr.teamName, sc) : isOrg ? `org:${sc}` : sc, estimate_usd: est, remaining_usd: left[sc],
                  ...(isTeam ? { team: fr.teamName } : {}), ...(isOrg ? { org: true } : {}), ...who };
                const what = isTeam ? `team "${fr.teamName}"` : isOrg ? "org" : "fleet agent";
                return block("budget_exceeded", detail, { error: "budget_exceeded", ...detail,
                  message: `CostCap preflight estimate: worst case $${est} does not fit the ${what} remaining ${sc} budget ($${left[sc]}). This is an estimate. The upstream call was not made.` });
              }
              const tagPf = tagCaps?.preflight?.(reqTags, est, reservedTag);
              if (tagPf) return block("tag_budget_exceeded", tagPf, tagBudgetExceededBody(tagPf));
              const modelPf = capModels.length ? modelCaps?.preflight?.(capModels, est, reservedModel) : null;
              if (modelPf) return block("model_budget_exceeded", modelPf, modelBudgetExceededBody(modelPf));
            }
          }
          // #192: RPM/TPM refuse with Retry-After; never latches, never a step.
          const rateHit = generates ? rateLimit?.check() : null;
          if (rateHit) return block("rate_limited", rateHit, rateLimitedBody(rateHit));
          const vhit = velocity?.check(inFlight);
          if (vhit) return block(vhit.reason, vhit, { error: "breaker_open", ...vhit });
          const spiralHit = spiral?.observe(req.method, path, body.toString("utf8"));
          if (spiralHit) return block("spiral_detected", spiralHit, { error: "spiral_detected", ...spiralHit });
          return null;
        });
        if (verdict === "blocked") return;
        if (dg) {
          if (!res.headersSent) res.setHeader(DOWNGRADE_HEADER, `${dg.from}->${dg.to}`);
          const ev = downgrader.notice(dg);
          if (ev) {
            const done = emitEvent(ev);
            try { onWarning(downgradeLine(done)); } catch { /* stderr is best effort */ }
          }
        }
        // #184: lookup only after the full verdict, so a hit never skips a refusal.
        let cacheMode = null, cacheKeyHex = null;
        if (cache) {
          cacheMode = cloud || cacheBypass || isStreamRequest({ path, body }) || !isCacheable({ method: req.method, path, body }) ? "bypass" : "miss";
          if (cacheMode === "miss") {
            cacheKeyHex = cacheKey({ provider, upstream, method: req.method, path, body, headers: req.headers });
            const entry = cache.get(cacheKeyHex);
            if (entry) {
              cache.hit(entry.cost_usd);
              velocity?.step?.();
              emit({ provider, path: storedPath, status: entry.status, blocked: false, model: entry.model ?? requestedModel ?? "unknown",
                cost_usd: 0, reason: "cache_hit", cache: "hit", ...dgReceipt, saved_usd: entry.cost_usd, cache_source_receipt: entry.receipt_id });
              flushWarnings();
              if (!res.destroyed) res.writeHead(entry.status, { "content-type": entry.content_type, [CACHE_HEADER]: "hit" }).end(entry.body);
              return;
            }
          }
        }
        // #192: reserve the RPM slot only for a request actually forwarded upstream.
        if (!["GET", "HEAD"].includes(req.method)) rateLimit?.admit();
        const forwardAndRecord = async () => {
        const cacheHeaders = cacheMode ? { [CACHE_HEADER]: cacheMode } : {};
        const injected = injectStreamUsage(provider, req.method, `/${rest.join("/")}`, body);
        let headers = { ...req.headers };
        for (const key of ["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]) delete headers[key];
        let target = `${upstream}${path}`;
        if (cloud) {
          const origin = upstream === BEDROCK_UPSTREAM ? `https://${bedrockHost(cloudAuth.region)}`
            : upstream === VERTEX_UPSTREAM ? `https://${vertexHost(cloudRoute.location)}` : upstream;
          target = `${origin}${cloudPath}${url.search}`;
          if (cloudAuth?.creds) {
            const t = new URL(target);
            headers = signRequest({ method: req.method, path: t.pathname, search: t.search, headers, body, host: t.host, region: cloudAuth.region, service: "bedrock" }, cloudAuth.creds);
            delete headers.host; // fetch derives Host from the URL; it matches the signed value
          }
        }
        const meterAs = cloudRoute?.gemini ? "gemini" : cloud ? "anthropic" : provider;
        try {
          const abort = new AbortController();
          let timer;
          const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => abort.abort(new Error("upstream_timeout")), ms); timer.unref?.(); };
          arm(timeoutMs);
          const onClientClose = () => { if (!res.writableFinished) abort.abort(); };
          res.once("close", onClientClose);
          const upstreamRes = await fetch(target, { method: req.method, headers,
            body: ["GET", "HEAD"].includes(req.method) ? undefined : (injected ?? body),
            // Never follow redirects: x-api-key / x-goog-api-key would be forwarded to another host.
            redirect: "manual",
            signal: abort.signal });
          if (custom && !customFirstSeen.has(provider)) {
            customFirstSeen.add(provider);
            if (upstreamRes.status === 404) {
              try { onWarning(`costcap: upstream "${provider.slice(2)}" returned 404 for /${rest.join("/")}; does --upstream URL need a /v1 suffix?`); } catch { /* stderr is best effort */ }
            }
          }
          if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
            clearTimeout(timer);
            res.off("close", onClientClose);
            upstreamRes.body?.cancel().catch(() => {});
            // Nothing was generated: the provider answered with a redirect, not a completion.
            emit({ provider, path: storedPath, status: upstreamRes.status, blocked: false, model: requestedModel ?? "unknown", cost_usd: 0, reason: "upstream_redirect" });
            send(502, { error: "upstream_redirect", message: "CostCap does not follow provider redirects, so your API key is never sent to another host." });
            return;
          }
          const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
          if (cacheMode && /^text\/event-stream/i.test(contentType)) cacheMode = "bypass";
          const receipt = { provider, path: storedPath, status: upstreamRes.status, blocked: false, ...dgReceipt, ...(cacheMode && { cache: cacheMode }),
            ...(preflightEst?.pass ? { preflight_estimate: false } : preflightEst && { output_tokens_est: preflightEst.output_tokens, output_multiplier: preflightEst.output_multiplier }) };
          let metered, raw, audioCost, streamCut = false, sseIncomplete = false;
          // #196: Responses background create / read / cancel on the first-party OpenAI route.
          const firstPartyOpenAI = provider === "openai" && !custom && !cloud;
          const bgCreate = firstPartyOpenAI && isResponsesCreate(req.method, req.url) && requestsBackground(body);
          const bgRead = firstPartyOpenAI ? responsesReadPath(req.method, req.url) : null;
          const tracker = bgCreate || bgRead ? createResponsesStreamTracker() : null;
          // #288: non-Anthropic Bedrock InvokeModel bodies are not Anthropic Messages.
          const bedrockInvokeThirdParty = provider === "bedrock" && !cloudRoute?.converse && isBedrockThirdParty(providerModel);
          const eventStream = cloud && /^application\/vnd\.amazon\.eventstream/i.test(contentType);
          if ((/^text\/event-stream/i.test(contentType) || eventStream) && upstreamRes.body) {
            // Real-time pass-through: forward each chunk as it arrives, meter from the stream.
            // #188: Bedrock eventstream frames are forwarded byte-for-byte and decoded on the side.
            const parser = eventStream ? (cloudRoute?.converse ? createConverseStreamUsageParser(requestedModel) : bedrockInvokeThirdParty ? createBedrockInvokeStreamUsageParser(requestedModel) : createEventStreamUsageParser(requestedModel)) : createSseUsageParser(meterAs, requestedModel, { images: req.method === "POST" && isImagesPath(req.url) });
            const decoder = new TextDecoder();
            arm(streamIdleMs);
            const filter = injected ? createUsageChunkFilter() : null;
            const forward = async (value) => {
              if (res.destroyed) throw new Error("client_closed");
              if (!value.length) return;
              if (!res.write(value)) {
                await new Promise((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
              }
            };
            if (!res.destroyed) {
              res.writeHead(upstreamRes.status, { "content-type": contentType, "cache-control": "no-cache", ...(cacheMode && { [CACHE_HEADER]: "bypass" }) });
              res.flushHeaders();
            }
            const reader = upstreamRes.body.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                arm(streamIdleMs);
                if (filter) {
                  const text = decoder.decode(value, { stream: true });
                  parser.push(text);
                  if (tracker) tracker.push(text);
                  await forward(Buffer.from(filter.push(text)));
                } else {
                  const chunk = eventStream ? value : decoder.decode(value, { stream: true });
                  parser.push(chunk);
                  if (tracker) tracker.push(chunk);
                  await forward(value);
                }
              }
              const tail = eventStream ? "" : decoder.decode();
              if (!eventStream) { parser.push(tail); tracker?.push(tail); }
              if (filter) await forward(Buffer.from(filter.push(tail) + filter.end()));
            } catch {
              streamCut = true;
              abort.abort();
              reader.cancel().catch(() => {});
            }
            tracker?.end();
            metered = parser.end();
            // Stream ended without its terminal event (Responses, Anthropic message_stop, Gemini finishReason): usage is partial or absent.
            if (parser.incomplete) { sseIncomplete = true; metered = null; }
          } else {
            raw = Buffer.from(await upstreamRes.arrayBuffer());
            metered = cloudRoute?.converse ? extractConverseUsage(raw.toString("utf8"), requestedModel)
              : bedrockInvokeThirdParty ? extractBedrockInvokeUsage(raw.toString("utf8"), upstreamRes.headers, requestedModel) ?? extractUsage("anthropic", raw.toString("utf8"), requestedModel) : extractUsage(meterAs, raw.toString("utf8"), requestedModel,
              { embeddings: req.method === "POST" && isEmbeddingsPath(req.url), images: req.method === "POST" && isImagesPath(req.url) });
          }
          if (meterAs === "gemini" && metered?.usage) {
            metered = { ...metered, usage: geminiServedTier(metered.usage, parsedBody, upstreamRes.headers.get("x-gemini-service-tier"), { vertex: Boolean(cloud) }) };
          }
          clearTimeout(timer);
          res.off("close", onClientClose);
          if (cloud) Object.assign(receipt, { provider_model: providerModel, endpoint_scope: cloudRoute.scope });
          const ok2xx = upstreamRes.status >= 200 && upstreamRes.status < 300;
          const isRead = ["GET", "HEAD"].includes(req.method);
          if (raw && ok2xx && isGeminiCacheRead(req.method, req.url)) {
            const b = safeJson(raw);
            for (const c of Array.isArray(b?.cachedContents) ? b.cachedContents : [b]) noteCacheExpiry(c);
          }
          const bgState = raw ? responseState(raw) : { id: tracker?.id ?? null, status: streamCut ? null : tracker?.terminal ?? null };
          const bgPending = bgRead && ok2xx ? findPendingBackground(bgRead.id) : null;
          if (bgPending && !resolvedBackground.has(bgRead.id) && TERMINAL_STATUSES.has(bgState.status) && !(raw ? false : streamCut)) {
            // #196: a terminal read settles the pending background response exactly once.
            resolvedBackground.add(bgRead.id);
            let c = null;
            if (metered && !metered.toolUseUnpriced) {
              // #236: a background response is priced at create and settle time; the higher cost is kept.
              const atCreate = costWithOverrides(userPrices, provider, metered.model, metered.usage, { at: (pinPrices ? pricingAt(bgPending.ts) : bgPending.ts) ?? priceAt });
              const atSettle = costWithOverrides(userPrices, provider, metered.model, metered.usage, { at: priceAt });
              const tokens = atCreate.cost_usd === null || atSettle.cost_usd === null ? (atCreate.cost_usd === null ? atCreate : atSettle)
                : atSettle.cost_usd > atCreate.cost_usd ? atSettle : atCreate;
              c = withToolCost(tokens, userPrices, provider, metered,
                // #219: the GET has no tools; use the type recorded at create time, else the response's echoed tools.
                bgPending.web_search_type ? { tools: [{ type: bgPending.web_search_type }] } : parsedBody, raw ? safeJson(raw) : null);
              if (c.cost_usd === null || c.reason) c = null;
            }
            receipt.response_id = bgRead.id;
            cap?.resolvePending?.(bgPending.id);
            if (c) {
              Object.assign(receipt, { model: metered.model ?? "unknown", cost_usd: 0, reason: "non_billable_request" });
              emitEvent({ event: "reconciliation", receipt_id: bgPending.id, cost_usd: c.cost_usd, source: "background_result", response_id: bgRead.id });
              const external = !(who.run_id != null && bgPending.run_id === who.run_id);
              recordSpend({ cost_usd: c.cost_usd, ts: bgPending.ts }, { external });
              agentBudgets?.settle({ receipt_id: bgPending.id, cost_usd: c.cost_usd });
              tagCaps?.settle(bgPending.id, c.cost_usd);
              modelCaps?.settle(bgPending.id, c.cost_usd);
              rateLimit?.record(usageTokens(metered.usage));
              // #201: another run's settle counts toward day/month and budgets, never this run's velocity (matches batches).
              if (external) velocity?.step?.();
              else velocity?.record(c.cost_usd);
              flushWarnings();
            } else {
              // The pending receipt becomes unknown (applySettlements reads this event); the run pauses until it is reconciled.
              Object.assign(receipt, { model: metered?.model ?? requestedModel ?? "unknown", cost_usd: 0, reason: "non_billable_request" });
              emitEvent({ event: "background_unpriced", receipt_id: bgPending.id, response_id: bgRead.id, status: bgState.status });
              recordSpend({ cost_usd: null, ts: bgPending.ts });
              failures.set(bgPending.id, `Background response ${bgRead.id} finished (${bgState.status}) with usage CostCap cannot price. Restart only after reconciling this request.`);
            }
            metered = null;
          } else if (bgRead && (isRead || ok2xx) && (bgPending || isRead || PENDING_STATUSES.has(bgState.status) || bgRead.kind === "cancel")) {
            // Reads of a background response (queued, in progress, already settled or unknown to this ledger) never bill.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: 0, reason: "non_billable_request", response_id: bgRead.id });
            metered = null; streamCut = false; sseIncomplete = false;
          } else if (bgCreate && ok2xx && bgState.id && (raw ? PENDING_STATUSES.has(bgState.status) : !bgState.status)) {
            // #196: queued/in-progress (or a cut background stream): pending, unknown (never $0), the run continues.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: null, reason: "background_pending", response_id: bgState.id,
              ...(requestWebSearchType(parsedBody) && { web_search_type: requestWebSearchType(parsedBody) }) });
            const done = emit(receipt);
            pendingBackground.set(bgState.id, { id: done.id, ts: done.ts, response_id: bgState.id, run_id: done.run_id ?? null, ...(done.web_search_type && { web_search_type: done.web_search_type }) });
            flushWarnings();
            if (raw) { if (!res.destroyed) res.writeHead(upstreamRes.status, { "content-type": contentType, ...cacheHeaders }).end(raw); }
            else if (streamCut) res.destroy();
            else if (!res.destroyed) res.end();
            return;
          } else if (cacheOp && raw && ok2xx) {
            // #257: storage billed per token-hour from the response's own times; never $0 when unknown.
            metered = null;
            const c = safeJson(raw);
            const tokens = c?.usageMetadata?.totalTokenCount;
            const model = stripModelsPrefix(typeof c?.model === "string" && c.model ? c.model : requestedModel) || "unknown";
            const name = typeof c?.name === "string" ? c.name : null;
            const end = Date.parse(c?.expireTime);
            const prev = name ? cacheExpiry.get(name) : undefined;
            const startIso = cacheOp === "create" ? c?.createTime : prev !== undefined ? new Date(prev).toISOString() : c?.updateTime;
            const start = Date.parse(startIso);
            const priced = Number.isFinite(end) && Number.isFinite(start)
              ? cacheStorageCost(model, tokens, new Date(start).toISOString(), new Date(Math.max(end, start)).toISOString()) : null;
            Object.assign(receipt, { model, kind: "cache_storage", ...(name && { cache_name: name }), ...(Number.isInteger(tokens) && { cache_tokens: tokens }),
              ...(cacheOp === "patch" && prev === undefined && { storage_upper_bound: true }) });
            if (priced) {
              const { cost_usd, storage_hours, table_version, table_sha256 } = priced;
              Object.assign(receipt, { cost_usd, storage_hours, table_version, table_sha256, fallback: false });
              noteCacheExpiry(c);
              recordSpend(receipt);
              velocity?.record(receipt.cost_usd);
            } else {
              Object.assign(receipt, { cost_usd: null, reason: "cache_storage_unpriced" });
              failMsg = `Gemini context cache storage for ${model} could not be priced (no cache_storage rate, token count or expiry). Restart only after reconciling this request.`;
            }
          } else if (isRead && !(raw && ok2xx && batchReadPath(req.method, req.url))) {
            // Retrieves never create spend (#135/#196), even when the body carries usage.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: 0, reason: "non_billable_request" });
            metered = null; streamCut = false; sseIncomplete = false;
          } else if (audio && ok2xx && (audioCost = audioUnitCost(audio, requestedModel, { responseText: raw ? raw.toString("utf8") : null, requestBody: parsedBody }))) {
            // #198: per-minute (whisper) and per-character (tts-1) audio, priced from the table.
            Object.assign(receipt, audioCost);
            recordSpend(receipt);
            velocity?.record(receipt.cost_usd);
            metered = null;
          } else if (metered && cloudRoute?.converse && converseServiceTier(parsedBody)) {
            // #278: Converse flex / priority / reserved tiers have no rate; unknown, never standard.
            Object.assign(receipt, { model: cloudModel ?? providerModel ?? "unknown", cost_usd: null, reason: "service_tier_unpriced", service_tier: converseServiceTier(parsedBody) });
            recordSpend(receipt);
            failMsg = `Bedrock serviceTier ${converseServiceTier(parsedBody)} for ${providerModel} has no published rate. Restart only after reconciling this request.`;
          } else if (metered && cloud && !cloudModel) {
            // #188: an unmapped cloud model is unknown, never the fallback rate.
            Object.assign(receipt, { model: providerModel ?? "unknown", cost_usd: null, reason: "cloud_model_unpriced" });
            recordSpend(receipt);
            failMsg = `Model ${providerModel} on ${provider} has no published rate. Restart only after reconciling this request.`;
          } else if (metered) {
            if (cloud) metered.model = cloudModel;
            Object.assign(receipt, custom ? costForUserPrices(userPrices, provider, metered.model, metered.usage)
              : bedrock3p ? bedrockCost(userPrices, bedrock3p.rate, metered.model, metered.usage)
              : cloud ? cloudCostWithOverrides(userPrices, provider, [providerModel, metered.model], metered.usage, cloudRoute.gemini === true
                ? { regional: cloudRoute.scope === "regional", vertex: true, at: priceAt }
                : { regional: cloudRoute.scope === "regional", undated: true })
                : costWithOverrides(userPrices, provider, metered.model, metered.usage, { at: priceAt }));
            // #262: Gemini tier provenance on the receipt (Vertex trafficType, a downgraded Priority request).
            if (metered.usage.traffic_type !== undefined) receipt.traffic_type = metered.usage.traffic_type;
            if (metered.usage.requested_service_tier !== undefined) receipt.requested_service_tier = metered.usage.requested_service_tier;
            rateLimit?.record(usageTokens(metered.usage));
            // #235/#242: OpenRouter's exact usage.cost also settles a table gap (cache write / service tier / modality / --price gap).
            if (metered.providerCost !== undefined && (receipt.cost_usd !== null || PROVIDER_COST_SETTLES.has(receipt.reason))) {
              delete receipt.reason;
              Object.assign(receipt, { cost_usd: Number(metered.providerCost.toFixed(6)), cost_source: "provider", fallback: false });
            }
            if (metered.toolUseUnpriced) Object.assign(receipt, { cost_usd: null, reason: "tool_use_unpriced", ...(metered.toolCalls && { tool_calls: metered.toolCalls }) });
            else if (metered.toolCalls) Object.assign(receipt, withToolCost(receipt, userPrices, provider, billedAsGrounding(provider, cloud, receipt, metered), parsedBody));
            const unpricedTool = receipt.unpriced_tool ?? metered.unpricedTool;
            delete receipt.unpriced_tool;
            recordSpend(receipt);
            if (receipt.reason === "tool_use_unpriced") failMsg = `A provider-side tool (${unpricedTool ?? "unknown server tool counter"}) was billed with no published rate for this tool or model. Restart only after reconciling this request.`;
            else if (receipt.reason === "upstream_model_unpriced") failMsg = `Model ${receipt.model} on custom upstream ${provider} has no rate in --upstream-prices. Restart only after reconciling this request.`;
            else if (receipt.reason === "user_price_unpriced") failMsg = `Model ${receipt.model} was billed for a component (cache write, long context, premium tier or non-text tokens) your --upstream-prices entry does not price. Restart only after reconciling this request.`;
            else if (receipt.reason === "modality_unpriced") failMsg = `Non-text (audio/image/video) tokens were billed for ${receipt.model} with no published modality rate. Restart only after reconciling this request.`;
            else if (receipt.reason === "unit_unpriced") failMsg = `Model ${receipt.model} is billed per minute or per character, and this response carried no usage CostCap can price. Restart only after reconciling this request.`;
            else if (receipt.reason === "service_tier_unpriced") failMsg = `A premium ${receipt.pricing_tier} tier was billed for ${receipt.model} with no published rate. Restart only after reconciling this request.`;
            else if (receipt.cost_usd === null) failMsg = "A cache write has no published rate for this model. Restart only after reconciling this request.";
            else velocity?.record(receipt.cost_usd);
          } else if (streamCut || sseIncomplete) {
            // Stream cut (upstream error, client abort or timeout) before usage arrived.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: null, reason: "stream_incomplete" });
            failMsg = "A streamed response was cut before usage arrived. Restart only after reconciling this request.";
          } else if (raw && REJECTED_STATUSES.has(upstreamRes.status) && (isProviderError(raw) || (cloud && isCloudError(raw)) || (custom && upstreamRes.status === 404 && isRouteNotFound(raw)))) {
            // Provider rejected the request before generation (rate limit, auth, bad request): not billed.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: 0, reason: "upstream_rejected" });
          } else if (raw && batchCreate && upstreamRes.status >= 200 && upstreamRes.status < 300 && batchIdOf(raw)) {
            // #160: a batch is billed when it runs. Pending, unknown (never $0), and the run continues.
            const batch_id = batchIdOf(raw);
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: null, reason: "batch_pending", batch_id,
              ...(batchModels && { request_count: batchModels.length }), ...(geminiReqs?.length && { request_count: geminiReqs.length }) });
            const done = emit(receipt);
            pendingBatches.set(batch_id, { id: done.id, ts: done.ts, provider: batchCreate, batch_id, run_id: done.run_id ?? null, model: done.model });
            if (!res.destroyed) res.writeHead(upstreamRes.status, { "content-type": contentType, ...cacheHeaders }).end(raw);
            return;
          } else if (raw && req.method === "GET" && upstreamRes.status >= 200 && upstreamRes.status < 300 && batchReadPath(req.method, req.url)) {
            Object.assign(receipt, { model: "unknown", cost_usd: 0, reason: "non_billable_request" });
            const read = batchReadPath(req.method, req.url);
            let batchId = null, inlineResults = null;
            if (read.kind === "openai_batch") {
              try {
                const b = JSON.parse(raw.toString("utf8"));
                if (typeof b?.output_file_id === "string" && /^[A-Za-z0-9_-]+$/.test(b.output_file_id) && findPending(read.id)?.provider === "openai") batchFiles.set(b.output_file_id, read.id);
              } catch { /* not a batch object: nothing to link */ }
            } else if (read.kind === "anthropic_results") batchId = read.id;
            else if (read.kind === "gemini_batch") {
              // #230: done + inlined responses settle now; a responsesFile is linked for the download.
              const out = geminiBatchOutput(raw.toString("utf8"));
              if (out?.inline) { batchId = read.id; inlineResults = out.inline; }
              else if (out?.file && findPending(read.id)?.provider === "gemini") batchFiles.set(out.file, read.id);
            } else batchId = batchFiles.get(read.id) ?? null;
            const pending = batchId ? findPending(batchId) : null;
            if (pending && !resolvedBatches.has(batchId) && pending.provider === provider) {
              resolvedBatches.add(batchId);
              const folded = foldBatchResults(provider, inlineResults ?? raw.toString("utf8"), userPrices, { model: pending.model && pending.model !== "unknown" ? pending.model : undefined, createdAt: pinPrices ? pricingAt(pending.ts) : pending.ts, settledAt: priceAt });
              receipt.batch_id = batchId;
              if (folded.ok) {
                emitEvent({ event: "reconciliation", receipt_id: pending.id, cost_usd: folded.cost_usd, source: "batch_results", batch_id: batchId,
                  succeeded: folded.succeeded, not_billed: folded.free, by_model: folded.by_model });
                // #182: another run's (or wrapper's) batch counts toward day/month only, like src/settle.js.
                const external = !(who.run_id != null && pending.run_id === who.run_id);
                cap?.resolvePending?.(pending.id);
                recordSpend({ cost_usd: folded.cost_usd, ts: pending.ts }, { external });
                // #179: --policy agent/team budgets count the batch at its original ts, no restart needed.
                agentBudgets?.settle({ receipt_id: pending.id, cost_usd: folded.cost_usd });
                tagCaps?.settle(pending.id, folded.cost_usd);
                modelCaps?.settle(pending.id, folded.cost_usd);
                flushWarnings();
              } else {
                // Unpriced, premium-speed or malformed results: the batch stays unknown, never $0.
                Object.assign(receipt, { cost_usd: null, reason: "batch_unpriced" });
                failMsg = "Batch results could not be priced. Restart only after reconciling this batch.";
              }
            }
          } else if (raw && (["GET", "HEAD"].includes(req.method) ||
            (upstreamRes.status >= 200 && upstreamRes.status < 300 &&
              ((req.method === "POST" && (isCountTokensPath(req.url) || cloudRoute?.countTokens)) || isNonBillableFilesRequest(req.method, req.url) || isGeminiBatchFreeCall(req.method, req.url))))) {
            // Metadata reads, token-count endpoints and Files upload/delete never generate tokens.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: 0, reason: "non_billable_request" });
          } else {
            // Unknown spend is never silently free. Stop subsequent calls.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: null, reason: "usage_unavailable" });
            failMsg = "Provider returned no usable token usage. Restart only after reconciling this request.";
          }
          const emitted = emit(receipt);
          // #171: the unknown counts on the running cap engine so a settle lands exactly once.
          // #184: only a 2xx, metered, known-cost response is stored.
          if (cacheMode === "miss") {
            cache.miss();
            if (raw && metered && !failMsg && upstreamRes.status >= 200 && upstreamRes.status < 300 && typeof emitted.cost_usd === "number" && Number.isFinite(emitted.cost_usd) && !emitted.reason) {
              try { cache.set(cacheKeyHex, { status: upstreamRes.status, contentType, body: raw, model: emitted.model ?? null, cost_usd: emitted.cost_usd, receipt_id: emitted.id }); } catch { /* cache is best effort */ }
            }
          }
          if (failMsg) { failures.set(emitted.id, failMsg); if (!metered) recordSpend(emitted); failMsg = null; }
          flushWarnings();
          if (raw) { if (!res.destroyed) res.writeHead(upstreamRes.status, { "content-type": contentType, ...cacheHeaders }).end(raw); }
          else if (streamCut) res.destroy();
          else if (!res.destroyed) res.end();
        } catch {
          // A failed fetch may already have billed upstream. Do not assume zero.
          hardFailure = "Upstream outcome or receipt persistence is uncertain. Reconcile before restarting.";
          try { emit({ provider, path: storedPath, blocked: false, cost_usd: null, reason: "upstream_outcome_unknown" }); } catch { /* stop on broken ledger */ }
          send(502, { error: "upstream_outcome_unknown" });
        }
        };
        // #249: at the default (1) the forward is awaited inside the queue, as before.
        if (concurrency() <= 1 && inFlight === 0) return forwardAndRecord();
        const token = {};
        inFlight += 1;
        if (preflightEst && !preflightEst.pass && Number.isFinite(preflightEst.estimate_usd)) inFlightEstimates.set(token, { est: preflightEst.estimate_usd, tags: reqTags, models: reserveModels });
        return { detached: forwardAndRecord().finally(() => { inFlight -= 1; inFlightEstimates.delete(token); }) };
      };
      const ledgerDown = () => { hardFailure = "Receipt ledger unavailable."; send(503, { error: "receipt_ledger_unavailable" }); };
      queue = queue.then(async () => {
        // #255: also wait when a lowered ceiling still has calls in flight.
        if (concurrency() > 1 || inFlight > 0) await acquireSlot();
        const out = await run();
        if (out?.detached) out.detached.catch(ledgerDown).finally(releaseSlot);
      }).catch(ledgerDown);
    });
  });
  // #194: OpenAI Realtime API over WebSocket. Every other upgrade is refused locally (never
  // reaches the HTTP path, never latches). Admission runs before 101; each response.done is
  // metered and the gate re-checked between responses; kill closes open sessions.
  const sessions = new Set();
  let killTimer = null;
  const sessionGate = (model, tags) => {
    const killed = killCheck?.();
    if (killed) return { status: 429, reason: "killed", detail: killed, body: { error: "killed", ...killed } };
    const accountingFailure = accountingFailureNow();
    if (accountingFailure) return { status: 429, reason: "accounting_unavailable", detail: {}, body: { error: "accounting_unavailable", message: accountingFailure } };
    const agentHit = agentBudgets?.check(who);
    if (agentHit) return { status: 429, reason: agentHit.reason, detail: agentHit, body: { error: agentHit.verdict, ...agentHit } };
    const teamHit = teamCheck?.();
    if (teamHit) return { status: 429, reason: teamHit.reason, detail: teamHit, body: { error: teamHit.verdict, ...teamHit } };
    const hit = cap?.check();
    if (hit) return { status: 429, reason: "budget_exceeded", detail: hit, body: budgetExceededBody(hit) };
    const tagHit = tagCaps?.check(tags);
    if (tagHit?.verdict === "accounting_unavailable") return { status: 429, reason: "accounting_unavailable", detail: tagHit, body: { error: "accounting_unavailable", ...tagHit } };
    if (tagHit) return { status: 429, reason: "tag_budget_exceeded", detail: tagHit, body: tagBudgetExceededBody(tagHit) };
    const modelHit = model ? modelCaps?.check([model]) : null;
    if (modelHit?.verdict === "accounting_unavailable") return { status: 429, reason: "accounting_unavailable", detail: modelHit, body: { error: "accounting_unavailable", ...modelHit } };
    if (modelHit) { const { rule_model: _rm, ...d } = modelHit; return { status: 429, reason: "model_budget_exceeded", detail: d, body: modelBudgetExceededBody(modelHit) }; }
    return null;
  };
  const ensureKillTimer = () => {
    if (killTimer || !killCheck) return;
    killTimer = setInterval(() => {
      if (!sessions.size) { clearInterval(killTimer); killTimer = null; return; }
      const k = killCheck();
      if (k) for (const s of [...sessions]) s.terminate("killed", k);
    }, 200);
    killTimer.unref?.();
  };
  // #273: OpenAI GPT-Live (/v1/live/sessions) over WebSocket. Admission runs before 101 and on
  // session.start (model). Each usage.seconds snapshot bills its delta; caps are re-checked after
  // every metered event and by a 1 s wall-clock estimate; a missing session.closed is unknown.
  const handleLive = (req, socket, head, reqAt, url, upstream) => {
    let reqTags = null;
    try { reqTags = mergeTags(wrapperTags, parseTagHeader(req.headers[TAG_HEADER])); } catch (e) {
      writeHttpJson(socket, 400, { error: "invalid_tags", message: `CostCap: ${e.message}. The upstream call was not made.` });
      return;
    }
    const emit = (receipt) => emitBase(reqTags ? { ...receipt, tags: reqTags } : receipt, reqAt);
    const base = { provider: "openai", path: "/v1/live/sessions", transport: "websocket" };
    let model = "unknown";
    try {
      const g = guarded(() => sessionGate(null, reqTags));
      if (g) {
        emit({ ...base, blocked: true, cost_usd: 0, model, ...g.detail, reason: g.reason });
        writeHttpJson(socket, g.status, g.body, g.detail?.retry_after_s != null ? { "retry-after": String(g.detail.retry_after_s) } : {});
        return;
      }
    } catch {
      writeHttpJson(socket, 503, { error: "receipt_ledger_unavailable" });
      return;
    }
    const target = new URL(`${upstream}/v1/live/sessions`);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "host" || k.startsWith("x-costcap-") || k === "sec-websocket-extensions") continue;
      headers[k] = v;
    }
    headers.host = target.host;
    const upReq = (target.protocol === "https:" ? https : http).request(target, { method: "GET", headers });
    let settledHandshake = false;
    const handshakeTimer = setTimeout(() => upReq.destroy(new Error("upstream_timeout")), timeoutMs);
    handshakeTimer.unref?.();
    const noUpgrade = (status, body, reason) => {
      if (settledHandshake) return;
      settledHandshake = true;
      clearTimeout(handshakeTimer);
      try { emit({ ...base, status, blocked: false, model, cost_usd: 0, reason }); } catch { /* surfaces on the next call */ }
      writeHttpJson(socket, status, body);
    };
    upReq.on("error", () => noUpgrade(502, { error: "upstream_unreachable", message: "CostCap could not open the GPT-Live WebSocket upstream." }, "upstream_handshake_failed"));
    upReq.on("response", (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { body = { error: "upstream_handshake_rejected" }; }
        noUpgrade(res.statusCode, body, "upstream_rejected");
      });
      res.on("error", () => noUpgrade(502, { error: "upstream_handshake_rejected" }, "upstream_rejected"));
    });
    upReq.on("upgrade", (upRes, upSocket, upHead) => {
      settledHandshake = true;
      clearTimeout(handshakeTimer);
      upSocket.on("error", () => {});
      if (socket.destroyed) { upSocket.destroy(); return; }
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        if (upRes.rawHeaders[i].toLowerCase() === "sec-websocket-extensions") continue;
        lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      let sessionId = null, rate = null, started = false, admitted = false, gotClosed = false;
      let closing = null, finished = false, lastSnapAt = now();
      const meter = createSnapshotMeter();
      const backendSeen = new Set();
      const down = createFrameParser(), up = createFrameParser();
      let held = [];
      const toClient = (b) => { try { if (!socket.destroyed) socket.write(b); } catch { /* gone */ } };
      const toUpstream = (b) => { try { if (!upSocket.destroyed) upSocket.write(b); } catch { /* gone */ } };
      const clientError = (code, message) => toClient(encodeFrame(0x1, JSON.stringify({ type: "error", error: { type: "costcap", code, message: `CostCap: ${message}` } })));
      const closeClient = (code, reason) => {
        if (socket.destroyed) return;
        toClient(encodeFrame(0x8, closePayload(code, `costcap: ${reason}`)));
        socket.end();
        setTimeout(() => socket.destroy(), 1000).unref?.();
      };
      const latch = (receipt, msg) => {
        const done = emit(receipt);
        failures.set(done.id, msg);
        recordSpend(done);
        flushWarnings();
        return done;
      };
      const rcpt = (extra) => ({ ...base, status: 101, blocked: false, model, session_id: sessionId, ...extra });
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(ticker);
        if (closing?.timer) clearTimeout(closing.timer);
        sessions.delete(session);
        if (started && !gotClosed) {
          try { latch(rcpt({ cost_usd: null, reason: "session_usage_unconfirmed", session_seconds_lower_bound: meter.seconds }),
            "A GPT-Live session ended without its final session.closed duration. Restart only after reconciling this session."); } catch { hardFailure = "Receipt ledger unavailable."; }
        }
        closeClient(closing?.code ?? 1000, closing?.reason ?? "session_ended");
        toUpstream(encodeFrame(0x8, closePayload(1000, "costcap"), { mask: true }));
        upSocket.end();
        setTimeout(() => upSocket.destroy(), 1000).unref?.();
      };
      // Ask upstream to close and wait up to 5 s for session.closed (the final billed duration).
      const startClose = (code, reason, { clientNow = false, errorCode = null } = {}) => {
        if (closing || finished) { if (clientNow) closeClient(code, reason); return; }
        closing = { code, reason };
        if (errorCode) clientError(errorCode, `${reason}. The session was closed.`);
        if (clientNow) closeClient(code, reason);
        if (!started) { finish(); return; }
        toUpstream(encodeFrame(0x1, JSON.stringify({ type: "session.close" }), { mask: true }));
        closing.timer = setTimeout(finish, liveCloseWaitMs);
        closing.timer.unref?.();
      };
      const billSnapshot = (seconds) => {
        const { billed_seconds, session_seconds } = meter.take(seconds);
        lastSnapAt = now();
        if (!rate) {
          latch(rcpt({ cost_usd: null, reason: "model_unpriced", billed_seconds, session_seconds }),
            `GPT-Live model ${model} has no published per-minute rate. Restart only after reconciling this session.`);
          return;
        }
        const { per_minute: perMinute, ...pinned } = rate;
        const done = emit(rcpt({ cost_basis: "duration", billed_seconds, session_seconds, ...pinned, cost_usd: durationCost(billed_seconds, perMinute) }));
        recordSpend(done);
        velocity?.record(done.cost_usd);
        flushWarnings();
      };
      const onEvent = (ev) => {
        if (!ev || typeof ev !== "object") return false;
        if (/^session\.(started|created|updated)$/.test(ev.type) && ev.session && typeof ev.session === "object") {
          if (typeof ev.session.id === "string") sessionId = ev.session.id;
          if (typeof ev.session.model === "string" && ev.session.model && ev.session.model !== model) { model = ev.session.model; rate = liveRate(model); }
          return false;
        }
        if (ev.type === "session.usage.updated") {
          const s = sessionSeconds(ev);
          if (s === null) return false;
          billSnapshot(s);
          return true;
        }
        if (ev.type === "session.closed") {
          gotClosed = true;
          const s = sessionSeconds(ev);
          if (s === null) gotClosed = false; // no usable final duration: stays unknown
          else billSnapshot(s);
          return true;
        }
        const r = backendResponse(ev);
        if (r) {
          const id = typeof r.id === "string" ? r.id : null;
          if (id && backendSeen.has(id)) return false;
          if (id) backendSeen.add(id);
          const bModel = typeof r.model === "string" && r.model ? r.model : null;
          const priced = bModel && (userPrices ? isPricedWithOverrides(userPrices, "openai", bModel) : isPricedModel(bModel));
          const extra = { backend: true, response_id: id };
          // #281: same accumulator as /v1/responses (tool calls, service_tier, image_generation).
          let metered = null;
          if (priced) { const acc = createUsageAccumulator("openai", bModel); acc.add({ type: "response.completed", response: r }); metered = acc.result(); }
          const usage = metered?.usage;
          if (!priced || !usage || !isCount(usage.input_tokens) || !isCount(usage.output_tokens)) {
            latch(rcpt({ ...extra, model: bModel ?? "unknown", cost_usd: null, reason: priced ? "usage_unavailable" : "model_unpriced" }),
              "A GPT-Live backend response could not be priced. Restart only after reconciling this session.");
            return true;
          }
          metered.model = bModel;
          let receipt = rcpt({ ...extra, ...costWithOverrides(userPrices, "openai", bModel, usage, { at: pinPrices ? pricingAt(now()) : now() }) });
          if (typeof usage.service_tier === "string") receipt.service_tier = usage.service_tier;
          if (metered.toolUseUnpriced) Object.assign(receipt, { cost_usd: null, reason: "tool_use_unpriced", ...(metered.toolCalls && { tool_calls: metered.toolCalls }) });
          else if (metered.toolCalls) Object.assign(receipt, withToolCost(receipt, userPrices, "openai", metered, null, r));
          delete receipt.unpriced_tool;
          rateLimit?.record(usageTokens(usage));
          if (receipt.cost_usd === null) latch(receipt, receipt.reason === "tool_use_unpriced"
            ? "A GPT-Live backend response used a provider-side tool with no published rate. Restart only after reconciling this session."
            : "A GPT-Live backend response has no published rate. Restart only after reconciling this session.");
          else { const done = emit(receipt); recordSpend(done); velocity?.record(done.cost_usd); flushWarnings(); }
          return true;
        }
        return false;
      };
      const gateHit = (g) => {
        if (g.reason === "killed") { session.terminate("killed", g.detail); return; }
        startClose(1008, g.reason, { errorCode: g.reason });
      };
      const session = {
        terminate(reason, detail) {
          if (finished) return;
          try { emit({ ...base, blocked: true, reason, cost_usd: 0, model, session_id: sessionId, ...detail }); } catch { /* ledger */ }
          clientError(reason, `${reason}. The session was closed.`);
          startClose(1008, reason, { clientNow: true });
        },
        close() { closing = closing ?? { code: 1001, reason: "proxy_closed" }; finish(); },
      };
      sessions.add(session);
      ensureKillTimer();
      // Wall-clock estimate between snapshots: never written as spend, only closes early.
      const ticker = setInterval(() => {
        if (!started || closing || finished || !rate || !cap?.remaining) return;
        const left = Object.values(cap.remaining());
        if (!left.length) return;
        const est = durationCost(Math.max(0, (now() - lastSnapAt) / 1000), rate.per_minute);
        if (est >= Math.min(...left)) startClose(1008, "budget_exceeded", { errorCode: "budget_exceeded" });
      }, liveTickMs);
      ticker.unref?.();
      const fromUpstream = (bytes) => {
        if (finished) return;
        for (const frame of down.push(bytes)) {
          if (finished) return;
          toClient(frame.raw);
          if (!frame.message || frame.message.opcode !== 0x1) continue;
          let ev;
          try { ev = JSON.parse(frame.message.data.toString("utf8")); } catch { continue; }
          let metered;
          try { metered = onEvent(ev); } catch { hardFailure = "Receipt ledger unavailable."; closing = { code: 1011, reason: "accounting_unavailable" }; clientError("accounting_unavailable", "accounting_unavailable"); finish(); return; }
          if (ev.type === "session.closed" && gotClosed) { if (closing) finish(); continue; }
          if (!metered || closing) continue;
          const g = guarded(() => sessionGate(model, reqTags));
          if (g) gateHit(g);
        }
        if (down.corrupt) { closing = closing ?? { code: 1009, reason: "frame_too_large" }; finish(); }
      };
      // Client frames are held until the first complete message so session.start can be vetted.
      // #281: session.delegation.responses.model (the Responses backend) is vetted like session.model.
      const vetDelegation = (ev) => {
        const d = ev?.session?.delegation?.responses;
        if (!d || typeof d !== "object" || d.model === undefined) return null;
        const m = typeof d.model === "string" && d.model ? d.model : null;
        const allow = allowedModels?.() ?? null;
        if (allow && (!m || !allow.includes(m))) return { reason: "model_not_allowed", message: `delegation model "${m ?? "(none)"}" is not in this agent's allowlist (${allow.join(", ")}). The upstream call was not made` };
        if (unknownModels === "refuse" && (!m || !(userPrices ? isPricedWithOverrides(userPrices, "openai", m) : isPricedModel(m)))) return { reason: "model_unpriced", message: `delegation model "${m ?? "(none)"}" has no published rate and --unknown-models refuse is set. The upstream call was not made` };
        return null;
      };
      const admitStart = (ev) => {
        const m = typeof ev.session?.model === "string" && ev.session.model ? ev.session.model : null;
        model = m ?? "unknown";
        rate = liveRate(m);
        const allow = allowedModels?.() ?? null;
        let v = null;
        if (allow && (!m || !allow.includes(m))) v = { reason: "model_not_allowed", message: `model "${m ?? "(none)"}" is not in this agent's allowlist (${allow.join(", ")}). The upstream call was not made` };
        else if (unknownModels === "refuse" && (!m || !(userPrices ? isPricedWithOverrides(userPrices, "openai", m) : isPricedModel(m)))) v = { reason: "model_unpriced", message: `model "${m ?? "(none)"}" has no published rate and --unknown-models refuse is set. The upstream call was not made` };
        if (!v) v = vetDelegation(ev);
        if (!v) { const g = guarded(() => sessionGate(m, reqTags)); if (g) v = { reason: g.reason, message: `${g.reason}. The upstream call was not made`, detail: g.detail }; }
        return v;
      };
      const fromClient = (bytes) => {
        if (finished) return;
        for (const frame of up.push(bytes)) {
          if (admitted) {
            // #281: a session.update switching to a disallowed delegation model is not forwarded.
            if (frame.message?.opcode === 0x1) {
              let u = null;
              try { u = JSON.parse(frame.message.data.toString("utf8")); } catch { /* not JSON */ }
              const v = u?.type === "session.update" ? vetDelegation(u) : null;
              if (v) { try { emit({ ...base, blocked: true, cost_usd: 0, model, session_id: sessionId, reason: v.reason, outcome: "blocked_model" }); } catch { /* ledger */ } clientError(v.reason, v.message); continue; }
            }
            toUpstream(frame.raw); continue;
          }
          held.push(frame.raw);
          if (!frame.message) { if (frame.opcode === 0x8) { toUpstream(Buffer.concat(held)); held = []; } continue; }
          let ev = null;
          if (frame.message.opcode === 0x1) { try { ev = JSON.parse(frame.message.data.toString("utf8")); } catch { /* not JSON */ } }
          if (ev?.type !== "session.start") { toUpstream(Buffer.concat(held)); held = []; continue; }
          let v;
          try { v = admitStart(ev); } catch { hardFailure = "Receipt ledger unavailable."; v = { reason: "accounting_unavailable", message: "accounting_unavailable" }; }
          if (v) {
            held = [];
            try { emit({ ...base, blocked: true, cost_usd: 0, model, ...(v.detail ?? {}), reason: v.reason, ...(v.detail ? {} : { outcome: "blocked_model" }) }); } catch { /* ledger */ }
            clientError(v.reason, v.message);
            closing = { code: 1008, reason: v.reason };
            finish();
            return;
          }
          admitted = true; started = true; lastSnapAt = now();
          toUpstream(Buffer.concat(held)); held = [];
        }
      };
      if (upHead?.length) fromUpstream(upHead);
      upSocket.on("data", fromUpstream);
      socket.on("data", fromClient);
      if (head?.length) fromClient(head);
      const clientGone = () => { if (!finished) startClose(1000, "client_closed"); };
      const upstreamGone = () => finish();
      socket.on("end", clientGone); socket.on("close", clientGone);
      upSocket.on("end", upstreamGone); upSocket.on("close", upstreamGone);
    });
    upReq.end();
  };
  // #277: Gemini Live API (BidiGenerateContent / BidiGenerateContentConstrained) over WebSocket.
  // Admission runs before 101 and on the first `setup` message (model). Each server message with
  // usageMetadata is one receipt; caps are re-checked after each; a close with an unanswered
  // client turn, unpriced modality, cache read or grounding is an honest unknown.
  const handleGeminiLive = (req, socket, head, reqAt, url, rawPathname, upstream) => {
    let reqTags = null;
    try { reqTags = mergeTags(wrapperTags, parseTagHeader(req.headers[TAG_HEADER])); } catch (e) {
      writeHttpJson(socket, 400, { error: "invalid_tags", message: `CostCap: ${e.message}. The upstream call was not made.` });
      return;
    }
    const emit = (receipt) => emitBase(reqTags ? { ...receipt, tags: reqTags } : receipt, reqAt);
    const upstreamPath = rawPathname.replace(/^\/gemini/, "");
    const base = { provider: "gemini", path: receiptPath(upstreamPath, url.search), transport: "websocket" };
    let model = "unknown";
    try {
      const g = guarded(() => sessionGate(null, reqTags));
      if (g) {
        emit({ ...base, blocked: true, cost_usd: 0, model, ...g.detail, reason: g.reason });
        writeHttpJson(socket, g.status, g.body, g.detail?.retry_after_s != null ? { "retry-after": String(g.detail.retry_after_s) } : {});
        return;
      }
    } catch {
      writeHttpJson(socket, 503, { error: "receipt_ledger_unavailable" });
      return;
    }
    const target = new URL(`${upstream}${upstreamPath}${url.search}`);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "host" || k.startsWith("x-costcap-") || k === "sec-websocket-extensions") continue;
      headers[k] = v;
    }
    headers.host = target.host;
    const upReq = (target.protocol === "https:" ? https : http).request(target, { method: "GET", headers });
    let settledHandshake = false;
    const handshakeTimer = setTimeout(() => upReq.destroy(new Error("upstream_timeout")), timeoutMs);
    handshakeTimer.unref?.();
    const noUpgrade = (status, body, reason) => {
      if (settledHandshake) return;
      settledHandshake = true;
      clearTimeout(handshakeTimer);
      try { emit({ ...base, status, blocked: false, model, cost_usd: 0, reason }); } catch { /* surfaces on the next call */ }
      writeHttpJson(socket, status, body);
    };
    upReq.on("error", () => noUpgrade(502, { error: "upstream_unreachable", message: "CostCap could not open the Gemini Live WebSocket upstream." }, "upstream_handshake_failed"));
    upReq.on("response", (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { body = { error: "upstream_handshake_rejected" }; }
        noUpgrade(res.statusCode, body, "upstream_rejected");
      });
      res.on("error", () => noUpgrade(502, { error: "upstream_handshake_rejected" }, "upstream_rejected"));
    });
    upReq.on("upgrade", (upRes, upSocket, upHead) => {
      settledHandshake = true;
      clearTimeout(handshakeTimer);
      upSocket.on("error", () => {});
      if (socket.destroyed) { upSocket.destroy(); return; }
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        if (upRes.rawHeaders[i].toLowerCase() === "sec-websocket-extensions") continue;
        lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      // #284: pendingTurn is "hard" (explicit turn request, or the server started a turn) or "soft"
      // (streamed mic input only). A normal client close drops a soft pending turn: trailing mic
      // input after the last usage is not a cut turn. An upstream drop or cap close still latches.
      let closed = false, admitted = false, pendingTurn = false, hardTurn = false, grounded = false;
      let held = [];
      const down = createFrameParser(), up = createFrameParser();
      const rcpt = (extra) => ({ ...base, status: 101, blocked: false, model, ...extra });
      const latch = (receipt, msg) => {
        const done = emit(receipt);
        failures.set(done.id, msg);
        recordSpend(done);
        flushWarnings();
        return done;
      };
      const shutdown = (code, reason) => {
        if (closed) return;
        closed = true;
        sessions.delete(session);
        try { socket.write(encodeFrame(0x8, closePayload(code, `costcap: ${reason}`))); } catch { /* client gone */ }
        socket.end();
        try { upSocket.write(encodeFrame(0x8, closePayload(1000, "costcap"), { mask: true })); } catch { /* upstream gone */ }
        upSocket.end();
        setTimeout(() => { socket.destroy(); upSocket.destroy(); }, 1000).unref?.();
      };
      const finishIncomplete = () => {
        if (!pendingTurn) return;
        pendingTurn = false; hardTurn = false;
        try { latch(rcpt({ cost_usd: null, reason: "stream_incomplete" }), "A Gemini Live turn was cut before its usage arrived. Restart only after reconciling this session."); } catch { hardFailure = "Receipt ledger unavailable."; }
      };
      const onMessage = (msg) => {
        if (!msg || typeof msg !== "object") return false;
        if (msg.serverContent?.groundingMetadata && typeof msg.serverContent.groundingMetadata === "object") grounded = true;
        if (!msg.usageMetadata || typeof msg.usageMetadata !== "object") {
          if (msg.serverContent && typeof msg.serverContent === "object") { pendingTurn = true; hardTurn = true; }
          return false;
        }
        pendingTurn = false; hardTurn = false;
        const usage = geminiLiveUsage(msg.usageMetadata);
        const wasGrounded = grounded;
        grounded = false;
        if (!usage) {
          latch(rcpt({ cost_usd: null, reason: "usage_unavailable" }), "A Gemini Live turn reported no usable token usage. Restart only after reconciling this session.");
          return true;
        }
        const priced = costWithOverrides(userPrices, "gemini", model, usage, { at: pinPrices ? pricingAt(now()) : now() });
        const receipt = rcpt(priced);
        rateLimit?.record(usageTokens(usage));
        if (wasGrounded && receipt.cost_usd !== null) Object.assign(receipt, { cost_usd: null, reason: "tool_use_unpriced" });
        if (receipt.cost_usd === null) {
          latch(receipt, receipt.reason === "tool_use_unpriced"
            ? "A Gemini Live turn used Grounding with Google Search, which has no published Live rate. Restart only after reconciling this session."
            : `A Gemini Live turn on ${model} has no published rate (${receipt.reason ?? "unpriced"}). Restart only after reconciling this session.`);
        } else {
          const done = emit(receipt);
          recordSpend(done);
          velocity?.record(done.cost_usd);
          flushWarnings();
        }
        return true;
      };
      const session = {
        terminate(reason, detail) {
          if (closed) return;
          try { emit({ ...base, blocked: true, reason, cost_usd: 0, model, ...detail }); } catch { /* ledger */ }
          finishIncomplete();
          shutdown(1008, reason);
        },
        close() { finishIncomplete(); shutdown(1001, "proxy_closed"); },
      };
      sessions.add(session);
      ensureKillTimer();
      const fromUpstream = (bytes) => {
        if (closed) return;
        for (const frame of down.push(bytes)) {
          if (closed) return;
          socket.write(frame.raw);
          if (!frame.message) continue;
          let msg;
          try { msg = JSON.parse(frame.message.data.toString("utf8")); } catch { continue; }
          let metered;
          try { metered = onMessage(msg); } catch { hardFailure = "Receipt ledger unavailable."; shutdown(1011, "accounting_unavailable"); return; }
          if (!metered) continue;
          const g = guarded(() => sessionGate(model, reqTags));
          if (g) { if (g.reason === "killed") session.terminate("killed", g.detail); else { finishIncomplete(); shutdown(1008, g.reason); } return; }
        }
        if (down.corrupt) { finishIncomplete(); shutdown(1009, "frame_too_large"); }
      };
      // Client frames are held until the first complete message, which must be `setup`.
      const admitSetup = (msg) => {
        const m = setupModel(msg);
        model = m ?? "unknown";
        const allow = allowedModels?.() ?? null;
        if (allow && (!m || !allow.includes(m))) return { reason: "model_not_allowed" };
        if (unknownModels === "refuse" && (!m || !(userPrices ? isPricedWithOverrides(userPrices, "gemini", m) : isPricedModel(m)))) return { reason: "model_unpriced" };
        const g = guarded(() => sessionGate(m, reqTags));
        return g ? { reason: g.reason, detail: g.detail } : null;
      };
      const tapClient = (frames) => {
        for (const f of frames) {
          if (f.opcode === 0x8) { if (!hardTurn) pendingTurn = false; continue; }
          if (!f.message) continue;
          try {
            const m = JSON.parse(f.message.data.toString("utf8"));
            if (isTurnInput(m)) pendingTurn = true;
            if (isExplicitTurn(m)) hardTurn = true;
          } catch { /* not JSON */ }
        }
      };
      const fromClient = (bytes) => {
        if (closed) return;
        // #283: after admission bytes pass through raw; `up` keeps parsing only to tap turns.
        if (admitted) { upSocket.write(bytes); tapClient(up.push(bytes)); return; }
        const frames = up.push(bytes);
        for (const frame of frames) {
          if (admitted) { upSocket.write(frame.raw); tapClient([frame]); continue; }
          held.push(frame.raw);
          if (!frame.message) { if (frame.opcode === 0x8) { closed = true; sessions.delete(session); socket.end(); upSocket.destroy(); } continue; }
          let msg = null;
          try { msg = JSON.parse(frame.message.data.toString("utf8")); } catch { /* not JSON */ }
          let v;
          if (!msg?.setup) v = { reason: "setup_required" };
          else { try { v = admitSetup(msg); } catch { hardFailure = "Receipt ledger unavailable."; v = { reason: "accounting_unavailable" }; } }
          if (v) {
            held = [];
            try { emit({ ...base, blocked: true, cost_usd: 0, model, ...(v.detail ?? {}), reason: v.reason, ...(v.detail ? {} : { outcome: "blocked_model" }) }); } catch { /* ledger */ }
            shutdown(1008, v.reason);
            return;
          }
          admitted = true;
          upSocket.write(Buffer.concat(held)); held = [];
        }
        // #283: a partial next frame that shared this read with `setup` is still in `up`'s buffer.
        // Forward it now; `up` keeps it so the frame is tapped once its tail arrives.
        if (admitted && up.pending) upSocket.write(up.buffered);
      };
      if (upHead?.length) fromUpstream(upHead);
      upSocket.on("data", fromUpstream);
      socket.on("data", fromClient);
      if (head?.length) fromClient(head);
      const onEnd = () => {
        if (closed) return;
        closed = true;
        sessions.delete(session);
        finishIncomplete();
        socket.end(); upSocket.end();
        setTimeout(() => { socket.destroy(); upSocket.destroy(); }, 1000).unref?.();
      };
      for (const s of [socket, upSocket]) { s.on("end", onEnd); s.on("close", onEnd); }
    });
    upReq.end();
  };
  server.on("upgrade", (req, socket, head) => {
    const reqAt = now();
    socket.on("error", () => {});
    const url = new URL(req.url, "http://localhost");
    const rawPathname = req.url.split(/[?#]/, 1)[0];
    const upstream = upstreams.openai;
    if (LIVE_PATH.test(rawPathname) && upstream) { handleLive(req, socket, head, reqAt, url, upstream); return; }
    if (GEMINI_LIVE_PATH.test(rawPathname) && upstreams.gemini) { handleGeminiLive(req, socket, head, reqAt, url, rawPathname, upstreams.gemini); return; }
    if (!REALTIME_PATH.test(rawPathname) || !upstream) {
      writeHttpJson(socket, 501, { error: "websocket_unsupported", message: "CostCap proxies WebSocket upgrades only on /openai/v1/realtime, /openai/v1/live/sessions and /gemini/ws/...BidiGenerateContent (Gemini Live). The upstream call was not made." });
      return;
    }
    let reqTags = null;
    try { reqTags = mergeTags(wrapperTags, parseTagHeader(req.headers[TAG_HEADER])); } catch (e) {
      writeHttpJson(socket, 400, { error: "invalid_tags", message: `CostCap: ${e.message}. The upstream call was not made.` });
      return;
    }
    const emit = (receipt) => emitBase(reqTags ? { ...receipt, tags: reqTags } : receipt, reqAt);
    const storedPath = receiptPath("/v1/realtime", url.search);
    const queryModel = url.searchParams.get("model") || undefined;
    let model = queryModel ?? "unknown";
    const base = { provider: "openai", path: storedPath, transport: "websocket" };
    let verdict;
    try {
      verdict = guarded(() => {
        const g = sessionGate(queryModel, reqTags);
        if (g) return g;
        const allow = allowedModels?.() ?? null;
        if (allow && (!queryModel || !allow.includes(queryModel))) return { status: 403, reason: "model_not_allowed", model: true,
          body: { error: "model_not_allowed", model: queryModel ?? null, message: `CostCap: model "${queryModel ?? "(none)"}" is not in this agent's allowlist (${allow.join(", ")}). The upstream call was not made.` } };
        const priced = userPrices ? isPricedWithOverrides(userPrices, "openai", queryModel) : isPricedModel(queryModel);
        if (unknownModels === "refuse" && (!queryModel || !priced)) return { status: 403, reason: "model_unpriced", model: true,
          body: { error: "model_unpriced", model: queryModel ?? null, message: `CostCap: model "${queryModel ?? "(none)"}" has no published rate and --unknown-models refuse is set. The upstream call was not made.` } };
        return null;
      });
      if (verdict) {
        emit({ ...base, blocked: true, reason: verdict.reason, cost_usd: 0, ...(verdict.model ? { outcome: "blocked_model", model } : verdict.detail) });
        writeHttpJson(socket, verdict.status, verdict.body, verdict.detail?.retry_after_s != null ? { "retry-after": String(verdict.detail.retry_after_s) } : {});
        return;
      }
    } catch {
      writeHttpJson(socket, 503, { error: "receipt_ledger_unavailable" });
      return;
    }
    // Dial the upstream. Compression is stripped so frames stay parseable; CostCap headers never leave.
    const target = new URL(`${upstream}/v1/realtime${url.search}`);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "host" || k.startsWith("x-costcap-") || k === "sec-websocket-extensions") continue;
      headers[k] = v;
    }
    headers.host = target.host;
    const client = target.protocol === "https:" ? https : http;
    const upReq = client.request(target, { method: "GET", headers });
    let settledHandshake = false;
    const handshakeTimer = setTimeout(() => upReq.destroy(new Error("upstream_timeout")), timeoutMs);
    handshakeTimer.unref?.();
    const noUpgrade = (status, body, reason) => {
      if (settledHandshake) return;
      settledHandshake = true;
      clearTimeout(handshakeTimer);
      // #135: a handshake that never got 101 generated nothing: $0 with status, no latch.
      try { emit({ ...base, status, blocked: false, model, cost_usd: 0, reason }); } catch { /* ledger failure surfaces on the next call */ }
      writeHttpJson(socket, status, body);
    };
    upReq.on("error", () => noUpgrade(502, { error: "upstream_unreachable", message: "CostCap could not open the Realtime WebSocket upstream." }, "upstream_handshake_failed"));
    upReq.on("response", (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { body = { error: "upstream_handshake_rejected" }; }
        noUpgrade(res.statusCode, body, "upstream_rejected");
      });
      res.on("error", () => noUpgrade(502, { error: "upstream_handshake_rejected" }, "upstream_rejected"));
    });
    upReq.on("upgrade", (upRes, upSocket, upHead) => {
      settledHandshake = true;
      clearTimeout(handshakeTimer);
      upSocket.on("error", () => {});
      if (socket.destroyed) { upSocket.destroy(); return; }
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        if (upRes.rawHeaders[i].toLowerCase() === "sec-websocket-extensions") continue;
        lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      let sessionId = null, closed = false;
      const inflight = new Set();
      const down = createFrameParser();
      const latch = (receipt, msg) => {
        const done = emit(receipt);
        failures.set(done.id, msg);
        recordSpend(done);
        flushWarnings();
        return done;
      };
      const shutdown = (code, reason, errorCode) => {
        if (closed) return;
        closed = true;
        sessions.delete(session);
        try {
          if (errorCode) socket.write(encodeFrame(0x1, JSON.stringify({ type: "error", error: { type: "costcap", code: errorCode, message: `CostCap: ${reason}. The session was closed.` } })));
          socket.write(encodeFrame(0x8, closePayload(code, `costcap: ${reason}`)));
        } catch { /* client already gone */ }
        socket.end();
        try { upSocket.write(encodeFrame(0x8, closePayload(1000, "costcap"), { mask: true })); } catch { /* upstream already gone */ }
        upSocket.end();
        setTimeout(() => { socket.destroy(); upSocket.destroy(); }, 1000).unref?.();
      };
      const finishIncomplete = () => {
        for (const id of inflight) {
          try { latch({ ...base, status: 101, blocked: false, model, session_id: sessionId, response_id: id, cost_usd: null, reason: "stream_incomplete" },
            "A Realtime response was cut before usage arrived. Restart only after reconciling this request."); } catch { hardFailure = "Receipt ledger unavailable."; }
        }
        inflight.clear();
      };
      const onEvent = (ev) => {
        if (!ev || typeof ev !== "object") return false;
        if ((ev.type === "session.created" || ev.type === "session.updated") && ev.session && typeof ev.session === "object") {
          if (typeof ev.session.id === "string") sessionId = ev.session.id;
          if (typeof ev.session.model === "string" && ev.session.model) model = ev.session.model;
        } else if (ev.type === "response.created" && typeof ev.response?.id === "string") {
          inflight.add(ev.response.id);
        } else if (ev.type === "response.done" && ev.response && typeof ev.response === "object") {
          const responseId = typeof ev.response.id === "string" ? ev.response.id : null;
          inflight.delete(responseId);
          const usage = realtimeUsage(ev.response.usage);
          const receiptBase = { ...base, status: 101, blocked: false, session_id: sessionId, response_id: responseId };
          if (!usage) {
            latch({ ...receiptBase, model, cost_usd: null, reason: "usage_unavailable" }, "A Realtime response reported no usable token usage. Restart only after reconciling this request.");
            return true;
          }
          const priced = costWithOverrides(userPrices, "openai", model, usage, { at: pinPrices ? pricingAt(now()) : now() });
          const receipt = { ...receiptBase, ...priced };
          rateLimit?.record(usageTokens(usage));
          if (receipt.cost_usd === null) {
            latch(receipt, receipt.reason === "modality_unpriced"
              ? `Non-text (audio/image) Realtime tokens were billed for ${receipt.model} with no published modality rate. Restart only after reconciling this request.`
              : "A Realtime response has no published rate. Restart only after reconciling this request.");
          } else {
            const done = emit(receipt);
            recordSpend(done);
            velocity?.record(done.cost_usd);
            flushWarnings();
          }
          return true;
        } else if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.usage && typeof ev.usage === "object") {
          latch({ ...base, status: 101, blocked: false, model, session_id: sessionId, item_id: typeof ev.item_id === "string" ? ev.item_id : null, cost_usd: null, reason: "transcription_unpriced" },
            "A Realtime input transcription was billed with no published rate. Restart only after reconciling this request.");
          return true;
        }
        return false;
      };
      const session = {
        terminate(reason, detail) {
          if (closed) return;
          try { emit({ ...base, blocked: true, reason, cost_usd: 0, model, session_id: sessionId, ...detail }); } catch { /* ledger */ }
          finishIncomplete();
          shutdown(1008, reason, reason);
        },
      };
      sessions.add(session);
      session.close = () => shutdown(1001, "proxy_closed");
      ensureKillTimer();
      const fromUpstream = (bytes) => {
        if (closed) return;
        for (const frame of down.push(bytes)) {
          if (closed) return;
          socket.write(frame.raw);
          if (!frame.message || frame.message.opcode !== 0x1) continue;
          let ev;
          try { ev = JSON.parse(frame.message.data.toString("utf8")); } catch { continue; }
          let metered;
          try { metered = onEvent(ev); } catch { hardFailure = "Receipt ledger unavailable."; shutdown(1011, "accounting_unavailable", "accounting_unavailable"); return; }
          if (!metered) continue;
          const g = guarded(() => sessionGate(model, reqTags));
          if (g) {
            if (g.reason === "killed") { session.terminate("killed", g.detail); return; }
            finishIncomplete();
            shutdown(1008, g.reason, g.reason);
            return;
          }
        }
        if (down.corrupt) { finishIncomplete(); shutdown(1009, "frame_too_large", "frame_too_large"); }
      };
      if (upHead?.length) fromUpstream(upHead);
      upSocket.on("data", fromUpstream);
      socket.on("data", (bytes) => { if (!closed) upSocket.write(bytes); });
      if (head?.length) upSocket.write(head);
      const onEnd = () => {
        if (closed) return;
        closed = true;
        sessions.delete(session);
        finishIncomplete();
        socket.end(); upSocket.end();
        setTimeout(() => { socket.destroy(); upSocket.destroy(); }, 1000).unref?.();
      };
      // The HTTP server allows half-open sockets, so a peer FIN alone ends the session.
      for (const s of [socket, upSocket]) { s.on("end", onEnd); s.on("close", onEnd); }
    });
    upReq.end();
  });
  // #171: a settlement (hosted poll or reconciliation) of a receipt that caused an
  // accounting failure clears that failure; the block lifts once all are settled.
  // #176: a settled pending batch is resolved, so a later results read in this run
  // neither emits a second reconciliation nor records its spend again.
  // #181: warn for fractions reached via settlements, sibling receipts or cap changes.
  server.checkWarnings = () => {
    if (!cap || !capWarner) return;
    const spend = cap.spend();
    pendingWarnings.push(...capWarner.reached({ caps: cap.limits(), spend, lowerBound: isLowerBound(spend) }));
    flushWarnings();
  };
  server.settle = (r) => {
    const id = r?.receipt_id ?? r?.id;
    if (typeof r?.batch_id === "string") resolvedBatches.add(r.batch_id);
    for (const [batchId, p] of pendingBatches) if (p.id === id) resolvedBatches.add(batchId);
    return failures.delete(id);
  };
  server.accountingFailure = accountingFailureNow;
  server.inFlight = () => inFlight;
  // Upgraded sockets are detached from the HTTP server, so close() shuts open sessions itself.
  const closeServer = server.close.bind(server);
  server.close = (cb) => { for (const s of [...sessions]) s.close(); if (killTimer) { clearInterval(killTimer); killTimer = null; } return closeServer(cb); };
  return server;
}

export function startMeteringProxy(opts = {}, port = 0) {
  const server = createMeteringProxy(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
