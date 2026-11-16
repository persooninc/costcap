// Issue #143: alert lifecycle in the hosted UI. Fixture delivery only; injected clock.
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

test("cap_hit alert shows fired time, can be acknowledged, then resolves on clock advance", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const delivered = [];
  let clock = Date.parse("2026-11-15T10:00:00.000Z");
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-alerts-")), "data.json"),
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
    await page.locator("#email").fill("alerts-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await expect(page.locator("#verify")).toBeVisible();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#enroll input[name=day]").fill("1");
    await page.locator("#enroll button").click();
    await expect(page.locator("#token")).not.toHaveText("");
    const token = (await page.locator("#token").innerText()).trim();
    const ts = new Date(clock).toISOString();
    const synced = await page.evaluate(async ({ credential, ts }) => {
      const e = await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "spender" }) });
      const agent = await e.json();
      const r = await fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "r1", ts, cost_usd: 2, model: "m" }] }) });
      return r.status;
    }, { credential: token, ts });
    expect(synced).toBe(200);
    await service.evaluateFleetAlerts();
    expect(delivered.some((a) => a.kind === "cap_hit")).toBe(true);
    await page.locator("#refresh").click();
    const hit = page.locator("#alerts .alert-active", { hasText: "cap_hit" });
    await expect(hit).toBeVisible();
    await expect(hit).toContainText("active · fired");
    await expect(hit).not.toContainText("time unknown");
    await hit.getByRole("button", { name: "Acknowledge" }).click();
    await expect(hit).toContainText("acknowledged by alerts-owner@example.invalid");
    await expect(hit.getByRole("button", { name: "Acknowledge" })).toHaveCount(0);
    clock = Date.parse("2026-11-16T09:00:00.000Z");
    await service.evaluateFleetAlerts();
    await page.locator("#refresh").click();
    const resolved = page.locator("#alerts .alert-resolved", { hasText: "cap_hit" });
    await expect(resolved).toBeVisible();
    await expect(resolved).toContainText("resolved");
    await expect(page.locator("#alerts .alert-active", { hasText: "cap_hit" })).toHaveCount(0);
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});
