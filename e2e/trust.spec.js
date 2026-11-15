import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

// FA-CC-02: trust pages are public, linked from the landing footer, and reachable by click.
test("landing footer links privacy, terms and security pages", async ({ page }) => {
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-trust-")), "data.json"),
    origin: "http://127.0.0.1", secureCookies: false, turnstileSiteKey: "fixture-key",
    verifyChallenge: async () => false, sendCode: async () => {},
  });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/googletagmanager.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  try {
    await page.goto(base + "/");
    const footer = page.locator("footer");
    for (const [label, heading] of [["Privacy", "Privacy"], ["Terms", "Terms of use"], ["Security", "Security"]]) {
      await expect(footer.getByRole("link", { name: label, exact: true })).toBeVisible();
      await footer.getByRole("link", { name: label, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      await expect(page.locator("footer").getByRole("link", { name: "Privacy", exact: true })).toBeVisible();
      await page.goto(base + "/");
    }
    for (const path of ["/privacy", "/terms", "/security"]) {
      const res = await page.request.get(base + path);
      expect(res.status()).toBe(200);
    }
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});
