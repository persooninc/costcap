// Portable billing configuration. Reads only the env object it is given,
// never process.env. Never returns a secret value: only names and booleans.

/** @typedef {import('./index.js').BillingConfig} BillingConfig */

const MODES = new Set(["live", "test"]);
const ENFORCEMENT = new Set(["", "enforced", "report"]);

/**
 * Resolve billing switches from an env object.
 * - `<P>BILLING=enabled` turns checkout on. Default off.
 * - `<P>STRIPE_MODE` is `live` (default) or `test`. Test mode accepts only an `sk_test_` key.
 * - `<P>PUBLIC_PRICING=enabled` serves the public pricing page. Owner gate, default off.
 * - `<P>ENTITLEMENTS` is `enforced` or `report`. Default: enforced in test mode,
 *   report-only in live mode, so a deploy never starts limiting live free users
 *   without an explicit owner switch.
 * @param {Record<string, string|undefined>} env
 * @param {{ prefix?: string }} [options]
 * @returns {BillingConfig}
 */
export function resolveBillingConfig(env = {}, { prefix = "COSTCAP_" } = {}) {
  const get = (key) => String(env[`${prefix}${key}`] ?? "").trim();
  const errors = [];
  const billingFlag = get("BILLING");
  if (billingFlag && billingFlag !== "enabled") errors.push(`${prefix}BILLING must be enabled or unset`);
  const stripeMode = get("STRIPE_MODE") || "live";
  if (!MODES.has(stripeMode)) errors.push(`${prefix}STRIPE_MODE must be live or test`);
  const enforcementFlag = get("ENTITLEMENTS");
  if (!ENFORCEMENT.has(enforcementFlag)) errors.push(`${prefix}ENTITLEMENTS must be enforced or report`);
  const enabled = billingFlag === "enabled";
  const required = [`${prefix}STRIPE_SECRET_KEY`, `${prefix}STRIPE_WEBHOOK_SECRET`, `${prefix}STRIPE_PRICE_ID`];
  if (stripeMode === "live") required.push(`${prefix}STRIPE_ACCOUNT_ID`);
  const missing = enabled ? required.filter((key) => !String(env[key] ?? "").trim()) : [];
  const secret = get("STRIPE_SECRET_KEY");
  if (enabled && stripeMode === "test" && secret && !secret.startsWith("sk_test_")) {
    errors.push(`${prefix}STRIPE_SECRET_KEY must be an sk_test_ key in test mode`);
  }
  return {
    enabled,
    stripeMode: MODES.has(stripeMode) ? stripeMode : "live",
    publicPricing: get("PUBLIC_PRICING") === "enabled",
    enforceEntitlements: enforcementFlag ? enforcementFlag === "enforced" : stripeMode === "test",
    required,
    missing,
    errors,
  };
}

/**
 * Price label for public copy. Live billing shows the verified price; test mode
 * never shows a price; billing off says the plan is not on sale.
 * @param {{ billing: boolean, stripeMode: string, amount?: number, currency?: string, interval?: string }} input
 */
export function priceLabel({ billing, stripeMode, amount = 1900, currency = "USD", interval = "month" }) {
  if (stripeMode === "test") return "Test mode. No public price.";
  if (!billing) return "Not on sale yet. Free beta.";
  const whole = amount % 100 === 0 ? String(amount / 100) : (amount / 100).toFixed(2);
  return `$${whole} ${currency} per ${interval}`;
}
