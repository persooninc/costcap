// AWS Signature Version 4 (#188): sign, parse and verify, node:crypto only.
// Portable: no globals, credentials are always passed in. Used by the proxy to
// verify a Bedrock client's signature (made for 127.0.0.1) with wrap's own AWS
// credentials and to re-sign the request for the real bedrock-runtime host.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ALGORITHM = "AWS4-HMAC-SHA256";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding as AWS specifies it (unreserved: A-Z a-z 0-9 - _ . ~).
export function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * Canonical URI. Non-S3 services (bedrock included) encode each path segment of
 * the already-encoded request path again ("double encoding"); with
 * `doubleEncode: false` segments are normalized to single encoding.
 */
export function canonicalUri(rawPath, { doubleEncode = true } = {}) {
  const path = rawPath || "/";
  return path.split("/").map((seg) => (doubleEncode ? uriEncode(seg) : uriEncode(safeDecode(seg)))).join("/") || "/";
}

export function canonicalQuery(search) {
  const q = String(search ?? "").replace(/^\?/, "");
  if (!q) return "";
  return q.split("&").filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    const k = safeDecode((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, " "));
    const v = eq < 0 ? "" : safeDecode(part.slice(eq + 1).replace(/\+/g, " "));
    return [uriEncode(k), uriEncode(v)];
  }).sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
}

const headerValue = (v) => (Array.isArray(v) ? v.join(",") : String(v ?? "")).trim().replace(/\s+/g, " ");

export function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

/**
 * Computes a signature. `headers` keys are matched case-insensitively; only
 * `signedHeaders` (lowercase names) are included in the canonical request.
 */
export function computeSignature({ method, path, search = "", headers, signedHeaders, payloadHash, secretAccessKey, amzDate, region, service, doubleEncode = true }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const names = [...signedHeaders].map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${headerValue(lower[h])}\n`).join("");
  const canonicalRequest = [method.toUpperCase(), canonicalUri(path, { doubleEncode }), canonicalQuery(search), canonicalHeaders, names.join(";"), payloadHash].join("\n");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join("\n");
  return { signature: createHmac("sha256", signingKey(secretAccessKey, date, region, service)).update(stringToSign).digest("hex"), scope, signedHeaders: names.join(";"), canonicalRequest };
}

export const amzDateOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Signs a request for `host`. Returns the headers to set (host, x-amz-date,
 * x-amz-content-sha256, optional x-amz-security-token, authorization).
 * `extraSigned` are other headers from `headers` to cover (e.g. content-type).
 */
export function signRequest({ method, host, path, search = "", headers = {}, body = "", credentials, region, service, now = new Date(), extraSigned = [], doubleEncode = true }) {
  const amzDate = amzDateOf(now);
  const payloadHash = sha256(body ?? "");
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out = { host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash, ...(credentials.sessionToken && { "x-amz-security-token": credentials.sessionToken }) };
  const signed = { ...out };
  for (const h of extraSigned) if (lower[h] !== undefined) signed[h] = lower[h];
  const { signature, scope, signedHeaders } = computeSignature({ method, path, search, headers: signed, signedHeaders: Object.keys(signed), payloadHash, secretAccessKey: credentials.secretAccessKey, amzDate, region, service, doubleEncode });
  out.authorization = `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

/** Parses an AWS4-HMAC-SHA256 Authorization header, or null. */
export function parseAuthorization(value) {
  if (typeof value !== "string" || !value.startsWith(`${ALGORITHM} `)) return null;
  const fields = {};
  for (const part of value.slice(ALGORITHM.length + 1).split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const cred = (fields.Credential ?? "").split("/");
  if (cred.length !== 5 || cred[4] !== "aws4_request" || !fields.SignedHeaders || !/^[0-9a-f]{64}$/.test(fields.Signature ?? "")) return null;
  const [accessKeyId, date, region, service] = cred;
  return { accessKeyId, date, region, service, signedHeaders: fields.SignedHeaders.split(";"), signature: fields.Signature };
}

/**
 * Verifies an inbound signed request with the given credentials.
 * Returns { ok: true, region, service } or { ok: false, reason }.
 */
export function verifyRequest({ method, path, search = "", headers, body = "", credentials, doubleEncode = true }) {
  const auth = parseAuthorization(headers.authorization);
  if (!auth) return { ok: false, reason: "malformed_authorization" };
  if (auth.accessKeyId !== credentials.accessKeyId) return { ok: false, reason: "access_key_mismatch" };
  const amzDate = headers["x-amz-date"];
  if (typeof amzDate !== "string" || amzDate.slice(0, 8) !== auth.date) return { ok: false, reason: "date_mismatch" };
  if (!auth.signedHeaders.includes("host")) return { ok: false, reason: "host_unsigned" };
  const declared = headers["x-amz-content-sha256"];
  const payloadHash = typeof declared === "string" && declared ? declared : sha256(body ?? "");
  if (typeof declared === "string" && /^[0-9a-f]{64}$/.test(declared) && declared !== sha256(body ?? "")) return { ok: false, reason: "payload_hash_mismatch" };
  const { signature } = computeSignature({ method, path, search, headers, signedHeaders: auth.signedHeaders, payloadHash, secretAccessKey: credentials.secretAccessKey, amzDate, region: auth.region, service: auth.service, doubleEncode });
  const a = Buffer.from(signature), b = Buffer.from(auth.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true, region: auth.region, service: auth.service };
}

/** Static AWS credentials from an env object, or null. Never logged. */
export function credentialsFromEnv(env = {}) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID, secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN && { sessionToken: env.AWS_SESSION_TOKEN }) };
}
