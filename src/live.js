// #273: OpenAI GPT-Live (`/v1/live/sessions` WebSocket). Pure helpers; the proxy owns the session.
// Billing per https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live:
// `session.usage.updated` usage.seconds is a cumulative snapshot (never summed), the final
// usage.seconds comes once from `session.closed`, and backend model usage arrives as
// `response.completed` nested in a `response.event`, counted once per response id.

export const LIVE_PATH = /^\/openai\/v1\/live\/sessions\/?$/;

const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Cumulative session seconds reported by a session.usage.updated / session.closed event, or null. */
export function liveSeconds(ev) {
  const s = ev?.usage?.seconds ?? ev?.session?.usage?.seconds;
  return isCount(s) ? s : null;
}

/** Duration cost: seconds x per_minute / 60, per second without rounding to a minute (6 dp like #198). */
export function durationCost(seconds, perMinute) {
  return Number(((seconds * perMinute) / 60).toFixed(6));
}

/** The nested Responses event of a `response.event` envelope (or a bare response.completed), else null. */
export function backendResponse(ev) {
  if (!ev || typeof ev !== "object") return null;
  const inner = ev.type === "response.event" ? (ev.event ?? ev.data ?? null) : ev;
  if (!inner || typeof inner !== "object" || inner.type !== "response.completed") return null;
  const r = inner.response;
  if (!r || typeof r !== "object" || !r.usage || typeof r.usage !== "object") return null;
  return { id: typeof r.id === "string" ? r.id : null, model: typeof r.model === "string" && r.model ? r.model : null, usage: r.usage };
}

/** The model requested by a client `session.start` message, or undefined. */
export function sessionStartModel(msg) {
  const m = msg?.session?.model;
  return typeof m === "string" && m ? m : undefined;
}
