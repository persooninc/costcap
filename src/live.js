// #273: OpenAI GPT-Live (`/v1/live/sessions` WebSocket) helpers. Pure functions, Node built-ins only.
// Billing is per session second (snapshots replace each other, never summed); backend model
// usage arrives in `response.completed` events nested in a `response.event` envelope.
import { lookupPrice } from "./pricing.js";

export const LIVE_PATH = /^\/openai\/v1\/live\/sessions\/?$/;

const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Per-minute row for a live model, or null when the table has none. */
export function liveRate(model) {
  if (typeof model !== "string" || !model) return null;
  const p = lookupPrice(model);
  if (p.fallback || !isCount(p.per_minute)) return null;
  return { per_minute: p.per_minute, table_version: p.table_version, table_sha256: p.table_sha256, fallback: false, cost_source: "table" };
}

/** USD for `seconds` at `perMinute`, unrounded to whole minutes (6 dp like other receipts). */
export const durationCost = (seconds, perMinute) => Number(((seconds * perMinute) / 60).toFixed(6));

/** `usage.seconds` from session.usage.updated / session.closed, or null. */
export function sessionSeconds(ev) {
  const s = ev?.usage?.seconds;
  return isCount(s) ? s : null;
}

/**
 * Snapshot meter: each snapshot replaces the last; only growth is billed, a snapshot that goes
 * backwards bills 0. Returns { billed_seconds, session_seconds }.
 */
export function createSnapshotMeter() {
  let high = 0;
  return {
    take(seconds) {
      const billed = Math.max(0, seconds - high);
      if (seconds > high) high = seconds;
      return { billed_seconds: Number(billed.toFixed(6)), session_seconds: high };
    },
    get seconds() { return high; },
  };
}

/** The backend Responses object from a `response.event` envelope (or a bare event), or null. */
export function backendResponse(ev) {
  if (!ev || typeof ev !== "object") return null;
  const inner = ev.type === "response.event" ? (ev.event ?? ev.data ?? null) : ev;
  if (!inner || typeof inner !== "object" || inner.type !== "response.completed") return null;
  const r = inner.response;
  if (!r || typeof r !== "object" || !r.usage || typeof r.usage !== "object") return null;
  return r;
}
