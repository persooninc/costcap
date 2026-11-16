// Issue #224: weekly digest card — save settings and preview, desktop and mobile widths. Fixture delivery only; injected clock.
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

for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`digest card saves settings and previews the weekly digest (${label})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const codes = [];
    const sent = [];
    const clock = { ms: Date.parse("2026-11-10T15:00:00.000Z") };
    const service = createHostedServer({
      storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-digest-")), "data.json"),
      origin, secureCookies: false, turnstileSiteKey: "fixture-public-key", now: () => clock.ms,
      verifyChallenge: async (token) => token === fixtureToken,
      sendCode: async (message) => { codes.push(message); },
      sendInvite: async () => {},
      deliverDigest: async (d, _dest, { channels }) => { sent.push(d); return channels.map((channel) => ({ channel, status: "accepted" })); },
    });
    await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
    try {
      await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
        status: 200, contentType: "application/javascript",
        body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
      }));
      await page.goto(origin);
      await page.locator("#email").fill(`digest-${label}@example.invalid`);
      await expect(page.locator("#requestButton")).toBeEnabled();
      await page.locator("#requestButton").click();
      await expect.poll(() => codes.length).toBeGreaterThan(0);
      await page.locator("#code").fill(codes.at(-1).code);
      await page.locator("#verify button[type=submit]").click();
      await expect(page.locator("#workspace")).toBeVisible();
      await page.locator("#enroll input[name=day]").fill("100");
      await page.locator("#enroll button").click();
      await expect(page.locator("#token")).not.toHaveText("");
      const token = (await page.locator("#token").innerText()).trim();
      const status = await page.evaluate(async ({ credential }) => {
        const e = await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "digester" }) });
        const agent = await e.json();
        const receipts = [{ id: "a", ts: "2026-11-03T10:00:00Z", cost_usd: 4, model: "gpt-4o" }, { id: "b", ts: "2026-11-04T10:00:00Z", cost_usd: null, model: "claude" }];
        return (await fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts }) })).status;
      }, { credential: token });
      expect(status).toBe(200);
      const card = page.locator("#digestCard");
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeVisible();
      // New org default: on, Monday 09:00 UTC, email.
      await expect(page.locator("#digestEnabled")).toBeChecked();
      await expect(page.locator("#digestNow")).toContainText("Sends Monday at 9:00 (UTC) to email");
      await page.locator("#digestWeekday").selectOption("5");
      await page.locator("#digestHour").fill("17");
      await page.locator("#digestSlack").check();
      await page.locator("#digestSave").click();
      await expect(page.locator("#digestNow")).toContainText("Sends Friday at 17:00 (UTC) to email, slack");
      await page.reload();
      await expect(page.locator("#digestWeekday")).toHaveValue("5");
      await expect(page.locator("#digestHour")).toHaveValue("17");
      await page.locator("#digestPreview").click();
      const preview = page.locator("#digestPreviewText");
      await expect(preview).toBeVisible();
      await expect(preview).toContainText("week 2026-W45");
      await expect(preview).toContainText("Spend: at least $4.00");
      await expect(preview).toContainText("digester: at least $4.00");
      await expect(preview).not.toContainText("$0.00 (");
      expect(sent).toHaveLength(0);
    } finally {
      service.server.closeAllConnections();
      await new Promise((resolve) => service.server.close(resolve));
    }
  });
}
