// Claude on Amazon Bedrock and Google Vertex AI (#188): route parsing, upstream
// host derivation, path-model mapping and the binary AWS eventstream decoder.
// Portable: pure functions plus one stateful decoder; no globals, no deps.
import { resolveModelId } from "./pricing.js";

export const CLOUD_PROVIDERS = Object.freeze(["bedrock", "vertex"]);
export const isCloudProvider = (p) => CLOUD_PROVIDERS.includes(p);

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

// Bedrock: geo prefix (cross-region inference profiles), "anthropic." vendor prefix, -vN[:M] version.
const BEDROCK_GEO = /^(global|us|eu|apac|jp|au)\./;
const BEDROCK_PATH = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|count-tokens)$/;
// Vertex: single-region locations look like us-east5 / europe-west1; "global" is the global endpoint.
const VERTEX_REGION = /^[a-z]+-[a-z]+\d+$/;
const VERTEX_PATH = /^\/v1(?:beta1)?\/projects\/[^/]+\/locations\/([^/]+)\/publishers\/([^/]+)\/models\/([^/:]+):([A-Za-z]+)$/;

/** Maps a raw Bedrock model id to a pricing-table id, or null (non-Anthropic, ARN, unlisted). */
export function mapBedrockModel(raw) {
  if (typeof raw !== "string" || !raw || raw.startsWith("arn:")) return null;
  const id = raw.replace(BEDROCK_GEO, "");
  if (!id.startsWith("anthropic.")) return null;
  return resolveModelId(id.slice("anthropic.".length).replace(/-v\d+(?::\d+)?$/, ""));
}

/** Maps a raw Vertex model id (claude-opus-4-5@20251101) to a pricing-table id, or null. */
export function mapVertexModel(raw) {
  if (typeof raw !== "string" || !raw.startsWith("claude-")) return null;
  return resolveModelId(raw.replace(/@\d{8}$/, ""));
}

/**
 * Parses a cloud route. `rawPath` is the path after /bedrock or /vertex, still
 * percent-encoded. Returns { ok: false } for anything outside the supported
 * surface (answered locally with 404 cloud_route_unsupported), else
 * { ok: true, provider, rawModel, model, scope, countTokens, stream, region?, location? }.
 */
export function parseCloudRoute(provider, rawPath) {
  if (provider === "bedrock") {
    const m = BEDROCK_PATH.exec(rawPath);
    if (!m) return { ok: false };
    const rawModel = safeDecode(m[1]);
    if (rawModel === null) return { ok: false };
    const countTokens = m[2] === "count-tokens";
    return { ok: true, provider, rawModel, model: mapBedrockModel(rawModel), scope: rawModel.startsWith("global.") ? "global" : "regional",
      countTokens, stream: m[2] === "invoke-with-response-stream" };
  }
  if (provider === "vertex") {
    const m = VERTEX_PATH.exec(rawPath);
    if (!m) return { ok: false };
    const [, location, publisher, rawModelEnc, method] = m;
    if (location !== "global" && !VERTEX_REGION.test(location)) return { ok: false };
    if (!["rawPredict", "streamRawPredict"].includes(method)) return { ok: false };
    const rawModel = safeDecode(rawModelEnc);
    if (rawModel === null) return { ok: false };
    const countTokens = publisher === "anthropic" && rawModel === "count-tokens";
    return { ok: true, provider, location, rawModel, model: publisher === "anthropic" && !countTokens ? mapVertexModel(rawModel) : null,
      scope: location === "global" ? "global" : "regional", countTokens, stream: method === "streamRawPredict" };
  }
  return { ok: false };
}

/** Real upstream origin for a cloud route. `override` (test hook) wins when set. */
export function cloudUpstream(provider, { region, location, override } = {}) {
  if (override) return override;
  if (provider === "bedrock") return region && /^[a-z0-9-]+$/.test(region) ? `https://bedrock-runtime.${region}.amazonaws.com` : null;
  if (provider === "vertex") return location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
  return null;
}

/** One stderr note when Claude Code is set to Bedrock but the proxy can neither re-sign nor pass a bearer token. */
export function bedrockStartupNote(env = {}) {
  if (env.CLAUDE_CODE_USE_BEDROCK !== "1") return null;
  if ((env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) || env.AWS_BEARER_TOKEN_BEDROCK) return null;
  return 'costcap: CLAUDE_CODE_USE_BEDROCK=1 but no static AWS credentials or AWS_BEARER_TOKEN_BEDROCK are set; signed Bedrock calls will be refused. Run eval "$(aws configure export-credentials --format env)" first.';
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

/** Parses eventstream headers into { name: value } (strings, numbers, booleans; others as Buffers). */
export function parseEventHeaders(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const nameLen = buf[i]; i += 1;
    const name = buf.subarray(i, i + nameLen).toString("utf8"); i += nameLen;
    const type = buf[i]; i += 1;
    let value;
    switch (type) {
      case 0: value = true; break;
      case 1: value = false; break;
      case 2: value = buf.readInt8(i); i += 1; break;
      case 3: value = buf.readInt16BE(i); i += 2; break;
      case 4: value = buf.readInt32BE(i); i += 4; break;
      case 5: value = Number(buf.readBigInt64BE(i)); i += 8; break;
      case 6: case 7: { const len = buf.readUInt16BE(i); i += 2; const v = buf.subarray(i, i + len); i += len; value = type === 7 ? v.toString("utf8") : v; break; }
      case 8: value = Number(buf.readBigInt64BE(i)); i += 8; break;
      case 9: value = buf.subarray(i, i + 16); i += 16; break;
      default: throw new Error("eventstream_bad_header");
    }
    out[name] = value;
  }
  return out;
}

/** Encodes one eventstream frame with string headers (tests and fakes). */
export function encodeEventFrame(headers, payload) {
  const parts = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name), v = Buffer.from(String(value));
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    h[0] = n.length; n.copy(h, 1); h[1 + n.length] = 7; h.writeUInt16BE(v.length, 2 + n.length); v.copy(h, 4 + n.length);
    parts.push(h);
  }
  const hb = Buffer.concat(parts), pb = Buffer.from(payload);
  const total = 12 + hb.length + pb.length + 4;
  const frame = Buffer.alloc(total);
  frame.writeUInt32BE(total, 0); frame.writeUInt32BE(hb.length, 4); frame.writeUInt32BE(crc32(frame, 0, 8), 8);
  hb.copy(frame, 12); pb.copy(frame, 12 + hb.length);
  frame.writeUInt32BE(crc32(frame, 0, total - 4), total - 4);
  return frame;
}

/** A Bedrock invoke-with-response-stream "chunk" frame wrapping one Anthropic event. */
export const bedrockChunkFrame = (event) => encodeEventFrame({ ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" },
  JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") }));

/**
 * Incremental eventstream decoder. push() accepts arbitrary byte chunks (frames
 * may split anywhere); every complete Bedrock chunk payload is decoded and handed
 * to onEvent(json). A CRC mismatch, malformed frame or exception message marks
 * the stream `corrupt` and stops decoding (bytes are still forwarded by the caller).
 */
export function createEventStreamDecoder(onEvent) {
  let pending = Buffer.alloc(0);
  let corrupt = false;
  const fail = () => { corrupt = true; pending = Buffer.alloc(0); };
  return {
    push(chunk) {
      if (corrupt) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      while (pending.length >= 12) {
        const total = pending.readUInt32BE(0), hlen = pending.readUInt32BE(4);
        if (crc32(pending, 0, 8) !== pending.readUInt32BE(8) || total < 16 || hlen > total - 16) return fail();
        if (pending.length < total) return;
        if (crc32(pending, 0, total - 4) !== pending.readUInt32BE(total - 4)) return fail();
        let headers;
        try { headers = parseEventHeaders(pending.subarray(12, 12 + hlen)); } catch { return fail(); }
        const payload = pending.subarray(12 + hlen, total - 4);
        pending = pending.subarray(total);
        if (headers[":message-type"] !== "event") return fail();
        if (headers[":event-type"] !== "chunk") continue;
        try {
          const outer = JSON.parse(payload.toString("utf8"));
          if (typeof outer?.bytes === "string") onEvent(JSON.parse(Buffer.from(outer.bytes, "base64").toString("utf8")));
        } catch { /* non-JSON payload is forwarded unmetered */ }
      }
    },
    end() { if (pending.length) corrupt = true; },
    get corrupt() { return corrupt; },
  };
}
