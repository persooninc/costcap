// Budget-triggered model downgrade (#207): "degrade, don't die". Once the first
// run/hour/day/month scope reaches a fraction `at` of its cap, a request whose JSON
// `model` is a mapped FROM goes upstream as TO. Only the `model` field changes.
// A downgrade never raises or bypasses a cap: the hard stop at 100% is unchanged.
// Pure module except for the tracker's in-memory dedupe.

export const DEFAULT_DOWNGRADE_AT = 0.8;
export const DOWNGRADE_HEADER = "x-costcap-model-downgraded";
export const DOWNGRADE_SCOPES = Object.freeze(["run", "hour", "day", "month"]);
const MAX_MAP = 50;

const isId = (m) => typeof m === "string" && m.trim() !== "" && m === m.trim() && m.length <= 200;

/** "--downgrade FROM=TO[,FROM=TO]" -> { FROM: TO }. Throws on anything invalid. */
export function parseDowngradeMap(v, into = {}) {
  const out = { ...into };
  for (const part of String(v).split(",")) {
    const [from, to, extra] = part.split("=").map((s) => s.trim());
    if (extra !== undefined || !isId(from) || !isId(to)) throw new Error(`--downgrade needs FROM=TO[,FROM=TO], got "${v}"`);
    if (from === to) throw new Error(`--downgrade maps ${from} to itself`);
    if (Object.hasOwn(out, from) && out[from] !== to) throw new Error(`--downgrade maps ${from} twice`);
    out[from] = to;
  }
  return out;
}

/** "--downgrade-at F": 0 < F < 1. */
export function parseDowngradeAt(v) {
  const n = String(v).trim() === "" ? NaN : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) throw new Error(`--downgrade-at needs a fraction between 0 and 1 (exclusive), got "${v}"`);
  return n;
}

/** Fleet policy `downgrade: { at, map }` validation. Returns an error string or null. */
export function downgradeError(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== "object" || Array.isArray(d)) return "downgrade must be an object { at, map }";
  for (const k of Object.keys(d)) if (k !== "at" && k !== "map") return `downgrade.${k} is not allowed`;
  if (!(typeof d.at === "number" && Number.isFinite(d.at) && d.at > 0 && d.at < 1)) return "downgrade.at must be a number between 0 and 1 (exclusive)";
  const m = d.map;
  if (!m || typeof m !== "object" || Array.isArray(m)) return "downgrade.map must be an object of FROM: TO model ids";
  const entries = Object.entries(m);
  if (!entries.length || entries.length > MAX_MAP) return `downgrade.map needs 1 to ${MAX_MAP} entries`;
  for (const [from, to] of entries) {
    if (!isId(from) || !isId(to)) return "downgrade.map keys and values must be model ids";
    if (from === to) return `downgrade.map maps ${from} to itself`;
  }
  return null;
}

/**
 * Fleet + local merge: local settings can only add or tighten. `at` is the lower
 * (earlier) fraction; maps are unioned and the fleet target wins on a clash.
 */
export function mergeDowngrade(server, local) {
  const parts = [server, local].filter((d) => d && d.map && Object.keys(d.map).length);
  if (!parts.length) return null;
  const at = Math.min(...parts.map((d) => d.at ?? DEFAULT_DOWNGRADE_AT));
  return { at, map: { ...(local?.map ?? {}), ...(server?.map ?? {}) } };
}

/**
 * First scope (in caller order) whose spend is at or above at * cap.
 * scopes: [{ scope, cap, spent }]. Returns { scope, fraction } or null.
 */
export function triggerScope(scopes, at) {
  for (const s of scopes ?? []) {
    if (s == null || !(s.cap > 0) || typeof s.spent !== "number" || !Number.isFinite(s.spent)) continue;
    if (s.spent >= s.cap * at) return { scope: s.scope, fraction: Number((s.spent / s.cap).toFixed(4)), cap: s.cap, spent_usd: Number(s.spent.toFixed(6)) };
  }
  return null;
}

/** Scopes from a cap engine: limits() + spend(). Optional prefix (e.g. "agent:"). */
export function capScopes(limits = {}, spend = {}, prefix = "") {
  return DOWNGRADE_SCOPES.filter((sc) => limits[sc] != null).map((sc) => ({ scope: `${prefix}${sc}`, cap: limits[sc], spent: spend[sc] ?? 0 }));
}

/** Scopes from caps + remaining (fleet-synced spend): spent = cap - remaining. */
export function remainingScopes(caps = {}, remaining = {}, prefix = "") {
  return DOWNGRADE_SCOPES.filter((sc) => caps?.[sc] != null && typeof remaining?.[sc] === "number")
    .map((sc) => ({ scope: `${prefix}${sc}`, cap: caps[sc], spent: Math.max(0, caps[sc] - remaining[sc]) }));
}

/** Rewrites only the JSON `model`. Returns the new body Buffer, or null when it cannot. */
export function rewriteModel(body, to) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.model !== "string") return null;
  parsed.model = to;
  return Buffer.from(JSON.stringify(parsed));
}

function periodOf(scope, runId, now) {
  const base = scope.split(":").pop();
  const iso = now.toISOString();
  if (base === "run") return String(runId ?? "");
  if (base === "hour") return iso.slice(0, 13);
  if (base === "day") return iso.slice(0, 10);
  return iso.slice(0, 7);
}

/**
 * Dedupe for the `model_downgrade` ledger line: one per (scope, period).
 * `events` are prior ledger events so a restarted wrapper does not repeat itself.
 */
export function createDowngradeTracker({ events = [], runId = null, agentId = null, now = () => new Date() } = {}) {
  const seen = new Set();
  for (const e of events) if (e?.event === "model_downgrade") seen.add(`${e.scope}|${e.period}`);
  return {
    // Returns the event to persist (not yet written), or null when already noted.
    observe({ scope, fraction, cap, spent_usd }, from, to) {
      const period = periodOf(scope, runId, now());
      const k = `${scope}|${period}`;
      if (seen.has(k)) return null;
      seen.add(k);
      return { event: "model_downgrade", scope, fraction, cap, spent_usd, period, from, to, run_id: runId, agent_id: agentId };
    },
  };
}

export function downgradeLine({ scope, fraction, from, to }) {
  return `costcap: ${scope} spend is ${Math.round(fraction * 100)}% of its cap; downgrading ${from} -> ${to}`;
}
