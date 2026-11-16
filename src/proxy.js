// Local, post-response metering. Only proxy-routed traffic is covered.
// Requests are serialized per proxy, so the next decision sees prior usage.
// A request already accepted by a provider can exceed the remaining budget.
import http from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { receiptPath } from "./receipt-path.js";
import { mergeTags, parseTagHeader, TAG_HEADER } from "./tags.js";
import { randomUUID } from "node:crypto";
import { costForUsage, isPricedModel } from "./pricing.js";
import { budgetExceededBody } from "./cap.js";
import { warningLine } from "./cap-warn.js";
import { createSpiralDetector } from "./spiral.js";
import { preflightCheck, openRouterModels } from "./preflight.js";
import { anthropicBatchModels, batchCreateProvider, batchReadPath, foldBatchResults } from "./batch.js";
import { loadLedgerLines, isSettlement } from "./cap.js";

const PROVIDERS = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api",
  gemini: "https://generativelanguage.googleapis.com",
};

export function baseUrlOverrides(port, providers = Object.keys(PROVIDERS)) {
  const lines = [];
  if (providers.includes("openai")) lines.push(`OPENAI_BASE_URL=http://127.0.0.1:${port}/openai/v1`);
  if (providers.includes("anthropic")) lines.push(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port}/anthropic`);
  if (providers.includes("openrouter")) lines.push(`OPENROUTER_BASE_URL=http://127.0.0.1:${port}/openrouter`);
  if (providers.includes("gemini")) {
    // Google's SDKs (go-genai, @google/genai) and Gemini CLI read GOOGLE_GEMINI_BASE_URL;
    // GEMINI_BASE_URL is kept for backward compatibility.
    lines.push(`GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:${port}/gemini`);
    lines.push(`GEMINI_BASE_URL=http://127.0.0.1:${port}/gemini`);
  }
  return lines;
}

const UNPRICED_RESPONSES_ITEMS = new Set(["web_search_call", "file_search_call"]);

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
const FILES_UPLOAD_PATHS = [/^\/anthropic\/v1\/files$/, /^\/openai\/v1\/files$/];
const FILES_DELETE_PATHS = [/^\/anthropic\/v1\/files\/[A-Za-z0-9_-]+$/, /^\/openai\/v1\/files\/[A-Za-z0-9_-]+$/];
export function isNonBillableFilesRequest(method, rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  if (/%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname)) return false;
  if (method === "POST") return FILES_UPLOAD_PATHS.some((re) => re.test(pathname));
  if (method === "DELETE") return FILES_DELETE_PATHS.some((re) => re.test(pathname));
  return false;
}

// OpenAI embeddings (#145): billed on input only. Exact path, same hardening as count_tokens.
export function isEmbeddingsPath(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  if (/%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname)) return false;
  return /^\/openai\/v1\/embeddings$/.test(pathname);
}

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

// Folds provider usage shapes from parsed JSON chunks (whole body or SSE events).
export function createUsageAccumulator(provider, requestedModel, { embeddings = false } = {}) {
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
  // OpenRouter only (#148): the provider-reported usage.cost (USD) is the exact charge for any routed model.
  // Absent/invalid values are ignored so pricing falls back to the table; it is never trusted on other routes.
  let providerCost;
  const noteResponsesItems = (items) => {
    if (Array.isArray(items) && items.some((it) => it && UNPRICED_RESPONSES_ITEMS.has(it.type))) toolUseUnpriced = true;
  };
  const add = (chunk) => {
    if (!chunk || typeof chunk !== "object") return;
    if (provider !== "anthropic" && provider !== "gemini") {
      noteResponsesItems(chunk.output);
      if (chunk.item) noteResponsesItems([chunk.item]);
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
      if (chunk.candidates.some((c) => c && typeof c.finishReason === "string")) geminiFinished = true;
    }
    if (provider === "gemini" && chunk.promptFeedback?.blockReason) geminiFinished = true;
    if (provider === "gemini") {
      const u = chunk.usageMetadata;
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
        const mt = modalityTokens({ input, cached_input: cached, output });
        if (mt) usage.modality_tokens = mt;
      }
    } else if (provider === "anthropic") {
      // message_start contains input usage; message_delta carries final output.
      const u = chunk.usage ?? chunk.message?.usage;
      if (u) {
        const stu = u.server_tool_use;
        if (stu && typeof stu === "object" && Object.entries(stu).some(([k, v]) => k.endsWith("_requests") && typeof v === "number" && v > 0)) toolUseUnpriced = true;
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
      if (embeddings && provider === "openai") {
        // Embeddings carry only prompt_tokens (input-only billing); anything else is unknown.
        usage = u && isCount(u.prompt_tokens) && u.completion_tokens == null ? { input_tokens: u.prompt_tokens, output_tokens: 0, cached_input_tokens: 0 } : { unpriceable: NaN };
        return;
      }
      // Both prompt/input and completion/output counters are required; duration-billed or empty shapes are unknown.
      if (u && !(isCount(u.prompt_tokens ?? u.input_tokens) && isCount(u.completion_tokens ?? u.output_tokens))) usage = { unpriceable: NaN };
      else if (u) usage = { input_tokens: (u.prompt_tokens ?? u.input_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0),
        output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
        cached_input_tokens: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0 };
      if (u && usage.input_tokens !== undefined) {
        const inDetails = u.prompt_tokens_details ?? u.input_tokens_details;
        const cachedDetails = inDetails?.cached_tokens_details;
        const cached = openaiModalitySlice(cachedDetails, usage.cached_input_tokens);
        const all = openaiModalitySlice(inDetails, usage.input_tokens + usage.cached_input_tokens);
        const input = all ? Object.fromEntries(Object.keys(all).map((k) => [k, Math.max(0, all[k] - (cached?.[k] ?? (k === "text" ? usage.cached_input_tokens : 0)))])) : null;
        const output = openaiModalitySlice(u.completion_tokens_details ?? u.output_tokens_details, usage.output_tokens);
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
    return { model, usage: { ...usage, ...signal }, ...(toolUseUnpriced && { toolUseUnpriced: true }), ...(providerCost !== undefined && { providerCost }) };
  };
  // A stream that never reached its provider's terminal event (or errored first) is incomplete.
  return { add, result, get incomplete() {
    return (responsesStream && !responsesTerminal) || (anthropicStream && (!anthropicStopped || anthropicErrored))
      || (geminiStream && !geminiFinished);
  } };
}

export function extractUsage(provider, text, requestedModel, opts = {}) {
  let chunks;
  try { const parsed = JSON.parse(text); chunks = Array.isArray(parsed) ? parsed : [parsed]; }
  catch {
    const parser = createSseUsageParser(provider, requestedModel);
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
export function createSseUsageParser(provider, requestedModel) {
  const acc = createUsageAccumulator(provider, requestedModel);
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

const REJECTED_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422, 429]);

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
  if (!CHAT_STREAM_PROVIDERS.has(provider) || method !== "POST" || !/\/chat\/completions\/?$/.test(pathname)) return null;
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
  try { const b = JSON.parse(raw.toString("utf8")); return typeof b?.id === "string" && /^[A-Za-z0-9_-]+$/.test(b.id) ? b.id : null; } catch { return null; }
}

export function createMeteringProxy({ receiptsPath, upstreams = PROVIDERS, onReceipt, cap,
  spiral = createSpiralDetector(), velocity, allowedModels, unknownModels = "fallback", killCheck, who = {}, agentBudgets, teamCheck, sharedLedger, capWarner, onWarning = (line) => console.error(line), preflight = false, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, streamIdleMs = DEFAULT_STREAM_IDLE_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, tags: wrapperTags = null } = {}) {
  if (receiptsPath) mkdirSync(dirname(receiptsPath), { recursive: true });
  let queue = Promise.resolve();
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
  const emitBase = (receipt) => guarded(() => {
    const complete = { id: randomUUID(), ts: new Date().toISOString(), ...who, ...receipt };
    agentBudgets?.record(complete);
    // Persist before invoking integrations. Callback failures must not break metering.
    if (receiptsPath) appendFileSync(receiptsPath, JSON.stringify(complete) + "\n", { mode: 0o600 });
    sharedLedger?.track?.(complete);
    try { Promise.resolve(onReceipt?.(complete)).catch(() => {}); } catch { /* delivery is outside the local ledger */ }
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
    const entry = { id: r.id, ts: r.ts, provider: r.provider, batch_id: batchId, run_id: r.run_id ?? null };
    pendingBatches.set(batchId, entry);
    if (lines.some((l) => isSettlement(l) && l.receipt_id === r.id)) resolvedBatches.add(batchId);
    return entry;
  };
  const emitEvent = (event) => guarded(() => {
    const complete = { ts: new Date().toISOString(), ...event };
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
    pendingWarnings.push(...capWarner.observe({ caps: cap.limits(), before, after, lowerBound: after.unknown > 0 }));
  };
  const flushWarnings = () => {
    const evs = pendingWarnings;
    pendingWarnings = [];
    for (const ev of evs) {
      const done = emitEvent(ev);
      try { onWarning(warningLine(done)); } catch { /* stderr is best effort */ }
    }
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const [, provider, ...rest] = url.pathname.split("/");
    const upstream = upstreams[provider];
    const send = (status, body, headers = {}) => { if (!res.writableEnded && !res.destroyed) res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body)); };
    if (!upstream || !rest.length) { send(404, { error: "unknown provider path" }); return; }
    // #169: x-costcap-tag is CostCap's, never the provider's. Wrapper tags win on a clash.
    let reqTags = null, tagError = null;
    try { reqTags = mergeTags(wrapperTags, parseTagHeader(req.headers[TAG_HEADER])); } catch (e) { tagError = e.message; }
    delete req.headers[TAG_HEADER];
    const emit = (receipt) => emitBase(reqTags ? { ...receipt, tags: reqTags } : receipt);
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
      const body = Buffer.concat(chunks);
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
        const batchCreate = batchCreateProvider(req.method, req.url);
        // #160: an Anthropic batch names its models per request; every one is checked.
        const batchModels = batchCreate === "anthropic" ? anthropicBatchModels(body) : null;
        if (batchModels && !requestedModel) requestedModel = batchModels.find(Boolean);
        // Model allowlist (#153): refused before forwarding; zero-cost receipt, the run is not frozen.
        const modelRefusal = (status, error, message) => {
          emit({ provider, path: storedPath, blocked: true, reason: error, outcome: "blocked_model", model: requestedModel ?? "unknown", cost_usd: 0 });
          send(status, { error, model: requestedModel ?? null, message });
          return "blocked";
        };
        let preflightEst;
        const verdict = guarded(() => {
          const killed = killCheck?.();
          if (killed) return block("killed", killed, { error: "killed", ...killed });
          const accountingFailure = accountingFailureNow();
          if (accountingFailure) return block("accounting_unavailable", {}, { error: "accounting_unavailable", message: accountingFailure });
          const generates = !["GET", "HEAD"].includes(req.method);
          const allow = generates ? allowedModels?.() ?? null : null;
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
          if (generates && unknownModels === "refuse" && offending(isPricedModel) !== -1) {
            refuse(offending(isPricedModel));
            return modelRefusal(403, "model_unpriced", `CostCap: model "${requestedModel ?? "(none)"}" has no published rate and --unknown-models refuse is set. The upstream call was not made.`);
          }
          const agentHit = agentBudgets?.check(who);
          if (agentHit) return block(agentHit.reason, agentHit, { error: agentHit.verdict, ...agentHit });
          const teamHit = teamCheck?.();
          if (teamHit) return block(teamHit.reason, teamHit, { error: teamHit.verdict, ...teamHit });
          const hit = cap?.check();
          if (hit) return block("budget_exceeded", hit, budgetExceededBody(hit));
          if (preflight) {
            const pf = preflightCheck(cap, provider, body, path, (est) => { preflightEst = est; });
            if (pf?.reason === "preflight_unpriced") return block("preflight_unpriced", pf, { error: { type: "preflight_unpriced", model: pf.model,
              message: `CostCap preflight: model "${pf.model}" has no published rate, so its worst case cannot be estimated. The upstream call was not made.` } });
            if (pf) return block("budget_exceeded", pf, { error: { type: "budget_exceeded", reason: "preflight_estimate", estimate: true,
              message: `CostCap preflight estimate: worst case $${pf.estimate_usd} does not fit the remaining ${pf.scope} budget ($${pf.remaining_usd[pf.scope]}). This is an estimate. The upstream call was not made.`,
              scope: pf.scope, estimate_usd: pf.estimate_usd, remaining_usd: pf.remaining_usd } });
          }
          const vhit = velocity?.check();
          if (vhit) return block(vhit.reason, vhit, { error: "breaker_open", ...vhit });
          const spiralHit = spiral?.observe(req.method, path, body.toString("utf8"));
          if (spiralHit) return block("spiral_detected", spiralHit, { error: "spiral_detected", ...spiralHit });
          return null;
        });
        if (verdict === "blocked") return;
        const injected = injectStreamUsage(provider, req.method, `/${rest.join("/")}`, body);
        const headers = { ...req.headers };
        for (const key of ["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]) delete headers[key];
        try {
          const abort = new AbortController();
          let timer;
          const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => abort.abort(new Error("upstream_timeout")), ms); timer.unref?.(); };
          arm(timeoutMs);
          const onClientClose = () => { if (!res.writableFinished) abort.abort(); };
          res.once("close", onClientClose);
          const upstreamRes = await fetch(`${upstream}${path}`, { method: req.method, headers,
            body: ["GET", "HEAD"].includes(req.method) ? undefined : (injected ?? body),
            // Never follow redirects: x-api-key / x-goog-api-key would be forwarded to another host.
            redirect: "manual",
            signal: abort.signal });
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
          const receipt = { provider, path: storedPath, status: upstreamRes.status, blocked: false,
            ...(preflightEst && { output_tokens_est: preflightEst.output_tokens, output_multiplier: preflightEst.output_multiplier }) };
          let metered, raw, streamCut = false, sseIncomplete = false;
          if (/^text\/event-stream/i.test(contentType) && upstreamRes.body) {
            // Real-time pass-through: forward each chunk as it arrives, meter from the stream.
            const parser = createSseUsageParser(provider, requestedModel);
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
              res.writeHead(upstreamRes.status, { "content-type": contentType, "cache-control": "no-cache" });
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
                  await forward(Buffer.from(filter.push(text)));
                } else {
                  parser.push(decoder.decode(value, { stream: true }));
                  await forward(value);
                }
              }
              const tail = decoder.decode();
              parser.push(tail);
              if (filter) await forward(Buffer.from(filter.push(tail) + filter.end()));
            } catch {
              streamCut = true;
              abort.abort();
              reader.cancel().catch(() => {});
            }
            metered = parser.end();
            // Stream ended without its terminal event (Responses, Anthropic message_stop, Gemini finishReason): usage is partial or absent.
            if (parser.incomplete) { sseIncomplete = true; metered = null; }
          } else {
            raw = Buffer.from(await upstreamRes.arrayBuffer());
            metered = extractUsage(provider, raw.toString("utf8"), requestedModel,
              { embeddings: req.method === "POST" && isEmbeddingsPath(req.url) });
          }
          clearTimeout(timer);
          res.off("close", onClientClose);
          if (metered) {
            Object.assign(receipt, costForUsage(metered.model, metered.usage));
            if (metered.providerCost !== undefined && receipt.cost_usd !== null) Object.assign(receipt, { cost_usd: Number(metered.providerCost.toFixed(6)), cost_source: "provider", fallback: false });
            if (metered.toolUseUnpriced) Object.assign(receipt, { cost_usd: null, reason: "tool_use_unpriced" });
            recordSpend(receipt);
            if (receipt.reason === "tool_use_unpriced") failMsg = "A provider-side tool (web search / file search) was billed with no published rate. Restart only after reconciling this request.";
            else if (receipt.reason === "modality_unpriced") failMsg = `Non-text (audio/image/video) tokens were billed for ${receipt.model} with no published modality rate. Restart only after reconciling this request.`;
            else if (receipt.reason === "service_tier_unpriced") failMsg = `A premium ${receipt.pricing_tier} tier was billed for ${receipt.model} with no published rate. Restart only after reconciling this request.`;
            else if (receipt.cost_usd === null) failMsg = "A cache write has no published rate for this model. Restart only after reconciling this request.";
            else velocity?.record(receipt.cost_usd);
          } else if (streamCut || sseIncomplete) {
            // Stream cut (upstream error, client abort or timeout) before usage arrived.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: null, reason: "stream_incomplete" });
            failMsg = "A streamed response was cut before usage arrived. Restart only after reconciling this request.";
          } else if (raw && REJECTED_STATUSES.has(upstreamRes.status) && isProviderError(raw)) {
            // Provider rejected the request before generation (rate limit, auth, bad request): not billed.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: 0, reason: "upstream_rejected" });
          } else if (raw && batchCreate && upstreamRes.status >= 200 && upstreamRes.status < 300 && batchIdOf(raw)) {
            // #160: a batch is billed when it runs. Pending, unknown (never $0), and the run continues.
            const batch_id = batchIdOf(raw);
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: null, reason: "batch_pending", batch_id,
              ...(batchModels && { request_count: batchModels.length }) });
            const done = emit(receipt);
            pendingBatches.set(batch_id, { id: done.id, ts: done.ts, provider: batchCreate, batch_id, run_id: done.run_id ?? null });
            if (!res.destroyed) res.writeHead(upstreamRes.status, { "content-type": contentType }).end(raw);
            return;
          } else if (raw && req.method === "GET" && upstreamRes.status >= 200 && upstreamRes.status < 300 && batchReadPath(req.method, req.url)) {
            Object.assign(receipt, { model: "unknown", cost_usd: 0, reason: "non_billable_request" });
            const read = batchReadPath(req.method, req.url);
            let batchId = null;
            if (read.kind === "openai_batch") {
              try {
                const b = JSON.parse(raw.toString("utf8"));
                if (typeof b?.output_file_id === "string" && /^[A-Za-z0-9_-]+$/.test(b.output_file_id) && findPending(read.id)?.provider === "openai") batchFiles.set(b.output_file_id, read.id);
              } catch { /* not a batch object: nothing to link */ }
            } else if (read.kind === "anthropic_results") batchId = read.id;
            else batchId = batchFiles.get(read.id) ?? null;
            const pending = batchId ? findPending(batchId) : null;
            if (pending && !resolvedBatches.has(batchId) && pending.provider === provider) {
              resolvedBatches.add(batchId);
              const folded = foldBatchResults(provider, raw.toString("utf8"));
              receipt.batch_id = batchId;
              if (folded.ok) {
                emitEvent({ event: "reconciliation", receipt_id: pending.id, cost_usd: folded.cost_usd, source: "batch_results", batch_id: batchId,
                  succeeded: folded.succeeded, not_billed: folded.free });
                // #182: another run's (or wrapper's) batch counts toward day/month only, like src/settle.js.
                const external = !(who.run_id != null && pending.run_id === who.run_id);
                recordSpend({ cost_usd: folded.cost_usd, ts: pending.ts }, { external });
                // #179: --policy agent/team budgets count the batch at its original ts, no restart needed.
                agentBudgets?.settle({ receipt_id: pending.id, cost_usd: folded.cost_usd });
                flushWarnings();
              } else {
                // Unpriced, premium-speed or malformed results: the batch stays unknown, never $0.
                Object.assign(receipt, { cost_usd: null, reason: "batch_unpriced" });
                failMsg = "Batch results could not be priced. Restart only after reconciling this batch.";
              }
            }
          } else if (raw && (["GET", "HEAD"].includes(req.method) ||
            (upstreamRes.status >= 200 && upstreamRes.status < 300 &&
              ((req.method === "POST" && isCountTokensPath(req.url)) || isNonBillableFilesRequest(req.method, req.url))))) {
            // Metadata reads, token-count endpoints and Files upload/delete never generate tokens.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: 0, reason: "non_billable_request" });
          } else {
            // Unknown spend is never silently free. Stop subsequent calls.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: null, reason: "usage_unavailable" });
            failMsg = "Provider returned no usable token usage. Restart only after reconciling this request.";
          }
          const emitted = emit(receipt);
          // #171: the unknown counts on the running cap engine so a settle lands exactly once.
          if (failMsg) { failures.set(emitted.id, failMsg); if (!metered) recordSpend(emitted); failMsg = null; }
          flushWarnings();
          if (raw) { if (!res.destroyed) res.writeHead(upstreamRes.status, { "content-type": contentType }).end(raw); }
          else if (streamCut) res.destroy();
          else if (!res.destroyed) res.end();
        } catch {
          // A failed fetch may already have billed upstream. Do not assume zero.
          hardFailure = "Upstream outcome or receipt persistence is uncertain. Reconcile before restarting.";
          try { emit({ provider, path: storedPath, blocked: false, cost_usd: null, reason: "upstream_outcome_unknown" }); } catch { /* stop on broken ledger */ }
          send(502, { error: "upstream_outcome_unknown" });
        }
      };
      queue = queue.then(run).catch(() => { hardFailure = "Receipt ledger unavailable."; send(503, { error: "receipt_ledger_unavailable" }); });
    });
  });
  // #171: a settlement (hosted poll or reconciliation) of a receipt that caused an
  // accounting failure clears that failure; the block lifts once all are settled.
  // #176: a settled pending batch is resolved, so a later results read in this run
  // neither emits a second reconciliation nor records its spend again.
  // #181: warn for fractions reached via settlements, sibling receipts or cap changes.
  server.checkWarnings = () => {
    if (!cap || !capWarner) return;
    const spend = cap.spend();
    pendingWarnings.push(...capWarner.reached({ caps: cap.limits(), spend, lowerBound: spend.unknown > 0 }));
    flushWarnings();
  };
  server.settle = (r) => {
    const id = r?.receipt_id ?? r?.id;
    if (typeof r?.batch_id === "string") resolvedBatches.add(r.batch_id);
    for (const [batchId, p] of pendingBatches) if (p.id === id) resolvedBatches.add(batchId);
    return failures.delete(id);
  };
  server.accountingFailure = accountingFailureNow;
  return server;
}

export function startMeteringProxy(opts = {}, port = 0) {
  const server = createMeteringProxy(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
