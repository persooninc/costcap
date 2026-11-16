// AWS Signature Version 4 (#188), node:crypto only. Used to verify a request the wrapped
// child signed for the local proxy host, then re-sign it for the real Bedrock host.
// Canonicalisation follows the non-S3 rules: each path segment is URI-encoded again
// (so a wire `%3A` becomes `%253A`), query pairs are sorted, header values trimmed.
// Secrets never leave this module: errors carry only reason codes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// RFC 3986 unreserved characters stay; everything else is %XX (uppercase).
export function uriEncode(str, keepSlash = false) {
  let out = "";
  for (const byte of Buffer.from(String(str), "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function canonicalPath(rawPath) {
  const p = rawPath || "/";
  return p.split("/").map((seg) => uriEncode(seg)).join("/");
}

const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };

export function canonicalQuery(search) {
  const q = String(search ?? "").replace(/^\?/, "");
  if (!q) return "";
  return q.split("&").filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? "" : part.slice(eq + 1);
    return [uriEncode(decode(k)), uriEncode(decode(v))];
  }).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join("&");
}

const headerValue = (v) => (Array.isArray(v) ? v.join(",") : String(v ?? "")).trim().replace(/\s+/g, " ");

/** Lower-cased header lookup over a plain object. */
export function getHeader(headers, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === want) return v;
  return undefined;
}

export function canonicalRequest({ method, path, search = "", headers, signedHeaders, payloadHash }) {
  const names = [...signedHeaders].map((h) => h.toLowerCase()).sort();
  const lines = names.map((h) => `${h}:${headerValue(getHeader(headers, h))}\n`).join("");
  return [method.toUpperCase(), canonicalPath(path), canonicalQuery(search), lines, names.join(";"), payloadHash].join("\n");
}

export function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

/** Signature hex for a request. `amzDate` is YYYYMMDDTHHMMSSZ. */
export function signature({ method, path, search, headers, signedHeaders, payloadHash, amzDate, region, service, secretAccessKey }) {
  const scope = `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
  const creq = canonicalRequest({ method, path, search, headers, signedHeaders, payloadHash });
  const sts = [ALGORITHM, amzDate, scope, sha256Hex(creq)].join("\n");
  return createHmac("sha256", signingKey(secretAccessKey, amzDate.slice(0, 8), region, service)).update(sts).digest("hex");
}

/** Parses `AWS4-HMAC-SHA256 Credential=AK/DATE/REGION/SERVICE/aws4_request, SignedHeaders=a;b, Signature=hex`. */
export function parseAuthorization(value) {
  if (typeof value !== "string" || !value.startsWith(`${ALGORITHM} `)) return null;
  const fields = {};
  for (const part of value.slice(ALGORITHM.length + 1).split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const cred = (fields.Credential ?? "").split("/");
  if (cred.length !== 5 || cred[4] !== "aws4_request" || !/^\d{8}$/.test(cred[1]) || !fields.SignedHeaders || !/^[0-9a-f]{64}$/.test(fields.Signature ?? "")) return null;
  return { accessKeyId: cred[0], date: cred[1], region: cred[2], service: cred[3], signedHeaders: fields.SignedHeaders.split(";"), signature: fields.Signature };
}

export const isSigV4 = (authorization) => typeof authorization === "string" && authorization.startsWith(`${ALGORITHM} `);

const payloadHashOf = (headers, body) => {
  const declared = getHeader(headers, "x-amz-content-sha256");
  return typeof declared === "string" && declared ? declared : sha256Hex(body ?? Buffer.alloc(0));
};

/**
 * Verifies an inbound SigV4 request against static credentials.
 * Returns { ok: true, region, service } or { ok: false, reason }.
 */
export function verifyRequest({ method, path, search, headers, body }, creds) {
  const auth = parseAuthorization(getHeader(headers, "authorization"));
  if (!auth) return { ok: false, reason: "malformed_authorization" };
  if (!creds?.accessKeyId || !creds?.secretAccessKey) return { ok: false, reason: "credentials_unavailable" };
  if (auth.accessKeyId !== creds.accessKeyId) return { ok: false, reason: "access_key_mismatch" };
  const amzDate = getHeader(headers, "x-amz-date");
  if (typeof amzDate !== "string" || !/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== auth.date) return { ok: false, reason: "bad_date" };
  if (!auth.signedHeaders.includes("host")) return { ok: false, reason: "host_unsigned" };
  const expected = signature({ method, path, search, headers, signedHeaders: auth.signedHeaders, payloadHash: payloadHashOf(headers, body),
    amzDate, region: auth.region, service: auth.service, secretAccessKey: creds.secretAccessKey });
  const a = Buffer.from(expected, "hex"), b = Buffer.from(auth.signature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true, region: auth.region, service: auth.service };
}

export const amzDateOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Signs a request for `host`. Returns the headers to send (input headers minus any old
 * signature fields, plus host, x-amz-date, optional x-amz-security-token, authorization).
 */
export function signRequest({ method, path, search = "", headers = {}, body, host, region, service }, creds, now = new Date()) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!["authorization", "x-amz-date", "x-amz-security-token", "host"].includes(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  const amzDate = amzDateOf(now);
  out.host = host;
  out["x-amz-date"] = amzDate;
  if (creds.sessionToken) out["x-amz-security-token"] = creds.sessionToken;
  const payloadHash = payloadHashOf(out, body);
  const signedHeaders = ["host", "x-amz-date", ...(creds.sessionToken ? ["x-amz-security-token"] : []),
    ...(out["x-amz-content-sha256"] ? ["x-amz-content-sha256"] : []), ...(out["content-type"] ? ["content-type"] : [])].sort();
  const sig = signature({ method, path, search, headers: out, signedHeaders, payloadHash, amzDate, region, service, secretAccessKey: creds.secretAccessKey });
  out.authorization = `${ALGORITHM} Credential=${creds.accessKeyId}/${amzDate.slice(0, 8)}/${region}/${service}/aws4_request, SignedHeaders=${signedHeaders.join(";")}, Signature=${sig}`;
  return out;
}

/** Static AWS credentials from an env object, or null. */
export function awsCredentials(env = process.env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID, secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN && { sessionToken: env.AWS_SESSION_TOKEN }) };
}
