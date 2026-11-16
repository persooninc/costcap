import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { DEFAULT_PLANS } from "../src/billing/index.js";

// costcap#141: /pricing is public by default (no redirect, 200), shows catalog prices,
// names the Guardrails bundle, carries title/meta/OG, and is listed in sitemap.xml.
test("public pricing page: 200, catalog prices, bundle, meta, sitemap", async ({ page }) => {
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pricing-")), "data.json"),
    origin: "http://127.0.0.1", secureCookies: false, turnstileSiteKey: "fixture-key",
    verifyChallenge: async () => false, sendCode: async () => {},
  });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  await page.route("**/googletagmanager.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  try {
    const res = await page.request.get(base + "/pricing", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    await page.goto(base + "/pricing");
    await expect(page).toHaveTitle(/CostCap pricing/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator('[data-plan="cli"] .price')).toHaveText("Free");
    await expect(page.locator('[data-plan="workspace"]')).toContainText(`$${DEFAULT_PLANS.workspace.priceUsdMonthly}`);
    await expect(page.locator('[data-plan="team"]')).toContainText(`$${DEFAULT_PLANS.team.priceUsdMonthly}`);
    await expect(page.locator('[data-plan="team"] .bundle')).toContainText("Agent Guardrails bundle");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /\$19 per month.*Agent Guardrails bundle.*\$79 per month/);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", /\/pricing$/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/pricing$/);
    const sitemap = await (await page.request.get(base + "/sitemap.xml")).text();
    expect(sitemap).toContain("/pricing</loc>");
    await page.goto(base + "/");
    await page.getByRole("link", { name: "Compare plans" }).click();
    await expect(page).toHaveURL(/\/pricing$/);
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});
