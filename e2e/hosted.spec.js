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
    // #114: the dashboard edits the per-run step budget; policy and audit both show it.
    await page.locator("#agents input[name=maxSteps]").fill("5");
    await page.locator("#agents button[type=submit]").click();
    await expect(page.locator("#agents small")).toContainText("Policy v5 · max 5 steps per run");
    const fleetView = await page.evaluate(async () => (await fetch("/v1/fleet")).json());
    expect(fleetView.agents[0].policy.maxSteps).toBe(5);
    expect(fleetView.audit.filter((x) => x.action === "policy.change").at(-1).detail.policy.maxSteps).toBe(5);
    // #153: the dashboard edits the model allowlist; it saves and shows on the agent.
    await page.locator("#agents input[name=models]").fill("gpt-4o-mini, claude-haiku-4-5");
    await page.locator("#agents button[type=submit]").click();
    await expect(page.locator("#agents small")).toContainText("Policy v6 · max 5 steps per run · models: gpt-4o-mini, claude-haiku-4-5");
    const modelsView = await page.evaluate(async () => (await fetch("/v1/fleet")).json());
    expect(modelsView.agents[0].policy.models).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    await page.locator("#agents .danger").nth(1).click();
    await expect(page.locator("#agents strong")).toHaveText("REVOKED");
    await page.locator("#invite input[name=email]").fill("teammate@example.invalid");
    await page.locator("#invite button").click();
    await expect(page.locator("#invites")).toContainText("teammate@example.invalid");
    expect(invites).toEqual([expect.objectContaining({ email: "teammate@example.invalid", role: "viewer" })]);
    // Issue #137: members card and invitation revoke.
    await expect(page.locator("#members .member")).toHaveCount(1);
    await expect(page.locator("#members")).toContainText("fixture@example.invalid · owner");
    await page.locator('#invites .invite button', { hasText: "Revoke" }).click();
    await expect(page.locator("#status")).toContainText("Invitation revoked.");
    await expect(page.locator("#invites")).toContainText("No pending invitations.");
    await page.locator("#invite input[name=email]").fill("teammate@example.invalid");
    await page.locator("#invite button").click();
    await expect(page.locator("#invites")).toContainText("teammate@example.invalid");
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
    // #118: the signed-in evidence export carries policy.change with previous caps.
    await post(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 6 }, reason: "e2e raise" }, { cookie: owner });
    const ev = await request.get(`${origin}/v1/evidence.json`, { headers: { cookie: owner } });
    expect(ev.status()).toBe(200);
    const change = (await ev.json()).audit.find((e) => e.action === "policy.change");
    expect(change.detail.previous.caps).toEqual({ day: 4 });
    expect(change.detail.policy.caps).toEqual({ day: 6 });
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

test("#121 admin saves alert destinations, dashboard shows masked webhook, viewer is read-only", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const hook = "https://hooks.slack.com/services/T0E2E/B0E2E/e2eFullSecretZ9Q1";
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-alert-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key",
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    const signIn = async (email) => {
      await page.goto(origin);
      await expect(page.locator("#requestButton")).toBeEnabled();
      await page.locator("#email").fill(email);
      await page.locator("#requestButton").click();
      await expect(page.locator("#verify")).toBeVisible();
      await page.locator("#code").fill(codes.at(-1).code);
      await page.locator("#verify button[type=submit]").click();
      await expect(page.locator("#workspace")).toBeVisible();
    };
    await signIn("admin@example.invalid");
    await page.locator("#invite input[name=email]").fill("viewer@example.invalid");
    await page.locator("#invite button").click();
    await expect(page.locator("#invites")).toContainText("viewer@example.invalid");
    await expect(page.locator("#alertSlack")).toHaveText("not set");
    await page.locator("#alertForm input[name=emails]").fill("admin@example.invalid");
    await page.locator("#alertForm input[name=slack]").fill(hook);
    await page.locator("#alertForm button").click();
    await expect(page.locator("#alertSlack")).toHaveText("https://hooks.slack.com/services/…Z9Q1");
    await expect(page.locator("#alertEmails")).toHaveText("admin@example.invalid");
    expect(await page.content()).not.toContain("e2eFullSecretZ9Q1");
    await page.locator("#logout").click();
    await expect(page.locator("#login")).toBeVisible();
    await signIn("viewer@example.invalid");
    await expect(page.locator("#alertSlack")).toHaveText("https://hooks.slack.com/services/…Z9Q1");
    await expect(page.locator("#alertForm")).toBeHidden();
    expect(await page.evaluate(async () => (await fetch("/v1/alert-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ emails: [] }) })).status)).toBe(403);
    expect(await page.content()).not.toContain("e2eFullSecretZ9Q1");
    // Issue #137: viewers see members but no Remove; an admin removes the viewer with a confirm step.
    await expect(page.locator("#members")).toContainText("viewer@example.invalid · viewer");
    await expect(page.locator("#members button")).toHaveCount(0);
    await page.locator("#logout").click();
    await signIn("admin@example.invalid");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('#members .member', { hasText: "viewer@example.invalid" }).locator("button", { hasText: "Remove" }).click();
    await expect(page.locator("#status")).toContainText("Member removed.");
    await expect(page.locator("#members")).not.toContainText("viewer@example.invalid");
    await expect(page.locator("#alertEmails")).toHaveText("admin@example.invalid");
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("#123 admin creates a team in the dashboard and sees the team spend card", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-team-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key",
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#email").fill("team-admin@example.invalid");
    await page.locator("#requestButton").click();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    const agents = await page.evaluate(async (base) => {
      const out = [];
      for (const name of ["release-bot", "triage-bot"]) {
        const t = await (await fetch("/v1/enrollment-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
        out.push(await (await fetch(base + "/v1/enroll", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t.token }, body: JSON.stringify({ name }) })).json());
      }
      return out;
    }, origin);
    await page.request.post(`${origin}/v1/receipts`, { headers: { authorization: `Bearer ${agents[0].token}`, "content-type": "application/json" },
      data: { receipts: [{ id: "r1", ts: new Date().toISOString(), cost_usd: 12.5 }] } });
    await page.locator("#refresh").click();
    await expect(page.locator("#teams")).toContainText("No teams yet.");
    await page.locator("#teamForm input[name=name]").fill("ops");
    await page.locator("#teamAgents label", { hasText: "release-bot" }).locator("input").check();
    await page.locator("#teamAgents label", { hasText: "triage-bot" }).locator("input").check();
    await page.locator("#teamForm input[name=day]").fill("30");
    await page.locator("#teamForm button").click();
    const card = page.locator('#teams [data-team="ops"]');
    await expect(card).toContainText("today $12.50 of $30.00");
    await expect(card).toContainText("release-bot, triage-bot");
    await expect(card.locator("strong")).toHaveText("OK");
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((resolve) => service.server.close(resolve));
  }
});
