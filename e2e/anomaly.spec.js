// Issue #223: spend_anomaly in the hosted UI (dashboard alert list + policy editor). Fixture delivery only; injected clock.
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


test("spend_anomaly shows today vs baseline; a policy-editor override suppresses it", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const delivered = [];
  const clock = Date.parse("2026-11-16T15:00:00.000Z");
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-anom-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key", now: () => clock,
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
    deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; },
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await page.locator("#email").fill("anomaly-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#enroll input[name=day]").fill("100");
    await page.locator("#enroll button").click();
    await expect(page.locator("#token")).not.toHaveText("");
    const token = (await page.locator("#token").innerText()).trim();
    const receipts = [];
    for (let i = 1; i <= 14; i += 1) receipts.push({ id: `h${i}`, ts: new Date(clock - i * 86_400_000).toISOString(), cost_usd: 2, model: "m" });
    receipts.push({ id: "today", ts: new Date(clock - 60_000).toISOString(), cost_usd: 7, model: "gpt-x" });
    const synced = await page.evaluate(async ({ credential, receipts }) => {
      const e = await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "spiker" }) });
      const agent = await e.json();
      return (await fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts }) })).status;
    }, { credential: token, receipts });
    expect(synced).toBe(200);
    await service.evaluateFleetAlerts();
    expect(delivered.filter((a) => a.kind === "spend_anomaly")).toHaveLength(1);
    await page.locator("#refresh").click();
    const alert = page.locator("#alerts .alert-active", { hasText: "spend_anomaly" });
    await expect(alert).toContainText("today $7 vs baseline $2 (3x)");
    const card = page.locator("#agents .agent", { hasText: "spiker" });
    await card.locator("input[name=anomalyMult]").fill("10");
    await card.getByRole("button", { name: "Save caps" }).click();
    await expect(page.locator("#agents .agent", { hasText: "spiker" }).locator("input[name=anomalyMult]")).toHaveValue("10");
    await service.evaluateFleetAlerts();
    await page.locator("#refresh").click();
    await expect(page.locator("#alerts .alert-active", { hasText: "spend_anomaly" })).toHaveCount(0);
    await expect(page.locator("#alerts .alert-resolved", { hasText: "spend_anomaly" })).toBeVisible();
    expect(delivered.filter((a) => a.kind === "spend_anomaly")).toHaveLength(1);
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});
