import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

// Issue #203: create an org API key in the UI, read /v1/spend with it, revoke it, get 401. No outbound calls.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("API keys card: create, use on /v1/spend, revoke, 401", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-keys-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const email = "keys-e2e@example.invalid";
    const c = await post("/auth/request", { email, turnstileToken: "x" }).then((r) => r.json());
    const owner = (await post("/auth/verify", { challengeId: c.challengeId, code: codes[email] })).headers.get("set-cookie").split(";")[0];
    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    page.on("dialog", (d) => d.accept());
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#apiKeysCard")).toBeVisible();
    await page.locator("#apiKeyForm input[name=name]").fill("grafana");
    await page.locator("#apiKeyForm select[name=role]").selectOption("viewer");
    await page.locator("#apiKeyForm button").click();
    await expect(page.locator("#apiKeySecretBox")).toBeVisible();
    const secret = (await page.locator("#apiKeySecret").textContent()).trim();
    expect(secret).toMatch(/^cck_/);
    const row = page.locator("#apiKeys .entry").first();
    await expect(row).toContainText(`grafana · viewer · cck_…${secret.slice(-4)} · active`);
    await expect(row).not.toContainText(secret);

    const spend = await fetch(origin + "/v1/spend", { headers: { authorization: `Bearer ${secret}` } });
    expect(spend.status).toBe(200);

    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(page.locator("#apiKeys .entry").first()).toContainText("revoked");
    await expect(page.locator("#apiKeySecretBox")).toBeHidden();
    const after = await fetch(origin + "/v1/spend", { headers: { authorization: `Bearer ${secret}` } });
    expect(after.status).toBe(401);
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});
