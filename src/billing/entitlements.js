// Portable entitlement checks. Pure functions over (status, usage, catalog).
// The host app counts usage and decides where to call these; this module
// never reads a store, a request, or the environment.
import { DEFAULT_PLANS, planForStatus, upgradePlan } from "./plans.js";

/** @typedef {import('./index.js').Entitlements} Entitlements */
/** @typedef {import('./index.js').EntitlementDecision} EntitlementDecision */

/**
 * Entitlements for a workspace.
 * @param {{ status?: string|null, enforced?: boolean, catalog?: import('./index.js').PlanCatalog }} [input]
 * @returns {Entitlements}
 */
export function entitlementsFor({ status = null, enforced = false, catalog = DEFAULT_PLANS } = {}) {
  const plan = planForStatus(status, catalog);
  const next = plan.paid ? null : upgradePlan(catalog);
  return {
    plan: plan.id,
    planName: plan.name,
    paid: plan.paid,
    enforced: Boolean(enforced),
    limits: { ...plan.limits },
    upgradeTo: next ? { id: next.id, name: next.name, limits: { ...next.limits } } : null,
  };
}

/**
 * May the workspace add `adding` more of `feature` given `used` today?
 * When not enforced the decision is always allowed, but `wouldExceed`
 * still reports the overage so the UI can show the upgrade path.
 * @param {Entitlements} entitlements
 * @param {string} feature
 * @param {number} used
 * @param {number} [adding]
 * @returns {EntitlementDecision}
 */
export function checkLimit(entitlements, feature, used, adding = 1) {
  const raw = entitlements.limits[feature];
  const limit = Number.isFinite(raw) ? raw : Infinity;
  const wouldExceed = used + adding > limit;
  return {
    feature,
    allowed: !wouldExceed || !entitlements.enforced,
    wouldExceed,
    used,
    limit: Number.isFinite(limit) ? limit : null,
    plan: entitlements.plan,
    upgradeTo: wouldExceed ? entitlements.upgradeTo : null,
  };
}

/** Error carrying a 402 status and a JSON-safe upgrade hint. */
export class EntitlementError extends Error {
  /** @param {EntitlementDecision} decision @param {string} [upgradeUrl] */
  constructor(decision, upgradeUrl = "/#plan") {
    const target = decision.upgradeTo ? ` Upgrade to the ${decision.upgradeTo.name} for more.` : "";
    super(`Your plan allows ${decision.limit} ${decision.feature}.${target}`);
    this.name = "EntitlementError";
    this.status = 402;
    this.body = {
      code: "plan_limit",
      feature: decision.feature,
      limit: decision.limit,
      used: decision.used,
      plan: decision.plan,
      upgrade: decision.upgradeTo ? { plan: decision.upgradeTo.id, url: upgradeUrl } : null,
    };
  }
}

/** Throw EntitlementError when the decision is not allowed. Returns the decision otherwise. */
export function requireLimit(entitlements, feature, used, adding = 1, upgradeUrl) {
  const decision = checkLimit(entitlements, feature, used, adding);
  if (!decision.allowed) throw new EntitlementError(decision, upgradeUrl);
  return decision;
}
