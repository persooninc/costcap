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
    summary: "Hosted fleet view for a small team.",
    limits: Object.freeze({ agents: 3, seats: 3 }),
    features: Object.freeze([
      "Up to 3 enrolled agents",
      "Up to 3 people (owner included)",
      "Remote caps, freeze and resume",
      "Alerts, audit log, receipts CSV",
    ]),
  }),
  workspace: Object.freeze({
    id: "workspace",
    name: "Workspace plan",
    hosted: true,
    paid: true,
    summary: "The same workspace without the small-team limits.",
    limits: Object.freeze({ agents: 100, seats: 20 }),
    features: Object.freeze([
      "Up to 100 enrolled agents",
      "Up to 20 people",
      "Everything in the free workspace",
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

/**
 * Hosted plan for a subscription status. Any status that is not paid
 * (none, free_beta, canceled, unpaid, incomplete, incomplete_expired) is free.
 * @returns {Plan}
 */
export function planForStatus(status, catalog = DEFAULT_PLANS) {
  const paid = listPlans(catalog).find((p) => p.hosted && p.paid);
  const free = listPlans(catalog).find((p) => p.hosted && !p.paid);
  if (!free) throw new Error("Plan catalog needs a free hosted plan");
  return isPaidStatus(status) && paid ? paid : free;
}

/** The paid hosted plan a free workspace upgrades to, or null. */
export function upgradePlan(catalog = DEFAULT_PLANS) {
  return listPlans(catalog).find((p) => p.hosted && p.paid) ?? null;
}
