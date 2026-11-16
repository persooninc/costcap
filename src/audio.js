// OpenAI audio metering (#198): transcriptions / translations (multipart, billed per
// minute or per token) and speech (JSON, billed per character or per token).
// Pure helpers; src/proxy.js wires them in. Unknown stays unknown (null), never $0.

import { lookupPrice } from "./pricing.js";

const AUDIO_PATH = /^\/v1\/audio\/(transcriptions|translations|speech)\/?(?:\?|$)/;

// "transcription" | "translation" | "speech" | null for a POST on the first-party OpenAI route.
export function audioRoute(method, url) {
  if (method !== "POST" || typeof url !== "string") return null;
  const path = url.replace(/^\/openai(?=\/)/, "");
  const m = AUDIO_PATH.exec(path);
  if (!m) return null;
  return m[1] === "transcriptions" ? "transcription" : m[1] === "translations" ? "translation" : "speech";
}

const READ_FIELDS = new Set(["model", "response_format", "stream"]);
export const MULTIPART_FIELD_MAX = 256;

function boundaryOf(contentType) {
  if (typeof contentType !== "string" || !/^\s*multipart\/form-data\s*;/i.test(contentType)) return null;
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType);
  return m ? m[1] ?? m[2] : null;
}

// Bounded multipart reader: only text parts named model / response_format / stream,
// each capped at MULTIPART_FIELD_MAX bytes. File parts are skipped (never copied).
// Returns null when the body is not parseable multipart; { fields, duplicateModel } otherwise.
export function parseMultipartFields(body, contentType) {
  const boundary = boundaryOf(contentType);
  if (!boundary || !Buffer.isBuffer(body)) return null;
  const delim = Buffer.from(`--${boundary}`);
  const fields = {};
  let models = 0;
  let pos = body.indexOf(delim);
  if (pos === -1) return null;
  let parts = 0;
  while (pos !== -1) {
    let start = pos + delim.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // closing --boundary--
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    else if (body[start] === 0x0a) start += 1;
    else return parts ? { fields, duplicateModel: models > 1 } : null;
    const headerEnd = body.indexOf("\r\n\r\n", start);
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delim]), start);
    if (headerEnd === -1 || (next !== -1 && headerEnd > next)) return parts ? { fields, duplicateModel: models > 1 } : null;
    parts += 1;
    const headers = body.subarray(start, Math.min(headerEnd, start + 1024)).toString("latin1");
    const disp = /content-disposition:\s*form-data\s*;([^\r\n]*)/i.exec(headers);
    const name = disp ? /\bname="([^"]*)"/i.exec(disp[1])?.[1] : undefined;
    const isFile = disp ? /\bfilename\*?=/i.test(disp[1]) : true;
    const valueStart = headerEnd + 4;
    const valueEnd = next === -1 ? body.length : next;
    if (name && !isFile && READ_FIELDS.has(name)) {
      if (name === "model") models += 1;
      if (valueEnd - valueStart <= MULTIPART_FIELD_MAX && !Object.hasOwn(fields, name)) fields[name] = body.subarray(valueStart, valueEnd).toString("utf8").trim();
    }
    if (next === -1) break;
    pos = next + 2;
  }
  return parts ? { fields, duplicateModel: models > 1 } : null;
}

// Unicode code points (what OpenAI counts for tts-1 characters).
export const codePoints = (s) => (typeof s === "string" ? [...s].length : 0);

const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

// Billed seconds for a transcription / translation JSON reply: usage.seconds (duration usage),
// else verbose_json `duration` rounded up to a whole second. null when absent or token-billed.
export function billedSeconds(json) {
  if (!json || typeof json !== "object") return null;
  const u = json.usage;
  if (u && typeof u === "object" && u.type === "tokens") return null;
  if (u && typeof u === "object" && finite(u.seconds)) return Math.ceil(u.seconds);
  if (finite(json.duration)) return Math.ceil(json.duration);
  return null;
}

const pin = (price) => ({ table_version: price.table_version, table_sha256: price.table_sha256, fallback: false, cost_source: "table" });

// Duration- or character-billed audio cost. Returns a receipt fragment, or null when this
// call is not unit-billed (token usage, unknown model, no rate for the unit, no usage).
export function audioUnitCost(route, model, { responseText, requestBody } = {}) {
  if (!route || typeof model !== "string" || !model) return null;
  const price = lookupPrice(model);
  if (price.fallback) return null;
  if (route === "speech") {
    if (!finite(price.per_million_characters)) return null;
    const input = requestBody && typeof requestBody === "object" ? requestBody.input : undefined;
    if (typeof input !== "string") return null;
    const billed_characters = codePoints(input);
    return { model, cost_usd: Number(((billed_characters * price.per_million_characters) / 1_000_000).toFixed(6)),
      cost_basis: "characters", billed_characters, ...pin(price) };
  }
  if (!finite(price.per_minute)) return null;
  let json;
  try { json = JSON.parse(responseText); } catch { return null; }
  const billed_seconds = billedSeconds(json);
  if (billed_seconds === null) return null;
  return { model, cost_usd: Number(((billed_seconds * price.per_minute) / 60).toFixed(6)),
    cost_basis: "duration", billed_seconds, ...pin(price) };
}
