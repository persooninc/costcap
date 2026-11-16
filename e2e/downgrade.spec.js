// Issue #207: set a model downgrade on the agent card, reload, see it saved,
// then receive it through the enrolled wrapper's policy sync. Local server only.
import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { createFleetClient, enroll } from "../src/hosted/client.js";
import { mergeDowngrade } from "../src/downgrade.js";

const fixtureToken = "fixture-" + "pass";
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("Downgrade on the agent card persists and reaches the wrapper by policy sync", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-pw-downgrade-"));
  const service = createHostedServer({
    storePath: join(dir, "data.json"), origin, secureCookies: false, turnstileSiteKey: "fixture-public-key",
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
    const enrollmentPath = join(dir, "enrollment.json");
    await enroll({ url: origin, name: "researcher", token, path: enrollmentPath });
    await page.locator("#refresh").click();
    let card = page.locator("#agents .agent", { hasText: "researcher" });
    await expect(card.locator("input[name=downgradeMap]")).toHaveValue("");
    // An invalid map (FROM equal to TO) is refused by the server and shown.
    await card.locator("input[name=downgradeMap]").fill("gpt-4o=gpt-4o");
    await card.getByRole("button", { name: "Save caps" }).click();
    await expect(page.locator("#status")).toContainText("Invalid policy");
    card = page.locator("#agents .agent", { hasText: "researcher" });
    await card.locator("input[name=downgradeMap]").fill("gpt-4o=gpt-4o-mini, claude-sonnet-4-5=claude-haiku-4-5");
    await card.locator("input[name=downgradeAt]").fill("75");
    await card.getByRole("button", { name: "Save caps" }).click();
    await expect(page.locator("#agents .agent", { hasText: "researcher" })).toContainText("downgrade at 75%: gpt-4o → gpt-4o-mini");
    await page.reload();
    await expect(page.locator("#workspace")).toBeVisible();
    card = page.locator("#agents .agent", { hasText: "researcher" });
    await expect(card.locator("input[name=downgradeMap]")).toHaveValue("gpt-4o=gpt-4o-mini, claude-sonnet-4-5=claude-haiku-4-5");
    await expect(card.locator("input[name=downgradeAt]")).toHaveValue("75");
    const received = [];
    const fleet = createFleetClient({ path: enrollmentPath, receiptsPath: join(dir, "receipts.jsonl"), onPolicy: (p) => received.push(p) });
    const sync = await fleet.sync();
    expect(sync.online).toBe(true);
    const policy = fleet.policy();
    expect(policy.downgrade).toEqual({ at: 0.75, map: { "gpt-4o": "gpt-4o-mini", "claude-sonnet-4-5": "claude-haiku-4-5" } });
    // The wrapper merges it with local flags: local can add a model and lower `at`, never raise it.
    expect(mergeDowngrade(policy.downgrade, { at: 0.9, map: { "gpt-4o": "x", o3: "o4-mini" } })).toEqual({ at: 0.75, map: { "gpt-4o": "gpt-4o-mini", "claude-sonnet-4-5": "claude-haiku-4-5", o3: "o4-mini" } });
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});
