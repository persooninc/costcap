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

test("#261 agent week cap reaches cap_hit · week and resolves when the next Monday starts", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const delivered = [];
  let clock = Date.parse("2026-11-15T10:00:00.000Z");
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-week-")), "data.json"),
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
    await page.locator("#email").fill("week-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await expect(page.locator("#verify")).toBeVisible();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#enroll input[name=week]").fill("1");
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
    expect(delivered.some((a) => a.kind === "cap_hit" && a.scope === "week")).toBe(true);
    await page.locator("#refresh").click();
    const hit = page.locator("#alerts .alert-active", { hasText: "cap_hit" });
    await expect(hit).toBeVisible();
    await expect(hit).toContainText("cap_hit · week");
    await expect(page.locator("#agents")).toContainText("week $2.00 of $1.00 (left $0.00)");
    clock = Date.parse("2026-11-16T09:00:00.000Z"); // Sunday 10:00Z -> Monday: a new UTC ISO week
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

// Issue #165: per-agent "Warn at (%)" fractions, shown on the card and in the alert list.
test("Warn at 50, 95 on an agent card fires cap_approaching 50% then 95% once each", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const delivered = [];
  const clock = Date.parse("2026-11-15T10:00:00.000Z");
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-warn-")), "data.json"),
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
    await page.locator("#email").fill("warn-owner@example.invalid");
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
      const e = await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "researcher" }) });
      return (await e.json()).token;
    }, token);
    await page.locator("#refresh").click();
    const card = page.locator("#agents .agent", { hasText: "researcher" });
    await expect(card).toContainText("warn at 80% (default)");
    await card.locator("input[name=warnAt]").fill("50, 95");
    await card.getByRole("button", { name: "Save caps" }).click();
    await expect(page.locator("#agents .agent", { hasText: "researcher" })).toContainText("warn at 50%, 95%");
    const sync = (id, cost) => page.evaluate(async ({ agentToken, id, cost, ts }) => (await fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id, ts, cost_usd: cost, model: "m" }] }) })).status, { agentToken, id, cost, ts: new Date(clock).toISOString() });
    expect(await sync("r1", 6)).toBe(200);
    await service.evaluateFleetAlerts();
    await page.locator("#refresh").click();
    await expect(page.locator("#alerts .alert-active", { hasText: "cap_approaching 50% · day" })).toBeVisible();
    expect(await sync("r2", 3.6)).toBe(200);
    await service.evaluateFleetAlerts();
    await service.evaluateFleetAlerts();
    await page.locator("#refresh").click();
    await expect(page.locator("#alerts .alert-active", { hasText: "cap_approaching 95% · day" })).toBeVisible();
    expect(delivered.filter((a) => a.kind === "cap_approaching").map((a) => a.fraction)).toEqual([0.5, 0.95]);
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});

// Issue #168: a hosted per-run cap raises cap_approaching per run_id, shown in the alert list.
test("run cap: receipts for one run past 80% show cap_approaching 80% · run <id>", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const delivered = [];
  const clock = Date.parse("2026-11-16T10:00:00.000Z");
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-runcap-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key", now: () => clock,
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
    deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; },
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await page.locator("#email").fill("runcap-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#enroll input[name=run]").fill("5");
    await page.locator("#enroll button").click();
    await expect(page.locator("#token")).not.toHaveText("");
    const token = (await page.locator("#token").innerText()).trim();
    const ts = new Date(clock).toISOString();
    const synced = await page.evaluate(async ({ credential, ts }) => {
      const e = await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "runner" }) });
      const agent = await e.json();
      const r = await fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "a1", ts, run_id: "job-7", cost_usd: 2, model: "m" }, { id: "a2", ts, run_id: "job-7", cost_usd: 2.1, model: "m" }] }) });
      return r.status;
    }, { credential: token, ts });
    expect(synced).toBe(200);
    await service.evaluateFleetAlerts();
    expect(delivered.filter((a) => a.run_id === "job-7")).toHaveLength(1);
    await page.locator("#refresh").click();
    await expect(page.locator("#alerts .alert-active", { hasText: "cap_approaching 80% · run job-7" })).toBeVisible();
    const doc = await page.evaluate(async () => (await fetch("/v1/evidence.json")).json());
    expect(doc.alerts.some((a) => a.run_id === "job-7")).toBe(true);
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});

// Issue #199: signed generic webhook destination. The receiver is an in-process
// fixture behind an injected fetch; nothing leaves the host.
test("admin saves a signed webhook, sees it masked, viewer is read-only, fixture receiver gets a signed alert", async ({ page }) => {
  const { createOrgAlertRouter, verifyWebhookSignature } = await import("../src/hosted/delivery.js");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const received = [];
  const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];
  const deliverAlert = createOrgAlertRouter({ lookup: resolveHost, dashboardUrl: origin, fetchImpl: async (url, o) => { received.push({ url, body: o.body, sig: o.headers["x-costcap-signature"] }); return { ok: true, status: 200 }; } });
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-webhook-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key", resolveHost,
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
    deliverAlert,
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
    await signIn("hook-owner@example.invalid");
    await page.locator("#alertForm input[name=webhook]").fill("https://receiver.example.com/costcap/e2ePathK3");
    await page.locator("#alertForm button.primary").click();
    await expect(page.locator("#alertWebhook")).toHaveText(/^https:\/\/receiver\.example\.com\/… · secret whsec_…[0-9a-f]{4}$/);
    await expect(page.locator("#webhookSecretBox")).toBeVisible();
    const secret1 = (await page.locator("#webhookSecret").innerText()).trim();
    expect(secret1).toMatch(/^whsec_[0-9a-f]{48}$/);
    await page.locator("#rotateWebhook").click();
    await expect(page.locator("#status")).toContainText("Webhook secret rotated.");
    const secret = (await page.locator("#webhookSecret").innerText()).trim();
    expect(secret).not.toBe(secret1);
    await expect(page.locator("#alertWebhook")).toContainText(secret.slice(-4));
    // Enroll and overspend so an alert fires.
    await page.locator("#enroll input[name=day]").fill("1");
    await page.locator("#enroll button").click();
    await expect(page.locator("#token")).not.toHaveText("");
    const token = (await page.locator("#token").innerText()).trim();
    const status = await page.evaluate(async ({ credential, ts }) => {
      const agent = await (await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "hooked" }) })).json();
      return (await fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "r1", ts, cost_usd: 2, model: "m" }] }) })).status;
    }, { credential: token, ts: new Date().toISOString() });
    expect(status).toBe(200);
    await service.evaluateFleetAlerts();
    expect(received.length).toBe(1);
    expect(received[0].url).toBe("https://receiver.example.com/costcap/e2ePathK3");
    expect(verifyWebhookSignature(secret, received[0].body, received[0].sig)).toBe(true);
    expect(verifyWebhookSignature(secret1, received[0].body, received[0].sig)).toBe(false);
    const payload = JSON.parse(received[0].body);
    expect(payload).toMatchObject({ kind: "cap_hit", agent_name: "hooked", spent_usd: 2, cap_usd: 1 });
    // Invite a viewer: read-only masked view, 403 on write.
    await page.locator("#invite input[name=email]").fill("hook-viewer@example.invalid");
    await page.locator("#invite button").click();
    await expect(page.locator("#invites")).toContainText("hook-viewer@example.invalid");
    await page.reload();
    expect(await page.content()).not.toContain(secret);
    await page.locator("#logout").click();
    await signIn("hook-viewer@example.invalid");
    await expect(page.locator("#alertWebhook")).toContainText("https://receiver.example.com/…");
    await expect(page.locator("#rotateWebhook")).toBeHidden();
    await expect(page.locator("#alertForm")).toBeHidden();
    expect(await page.evaluate(async () => (await fetch("/v1/alert-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rotateWebhookSecret: true }) })).status)).toBe(403);
    const html = await page.content();
    expect(html).not.toContain(secret);
    expect(html).not.toContain("e2ePathK3");
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});

// Issue #247: a team month projection shows in the dashboard alert list with the projected $.
test("team mid-month run rate shows cap_projected · team ops month · projected $", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  let clock = Date.parse("2026-11-07T12:00:00.000Z"); // sessions last 24h
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-proj-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key", now: () => clock,
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); }, sendInvite: async () => {},
    deliverAlert: async () => [{ status: "accepted" }],
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await page.locator("#email").fill("proj-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#enroll button").click();
    await expect(page.locator("#token")).not.toHaveText("");
    const token = (await page.locator("#token").innerText()).trim();
    const ok = await page.evaluate(async ({ credential, ts }) => {
      const agent = await (await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "ops-bot" }) })).json();
      const team = await fetch("/v1/teams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ops", agents: [agent.agentId], month: 100 }) });
      const r = await fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "p1", ts, cost_usd: 40, model: "m" }] }) });
      return [team.status, r.status];
    }, { credential: token, ts: new Date(clock).toISOString() });
    expect(ok).toEqual([200, 200]);
    clock = Date.parse("2026-11-08T00:00:00.000Z"); // day 7 of 30: $40 -> $171.43 projected
    await service.evaluateFleetAlerts();
    await page.locator("#refresh").click();
    await expect(page.locator("#alerts .alert-active", { hasText: "cap_projected · team ops month · projected $171.43" })).toBeVisible();
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});

// Issue #271: a team week cap projects like month. Wednesday 12:00 UTC, $40 of $70: 40 * 7 / 2.5 = $112.
test("#271 team week run rate shows cap_projected · team ops week · projected $112.00", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  let clock = Date.parse("2026-11-18T00:00:00.000Z");
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-proj-week-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key", now: () => clock,
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); }, sendInvite: async () => {},
    deliverAlert: async () => [{ status: "accepted" }],
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await page.locator("#email").fill("proj-week-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#enroll button").click();
    await expect(page.locator("#token")).not.toHaveText("");
    const token = (await page.locator("#token").innerText()).trim();
    const ok = await page.evaluate(async ({ credential, ts }) => {
      const agent = await (await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "ops-bot" }) })).json();
      const team = await fetch("/v1/teams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ops", agents: [agent.agentId], week: 70 }) });
      const r = await fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "p1", ts, cost_usd: 40, model: "m" }] }) });
      return [team.status, r.status];
    }, { credential: token, ts: "2026-11-17T10:00:00.000Z" });
    expect(ok).toEqual([200, 200]);
    clock = Date.parse("2026-11-18T12:00:00.000Z");
    await service.evaluateFleetAlerts();
    await page.locator("#refresh").click();
    await expect(page.locator("#alerts .alert-active", { hasText: "cap_projected · week · team ops week · projected $112.00" })).toBeVisible();
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});

// Issue #259: "Send test alert" on the Alert destinations card. Fixture receiver only.
for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`admin sends a test alert and sees per-channel results; viewer has no button (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { createOrgAlertRouter, verifyWebhookSignature } = await import("../src/hosted/delivery.js");
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const codes = [];
    const received = [];
    const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];
    const deliverAlert = createOrgAlertRouter({ lookup: resolveHost, dashboardUrl: origin, fetchImpl: async (url, o) => { received.push({ url, body: o.body, sig: o.headers["x-costcap-signature"] }); return { ok: true, status: 200 }; } });
    const service = createHostedServer({
      storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-testalert-")), "data.json"),
      origin, secureCookies: false, turnstileSiteKey: "fixture-public-key", resolveHost,
      verifyChallenge: async (token) => token === fixtureToken,
      sendCode: async (message) => { codes.push(message); },
      sendInvite: async () => {},
      deliverAlert,
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
      await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
        status: 200, contentType: "application/javascript",
        body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
      }));
      await signIn("test-owner@example.invalid");
      await page.locator("#alertForm input[name=emails]").fill("");
      await page.locator("#alertForm input[name=slack]").fill("https://hooks.slack.com/services/T0/B0/e2eSlackK9");
      await page.locator("#alertForm input[name=webhook]").fill("https://receiver.example.com/costcap/e2eTestK3");
      await page.locator("#alertForm button.primary").click();
      await expect(page.locator("#webhookSecretBox")).toBeVisible();
      const secret = (await page.locator("#webhookSecret").innerText()).trim();
      await page.locator("#testAlert").click();
      const rows = page.locator("#testAlertResults li");
      await expect(rows).toHaveCount(3);
      await expect(page.locator("#testAlertResults li[data-channel=email]")).toHaveText("email: not configured");
      await expect(page.locator("#testAlertResults li[data-channel=slack]")).toHaveText("slack: accepted · https://hooks.slack.com/services/…ckK9");
      await expect(page.locator("#testAlertResults li[data-channel=webhook]")).toHaveText("webhook: accepted · https://receiver.example.com/…");
      const hook = received.find((r) => r.url === "https://receiver.example.com/costcap/e2eTestK3");
      expect(verifyWebhookSignature(secret, hook.body, hook.sig)).toBe(true);
      expect(JSON.parse(hook.body)).toMatchObject({ kind: "test", test: true });
      expect(await page.content()).not.toContain("e2eSlackK9");
      await page.locator("#invite input[name=email]").fill("test-viewer@example.invalid");
      await page.locator("#invite button").click();
      await expect(page.locator("#invites")).toContainText("test-viewer@example.invalid");
      await page.locator("#logout").click();
      await signIn("test-viewer@example.invalid");
      await expect(page.locator("#alertSlack")).toContainText("https://hooks.slack.com/services/…");
      await expect(page.locator("#testAlert")).toBeHidden();
    } finally {
      service.server.closeAllConnections();
      await new Promise((resolve) => service.server.close(resolve));
    }
  });
}
// Issue #258: an admin adds a team route in the UI; an over-cap team alert reaches only the expected URL; a viewer sees the route read-only.
test("alert routes: admin adds a payments route, team cap alert goes only to its Slack, viewer read-only", async ({ page }) => {
  const { createOrgAlertRouter } = await import("../src/hosted/delivery.js");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const received = [];
  const S0 = "https://hooks.slack.com/services/T0/B0/e2eDefaultA1";
  const S1 = "https://hooks.slack.com/services/T1/B1/e2eRouteZ9";
  const deliverAlert = createOrgAlertRouter({ fetchImpl: async (url) => { received.push(url); return { ok: true, status: 200 }; } });
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-routes-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key",
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
    deliverAlert,
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
    await signIn("route-owner@example.invalid");
    // Enroll an uncapped agent and put it in team "payments" with a $1 day cap.
    await page.locator("#enroll button").click();
    await expect(page.locator("#token")).not.toHaveText("");
    const token = (await page.locator("#token").innerText()).trim();
    const agent = await page.evaluate(async ({ credential }) => {
      const a = await (await fetch("/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ name: "pay-bot" }) })).json();
      const t = await fetch("/v1/teams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "payments", agents: [a.agentId], day: 1 }) });
      return { ...a, teamStatus: t.status };
    }, { credential: token });
    expect(agent.teamStatus).toBe(200);
    // Defaults: Slack S0 for agent_silent only.
    await page.locator("#alertForm input[name=slack]").fill(S0);
    for (const box of await page.locator("#defaultKinds input[name=kind]").all()) if ((await box.getAttribute("value")) !== "agent_silent") await box.uncheck();
    await page.locator("#alertForm button.primary").click();
    await expect(page.locator("#defaultKindsView")).toHaveText("Default kinds: agent_silent");
    // Add the payments route in the UI.
    await page.locator("#routeForm input[name=rname]").fill("Payments");
    await page.locator("#routeForm input[name=teams]").fill("payments");
    await page.locator("#routeForm input[name=slack]").fill(S1);
    await page.locator("#routeForm button[type=submit]").click();
    await expect(page.locator("#alertRoutes li.route")).toHaveCount(1);
    await expect(page.locator("#alertRoutes li.route")).toContainText("Payments · teams: payments · kinds: all");
    await expect(page.locator("#alertRoutes li.route")).toContainText("https://hooks.slack.com/services/…teZ9");
    expect(await page.content()).not.toContain("e2eRouteZ9");
    // Over the team cap: the alert reaches only the route's Slack.
    const status = await page.evaluate(async ({ agentToken, ts }) => (await fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "r1", ts, cost_usd: 2, model: "m" }] }) })).status, { agentToken: agent.token, ts: new Date().toISOString() });
    expect(status).toBe(200);
    await service.evaluateFleetAlerts();
    expect(received.length).toBeGreaterThan(0);
    expect([...new Set(received)]).toEqual([S1]);
    // Viewer: route listed read-only.
    await page.locator("#invite input[name=email]").fill("route-viewer@example.invalid");
    await page.locator("#invite button").click();
    await expect(page.locator("#invites")).toContainText("route-viewer@example.invalid");
    await page.locator("#logout").click();
    await signIn("route-viewer@example.invalid");
    await expect(page.locator("#alertRoutes li.route")).toContainText("Payments");
    await expect(page.locator("#routeForm")).toBeHidden();
    await expect(page.locator("#alertRoutes li.route button")).toHaveCount(0);
    expect(await page.content()).not.toContain("e2eRouteZ9");
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});

// Issue #282: native PagerDuty / Teams / Discord destinations. Fake fetchImpl receiver; nothing leaves the host.
test("#282 admin saves PagerDuty, Teams and Discord, sees masked values, test send lists all three; viewer read-only", async ({ page }) => {
  const { createOrgAlertRouter } = await import("../src/hosted/delivery.js");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const received = [];
  const PD = "E2eRoutingKey0123456789abcdefXYZ";
  const TEAMS = "https://prod-01.westus.logic.azure.com/workflows/e2e/triggers/manual/paths/invoke?sig=e2eTeamsSigQ7";
  const DISCORD = "https://discord.com/api/webhooks/1234567890/e2eDiscordTokenZ9";
  const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];
  const deliverAlert = createOrgAlertRouter({ lookup: resolveHost, dashboardUrl: origin, fetchImpl: async (url, o) => { received.push({ url, body: JSON.parse(o.body) }); return { ok: true, status: url.includes("discord") ? 204 : 202 }; } });
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-282-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key", resolveHost,
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
    deliverAlert,
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
    await signIn("native-owner@example.invalid");
    const form = page.locator("#alertForm");
    await form.locator("input[name=pdKey]").fill(PD);
    await form.locator("select[name=pdRegion]").selectOption("eu");
    await form.locator("input[name=teamsHook]").fill(TEAMS);
    await form.locator("input[name=discordHook]").fill(DISCORD);
    await form.locator("button.primary").click();
    await expect(page.locator("#status")).toContainText("Alert destinations saved.");
    await expect(page.locator("#alertPagerDuty")).toHaveText(`key …${PD.slice(-4)} · eu · kinds: all`);
    await expect(page.locator("#alertTeams")).toHaveText("https://prod-01.westus.logic.azure.com/…");
    await expect(page.locator("#alertDiscord")).toHaveText(`https://discord.com/api/webhooks/…${DISCORD.slice(-4)}`);
    await page.locator("#testAlert").click();
    for (const ch of ["pagerduty", "teams", "discord"]) await expect(page.locator(`#testAlertResults li[data-channel=${ch}]`)).toHaveAttribute("data-status", "accepted");
    expect(received.map((r) => r.url)).toEqual(["https://events.eu.pagerduty.com/v2/enqueue", TEAMS, DISCORD]);
    expect(received[0].body.payload.severity).toBe("info");
    for (const html of [await page.content()]) for (const s of [PD, "e2eTeamsSigQ7", "e2eDiscordTokenZ9"]) expect(html).not.toContain(s);
    // Viewer: masked values, no edit fields.
    await page.locator("#invite input[name=email]").fill("native-viewer@example.invalid");
    await page.locator("#invite button").click();
    await expect(page.locator("#invites")).toContainText("native-viewer@example.invalid");
    await page.locator("#logout").click();
    await signIn("native-viewer@example.invalid");
    await expect(page.locator("#alertTeams")).toHaveText("https://prod-01.westus.logic.azure.com/…");
    await expect(page.locator("#alertForm")).toBeHidden();
    await expect(page.locator("#testAlert")).toBeHidden();
    const html = await page.content();
    for (const s of [PD, "e2eTeamsSigQ7", "e2eDiscordTokenZ9"]) expect(html).not.toContain(s);
  } finally {
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  }
});
