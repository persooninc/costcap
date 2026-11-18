import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { DEFAULT_PLANS } from "../src/billing/index.js";

// costcap#252: production runs billing in live mode (COSTCAP_STRIPE_MODE=live in the host .env).
// The buyer sees /pricing with the $19 Solo plan on sale, no test-mode banner, and /cli reachable.
// The billing adapter is a stub: nothing here calls Stripe.
test("live-mode pricing page: $19 Solo on sale, no test banner, /cli reachable", async ({ page }) => {
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pricing-live-")), "data.json"),
    origin: "http://127.0.0.1", secureCookies: false, turnstileSiteKey: "fixture-key",
    verifyChallenge: async () => false, sendCode: async () => {},
    stripeEnv: {}, stripeMode: "live",
    billingFactory: async () => ({ status: async () => ({ status: "free_beta" }), checkout: async () => ({}), portal: async () => ({}), webhook: async () => ({ received: true }) }),
  });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  await page.route("**/googletagmanager.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  try {
    const health = await (await page.request.get(base + "/health")).json();
    expect(health.billing).toBe("enabled");
    expect((await page.request.get(base + "/pricing", { maxRedirects: 0 })).status()).toBe(200);
    await page.goto(base + "/pricing");
    await expect(page).toHaveTitle(/CostCap pricing/);
    await expect(page.locator("#testModeBanner")).toHaveCount(0);
    await expect(page.getByText("Not on sale yet. The hosted workspace is a free beta today.")).toHaveCount(0);
    await expect(page.locator('[data-plan="workspace"] .price')).toHaveText(`$${DEFAULT_PLANS.workspace.priceUsdMonthly} USD per month`);
    await expect(page.locator('[data-plan="workspace"] a.cta')).toHaveAttribute("href", "/?plan=workspace#plan");
    await page.locator('[data-plan="cli"] a.cta').click();
    await expect(page).toHaveURL(/\/cli$/);
    expect((await page.request.get(base + "/cli")).status()).toBe(200);
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});
