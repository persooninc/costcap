// Issue #268 AC5: a frozen copy of the wrapper-side checks at 20dfc3a (pre-#268),
// so a week-capped /v1/policy is proven acceptable to an already-deployed wrapper.
// Generated from `git show 20dfc3a:<file>`; do not edit to match newer code.
import { TAG_KEY } from "../../src/tags.js";
import { warnFractionsError, sortWarnFractions } from "../../src/hosted/alerts.js";
import { validatePolicy as currentValidatePolicy } from "../../src/hosted/policy.js";
import { normalizeModel } from "../../src/model-cap.js";

const MODEL_CAP_SCOPES = Object.freeze(["hour", "day", "month"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const MAX_FLEET_MODELS = 20;
export const FLEET_TAG_SCOPES = Object.freeze(["day", "month"]);
export const MAX_FLEET_TAG_RULES = 10;
export function parseFleetTagCaps(input) {
  if (!Array.isArray(input)) return { error: "tagCaps must be a list" };
  if (input.length > MAX_FLEET_TAG_RULES) return { error: `At most ${MAX_FLEET_TAG_RULES} tag cap rules` };
  const seen = new Set();
  const rules = [];
  for (const r of input) {
    if (!r || typeof r !== "object" || typeof r.key !== "string" || !TAG_KEY.test(r.key)) return { error: "Each rule key must match [a-z0-9_.-]{1,32}" };
    if (!FLEET_TAG_SCOPES.includes(r.scope)) return { error: "Each rule scope must be day or month" };
    if (!(typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd > 0)) return { error: "Each rule usd must be a positive number" };
    const id = `${r.key}:${r.scope}`;
    if (seen.has(id)) return { error: `Duplicate rule ${id}` };
    seen.add(id);
    // Issue #243: optional per-rule cap_approaching fractions (default [0.8] when absent).
    if (r.warnFractions !== undefined) {
      const err = warnFractionsError(r.warnFractions);
      if (err) return { error: `Rule ${id}: ${err}` };
    }
    rules.push({ key: r.key, scope: r.scope, usd: r.usd, ...(r.warnFractions !== undefined ? { warnFractions: sortWarnFractions(r.warnFractions) } : {}) });
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
      if (!FLEET_TAG_SCOPES.every((s) => typeof e[s] === "number" && Number.isFinite(e[s]) && e[s] >= 0)) return false;
    }
  }
  return true;
}
export const ORG_SCOPES = Object.freeze(["day", "month"]); // no org week cap yet (#261 Out)
export function validOrgBudgetPolicy(o) {
  if (o === null || o === undefined) return true;
  if (typeof o !== "object" || !Number.isFinite(Date.parse(o.as_of)) || typeof o.verdict !== "string") return false;
  if (!Number.isInteger(o.spend?.unknown_count) || o.spend.unknown_count < 0) return false;
  if (!ORG_SCOPES.some((s) => o.caps?.[s] != null)) return false;
  for (const s of ORG_SCOPES) {
    const cap = o.caps?.[s];
    if (cap != null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) return false;
    const spent = o.spend[`${s}_usd`];
    if (!(typeof spent === "number" && Number.isFinite(spent) && spent >= 0)) return false;
  }
  return true;
}
export const FLEET_MODEL_SCOPES = Object.freeze(["day", "month"]);
export function validModelSpend(m) {
  if (m === undefined || m === null) return true;
  if (typeof m !== "object" || Array.isArray(m) || Object.keys(m).length > MAX_FLEET_MODELS) return false;
  return Object.values(m).every((e) => e && typeof e === "object" && Number.isInteger(e.unknown) && e.unknown >= 0
    && FLEET_MODEL_SCOPES.every((s) => typeof e[s] === "number" && Number.isFinite(e[s]) && e[s] >= 0));
}
export function modelCapsError(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20) return "modelCaps must be a list of 1-20 {model, scope, usd} rules";
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => !["model", "scope", "usd"].includes(k))) return "modelCaps entries are {model, scope, usd}";
    if (typeof r.model !== "string" || !MODEL_ID.test(r.model)) return "modelCaps model must be a model id";
    if (!MODEL_CAP_SCOPES.includes(r.scope)) return "modelCaps scope must be hour, day or month";
    if (!(typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd > 0)) return "modelCaps usd must be a positive number";
    const id = `${normalizeModel(r.model)}:${r.scope}`;
    if (seen.has(id)) return `duplicate modelCaps rule ${r.model}:${r.scope}`;
    seen.add(id);
  }
  return null;
}

// validatePolicy at 20dfc3a differed from today's only in the modelCaps scopes
// (#268 adds week), so the frozen check is today's minus that plus the old rule.
export function validatePolicy(p) {
  const errors = currentValidatePolicy({ ...p, modelCaps: undefined });
  if (p?.modelCaps !== undefined && p.modelCaps !== null) { const err = modelCapsError(p.modelCaps); if (err) errors.push(err); }
  return errors;
}
