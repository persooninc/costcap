// Portable plan catalog. No app globals, no Stripe calls, no I/O.
// A host app may pass its own catalog to every function in this module.
// Limits are integers; Infinity means "not limited by plan".

/** @typedef {import('./index.js').Plan} Plan */
/** @typedef {import('./index.js').PlanCatalog} PlanCatalog */

// Subscription statuses that keep the paid plan. `past_due` stays on the plan
// (Stripe is retrying the invoice) and blocks a second checkout.
export const PAID_STATUSES = Object.freeze(["active", "trialing", "past_due"]);

/** @type {PlanCatalog} */
export const DEFAULT_PLANS = Object.freeze({
  cli: Object.freeze({
    id: "cli",
    name: "CLI",
    hosted: false,
    paid: false,
    summary: "Local spend cap. One wrap command, no account.",
    limits: Object.freeze({}),
    features: Object.freeze([
      "Run, day and month USD caps",
      "Retry-spiral and cost-velocity breakers",
      "Local kill and resume",
      "Receipts on disk",
    ]),
  }),
  free: Object.freeze({
    id: "free",
    name: "Free workspace",
    hosted: true,
    paid: false,
    priceUsdMonthly: 0,
    summary: "Hosted fleet view for a small team.",
    limits: Object.freeze({ agents: 3, seats: 3, receiptRetentionDays: 30 }),
    features: Object.freeze([
      "Up to 3 enrolled agents",
      "Up to 3 people (owner included)",
      "Remote caps, freeze and resume",
      "Alerts, audit log, receipts CSV",
      "Receipts shown for 30 days",
    ]),
  }),
  // Id stays "workspace" so stored subscriptions from the first paid plan keep resolving.
  workspace: Object.freeze({
    id: "workspace",
    name: "Solo",
    hosted: true,
    paid: true,
    priceUsdMonthly: 19,
    summary: "For one builder running a handful of agents.",
    limits: Object.freeze({ agents: 15, seats: 3, receiptRetentionDays: 90 }),
    features: Object.freeze([
      "Up to 15 enrolled agents",
      "Up to 3 people",
      "Receipts shown for 90 days",
      "Everything in the free workspace",
      "Monthly renewal, cancel in the billing portal",
    ]),
  }),
  team: Object.freeze({
    id: "team",
    name: "Team",
    hosted: true,
    paid: true,
    priceUsdMonthly: 79,
    // Sold only in Stripe test mode until the owner approves a live Team price.
    testModeOnly: true,
    summary: "For a team sharing one agent fleet.",
    limits: Object.freeze({ agents: 50, seats: 15, receiptRetentionDays: 365 }),
    features: Object.freeze([
      "Up to 50 enrolled agents",
      "Up to 15 people with admin and viewer roles",
      "Receipts shown for 1 year",
      "Everything in Solo",
      "Monthly renewal, cancel in the billing portal",
    ]),
  }),
});

/** Plans in display order. */
export function listPlans(catalog = DEFAULT_PLANS) {
  return Object.values(catalog);
}

/** True when a provider subscription status keeps the paid plan. */
export function isPaidStatus(status) {
  return PAID_STATUSES.includes(String(status ?? ""));
}

/** Paid hosted plans in display order (cheapest first). */
export function paidPlans(catalog = DEFAULT_PLANS) {
  return listPlans(catalog).filter((p) => p.hosted && p.paid);
}

/**
 * Hosted plan for a subscription status. Any status that is not paid
 * (none, free_beta, canceled, unpaid, incomplete, incomplete_expired) is free.
 * A paid status uses `planId` when it names a paid hosted plan, else the first paid plan
 * (subscriptions recorded before plan ids existed).
 * @returns {Plan}
 */
export function planForStatus(status, catalog = DEFAULT_PLANS, planId = null) {
  const paid = paidPlans(catalog);
  const free = listPlans(catalog).find((p) => p.hosted && !p.paid);
  if (!free) throw new Error("Plan catalog needs a free hosted plan");
  if (!isPaidStatus(status) || !paid.length) return free;
  return paid.find((p) => p.id === planId) ?? paid[0];
}

/** The next paid hosted plan above `fromPlanId` (free, or unknown, upgrades to the first paid plan), or null. */
export function upgradePlan(catalog = DEFAULT_PLANS, fromPlanId = null) {
  const paid = paidPlans(catalog);
  const at = paid.findIndex((p) => p.id === fromPlanId);
  return paid[at + 1] ?? null;
}
