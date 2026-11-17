// Fleet policy for enrolled agents (story #13). Pure logic, no I/O, no web
// framework: the hosted service stores policies and enrollment tokens, the
// CLI uses resolvePolicy() to decide which caps apply.
//
// Offline rule: the CLI keeps the last policy it received. If the server is
// unreachable it keeps enforcing that policy (last-known). A policy only
// loosens when the server actually delivers a newer version.

import { intersectModels, isModelList } from "../agent-budget.js";
import { warnFractionsError } from "./alerts.js";
import { anomalyError } from "./anomaly.js";
import { modelCapsError } from "../model-cap.js";
import { downgradeError, mergeDowngrade } from "../downgrade.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Enrollment tokens are shown once. Only the SHA-256 hash is stored.
export function newEnrollmentToken() {
  const token = `cc_enr_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyToken(token, storedHash) {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash ?? "", "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// #265: total is a lifetime cap that never resets.
export const CAP_KEYS = ["run", "hour", "day", "week", "month", "total"];
// Scopes a time-boxed cap raise (#208) can target; week and total raises are out of scope (#261, #265 Out).
export const RAISE_KEYS = CAP_KEYS.filter((k) => k !== "week" && k !== "total");

// Issue #208/#212: time-boxed cap raise overlay. policy.raise = { <scope>: [{ amount_usd, expires_at, request_id }, ...] }.
// Raises stack: the effective cap is computed at evaluation time as current base + sum of
// active raise amounts, so lowering the base during a raise lowers the effective cap at once.
// Legacy (#208) entries { cap, expires_at, request_id } are still read: they are migrated by
// expireRaises() using the approved amount, and until then read as amount = cap - current base
// (never negative), so no in-flight raise grows.
const isLegacyRaise = (r) => r && typeof r === "object" && !Array.isArray(r) && "cap" in r;
const raiseEntryError = (r) => !r || typeof r !== "object" || typeof r.expires_at !== "string" || !Number.isFinite(Date.parse(r.expires_at)) || typeof r.request_id !== "string";

/** Entries for one scope as an array (legacy single objects wrapped). */
export function raiseEntries(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function raiseError(raise) {
  if (raise === undefined || raise === null) return null;
  if (typeof raise !== "object" || Array.isArray(raise)) return "raise must be an object";
  for (const [k, v] of Object.entries(raise)) {
    if (!RAISE_KEYS.includes(k)) return `raise.${k} is not a cap scope`;
    if (Array.isArray(v)) {
      if (!v.length) return `raise.${k} must be a non-empty array`;
      for (const r of v) if (raiseEntryError(r) || !(typeof r.amount_usd === "number" && Number.isFinite(r.amount_usd) && r.amount_usd > 0)) return `raise.${k} entries must be { amount_usd, expires_at, request_id }`;
    } else if (raiseEntryError(v) || !isLegacyRaise(v) || !(typeof v.cap === "number" && Number.isFinite(v.cap) && v.cap > 0)) return `raise.${k} must be an array of { amount_usd, expires_at, request_id }`;
  }
  return null;
}

/** Active raises at nowMs per scope (expired entries dropped). */
export function activeRaises(policy, nowMs = Date.now()) {
  const out = {};
  for (const [k, v] of Object.entries(policy?.raise ?? {})) {
    const live = raiseEntries(v).filter((r) => nowMs < Date.parse(r.expires_at));
    if (live.length) out[k] = live;
  }
  return out;
}

/** Amount one raise entry adds on top of `base`. */
export function raiseAmount(r, base) {
  return isLegacyRaise(r) ? Math.max(0, r.cap - base) : r.amount_usd;
}

/** Current base caps plus the sum of active raise amounts; a raise only ever raises a scope that already has a base cap. */
export function effectiveCaps(policy, nowMs = Date.now()) {
  const caps = { ...(policy?.caps ?? {}) };
  for (const [k, list] of Object.entries(activeRaises(policy, nowMs))) {
    if (caps[k] == null) continue;
    const base = caps[k];
    caps[k] = Number((base + list.reduce((sum, r) => sum + raiseAmount(r, base), 0)).toFixed(6));
  }
  return caps;
}

/** Earliest future raise expiry (ms) or null, so a long-running wrapper can re-resolve offline. */
export function nextRaiseExpiry(policy, nowMs = Date.now()) {
  const t = Object.values(activeRaises(policy, nowMs)).flat().map((r) => Date.parse(r.expires_at));
  return t.length ? Math.min(...t) : null;
}

export function validatePolicy(p) {
  const errors = [];
  if (!p || typeof p !== "object") return ["policy must be an object"];
  if (!Number.isInteger(p.version) || p.version < 1) errors.push("version must be a positive integer");
  if (p.caps !== undefined && p.caps !== null && (typeof p.caps !== "object" || Array.isArray(p.caps))) errors.push("caps must be an object");
  // #261: an unknown cap key (e.g. "weekly") is an error, never a silent no-op.
  else for (const k of Object.keys(p.caps ?? {})) if (!CAP_KEYS.includes(k)) errors.push(`caps.${k} is not a cap scope (${CAP_KEYS.join(", ")})`);
  for (const k of CAP_KEYS) {
    const v = p.caps?.[k];
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) errors.push(`caps.${k} must be a positive number`);
  }
  // Step budget (issue #114): upstream calls one run may make. Optional positive integer.
  if (p.maxSteps !== undefined && p.maxSteps !== null && !(Number.isInteger(p.maxSteps) && p.maxSteps > 0)) errors.push("maxSteps must be a positive integer");
  // Per-agent agent_silent threshold (issue #134): null/missing = 6h default, 0 = off, else 0 < n <= 720.
  if (p.silentAfterHours !== undefined && p.silentAfterHours !== null && !(typeof p.silentAfterHours === "number" && Number.isFinite(p.silentAfterHours) && p.silentAfterHours >= 0 && p.silentAfterHours <= 720)) errors.push("silentAfterHours must be 0 (off) or a number up to 720");
  // Model allowlist (issue #153): optional non-empty array of exact model ids.
  if (p.models !== undefined && p.models !== null && !isModelList(p.models)) errors.push("models must be a non-empty array of model ids");
  // Warning fractions (issue #165): null/missing = default [0.8], [] = cap_approaching off.
  if (p.warnFractions !== undefined && p.warnFractions !== null) {
    const err = warnFractionsError(p.warnFractions);
    if (err) errors.push(err);
  }
  // Rate limits (issue #192): optional positive integers per 60 s.
  for (const k of ["rpm", "tpm"]) if (p[k] !== undefined && p[k] !== null && !(Number.isInteger(p[k]) && p[k] > 0)) errors.push(`${k} must be a positive integer`);
  // #249: parallel upstream calls per wrapper (a ceiling), optional integer 1..64.
  if (p.maxConcurrent !== undefined && p.maxConcurrent !== null && !(Number.isInteger(p.maxConcurrent) && p.maxConcurrent >= 1 && p.maxConcurrent <= 64)) errors.push("maxConcurrent must be an integer from 1 to 64");
  // Budget-triggered model downgrade (issue #207): optional { at, map }.
  if (p.downgrade !== undefined && p.downgrade !== null) {
    const err = downgradeError(p.downgrade);
    if (err) errors.push(err);
  }
  // Spend anomaly override (issue #223): optional { enabled, multiplier, min_usd }.
  if (p.anomaly !== undefined && p.anomaly !== null) {
    const err = anomalyError(p.anomaly);
    if (err) errors.push(err);
  }
  // Per-model caps (issue #238): optional [{model, scope, usd}].
  if (p.modelCaps !== undefined && p.modelCaps !== null) {
    const err = modelCapsError(p.modelCaps);
    if (err) errors.push(err);
  }
  if (p.killed !== undefined && typeof p.killed !== "boolean") errors.push("killed must be boolean");
  const raiseErr = raiseError(p.raise);
  if (raiseErr) errors.push(raiseErr);
  return errors;
}

// Decide which policy the CLI enforces. `local` holds flags the user passed,
// `lastKnown` is the cached server policy (or null), `fetched` is the fresh
// server response (or null when offline/unreachable).
// Local flags can only tighten a fleet policy, never loosen it.
// A cap raise (#208) applies only while nowMs < expires_at, so an offline wrapper on a
// cached policy falls back to the base caps at expiry without fetching anything.
export function resolvePolicy({ local = {}, lastKnown = null, fetched = null, nowMs = Date.now() }) {
  if (lastKnown && validatePolicy(lastKnown).length) throw new Error("Invalid cached fleet policy; refusing to loosen enforcement");
  for (const k of CAP_KEYS) if (local[k] != null && (!Number.isFinite(local[k]) || local[k] <= 0)) throw new Error(`Invalid local cap ${k}`);
  if (local.maxSteps != null && !(Number.isInteger(local.maxSteps) && local.maxSteps > 0)) throw new Error("Invalid local maxSteps");
  if (local.models != null && !isModelList(local.models)) throw new Error("Invalid local models");
  for (const k of ["rpm", "tpm"]) if (local[k] != null && !(Number.isInteger(local[k]) && local[k] > 0)) throw new Error(`Invalid local ${k}`);
  if (local.maxConcurrent != null && !(Number.isInteger(local.maxConcurrent) && local.maxConcurrent >= 1 && local.maxConcurrent <= 64)) throw new Error("Invalid local maxConcurrent");
  let server = lastKnown;
  let source = lastKnown ? "last-known" : "none";
  if (fetched && validatePolicy(fetched).length === 0 && (!lastKnown || fetched.version > lastKnown.version)) {
    server = fetched;
    source = "server";
  }
  const caps = {};
  const serverCaps = effectiveCaps(server, nowMs);
  for (const k of CAP_KEYS) {
    const vals = [serverCaps[k], local?.[k]].filter((v) => v != null);
    if (vals.length) caps[k] = Math.min(...vals);
  }
  // A local step budget can tighten the fleet one, never loosen it.
  const steps = [server?.maxSteps, local?.maxSteps].filter((v) => v != null);
  const maxSteps = steps.length ? Math.min(...steps) : null;
  // Model allowlists combine as an intersection (most restrictive wins, #153).
  const models = intersectModels(server?.models ?? null, local?.models ?? null);
  // #192: rate limits: the minimum wins, so local can tighten but never loosen.
  const minOf = (k) => { const v = [server?.[k], local?.[k]].filter((x) => x != null); return v.length ? Math.min(...v) : null; };
  // #207: fleet downgrade; local can only add unmapped models and lower `at`.
  const downgrade = mergeDowngrade(server?.downgrade ?? null, local?.downgrade ?? null);
  return { caps, maxSteps, models, ...(server?.modelCaps ? { modelCaps: server.modelCaps } : {}), ...(downgrade ? { downgrade } : {}), ...(minOf("rpm") != null && { rpm: minOf("rpm") }), ...(minOf("tpm") != null && { tpm: minOf("tpm") }), ...(minOf("maxConcurrent") != null && { maxConcurrent: minOf("maxConcurrent") }), killed: Boolean(server?.killed), version: server?.version ?? null, source, raiseExpiresAt: nextRaiseExpiry(server, nowMs) };
}
