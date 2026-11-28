// Budget-triggered model downgrade (#207): "degrade, don't die". Once the first
// run/hour/day/month scope of any cap (local, --policy agent/team, enrolled fleet)
// reaches a fraction F of its cap, a request for model FROM is forwarded as model TO.
// Only the JSON `model` field changes. A downgrade never raises or bypasses a cap:
// the hard stop at 100% is untouched, and TO goes through every model check.
// Unknown-cost receipts are excluded from spend, so spend is a lower bound and never $0-padded.
// Pure module: no proxy, CLI or hosted globals; config is injected.

import { isCustomProvider } from "./upstreams.js";

export const DEFAULT_DOWNGRADE_AT = 0.8;
export const DOWNGRADE_HEADER = "x-costcap-model-downgraded";
export const DOWNGRADE_SCOPES = Object.freeze(["run", "hour", "day", "month"]);
export const MAX_DOWNGRADE_PAIRS = 50;

const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,200}$/;

/** "FROM=TO[,FROM=TO]" -> { FROM: TO }. FROM==TO, duplicates and empty ids are errors. */
export function parseDowngradeMap(v) {
  const out = {};
  const parts = String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`--downgrade needs FROM=TO[,FROM=TO], got "${v}"`);
  for (const p of parts) {
    const i = p.indexOf("=");
    const from = i > 0 ? p.slice(0, i).trim() : "", to = i > 0 ? p.slice(i + 1).trim() : "";
    if (!MODEL_ID.test(from) || !MODEL_ID.test(to)) throw new Error(`--downgrade needs FROM=TO model ids, got "${p}"`);
    if (from === to) throw new Error(`--downgrade maps ${from} to itself`);
    if (Object.hasOwn(out, from)) throw new Error(`--downgrade has a duplicate FROM ${from}`);
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

/** Hosted policy field `downgrade: { at?, map }`; returns an error string or null. */
export function downgradeError(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== "object" || Array.isArray(d)) return "downgrade must be an object";
  for (const k of Object.keys(d)) if (k !== "at" && k !== "map") return `downgrade.${k} is not a field`;
  if (d.at !== undefined && !(typeof d.at === "number" && Number.isFinite(d.at) && d.at > 0 && d.at < 1)) return "downgrade.at must be a fraction between 0 and 1";
  if (!d.map || typeof d.map !== "object" || Array.isArray(d.map)) return "downgrade.map must be an object of FROM: TO";
  const pairs = Object.entries(d.map);
  if (!pairs.length) return "downgrade.map must not be empty";
  if (pairs.length > MAX_DOWNGRADE_PAIRS) return `downgrade.map has more than ${MAX_DOWNGRADE_PAIRS} entries`;
  for (const [from, to] of pairs) {
    if (!MODEL_ID.test(from) || typeof to !== "string" || !MODEL_ID.test(to)) return "downgrade.map entries must be model ids";
    if (from === to) return `downgrade.map maps ${from} to itself`;
  }
  return null;
}

/**
 * Effective downgrade from the fleet (server) setting and local flags. Local can only add
 * pairs or tighten: `at` is the lower of the two, and a fleet pair wins over a local one.
 */
export function mergeDowngrade(server, local) {
  const s = server && !downgradeError(server) ? server : null;
  const l = local && local.map && Object.keys(local.map).length ? local : null;
  if (!s && !l) return null;
  const ats = [s ? s.at ?? DEFAULT_DOWNGRADE_AT : null, l ? l.at ?? DEFAULT_DOWNGRADE_AT : null].filter((x) => x != null);
  // A local --downgrade-at without a local map still lowers the fleet threshold.
  if (local?.at != null) ats.push(local.at);
  return { at: Math.min(...ats), map: { ...(l?.map ?? {}), ...(s?.map ?? {}) } };
}

/**
 * First scope (run, hour, day, month; sources in order within a scope) whose spend is at or
 * above `at` of its cap. sources: [{ kind, caps: {scope: usd}, spend: {scope: usd} }].
 */
export function downgradeTrigger({ at, sources = [] }) {
  if (!(at > 0)) return null;
  for (const scope of DOWNGRADE_SCOPES) {
    for (const src of sources) {
      const cap = src?.caps?.[scope], spent = src?.spend?.[scope];
      if (!(typeof cap === "number" && cap > 0) || typeof spent !== "number" || !Number.isFinite(spent)) continue;
      if (spent >= cap * at) return { scope, kind: src.kind, cap, spent_usd: Number(spent.toFixed(6)), fraction: Number((spent / cap).toFixed(4)) };
    }
  }
  return null;
}

const REWRITE_PROVIDERS = new Set(["openai", "anthropic", "openrouter"]);
export const isRewritableProvider = (provider) => REWRITE_PROVIDERS.has(provider) || isCustomProvider(provider);

/**
 * Rewrites only the JSON `model` field. Returns null when the model is not mapped,
 * { unsupported: true, from } when it is mapped but this route cannot be rewritten,
 * else { body, parsed, from, to }.
 */
export function rewriteModel({ provider, body, parsed, model, map, route = {} }) {
  if (typeof model !== "string" || !map || !Object.hasOwn(map, model)) return null;
  const to = map[model];
  const unsupported = !isRewritableProvider(provider) || route.batch || route.audio || route.realtime
    || !parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.model !== model
    || (provider === "openrouter" && parsed.models !== undefined);
  if (unsupported) return { unsupported: true, from: model };
  const next = { ...parsed, model: to };
  return { body: Buffer.from(JSON.stringify(next)), parsed: next, from: model, to };
}

export function downgradePeriod(scope, { runId, now = new Date() } = {}) {
  const iso = new Date(now).toISOString();
  if (scope === "run") return String(runId ?? "");
  if (scope === "hour") return iso.slice(0, 13);
  if (scope === "day") return iso.slice(0, 10);
  if (scope === "month") return iso.slice(0, 7);
  throw new Error(`unknown scope ${scope}`);
}

export const downgradeLine = (ev) => `costcap: ${ev.kind} ${ev.scope} spend $${ev.spent_usd.toFixed(4)} is ${Math.round(ev.fraction * 100)}% of $${ev.cap} cap; downgrading ${ev.from} -> ${ev.to} (${ev.scope === "run" ? `run ${ev.period}` : `${ev.period} UTC`})`;

/**
 * One {"event":"model_downgrade"} ledger line per (kind, scope, period); rebuilt from prior
 * ledger events so a second wrap in the same period stays quiet. Events are never spend.
 */
export function createDowngradeNotifier({ events = [], runId = null, agentId = null, now = () => new Date() } = {}) {
  const key = (kind, scope, period) => `${kind}|${scope}|${period}`;
  const seen = new Set();
  for (const e of events) if (e?.event === "model_downgrade") seen.add(key(e.kind, e.scope, e.period));
  return {
    observe(trigger, { from, to }) {
      const period = downgradePeriod(trigger.scope, { runId, now: now() });
      const k = key(trigger.kind, trigger.scope, period);
      if (seen.has(k)) return null;
      seen.add(k);
      return { event: "model_downgrade", kind: trigger.kind, scope: trigger.scope, fraction: trigger.fraction, cap: trigger.cap, spent_usd: trigger.spent_usd, from, to, period, run_id: runId, agent_id: agentId };
    },
  };
}
