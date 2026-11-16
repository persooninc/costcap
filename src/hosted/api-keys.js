// Issue #203: org API keys. Scoped, revocable bearer credentials (`cck_…`) for
// scripts that read spend/exports/alerts and (admin role) act on the fleet.
// Only a SHA-256 hash is stored; the full value is returned once at creation.
import { randomBytes, randomUUID } from "node:crypto";
import { hashToken } from "./policy.js";

export const API_KEY_PREFIX = "cck_";
export const API_KEY_ROLES = Object.freeze(["viewer", "admin"]);
const fail = (status, message) => { const err = new Error(message); err.status = status; throw err; };

/** The raw `cck_` bearer on a request, or null. */
export function bearerApiKey(req) {
  const m = /^Bearer (cck_[A-Za-z0-9_-]+)$/.exec(req.headers?.authorization ?? "");
  return m ? m[1] : null;
}

export function parseApiKeyInput(body, nowMs) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) fail(400, "Key name required (1-100 characters)");
  const role = body?.role ?? "viewer";
  if (!API_KEY_ROLES.includes(role)) fail(400, "role must be viewer or admin");
  let expiresAt = null;
  if (body?.expires_at != null) {
    const ms = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (Number.isNaN(ms)) fail(400, "expires_at must be an ISO date");
    if (ms <= nowMs) fail(400, "expires_at must be in the future");
    expiresAt = new Date(ms).toISOString();
  }
  return { name, role, expiresAt };
}

/** Creates a key record in `s`; returns { record, raw }. */
export function createApiKey(s, { orgId, createdBy, name, role, expiresAt }, nowMs) {
  s.apiKeys ??= {};
  const raw = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = `key_${randomUUID()}`;
  const record = { id, orgId, name, role, hash: hashToken(raw), last4: raw.slice(-4), createdAt: new Date(nowMs).toISOString(), createdBy, expiresAt, revokedAt: null, lastUsedAt: null };
  s.apiKeys[id] = record;
  return { record, raw };
}

/** Public view of a key: never the hash or the full value. */
export function maskApiKey(k, nowMs) {
  const expired = k.expiresAt != null && Date.parse(k.expiresAt) <= nowMs;
  return { id: k.id, name: k.name, role: k.role, masked: `${API_KEY_PREFIX}…${k.last4}`, created_at: k.createdAt, created_by: k.createdBy, expires_at: k.expiresAt, revoked_at: k.revokedAt, last_used_at: k.lastUsedAt, status: k.revokedAt ? "revoked" : expired ? "expired" : "active" };
}

/** Finds the live key for a raw bearer; 401 when unknown, revoked or expired. */
export function findApiKey(s, raw, nowMs) {
  const hashed = hashToken(raw);
  const key = Object.values(s.apiKeys ?? {}).find((k) => k.hash === hashed);
  if (!key || key.revokedAt || (key.expiresAt != null && Date.parse(key.expiresAt) <= nowMs)) fail(401, "API key invalid, revoked or expired");
  return key;
}

/** A user-shaped principal for a key. Its id is the key id so audit entries name the key. */
export function apiKeyPrincipal(key) {
  return { id: key.id, orgId: key.orgId, role: key.role, email: `api_key:${key.name}`, verified: true, apiKey: { id: key.id, name: key.name } };
}
