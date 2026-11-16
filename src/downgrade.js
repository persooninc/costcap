// Budget-triggered model downgrade (#207): "degrade, don't die". Once the first
// run/hour/day/month scope reaches a fraction F of its cap, a request for model
// FROM goes upstream as model TO. Only the JSON `model` field changes. The hard
// stop at 100% is untouched: a downgrade never raises or bypasses a cap.
// Unknown cost is never counted as $0: known spend is a lower bound and still
// triggers when it alone reaches F.

export const DEFAULT_DOWNGRADE_AT = 0.8;
export const DOWNGRADE_HEADER = "x-costcap-model-downgraded";
export const DOWNGRADE_SCOPES = Object.freeze(["run", "hour", "day", "month"]);
// Routes whose model lives in the top-level JSON `model` field.
const JSON_MODEL_PROVIDERS = new Set(["openai", "anthropic", "openrouter"]);

const isId = (m) => typeof m === "string" && m.trim() !== "" && m === m.trim();

// "--downgrade FROM=TO[,FROM=TO]" -> { FROM: TO }.
export function parseDowngradeMap(v) {
  const map = {};
  const parts = String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`--downgrade needs FROM=TO[,FROM=TO], got "${v}"`);
  for (const p of parts) {
    const i = p.indexOf("=");
    const from = i > 0 ? p.slice(0, i).trim() : "", to = i > 0 ? p.slice(i + 1).trim() : "";
    if (!from || !to) throw new Error(`--downgrade needs FROM=TO, got "${p}"`);
    if (from === to) throw new Error(`--downgrade maps "${from}" to itself`);
    if (Object.hasOwn(map, from)) throw new Error(`--downgrade has "${from}" twice`);
    map[from] = to;
  }
  return map;
}

// "--downgrade-at F": 0 < F <= 1.
export function parseDowngradeAt(v) {
  const n = String(v).trim() === "" ? NaN : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`--downgrade-at needs a fraction greater than 0 and at most 1, got "${v}"`);
  return n;
}

// Hosted policy field { at, map }. Returns an error string or null.
export function downgradeError(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "downgrade must be an object { at, map }";
  if (!(typeof d.at === "number" && Number.isFinite(d.at) && d.at > 0 && d.at <= 1)) return "downgrade.at must be a fraction greater than 0 and at most 1";
  if (!d.map || typeof d.map !== "object" || Array.isArray(d.map) || !Object.keys(d.map).length) return "downgrade.map must be a non-empty object of FROM: TO model ids";
  for (const [from, to] of Object.entries(d.map)) {
    if (!isId(from) || !isId(to)) return "downgrade.map entries must be model ids";
    if (from === to) return `downgrade.map maps "${from}" to itself`;
  }
  return null;
}

// Fleet + local: local can only add mappings for models the fleet does not map,
// and can only lower `at`. Returns { at, map } or null when nothing is mapped.
export function mergeDowngrade(server, local) {
  const map = { ...(local?.map ?? {}), ...(server?.map ?? {}) };
  if (!Object.keys(map).length) return null;
  const ats = [server?.map ? server.at : null, local?.at].filter((x) => typeof x === "number");
  return { at: ats.length ? Math.min(...ats) : DEFAULT_DOWNGRADE_AT, map };
}

// usage: [{ scope, cap, spent }] in priority order. First entry whose spend is at
// or above at * cap, or null.
export function downgradeTrigger(usage, at) {
  for (const u of usage ?? []) {
    if (u?.cap == null || !(u.cap > 0) || typeof u.spent !== "number") continue;
    if (u.spent >= u.cap * at) return { scope: u.scope, fraction: at, cap: u.cap, spent_usd: Number(u.spent.toFixed(6)) };
  }
  return null;
}

// Usage rows from a spend object and caps, in scope order.
export function scopeUsage(caps = {}, spend = {}, label = null) {
  return DOWNGRADE_SCOPES.filter((s) => caps[s] != null && typeof spend[s] === "number")
    .map((s) => ({ scope: label ? `${label}:${s}` : s, cap: caps[s], spent: spend[s] }));
}

// Whether a request can have its model rewritten. Gemini (model in path),
// Bedrock/Vertex, batches, multipart audio and OpenRouter `models[]` cannot.
export function downgradeRoute({ provider, custom = false, cloud = false, batch = false, multipart = false, routerModels = null, parsedBody }) {
  if (cloud || batch || multipart) return false;
  if (!custom && !JSON_MODEL_PROVIDERS.has(provider)) return false;
  if (Array.isArray(routerModels) && routerModels.length) return false;
  return Boolean(parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) && typeof parsedBody.model === "string");
}

// New body with only `model` replaced; key order and every other value are kept.
export function rewriteModel(parsedBody, to) {
  return Buffer.from(JSON.stringify({ ...parsedBody, model: to }));
}

function periodKey(scope, runId, now) {
  const base = scope.split(":").at(-1);
  const iso = new Date(now).toISOString();
  if (base === "run") return String(runId ?? "");
  if (base === "hour") return iso.slice(0, 13);
  if (base === "day") return iso.slice(0, 10);
  return iso.slice(0, 7);
}

export function downgradeLine(ev) {
  return `costcap: model downgrade: ${ev.scope} spend ${ev.lower_bound ? "(lower bound) " : ""}$${ev.spent_usd.toFixed(4)} is at or above ${Math.round(ev.fraction * 100)}% of $${ev.cap} cap; ${ev.from} -> ${ev.to} (${ev.period})`;
}

// Stateful downgrader for the proxy.
// config(): { at, map } | null (re-read per call, so fleet syncs apply).
// usage(): [{ scope, cap, spent }] in priority order; lowerBound(): unknown cost present.
// One model_downgrade event per scope and period, rebuilt from prior ledger events.
export function createDowngrader({ config, usage, lowerBound = () => false, events = [], runId = null, agentId = null, now = () => new Date() }) {
  const seen = new Set();
  for (const e of events) if (e?.event === "model_downgrade") seen.add(`${e.scope}|${e.period}`);
  return {
    // { to, scope, fraction, cap, spent_usd } for a model, or null.
    decide(model) {
      const c = config?.();
      if (!c || typeof model !== "string" || !Object.hasOwn(c.map, model)) return null;
      const t = downgradeTrigger(usage?.() ?? [], c.at);
      return t ? { from: model, to: c.map[model], ...t } : null;
    },
    // The model_downgrade event to persist for a decision, or null if already noted this period.
    notice(d) {
      const period = periodKey(d.scope, runId, now());
      const k = `${d.scope}|${period}`;
      if (seen.has(k)) return null;
      seen.add(k);
      return { event: "model_downgrade", scope: d.scope, fraction: d.fraction, cap: d.cap, spent_usd: d.spent_usd, from: d.from, to: d.to, period, run_id: runId, agent_id: agentId, lower_bound: Boolean(lowerBound()) };
    },
    note(e) { if (e?.event === "model_downgrade") seen.add(`${e.scope}|${e.period}`); },
  };
}
