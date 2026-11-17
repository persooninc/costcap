// Issue #240: the Org budget card saves a cap, seeded spend shows the verdict and an
// org alert, and a viewer sees the card read-only.
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

test("Org budget card: admin sets the cap, seeded spend shows verdict and alert, viewer read-only", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-orgbudget-")), "data.json"),
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
    await signIn("org-owner@example.invalid");
    await expect(page.locator("#orgBudgetCard")).toBeVisible();
    await expect(page.locator("#orgBudgetState")).toHaveText("No org budget.");
    await page.locator("#orgBudgetDay").fill("1");
    await page.locator("#orgBudgetWeek").fill("1");
    await page.locator("#orgBudgetSave").click();
    await expect(page.locator("#orgBudgetState")).toContainText("day: $0 of $1");
    await expect(page.locator("#orgBudgetState")).toContainText("week: $0 of $1");
    await expect(page.locator("#orgBudgetState")).toHaveAttribute("data-verdict", "ok");
    // Seed $1.20 of synced spend from an enrolled agent, then run the alert sweep.
    const token = await page.evaluate(async () => (await (await fetch("/v1/enrollment-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caps: {} }) })).json()).token);
    const agent = await (await fetch(`${origin}/v1/enroll`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "seed" }) })).json();
    const ts = new Date().toISOString();
    const synced = await fetch(`${origin}/v1/receipts`, { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "s1", ts, cost_usd: 1.2, model: "test" }] }) });
    expect(synced.status).toBe(200);
    await service.evaluateFleetAlerts();
    await page.reload();
    await expect(page.locator("#orgBudgetState")).toHaveAttribute("data-verdict", "budget_exceeded");
    await expect(page.locator("#orgBudgetState")).toContainText("day: $1.2 of $1");
    await expect(page.locator("#alerts")).toContainText("cap_hit");
    await expect(page.locator("#alerts")).toContainText("org budget day");
    // #268: the week cap shows its state line and pages cap_hit too.
    await expect(page.locator("#orgBudgetState")).toContainText("week: $1.2 of $1");
    await expect(page.locator("#alerts")).toContainText("org budget week");
    // The hosted verdict a wrapper checks names org:week once only the week is capped.
    await page.locator("#orgBudgetDay").fill("");
    await page.locator("#orgBudgetSave").click();
    await expect(page.locator("#orgBudgetState")).not.toContainText("day:");
    expect((await (await fetch(`${origin}/v1/agents/${agent.agentId}/budget`, { headers: { cookie: (await page.context().cookies()).map((c) => c.name + "=" + c.value).join("; ") } })).json()).scope).toBe("org:week");

    await page.locator("#invite input[name=email]").fill("org-viewer@example.invalid");
    await page.locator("#invite button").click();
    await expect(page.locator("#invites")).toContainText("org-viewer@example.invalid");
    await page.locator("#logout").click();
    await signIn("org-viewer@example.invalid");
    await expect(page.locator("#orgBudgetState")).toHaveAttribute("data-verdict", "budget_exceeded");
    await expect(page.locator("#orgBudgetDay")).toBeDisabled();
    await expect(page.locator("#orgBudgetWeek")).toBeDisabled();
    await expect(page.locator("#orgBudgetSave")).toBeDisabled();
    expect(await page.evaluate(async () => (await fetch("/v1/org-budget", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ day: 5 }) })).status)).toBe(403);
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});
