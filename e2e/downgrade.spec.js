// Issue #207: set a model downgrade on the agent card, reload, see it saved, receive it through policy sync.
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

test("agent card: downgrade map and fraction save, survive reload and sync to the agent", async ({ page }) => {
  test.setTimeout(120_000);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-downgrade-")), "data.json"),
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
    await page.locator("#email").fill("downgrade-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#enroll input[name=day]").fill("10");
    await page.locator("#enroll button").click();
    await expect(page.locator("#token")).not.toHaveText("");
    const token = (await page.locator("#token").innerText()).trim();
    const agentToken = await page.evaluate(async (credential) => {
      const e = await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "degrader" }) });
      return (await e.json()).token;
    }, token);
    await page.locator("#refresh").click();
    const card = () => page.locator("#agents .agent", { hasText: "degrader" });
    await expect(card().locator("input[name=downgradeMap]")).toHaveValue("");
    await card().locator("input[name=downgradeMap]").fill("gpt-4o=gpt-4o-mini, claude-sonnet-4-5=claude-haiku-4-5");
    await card().locator("input[name=downgradeAt]").fill("70");
    await card().getByRole("button", { name: "Save caps" }).click();
    await expect(card().locator("input[name=downgradeAt]")).toHaveValue("70");
    await page.reload();
    await expect(card().locator("input[name=downgradeMap]")).toHaveValue("gpt-4o=gpt-4o-mini, claude-sonnet-4-5=claude-haiku-4-5");
    await expect(card().locator("input[name=downgradeAt]")).toHaveValue("70");
    const synced = await page.evaluate(async (t) => (await fetch("/v1/policy", { headers: { authorization: `Bearer ${t}` } })).json(), agentToken);
    expect(synced.downgrade).toEqual({ at: 0.7, map: { "gpt-4o": "gpt-4o-mini", "claude-sonnet-4-5": "claude-haiku-4-5" } });
    // An invalid map (FROM equal to TO) is refused and the saved value is kept.
    await card().locator("input[name=downgradeMap]").fill("gpt-4o=gpt-4o");
    await card().getByRole("button", { name: "Save caps" }).click();
    await expect(page.locator("#status")).toContainText("Invalid policy");
    // Clearing the map turns it off.
    await page.reload();
    await card().locator("input[name=downgradeMap]").fill("");
    await card().getByRole("button", { name: "Save caps" }).click();
    await page.reload();
    await expect(card().locator("input[name=downgradeMap]")).toHaveValue("");
    const cleared = await page.evaluate(async (t) => (await fetch("/v1/policy", { headers: { authorization: `Bearer ${t}` } })).json(), agentToken);
    expect(cleared.downgrade).toBeUndefined();
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});
