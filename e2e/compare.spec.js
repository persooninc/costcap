import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

// go-to-market#10: the comparison page is public, linked from the footer, and cites vendor docs.
test("footer Compare link opens the comparison page with cited sources", async ({ page }) => {
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-compare-")), "data.json"),
    origin: "http://127.0.0.1", secureCookies: false, turnstileSiteKey: "fixture-key",
    verifyChallenge: async () => false, sendCode: async () => {},
  });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/googletagmanager.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  try {
    await page.goto(base + "/");
    await page.locator("footer").getByRole("link", { name: "Compare", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("CostCap compared");
    await expect(page.getByRole("link", { name: "Source" })).toHaveCount(3);
    await expect(page.getByRole("link", { name: "See the Agent Guardrails bundle" })).toHaveAttribute("href", "https://agentcontroltower.io/pricing");
    const res = await page.request.get(base + "/compare");
    expect(res.status()).toBe(200);
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});
