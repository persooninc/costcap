import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PLANS, priceCents } from "../src/billing/index.js";
import { TEAM_BUNDLE_LOOKUP_KEY, checkMonthlyPrice } from "../src/hosted/billing.js";
import { pricingMeta, uiResponse } from "../src/hosted/ui.js";
import { PUBLIC_PAGES, canary } from "../scripts/canary.mjs";

// costcap#141: one catalog drives the page, its meta/OG, and Checkout's price readback.
test("priceCents reads the catalog and rejects unpriced plans", () => {
  assert.equal(priceCents("workspace"), 1900);
  assert.equal(priceCents("team"), 7900);
  assert.equal(priceCents("free"), 0);
  assert.throws(() => priceCents("cli"), /No list price/);
  assert.throws(() => priceCents("nope"), /No list price/);
  assert.equal(priceCents("x", { x: { priceUsdMonthly: 9.99 } }), 999);
});

test("Checkout team lookup key and amount come from the catalog", () => {
  assert.equal(TEAM_BUNDLE_LOOKUP_KEY, DEFAULT_PLANS.team.lookupKey);
  assert.equal(TEAM_BUNDLE_LOOKUP_KEY, "guardrails_team_month");
  const price = { id: "price_abc", active: true, livemode: true, currency: "usd", unit_amount: priceCents("team"), recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } };
  assert.equal(checkMonthlyPrice(price, priceCents("team"), true), true);
  assert.equal(checkMonthlyPrice({ ...price, unit_amount: 7800 }, priceCents("team"), true), false);
});

test("pricing meta follows the catalog (no hard-coded mismatch)", () => {
  const meta = pricingMeta();
  assert.match(meta.description, /Solo at \$19 per month/);
  assert.match(meta.description, /Team \(Agent Guardrails bundle\) at \$79 per month/);
  assert.match(meta.og, /Solo \$19, Team \$79 per month/);
  const changed = { ...DEFAULT_PLANS, workspace: { ...DEFAULT_PLANS.workspace, priceUsdMonthly: 25 } };
  assert.match(pricingMeta(changed).description, /Solo at \$25 per month/);
  const page = uiResponse("/pricing", "", "https://costcap.dev", true, "live", { publicPricing: true, plans: changed }).body;
  assert.match(page, /<meta name="description" content="[^"]*Solo at \$25 per month/);
  assert.match(page, /\$25 USD per month/);
});

test("pricing page names the Guardrails bundle, OG tags, and sitemap entry", () => {
  const page = uiResponse("/pricing", "", "https://costcap.dev", true, "live", { publicPricing: true }).body;
  assert.match(page, /<title>CostCap pricing/);
  assert.match(page, /class="bundle">Same price as the Agent Guardrails bundle/);
  assert.match(page, /property="og:url" content="https:\/\/costcap.dev\/pricing"/);
  const sitemap = uiResponse("/sitemap.xml", "", "https://costcap.dev", true, "live", { publicPricing: true }).body;
  assert.match(sitemap, /<loc>https:\/\/costcap.dev\/pricing<\/loc>/);
});

test("canary requires /pricing to answer 200", async () => {
  assert.ok(PUBLIC_PAGES.includes("/pricing"));
  const result = await canary("http://example.invalid", async (url) => {
    if (url.endsWith("/health")) return { status: 200, json: async () => ({ billing: "disabled", persistence: "single-process-file" }) };
    if (url.endsWith("/ui/config")) return { status: 200, json: async () => ({ siteKey: "public" }) };
    if (url.endsWith("/v1/fleet")) return { status: 401, json: async () => ({}) };
    if (url.endsWith("/pricing")) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => ({}) };
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["page:/pricing"]);
});
