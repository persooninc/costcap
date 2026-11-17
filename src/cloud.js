// Claude on Amazon Bedrock and Google Vertex AI (#188): route classification, upstream
// host derivation, path-model mapping and a real-time AWS eventstream decoder.
// The Anthropic Messages wire format (invoke / rawPredict and their streaming forms) and
// Bedrock Converse / ConverseStream (#216) are metered. Anything else is answered locally with 404 cloud_route_unsupported.
import { resolveModelId, vertexGeminiModels } from "./pricing.js";
import { bedrockBaseId, isBedrockThirdParty, isListedBedrockModel } from "./bedrock-pricing.js";

export const CLOUD_PROVIDERS = Object.freeze(["bedrock", "vertex"]);
export const isCloudProvider = (p) => CLOUD_PROVIDERS.includes(p);

// Placeholder upstreams: the real host depends on the region (Bedrock) or path location (Vertex).
export const BEDROCK_UPSTREAM = "aws:bedrock-runtime";
export const VERTEX_UPSTREAM = "gcp:aiplatform";

const BEDROCK_ROUTE = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|count-tokens|converse|converse-stream)$/;
const VERTEX_ROUTE = /^\/v1(?:beta1)?\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/([^/]+)\/models\/([^/:]+):(rawPredict|streamRawPredict|generateContent|streamGenerateContent|countTokens)$/;
const GEMINI_VERBS = new Set(["generateContent", "streamGenerateContent", "countTokens"]);
const REGION = /^[a-z]+-[a-z]+\d+$/; // GCP regions: us-east5, europe-west1

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

/**
 * Classifies a cloud path (the part after /bedrock or /vertex, no query).
 * Returns null for unsupported routes, else
 * { modelId, stream, countTokens, scope: "global"|"regional", location? }.
 */
export function classifyCloudRoute(provider, method, pathname) {
  if (method !== "POST") return null;
  if (/\/\.{1,2}(?:\/|$)|\/\/|\\/.test(pathname)) return null;
  if (provider === "bedrock") {
    const m = BEDROCK_ROUTE.exec(pathname);
    if (!m) return null;
    const modelId = safeDecode(m[1]);
    if (!modelId) return null;
    return { modelId, stream: m[2] === "invoke-with-response-stream" || m[2] === "converse-stream", countTokens: m[2] === "count-tokens",
      ...(m[2].startsWith("converse") && { converse: true }), scope: /^global\./.test(modelId) ? "global" : "regional" };
  }
  if (provider === "vertex") {
    const m = VERTEX_ROUTE.exec(pathname);
    if (!m) return null;
    const location = m[2];
    if (location !== "global" && !REGION.test(location)) return null; // multi-region hosts are out of scope
    if (GEMINI_VERBS.has(m[5])) {
      // #217: Gemini on Vertex (publisher google only); the model id is in the path.
      if (m[3] !== "google") return null;
      const modelId = safeDecode(m[4]);
      if (!modelId) return null;
      return { modelId: `google/${modelId}`, publisher: "google", gemini: true, stream: m[5] === "streamGenerateContent",
        countTokens: m[5] === "countTokens", scope: location === "global" ? "global" : "regional", location };
    }
    const countTokens = m[4] === "count-tokens";
    if (countTokens && m[5] !== "rawPredict") return null;
    return { modelId: countTokens ? null : `${m[3] === "anthropic" ? "" : `${m[3]}/`}${m[4]}`, publisher: m[3], stream: m[5] === "streamRawPredict",
      countTokens, scope: location === "global" ? "global" : "regional", location };
  }
  return null;
}

/**
 * #216: Bedrock Converse usage ({inputTokens, outputTokens, cacheReadInputTokens,
 * cacheWriteInputTokens}) in Anthropic Messages shape, or null when the counters are missing.
 */
export function converseUsage(u) {
  if (!u || typeof u !== "object") return null;
  const ok = (v) => Number.isInteger(v) && v >= 0;
  if (!ok(u.inputTokens) || !ok(u.outputTokens)) return null;
  return { input_tokens: u.inputTokens, output_tokens: u.outputTokens,
    ...(u.cacheReadInputTokens != null && { cache_read_input_tokens: u.cacheReadInputTokens }),
    ...(u.cacheWriteInputTokens != null && { cache_creation_input_tokens: u.cacheWriteInputTokens }) };
}

/**
 * #288: usage from a non-Anthropic Bedrock InvokeModel response, in Anthropic Messages shape, or null.
 * Accepts the native body shapes (Nova `usage.inputTokens`, Llama `prompt_token_count`, OpenAI-style
 * `usage.prompt_tokens` for gpt-oss / DeepSeek / Qwen / Mistral chat), a stream's final
 * `amazon-bedrock-invocationMetrics`, or the `X-Amzn-Bedrock-*-Token-Count` response headers.
 */
const isCount = (v) => Number.isInteger(v) && v >= 0;
const cacheFields = (read, write) => {
  if ((read != null && !isCount(read)) || (write != null && !isCount(write))) return undefined;
  return { ...(read != null && { cache_read_input_tokens: read }), ...(write != null && { cache_creation_input_tokens: write }) };
};
export function invocationMetricsUsage(m) {
  if (!m || typeof m !== "object" || !isCount(m.inputTokenCount) || !isCount(m.outputTokenCount)) return null;
  const c = cacheFields(m.cacheReadInputTokenCount, m.cacheWriteInputTokenCount);
  return c ? { input_tokens: m.inputTokenCount, output_tokens: m.outputTokenCount, ...c } : null;
}
export function bedrockInvokeBodyUsage(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const u = body.usage;
  if (u && typeof u === "object" && (u.inputTokens != null || u.outputTokens != null)) {
    if (!isCount(u.inputTokens) || !isCount(u.outputTokens)) return null;
    const c = cacheFields(u.cacheReadInputTokenCount ?? u.cacheReadInputTokens, u.cacheWriteInputTokenCount ?? u.cacheWriteInputTokens);
    return c ? { input_tokens: u.inputTokens, output_tokens: u.outputTokens, ...c } : null;
  }
  if (u && typeof u === "object" && (u.prompt_tokens != null || u.completion_tokens != null)) {
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    if (!isCount(u.prompt_tokens) || !isCount(u.completion_tokens) || !isCount(cached) || cached > u.prompt_tokens) return null;
    return { input_tokens: u.prompt_tokens - cached, output_tokens: u.completion_tokens, ...(cached > 0 && { cache_read_input_tokens: cached }) };
  }
  if (body.prompt_token_count != null || body.generation_token_count != null) {
    if (!isCount(body.prompt_token_count) || !isCount(body.generation_token_count)) return null;
    return { input_tokens: body.prompt_token_count, output_tokens: body.generation_token_count };
  }
  return invocationMetricsUsage(body["amazon-bedrock-invocationMetrics"]);
}
export function bedrockHeaderUsage(headers) {
  const get = (k) => { const v = headers?.get?.(k); return v == null || !/^\d+$/.test(v) ? (v == null ? undefined : NaN) : Number(v); };
  const input = get("x-amzn-bedrock-input-token-count"), output = get("x-amzn-bedrock-output-token-count");
  if (!isCount(input) || !isCount(output)) return null;
  const read = get("x-amzn-bedrock-cache-read-input-token-count"), write = get("x-amzn-bedrock-cache-write-input-token-count");
  const c = cacheFields(read, write);
  return c ? { input_tokens: input, output_tokens: output, ...c } : null;
}

/** Real upstream origin for a Vertex location. */
export function vertexHost(location) {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

export function bedrockHost(region) {
  return `bedrock-runtime.${region}.amazonaws.com`;
}

const BEDROCK_GEO = /^(?:global|us|eu|apac|jp|au)\./;

/**
 * Maps a raw Bedrock/Vertex model id to the pricing-table id (#278: or a listed non-Anthropic
 * Bedrock base id), or null when it is not a model we can price (non-Anthropic, ARN, unlisted). Never the fallback.
 */
export function mapCloudModel(provider, rawId) {
  if (typeof rawId !== "string" || !rawId) return null;
  let id = rawId;
  if (provider === "bedrock") {
    if (id.startsWith("arn:")) return null;
    // #278: a listed non-Anthropic model maps to its base id (geo prefix stripped; rates are per region).
    if (isBedrockThirdParty(id)) { const b = bedrockBaseId(id); return isListedBedrockModel(b) ? b : null; }
    id = id.replace(BEDROCK_GEO, "");
    if (!id.startsWith("anthropic.")) return null;
    id = id.slice("anthropic.".length).replace(/-v\d+(?::\d+)?$/, "");
  } else if (provider === "vertex") {
    if (id.startsWith("google/")) return mapVertexGemini(id.slice("google/".length));
    if (id.includes("/")) return null; // non-Anthropic publisher
    id = id.replace(/@(?:\d{8}|latest)$/, "");
  } else return null;
  if (!id.startsWith("claude-")) return null;
  return resolveModelId(id);
}

/**
 * #217: a Vertex Gemini model id (gemini-2.5-pro, gemini-2.5-flash@001, gemini-2.0-flash-001)
 * mapped to its pricing-table id, only when the table lists a Vertex rate for it. Else null.
 */
export function mapVertexGemini(rawId) {
  if (typeof rawId !== "string" || !rawId.startsWith("gemini-")) return null;
  const listed = vertexGeminiModels();
  for (const id of [rawId, rawId.replace(/@[A-Za-z0-9._-]+$/, ""), rawId.replace(/@[A-Za-z0-9._-]+$/, "").replace(/-\d{3}$/, "")]) {
    if (listed.includes(id)) return id;
  }
  return null;
}

// ---- AWS eventstream (application/vnd.amazon.eventstream) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const HEADER_FIXED = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };

export function parseEventHeaders(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const nameLen = buf[i]; i += 1;
    const name = buf.subarray(i, i + nameLen).toString("utf8"); i += nameLen;
    const type = buf[i]; i += 1;
    if (type === 6 || type === 7) {
      const len = buf.readUInt16BE(i); i += 2;
      const raw = buf.subarray(i, i + len); i += len;
      out[name] = type === 7 ? raw.toString("utf8") : raw;
    } else if (type in HEADER_FIXED) {
      out[name] = type === 0 ? true : type === 1 ? false : null;
      i += HEADER_FIXED[type];
    } else throw new Error("bad header type");
    if (i > buf.length) throw new Error("truncated header");
  }
  return out;
}

/** Encodes one frame (used by tests and fakes). Headers are string-valued. */
export function encodeEventFrame(headers, payload) {
  const hparts = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = Buffer.from(k, "utf8"), val = Buffer.from(String(v), "utf8");
    const h = Buffer.alloc(1 + name.length + 1 + 2 + val.length);
    h[0] = name.length; name.copy(h, 1); h[1 + name.length] = 7;
    h.writeUInt16BE(val.length, 2 + name.length); val.copy(h, 4 + name.length);
    hparts.push(h);
  }
  const hbuf = Buffer.concat(hparts), body = Buffer.from(payload);
  const total = 12 + hbuf.length + body.length + 4;
  const frame = Buffer.alloc(total);
  frame.writeUInt32BE(total, 0); frame.writeUInt32BE(hbuf.length, 4);
  frame.writeUInt32BE(crc32(frame, 0, 8), 8);
  hbuf.copy(frame, 12); body.copy(frame, 12 + hbuf.length);
  frame.writeUInt32BE(crc32(frame, 0, total - 4), total - 4);
  return frame;
}

/** A ConverseStream event frame (messageStart, contentBlockDelta, messageStop, metadata, ...). */
export function converseEventFrame(type, payload) {
  return encodeEventFrame({ ":event-type": type, ":content-type": "application/json", ":message-type": "event" }, JSON.stringify(payload));
}

/** A Bedrock chunk frame wrapping one Anthropic stream event. */
export function bedrockChunkFrame(event) {
  return encodeEventFrame({ ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" },
    JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") }));
}

/**
 * Incremental decoder. push(bytes) accepts arbitrary splits; each complete, CRC-valid
 * chunk frame's decoded Anthropic event is passed to onEvent. A bad CRC, a malformed
 * frame or an exception frame marks the stream corrupt (never priced).
 */
export function createEventStreamDecoder(onEvent, { converse = false } = {}) {
  let pending = Buffer.alloc(0);
  let corrupt = false;
  const frame = (f) => {
    const total = f.readUInt32BE(0), hlen = f.readUInt32BE(4);
    if (crc32(f, 0, 8) !== f.readUInt32BE(8) || crc32(f, 0, total - 4) !== f.readUInt32BE(total - 4) || 12 + hlen + 4 > total) { corrupt = true; return; }
    let headers;
    try { headers = parseEventHeaders(f.subarray(12, 12 + hlen)); } catch { corrupt = true; return; }
    if (headers[":message-type"] !== "event") { corrupt = true; return; }
    if (converse) {
      // #216: ConverseStream frames carry their event JSON directly, typed by :event-type.
      try { onEvent(JSON.parse(f.subarray(12 + hlen, total - 4).toString("utf8")), headers[":event-type"]); } catch { corrupt = true; }
      return;
    }
    if (headers[":event-type"] !== "chunk") return;
    try {
      const outer = JSON.parse(f.subarray(12 + hlen, total - 4).toString("utf8"));
      onEvent(JSON.parse(Buffer.from(outer.bytes, "base64").toString("utf8")));
    } catch { corrupt = true; }
  };
  return {
    push(chunk) {
      if (corrupt) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      while (!corrupt && pending.length >= 12) {
        const total = pending.readUInt32BE(0);
        if (total < 16 || total > 16 * 1024 * 1024) { corrupt = true; break; }
        if (pending.length < total) break;
        frame(pending.subarray(0, total));
        pending = pending.subarray(total);
      }
    },
    get corrupt() { return corrupt; },
    /** True when bytes remain that never formed a whole frame. */
    get partial() { return pending.length > 0; },
  };
}
