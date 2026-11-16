import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

const fixtureToken = "fixture-" + "pass";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("hosted UI login, invitation, enrollment, freeze, resume, cap, revoke, and logout", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const invites = [];
  const external = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-")), "data.json"),
    origin,
    secureCookies: false,
    turnstileSiteKey: "fixture-public-key",
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async (message) => { invites.push(message); },
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("api.brevo.com") || url.includes("siteverify")) external.push(url);
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){const el=document.querySelector(selector);if(el)el.textContent="Local fixture challenge";opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#email").fill("fixture@example.invalid");
    await page.locator("#requestButton").click();
    await expect(page.locator("#verify")).toBeVisible();
    expect(codes.at(-1)?.code).toMatch(/^\d{8}$/);
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    // Unset COSTCAP_STRIPE_MODE resolves to test, so the default server shows the test-mode copy.
    await expect(page.locator("#workspace")).toContainText("Test mode. No public price.");
    await expect(page.locator("#agentCount")).toHaveText("0");
    await page.locator("#enroll input[name=day]").fill("5");
    await page.locator("#enroll button").click();
    await expect(page.locator("#token")).not.toHaveText("");
    const token = (await page.locator("#token").innerText()).trim();
    const enrolled = await page.evaluate(async (credential) => {
      const response = await fetch("/v1/enroll", {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "<img src=x onerror=alert(1)> fixture" }),
      });
      return response.status;
    }, token);
    expect(enrolled).toBe(201);
    await page.locator("#refresh").click();
    await expect(page.locator("#agentCount")).toHaveText("1");
    await expect(page.locator("#agents h3")).toHaveText("<img src=x onerror=alert(1)> fixture");
    await expect(page.locator("#agents img")).toHaveCount(0);
    await page.locator("#agents .danger").first().click();
    await expect(page.locator("#agents strong")).toHaveText("FROZEN");
    await page.locator("#agents .danger").first().click();
    await expect(page.locator("#agents strong")).toHaveText("ACTIVE");
    await page.locator("#agents input[name=day]").fill("3");
    await page.locator("#agents button[type=submit]").click();
    await expect(page.locator("#agents small")).toContainText("Policy v4");
    await page.locator("#agents .danger").nth(1).click();
    await expect(page.locator("#agents strong")).toHaveText("REVOKED");
    await page.locator("#invite input[name=email]").fill("teammate@example.invalid");
    await page.locator("#invite button").click();
    await expect(page.locator("#invites")).toContainText("teammate@example.invalid");
    expect(invites).toEqual([expect.objectContaining({ email: "teammate@example.invalid", role: "viewer" })]);
    await page.locator("#logout").click();
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#token")).toHaveText("");
    expect(await page.evaluate(async () => (await fetch("/v1/fleet")).status)).toBe(401);
    expect(external).toEqual([]);
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("#112 a signed-in org reads its agent budget verdict; cross-org read is 404", async ({ request }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-budget-")), "data.json"),
    origin, secureCookies: false, stripeEnv: {},
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    const login = async (email) => {
      const ch = await (await fetch(`${origin}/auth/request`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, turnstileToken: fixtureToken }) })).json();
      const r = await fetch(`${origin}/auth/verify`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: ch.challengeId, code: codes.at(-1).code }) });
      expect(r.status).toBe(200);
      return r.headers.get("set-cookie").split(";")[0];
    };
    const owner = await login("budget-owner@example.invalid");
    const outsider = await login("budget-outsider@example.invalid");
    const post = (path, body, headers) => fetch(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
    const { token } = await post("/v1/enrollment-tokens", { caps: { day: 4 } }, { cookie: owner });
    const agent = await post("/v1/enroll", { name: "e2e" }, { authorization: `Bearer ${token}` });
    await post("/v1/receipts", { receipts: [{ id: "e1", ts: new Date().toISOString(), cost_usd: 1 }] }, { authorization: `Bearer ${agent.token}` });
    const mine = await request.get(`${origin}/v1/agents/${agent.agentId}/budget`, { headers: { cookie: owner } });
    expect(mine.status()).toBe(200);
    const body = await mine.json();
    expect(body.verdict).toBe("ok");
    expect(body.budget_remaining.day_usd).toBe(3);
    const cross = await request.get(`${origin}/v1/agents/${agent.agentId}/budget`, { headers: { cookie: outsider } });
    expect(cross.status()).toBe(404);
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});

test("#113 freeze all agents from the dashboard with a reason, then resume", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-freeze-")), "data.json"),
    origin, secureCookies: false, stripeEnv: {}, turnstileSiteKey: "fixture-public-key",
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    const dialogs = [];
    page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await page.locator("#email").fill("freeze@example.invalid");
    await page.locator("#requestButton").click();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    for (const name of ["alpha", "beta"]) {
      await page.locator("#enroll button").click();
      await expect(page.locator("#token")).not.toHaveText("");
      const token = (await page.locator("#token").innerText()).trim();
      await page.locator("#hideToken").click();
      expect(await page.evaluate(async ([credential, n]) => (await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: n }) })).status, [token, name])).toBe(201);
    }
    await page.locator("#refresh").click();
    await expect(page.locator("#agents strong")).toHaveText(["ACTIVE", "ACTIVE"]);
    await expect(page.locator("#fleetFreeze")).toContainText("not instant");
    await page.locator("#freezeReason").fill("runaway spend incident");
    await page.locator("#freezeAll").click();
    await expect(page.locator("#fleetState")).toHaveText("FROZEN");
    await expect(page.locator("#agents strong")).toHaveText(["FROZEN", "FROZEN"]);
    await expect(page.locator("#audit")).toContainText("fleet.freeze");
    await expect(page.locator("#audit")).toContainText("reason: runaway spend incident");
    expect(dialogs.at(-1)).toContain("next policy poll");
    await expect(page.locator("#resumeFleet")).toBeVisible();
    await page.locator("#freezeReason").fill("incident resolved");
    await page.locator("#resumeFleet").click();
    await expect(page.locator("#fleetState")).toHaveText("ACTIVE");
    await expect(page.locator("#agents strong")).toHaveText(["ACTIVE", "ACTIVE"]);
    await expect(page.locator("#audit")).toContainText("reason: incident resolved");
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});
