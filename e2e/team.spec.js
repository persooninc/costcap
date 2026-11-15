import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { createTestModeStripeBilling } from "../src/hosted/billing.js";

// FA-CC-03: pricing page -> test checkout -> plan shows Team -> portal cancel returns to free.
// Stripe is a local fixture in test mode. No network call to Stripe, no price is created.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("pricing page to Team test checkout, Team plan, portal cancel back to free", async ({ page }) => {
  const secret = "whsec_team_fixture";
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const calls = [];
  const remote = { session: null, sub: null };
  let code, store;
  const provider = async (url, options = {}) => {
    const path = url.replace("https://api.stripe.com/v1", "");
    const method = options.method ?? "GET";
    calls.push({ method, path, body: options.body });
    let data;
    if (method === "POST" && path === "/checkout/sessions") {
      const form = new URLSearchParams(options.body);
      remote.session = { id: "cs_team", livemode: false, status: "open", url: "https://checkout.stripe.com/c/pay/team-fixture",
        client_reference_id: form.get("client_reference_id"), metadata: { app: form.get("metadata[app]"), org_id: form.get("metadata[org_id]"), plan: form.get("metadata[plan]") } };
      data = remote.session;
    }
    if (method === "GET" && path === "/checkout/sessions/cs_team") data = remote.session;
    if (method === "GET" && path === "/subscriptions/sub_team") data = remote.sub;
    if (method === "POST" && path === "/billing_portal/sessions") data = { livemode: false, url: "https://billing.stripe.com/p/session/team-fixture" };
    return new Response(JSON.stringify(data ?? { error: { message: "Unexpected fixture path" } }), { status: data ? 200 : 404 });
  };
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-team-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeMode: "test", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; },
    billingFactory: (s) => { store = s; return createTestModeStripeBilling({ store: s, origin, secretKey: "sk_test_team_fixture", webhookSecret: secret, priceId: "price_solo", teamPriceId: "price_team", fetchImpl: provider, log: () => {} }); },
  });
  await service.billingReady;
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "window.turnstile={render(s,o){o.callback('local-fixture');return 1},reset(){}}" }));
  await page.route("**/googletagmanager.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("https://checkout.stripe.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Test checkout fixture</h1>" }));
  await page.route("https://billing.stripe.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Test portal fixture</h1>" }));
  const webhook = (event) => {
    const raw = JSON.stringify(event), stamp = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${stamp}.${raw}`).digest("hex");
    return fetch(origin + "/billing/webhook", { method: "POST", headers: { "stripe-signature": `t=${stamp},v1=${sig}` }, body: raw });
  };
  try {
    const requested = await fetch(origin + "/auth/request", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: "team-owner@example.invalid", turnstileToken: "local-fixture" }) }).then((r) => r.json());
    const verified = await fetch(origin + "/auth/verify", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: requested.challengeId, code }) });
    const cookie = verified.headers.get("set-cookie").split(";")[0].split("=")[1];
    await page.context().addCookies([{ name: "costcap_session", value: cookie, url: origin }]);
    const orgId = store.read((s) => Object.values(s.users).find((u) => u.email === "team-owner@example.invalid").orgId);

    await page.goto(origin + "/pricing");
    await expect(page.locator("#testModeBanner")).toContainText("Test mode.");
    const team = page.locator('.tier[data-plan="team"]');
    await expect(team.locator(".price")).toHaveText("$79 USD per month");
    await expect(page.locator('.tier[data-plan="workspace"] .price')).toHaveText("$19 USD per month");
    await team.getByRole("link", { name: "Choose Team in your workspace" }).click();
    await expect(page.locator("#upgradeTeam")).toBeVisible();
    await page.locator("#upgradeTeam").click();
    await expect(page.getByRole("heading", { name: "Test checkout fixture" })).toBeVisible();
    const checkout = new URLSearchParams(calls.find((c) => c.method === "POST" && c.path === "/checkout/sessions").body);
    expect(checkout.get("line_items[0][price]")).toBe("price_team");
    expect(checkout.get("subscription_data[metadata][plan]")).toBe("team");

    remote.sub = { id: "sub_team", livemode: false, status: "active", customer: "cus_team", cancel_at_period_end: false,
      metadata: { app: "costcap", org_id: orgId, plan: "team" }, items: { data: [{ price: { id: "price_team" }, quantity: 1 }] } };
    Object.assign(remote.session, { status: "complete", subscription: "sub_team" });
    await page.goto(origin + "/?checkout=returned");
    await expect(page.locator("#billingStatus")).toHaveText("Verified subscription: active · Team plan");
    await page.locator("#refresh").click();
    await expect(page.locator("#planUsage")).toContainText("Current plan: Team.");
    await expect(page.locator("#portal")).toBeVisible();

    await page.locator("#portal").click();
    await expect(page.getByRole("heading", { name: "Test portal fixture" })).toBeVisible();
    remote.sub = { ...remote.sub, status: "canceled" };
    expect((await webhook({ id: "evt_team_canceled", livemode: false, type: "customer.subscription.deleted", data: { object: { id: "sub_team" } } })).status).toBe(200);
    await page.goto(origin + "/");
    await expect(page.locator("#billingStatus")).toHaveText("Free beta. No verified subscription.");
    await expect(page.locator("#planUsage")).toContainText("Current plan: Free workspace.");
    expect(store.read((s) => s.orgs[orgId].billing.plan)).toBeUndefined();
    expect(calls.some((c) => c.path.startsWith("/prices"))).toBe(false);
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});
