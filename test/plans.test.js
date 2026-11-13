import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PLANS, checkLimit, entitlementsFor, paidPlans, planForStatus, requireLimit, resolveBillingConfig, retentionCutoff, upgradePlan } from "../src/billing/index.js";
import { openStore } from "../src/hosted/store.js";
import { createStripeBilling, createTestModeStripeBilling, stripeHealth } from "../src/hosted/billing.js";

test("Team entitlements: 50 agents, 15 people, 1-year receipts, top of the ladder", () => {
  const team = entitlementsFor({ status: "active", plan: "team", enforced: true });
  assert.equal(team.plan, "team");
  assert.equal(team.planName, "Team");
  assert.deepEqual(team.limits, { agents: 50, seats: 15, receiptRetentionDays: 365 });
  assert.equal(team.upgradeTo, null);
  assert.equal(checkLimit(team, "agents", 49).allowed, true);
  assert.equal(checkLimit(team, "agents", 50).allowed, false);
  assert.throws(() => requireLimit(team, "seats", 15, 1, "/pricing"), (err) => err.status === 402 && err.body.upgrade === null);
  assert.equal(DEFAULT_PLANS.team.priceUsdMonthly, 79);
  assert.equal(DEFAULT_PLANS.workspace.priceUsdMonthly, 19);
});

test("plan ladder: free -> Solo -> Team; unknown or legacy paid subscriptions resolve to Solo", () => {
  assert.deepEqual(paidPlans().map((p) => p.id), ["workspace", "team"]);
  assert.equal(entitlementsFor({ status: null }).upgradeTo.id, "workspace");
  assert.equal(entitlementsFor({ status: "active" }).plan, "workspace");
  assert.equal(entitlementsFor({ status: "active" }).upgradeTo.id, "team");
  assert.equal(entitlementsFor({ status: "active", plan: "enterprise" }).plan, "workspace");
  assert.equal(entitlementsFor({ status: "canceled", plan: "team" }).plan, "free");
  assert.equal(planForStatus("past_due", DEFAULT_PLANS, "team").id, "team");
  assert.equal(upgradePlan(DEFAULT_PLANS, "team"), null);
});

test("retention hides receipts past the plan window only when enforced", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  assert.equal(retentionCutoff(entitlementsFor({ status: "active", plan: "team", enforced: true }), now), now - 365 * 86400_000);
  assert.equal(retentionCutoff(entitlementsFor({ status: null, enforced: true }), now), now - 30 * 86400_000);
  assert.equal(retentionCutoff(entitlementsFor({ status: "active", plan: "team", enforced: false }), now), null);
});

test("billing config: public pricing on by default, team price optional and validated", () => {
  assert.equal(resolveBillingConfig({}).publicPricing, true);
  assert.equal(resolveBillingConfig({ COSTCAP_PUBLIC_PRICING: "disabled" }).publicPricing, false);
  assert.match(resolveBillingConfig({ COSTCAP_PUBLIC_PRICING: "maybe" }).errors.join(), /PUBLIC_PRICING/);
  assert.equal(resolveBillingConfig({ COSTCAP_STRIPE_TEAM_PRICE_ID: "price_team" }).teamPrice, true);
  assert.match(resolveBillingConfig({ COSTCAP_STRIPE_TEAM_PRICE_ID: "prod_x" }).errors.join(), /TEAM_PRICE_ID/);
  assert.equal(stripeHealth({ env: {} }).team, "unset");
  assert.equal(stripeHealth({ env: { COSTCAP_STRIPE_PRICE_ID: "price_solo", COSTCAP_STRIPE_TEAM_PRICE_ID: "price_team" } }).team, "ready");
  assert.equal(stripeHealth({ env: { COSTCAP_STRIPE_TEAM_PRICE_ID: "price_team" }, mode: "live" }).team, "misconfigured");
});

test("test-mode checkout sells Team only with an owner team price and records the plan", async () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "cc-team-")), "s.json"));
  store.transaction((s) => { s.orgs.org1 = { id: "org1" }; });
  const posts = [];
  const sub = { id: "sub_t", livemode: false, status: "active", customer: "cus_t", metadata: { app: "costcap", org_id: "org1" }, items: { data: [{ price: { id: "price_team" }, quantity: 1 }] } };
  const fetchImpl = async (url, opts = {}) => {
    const path = url.replace("https://api.stripe.com/v1", "");
    if (opts.method === "POST" && path === "/checkout/sessions") {
      const form = new URLSearchParams(opts.body);
      posts.push(form);
      return new Response(JSON.stringify({ id: `cs_${posts.length}`, livemode: false, status: "open", url: "https://checkout.stripe.com/c/pay/x", client_reference_id: "org1", metadata: { app: "costcap", org_id: "org1" } }));
    }
    if (path === "/subscriptions/sub_t") return new Response(JSON.stringify(sub));
    if (path.startsWith("/checkout/sessions/")) return new Response(JSON.stringify({ id: path.split("/").pop(), livemode: false, status: "open", url: "https://checkout.stripe.com/c/pay/x", client_reference_id: "org1", metadata: { app: "costcap", org_id: "org1" } }));
    return new Response("{}", { status: 404 });
  };
  const base = { secretKey: "sk_test_x", webhookSecret: "whsec_x", priceId: "price_solo", origin: "https://app.costcap.dev", store, fetchImpl, log: () => {} };
  const soloOnly = createTestModeStripeBilling(base);
  await assert.rejects(soloOnly.checkout({ orgId: "org1", email: "o@example.invalid" }, { plan: "team" }), (e) => e.status === 409);
  await assert.rejects(soloOnly.checkout({ orgId: "org1", email: "o@example.invalid" }, { plan: "gold" }), (e) => e.status === 400);
  assert.equal(createTestModeStripeBilling({ ...base, teamPriceId: "price_solo" }), null);
  const both = createTestModeStripeBilling({ ...base, teamPriceId: "price_team" });
  await both.checkout({ orgId: "org1", email: "o@example.invalid" });
  await both.checkout({ orgId: "org1", email: "o@example.invalid" }, { plan: "team" });
  assert.deepEqual(posts.map((f) => f.get("line_items[0][price]")), ["price_solo", "price_team"]);
  assert.equal(posts[1].get("subscription_data[metadata][plan]"), "team");
  assert.notEqual(posts[0].get("metadata[plan]"), posts[1].get("metadata[plan]"));
  store.transaction((s) => { s.orgs.org1.billing.subscriptionId = "sub_t"; });
  const status = await both.status("org1");
  assert.equal(status.plan, "team");
  assert.deepEqual(status.plans, ["workspace", "team"]);
  sub.status = "canceled";
  assert.equal((await both.status("org1")).plan, null);
  assert.equal(store.read((s) => s.orgs.org1.billing.plan), undefined);
  assert.equal(posts.some((f) => [...f.keys()].some((k) => k.startsWith("unit_amount"))), false);
});

test("live adapter refuses a Team checkout before calling Stripe", async () => {
  let called = 0;
  const fetchImpl = async (url) => {
    called += 1;
    const path = url.replace("https://api.stripe.com/v1", "");
    if (path === "/account") return new Response(JSON.stringify({ id: "acct_1TdlLm0Yt0O6HtVs", charges_enabled: true }));
    return new Response(JSON.stringify({ active: true, livemode: true, currency: "usd", unit_amount: 1900, recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, product: { active: true, metadata: { app: "costcap" } } }));
  };
  const store = openStore(join(mkdtempSync(join(tmpdir(), "cc-live-team-")), "s.json"));
  const billing = await createStripeBilling({ secretKey: "rk_live_fixture", webhookSecret: "whsec_x", accountId: "acct_1TdlLm0Yt0O6HtVs", priceId: "price_live", origin: "https://app.costcap.dev", store, fetchImpl });
  const before = called;
  await assert.rejects(billing.checkout({ orgId: "o", email: "o@example.invalid" }, { plan: "team" }), (e) => e.status === 409);
  assert.equal(called, before);
});
