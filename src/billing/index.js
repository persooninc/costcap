// Portable billing module: plan catalog, entitlement checks, config switches.
// Provider adapters (Stripe Checkout live + test mode) live in
// src/hosted/billing.js and depend on the host store; this package does not.
// Types: ./index.d.ts.
export { DEFAULT_PLANS, PAID_STATUSES, listPlans, isPaidStatus, planForStatus, upgradePlan } from "./plans.js";
export { entitlementsFor, checkLimit, requireLimit, EntitlementError } from "./entitlements.js";
export { resolveBillingConfig, priceLabel } from "./config.js";
