// Issue #286 AC6: a frozen copy of the wrapper-side checks at b91f36e (pre-#286),
// so a /v1/policy with total caps is proven acceptable to an already-deployed wrapper.
// Generated from `git show b91f36e:<file>`; do not edit to match newer code.
import { TAG_KEY } from "../../src/tags.js";
import { warnFractionsError } from "../../src/hosted/alerts.js";
import { validatePolicy as currentValidatePolicy } from "../../src/hosted/policy.js";
import { normalizeModel } from "../../src/model-cap.js";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const HOSTED_MODEL_CAP_SCOPES = Object.freeze(["hour", "day", "week", "month"]);
const FLEET_TAG_SCOPES = Object.freeze(["day", "week", "month"]);
const MAX_FLEET_TAG_RULES = 10;
const MAX_FLEET_MODELS = 20;
const REQUIRED_SPEND = ["day", "month"];
const ORG_SCOPES = Object.freeze(["day", "week", "month"]);
const LEGACY_ORG_SCOPES = Object.freeze(["day", "month"]);
export function parseFleetTagCaps(input) {
  if (!Array.isArray(input)) return { error: "tagCaps must be a list" };
  if (input.length > MAX_FLEET_TAG_RULES) return { error: `At most ${MAX_FLEET_TAG_RULES} tag cap rules` };
  const seen = new Set();
  const rules = [];
  for (const r of input) {
    if (!r || typeof r !== "object" || typeof r.key !== "string" || !TAG_KEY.test(r.key)) return { error: "Each rule key must match [a-z0-9_.-]{1,32}" };
    if (!FLEET_TAG_SCOPES.includes(r.scope)) return { error: "Each rule scope must be day, week or month" };
    if (!(typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd > 0)) return { error: "Each rule usd must be a positive number" };
    const id = `${r.key}:${r.scope}`;
    if (seen.has(id)) return { error: `Duplicate rule ${id}` };
    seen.add(id);
    // Issue #243: optional per-rule cap_approaching fractions (default [0.8] when absent).
    if (r.warnFractions !== undefined) {
      const err = warnFractionsError(r.warnFractions);
      if (err) return { error: `Rule ${id}: ${err}` };
    }
    rules.push({ key: r.key, scope: r.scope, usd: r.usd, ...(r.warnFractions !== undefined ? { warnFractions: [...r.warnFractions].sort((a, b) => a - b) } : {}) });
  }
  return { rules };
}
export function validFleetTagCaps(t) {
  if (t === null || t === undefined) return true;
  if (typeof t !== "object" || typeof t.truncated !== "boolean" || !Number.isFinite(Date.parse(t.as_of))) return false;
  if (!t.rules?.length || parseFleetTagCaps(t.rules).error || !t.spend || typeof t.spend !== "object") return false;
  for (const values of Object.values(t.spend)) {
    if (!values || typeof values !== "object") return false;
    for (const e of Object.values(values)) {
      if (!e || !Number.isInteger(e.unknown) || e.unknown < 0) return false;
      if (!REQUIRED_SPEND.every((s) => typeof e[s] === "number" && Number.isFinite(e[s]) && e[s] >= 0)) return false;
      if (e.week !== undefined && !(typeof e.week === "number" && Number.isFinite(e.week) && e.week >= 0)) return false;
      if (e.unknown_week !== undefined && !(Number.isInteger(e.unknown_week) && e.unknown_week >= 0)) return false;
    }
  }
  return true;
}
export function validOrgBudgetPolicy(o) {
  if (o === null || o === undefined) return true;
  if (typeof o !== "object" || !Number.isFinite(Date.parse(o.as_of)) || typeof o.verdict !== "string") return false;
  if (!Number.isInteger(o.spend?.unknown_count) || o.spend.unknown_count < 0) return false;
  if (!ORG_SCOPES.some((s) => o.caps?.[s] != null)) return false;
  for (const s of ORG_SCOPES) {
    const cap = o.caps?.[s];
    if (cap != null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) return false;
    const spent = o.spend[`${s}_usd`];
    if (spent === undefined && !LEGACY_ORG_SCOPES.includes(s)) continue; // week spend is optional (missing = 0)
    if (!(typeof spent === "number" && Number.isFinite(spent) && spent >= 0)) return false;
  }
  return true;
}
export function validWeekModelCaps(list) {
  if (list === null || list === undefined) return true;
  return Array.isArray(list) && list.length <= MAX_FLEET_MODELS && list.every((r) => r && r.scope === "week" && typeof r.model === "string" && r.model
    && typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd > 0);
}
export function validModelSpend(m) {
  if (m === undefined || m === null) return true;
  if (typeof m !== "object" || Array.isArray(m) || Object.keys(m).length > MAX_FLEET_MODELS) return false;
  return Object.values(m).every((e) => e && typeof e === "object" && Number.isInteger(e.unknown) && e.unknown >= 0
    && REQUIRED_SPEND.every((s) => typeof e[s] === "number" && Number.isFinite(e[s]) && e[s] >= 0)
    && (e.week === undefined || (typeof e.week === "number" && Number.isFinite(e.week) && e.week >= 0))
    && (e.unknown_week === undefined || (Number.isInteger(e.unknown_week) && e.unknown_week >= 0)));
}
export function modelCapsError(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20) return "modelCaps must be a list of 1-20 {model, scope, usd} rules";
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => !["model", "scope", "usd"].includes(k))) return "modelCaps entries are {model, scope, usd}";
    if (typeof r.model !== "string" || !MODEL_ID.test(r.model)) return "modelCaps model must be a model id";
    if (!HOSTED_MODEL_CAP_SCOPES.includes(r.scope)) return "modelCaps scope must be hour, day, week or month";
    if (!(typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd > 0)) return "modelCaps usd must be a positive number";
    const id = `${normalizeModel(r.model)}:${r.scope}`;
    if (seen.has(id)) return `duplicate modelCaps rule ${r.model}:${r.scope}`;
    seen.add(id);
  }
  return null;
}

// validatePolicy at b91f36e differed from today's only in the modelCaps scopes
// (#286 adds total), so the frozen check is today's minus that plus the old rule.
export function validatePolicy(p) {
  const errors = currentValidatePolicy({ ...p, modelCaps: undefined });
  if (p?.modelCaps !== undefined && p.modelCaps !== null) { const err = modelCapsError(p.modelCaps); if (err) errors.push(err); }
  return errors;
}
