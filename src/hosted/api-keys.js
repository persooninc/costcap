// Issue #203: org API keys. Scoped, revocable bearer credentials (`cck_…`) for hosted
// spend, exports, alerts and fleet freeze. Pure and portable: no I/O; the caller supplies
// the state, the clock and the hash function. Only a hash of the key is ever stored.
import { randomBytes, randomUUID } from "node:crypto";

export const API_KEY_PREFIX = "cck_";
export const API_KEY_ROLES = Object.freeze(["viewer", "admin"]);
const KEY_PATTERN = /^cck_[A-Za-z0-9_-]{43}$/;

const bad = (status, message) => { const err = new Error(message); err.status = status; throw err; };

/** True when a bearer credential has the org API key shape (never an agent token). */
export const isApiKey = (raw) => typeof raw === "string" && raw.startsWith(API_KEY_PREFIX);

/** `cck_…abcd`: the only form of a key shown after creation. */
export const maskApiKey = (last4) => `${API_KEY_PREFIX}…${last4}`;

/** Validate `{name, role, expires_at?}`; returns normalized input or throws a 400. */
export function parseApiKeyInput(body, nowMs) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) bad(400, "Key name must be 1-100 characters");
  if (!API_KEY_ROLES.includes(body?.role)) bad(400, "Role must be viewer or admin");
  let expiresAt = null;
  if (body?.expires_at != null) {
    const ms = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (!Number.isFinite(ms) || ms <= nowMs) bad(400, "expires_at must be a future ISO timestamp");
    expiresAt = new Date(ms).toISOString();
  }
  return { name, role: body.role, expiresAt };
}

/** Create a key record. Returns `{ raw, record }`; `raw` must be shown once and never stored. */
export function createApiKey({ orgId, createdBy, name, role, expiresAt = null, nowMs, hash }) {
  const raw = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  const record = { id: randomUUID(), orgId, name, role, hash: hash(raw), last4: raw.slice(-4),
    created_at: new Date(nowMs).toISOString(), created_by: createdBy, expires_at: expiresAt, revoked_at: null, last_used_at: null };
  return { raw, record };
}

/** Public view of a key record: masked, never the hash. */
export function publicApiKey(k, nowMs) {
  const expired = k.expires_at != null && Date.parse(k.expires_at) <= nowMs;
  return { id: k.id, name: k.name, role: k.role, key: maskApiKey(k.last4), created_at: k.created_at, created_by: k.created_by,
    expires_at: k.expires_at, revoked_at: k.revoked_at, last_used_at: k.last_used_at, status: k.revoked_at ? "revoked" : expired ? "expired" : "active" };
}

/** Find the live key record for a raw credential, or null (unknown, malformed, revoked or expired). */
export function findApiKey(s, raw, nowMs, hash) {
  if (!KEY_PATTERN.test(raw ?? "")) return null;
  const h = hash(raw);
  const k = Object.values(s.apiKeys ?? {}).find((x) => x.hash === h);
  if (!k || k.revoked_at || (k.expires_at != null && Date.parse(k.expires_at) <= nowMs)) return null;
  return k;
}

/** Audit actor id for actions taken with a key. */
export const apiKeyActor = (k) => `apikey:${k.id}`;

/** A user-shaped principal for a key, so existing route code (orgId, role, id) works unchanged. */
export const apiKeyPrincipal = (k) => ({ id: apiKeyActor(k), orgId: k.orgId, role: k.role, email: `api-key:${k.name}`, verified: true, apiKey: { id: k.id, name: k.name } });
