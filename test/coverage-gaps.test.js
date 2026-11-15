// Unit + regression tests for branches the main suites did not reach.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBillingConfig, priceLabel } from "../src/billing/config.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const base = {
  PATH: process.env.PATH,
  COSTCAP_ORIGIN: "https://costcap.example",
  TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret",
  BREVO_API_KEY: "brevo", COSTCAP_EMAIL_FROM: "a@example.com",
};
const preflight = (extra) => spawnSync(process.execPath, ["scripts/deploy-preflight.mjs"], { cwd: repo, env: { ...base, ...extra }, encoding: "utf8" });

test("deploy preflight rejects a non-URL origin", () => {
  const r = preflight({ COSTCAP_ORIGIN: "not a url" });
  assert.equal(r.status, 2); assert.match(r.stderr, /not a URL/);
});
test("deploy preflight rejects an http origin", () => {
  const r = preflight({ COSTCAP_ORIGIN: "http://costcap.example" });
  assert.equal(r.status, 2); assert.match(r.stderr, /must be https/);
});
test("deploy preflight rejects a non-brevo email provider", () => {
  const r = preflight({ COSTCAP_EMAIL_PROVIDER: "smtp" });
  assert.equal(r.status, 2); assert.match(r.stderr, /must be brevo/);
});
test("deploy preflight rejects more than one replica", () => {
  const r = preflight({ COSTCAP_REPLICAS: "2" });
  assert.equal(r.status, 2); assert.match(r.stderr, /one replica/);
});
test("deploy preflight never prints secret values", () => {
  const r = preflight({});
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /brevo"|secret$/);
});

test("billing config: defaults with no env object", () => {
  const c = resolveBillingConfig();
  assert.equal(c.enabled, false); assert.equal(c.stripeMode, "test");
  assert.equal(c.publicPricing, true); assert.equal(c.enforceEntitlements, true);
  assert.deepEqual(c.errors, []); assert.deepEqual(c.missing, []);
});
test("billing config: invalid flags each produce an error", () => {
  const c = resolveBillingConfig({ COSTCAP_BILLING: "on", COSTCAP_STRIPE_MODE: "prod", COSTCAP_PUBLIC_PRICING: "maybe", COSTCAP_STRIPE_TEAM_PRICE_ID: "bad", COSTCAP_ENTITLEMENTS: "off" });
  assert.equal(c.errors.length, 5);
  assert.equal(c.stripeMode, "test", "unknown mode falls back to test");
});
test("billing config: live mode requires account id and defaults to report", () => {
  const c = resolveBillingConfig({ X_BILLING: "enabled", X_STRIPE_MODE: "live" }, { prefix: "X_" });
  assert.ok(c.required.includes("X_STRIPE_ACCOUNT_ID"));
  assert.equal(c.missing.length, 4); assert.equal(c.enforceEntitlements, false);
});
test("billing config: test mode rejects a non-test key, explicit entitlements win", () => {
  const c = resolveBillingConfig({ COSTCAP_BILLING: "enabled", COSTCAP_STRIPE_SECRET_KEY: "rk_other", COSTCAP_ENTITLEMENTS: "report", COSTCAP_PUBLIC_PRICING: "disabled", COSTCAP_STRIPE_TEAM_PRICE_ID: "price_abc" });
  assert.match(c.errors.join(), /sk_test_/);
  assert.equal(c.enforceEntitlements, false); assert.equal(c.publicPricing, false); assert.equal(c.teamPrice, true);
});
test("priceLabel covers test, off, whole and fractional prices", () => {
  assert.match(priceLabel({ billing: true, stripeMode: "test" }), /Test mode/);
  assert.match(priceLabel({ billing: false, stripeMode: "live" }), /Not on sale/);
  assert.equal(priceLabel({ billing: true, stripeMode: "live" }), "$19 USD per month");
  assert.equal(priceLabel({ billing: true, stripeMode: "live", amount: 1950, currency: "EUR", interval: "year" }), "$19.50 EUR per year");
});
