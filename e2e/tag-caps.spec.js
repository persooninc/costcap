// Issue #204: the Tag caps card saves and removes a fleet rule; a viewer sees it read-only.
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

test("Tag caps card: owner adds and removes a rule, viewer is disabled", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-tagcaps-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key",
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
    deliverAlert: async () => [{ status: "accepted" }],
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  const signIn = async (email) => {
    await page.goto(origin);
    await page.locator("#email").fill(email);
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await expect(page.locator("#verify")).toBeVisible();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
  };
  try {
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await signIn("tags-owner@example.invalid");
    await expect(page.locator("#tagCapsCard")).toBeVisible();
    await expect(page.locator("#tagCaps")).toContainText("No tag caps.");
    const form = page.locator("#tagCapForm");
    await form.locator("input[name=key]").fill("customer");
    await form.locator("select[name=scope]").selectOption("day");
    await form.locator("input[name=usd]").fill("5");
    await page.locator("#tagCapAdd").click();
    await expect(page.locator('#tagCaps li[data-rule="customer:day"]')).toContainText("$5");
    await form.locator("input[name=key]").fill("project");
    await form.locator("select[name=scope]").selectOption("month");
    await form.locator("input[name=usd]").fill("50");
    await form.locator("input[name=warn]").fill("80, 50");
    await page.locator("#tagCapAdd").click();
    await expect(page.locator('#tagCaps li[data-rule="project:month"]')).toContainText("warn at 50%, 80%");
    await expect(page.locator('#tagCaps li[data-rule="customer:day"]')).toContainText("warn at 80%");
    await page.reload();
    await expect(page.locator("#tagCaps li[data-rule]")).toHaveCount(2);
    await page.locator('#tagCaps li[data-rule="project:month"]').getByRole("button", { name: "Remove" }).click();
    await expect(page.locator('#tagCaps li[data-rule="project:month"]')).toHaveCount(0);
    await expect(page.locator("#tagCaps li[data-rule]")).toHaveCount(1);

    await page.locator("#invite input[name=email]").fill("tags-viewer@example.invalid");
    await page.locator("#invite button").click();
    await expect(page.locator("#invites")).toContainText("tags-viewer@example.invalid");
    await page.locator("#logout").click();
    await signIn("tags-viewer@example.invalid");
    await expect(page.locator('#tagCaps li[data-rule="customer:day"]')).toBeVisible();
    await expect(page.locator('#tagCaps li[data-rule="customer:day"] button')).toBeDisabled();
    await expect(page.locator("#tagCapAdd")).toBeDisabled();
    await expect(page.locator("#tagCapWarn")).toBeDisabled();
    expect(await page.evaluate(async () => (await fetch("/v1/tag-caps", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tagCaps: [] }) })).status)).toBe(403);
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});
