// Issue #203: create an org API key in the UI, read /v1/spend with it, revoke it, get 401.
// Local server only; Turnstile is stubbed and no outbound call is made.
import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

const fixtureToken = "fixture-" + "pass";
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("API key: create in UI, fetch spend with bearer, revoke, then 401", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-keys-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key",
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
    deliverAlert: async () => [{ status: "accepted" }],
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await page.locator("#email").fill("keys-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await expect(page.locator("#verify")).toBeVisible();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#apiKeysCard")).toBeVisible();

    await page.locator("#apiKeyForm input[name=name]").fill("grafana");
    await page.locator("#apiKeyCreate").click();
    await expect(page.locator("#apiKeyNew")).toBeVisible();
    const key = (await page.locator("#apiKeyValue").innerText()).trim();
    expect(key).toMatch(/^cck_/);
    const row = page.locator("#apiKeys li", { hasText: "grafana" });
    await expect(row).toContainText("active");
    await expect(row).not.toContainText(key);

    // A script: bearer only, no cookie, no Origin.
    const spend = await fetch(`${origin}/v1/spend`, { headers: { authorization: `Bearer ${key}` } });
    expect(spend.status).toBe(200);

    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(row).toContainText("revoked");
    const after = await fetch(`${origin}/v1/spend`, { headers: { authorization: `Bearer ${key}` } });
    expect(after.status).toBe(401);
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});
