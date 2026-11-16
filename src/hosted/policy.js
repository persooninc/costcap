// Fleet policy for enrolled agents (story #13). Pure logic, no I/O, no web
// framework: the hosted service stores policies and enrollment tokens, the
// CLI uses resolvePolicy() to decide which caps apply.
//
// Offline rule: the CLI keeps the last policy it received. If the server is
// unreachable it keeps enforcing that policy (last-known). A policy only
// loosens when the server actually delivers a newer version.

import { intersectModels, isModelList } from "../agent-budget.js";
import { warnFractionsError } from "./alerts.js";
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

const CAP_KEYS = ["run", "hour", "day", "month"];

export function validatePolicy(p) {
  const errors = [];
  if (!p || typeof p !== "object") return ["policy must be an object"];
  if (!Number.isInteger(p.version) || p.version < 1) errors.push("version must be a positive integer");
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
  if (p.killed !== undefined && typeof p.killed !== "boolean") errors.push("killed must be boolean");
  return errors;
}

// Decide which policy the CLI enforces. `local` holds flags the user passed,
// `lastKnown` is the cached server policy (or null), `fetched` is the fresh
// server response (or null when offline/unreachable).
// Local flags can only tighten a fleet policy, never loosen it.
export function resolvePolicy({ local = {}, lastKnown = null, fetched = null }) {
  if (lastKnown && validatePolicy(lastKnown).length) throw new Error("Invalid cached fleet policy; refusing to loosen enforcement");
  for (const k of CAP_KEYS) if (local[k] != null && (!Number.isFinite(local[k]) || local[k] <= 0)) throw new Error(`Invalid local cap ${k}`);
  if (local.maxSteps != null && !(Number.isInteger(local.maxSteps) && local.maxSteps > 0)) throw new Error("Invalid local maxSteps");
  if (local.models != null && !isModelList(local.models)) throw new Error("Invalid local models");
  for (const k of ["rpm", "tpm"]) if (local[k] != null && !(Number.isInteger(local[k]) && local[k] > 0)) throw new Error(`Invalid local ${k}`);
  let server = lastKnown;
  let source = lastKnown ? "last-known" : "none";
  if (fetched && validatePolicy(fetched).length === 0 && (!lastKnown || fetched.version > lastKnown.version)) {
    server = fetched;
    source = "server";
  }
  const caps = {};
  for (const k of CAP_KEYS) {
    const vals = [server?.caps?.[k], local?.[k]].filter((v) => v != null);
    if (vals.length) caps[k] = Math.min(...vals);
  }
  // A local step budget can tighten the fleet one, never loosen it.
  const steps = [server?.maxSteps, local?.maxSteps].filter((v) => v != null);
  const maxSteps = steps.length ? Math.min(...steps) : null;
  // Model allowlists combine as an intersection (most restrictive wins, #153).
  const models = intersectModels(server?.models ?? null, local?.models ?? null);
  // #192: rate limits: the minimum wins, so local can tighten but never loosen.
  const minOf = (k) => { const v = [server?.[k], local?.[k]].filter((x) => x != null); return v.length ? Math.min(...v) : null; };
  return { caps, maxSteps, models, ...(minOf("rpm") != null && { rpm: minOf("rpm") }), ...(minOf("tpm") != null && { tpm: minOf("tpm") }), killed: Boolean(server?.killed), version: server?.version ?? null, source };
}
