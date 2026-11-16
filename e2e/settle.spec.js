import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

// Issue #125: an admin settles an unknown-cost receipt from the dashboard; a viewer sees no Settle control.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("admin settles an unknown-cost receipt; viewer has no Settle control", async ({ page, browser }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-settle-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const session = async (email) => {
    const c = await post("/auth/request", { email, turnstileToken: "x" }).then((r) => r.json());
    const v = await post("/auth/verify", { challengeId: c.challengeId, code: codes[email] });
    return v.headers.get("set-cookie").split(";")[0];
  };
  try {
    const owner = await session("settle-admin@example.invalid");
    const token = await post("/v1/enrollment-tokens", { caps: { day: 5 } }, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "settle-agent" }) }).then((r) => r.json());
    const ts = new Date().toISOString();
    await fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "unk-1", ts, cost_usd: null, model: "m" }, { id: "k-1", ts, cost_usd: 1, model: "m" }] }) });
    expect((await post("/v1/invitations", { email: "settle-viewer@example.invalid", role: "viewer" }, { cookie: owner })).status).toBe(201);
    const viewer = await session("settle-viewer@example.invalid");

    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "window.turnstile={render(){return 1},reset(){}}" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#unknown")).toHaveText("1");
    const row = page.locator('#unknownRows [data-receipt="unk-1"]');
    await expect(row).toContainText("cost unknown");
    await row.locator("input[name=cost]").fill("2.5");
    await row.locator("select[name=source]").selectOption("provider_usage_export");
    await row.locator("input[name=reason]").fill("Usage export Nov");
    await row.getByRole("button", { name: "Settle" }).click();
    await expect(row).toContainText("$2.50 (settled, provider_usage_export)");
    await expect(page.locator("#unknown")).toHaveText("0");
    await expect(page.locator("#cost")).toHaveText("$3.50");
    await expect(row.getByRole("button", { name: "Settle" })).toHaveCount(0);

    // Issue #133: the audit row names the human and the agent, not UUIDs; CSV link present.
    await page.locator(".agent").first().locator("input[name=day]").fill("7");
    await page.locator(".agent").first().getByRole("button", { name: "Save caps" }).click();
    await expect(page.locator("#audit")).toContainText("settle-admin@example.invalid · policy.change · settle-agent");
    await expect(page.locator("#audit")).not.toContainText(agent.agentId);
    await expect(page.locator("#auditCsv")).toHaveAttribute("href", "/v1/audit.csv");

    // Viewer: sees the row, never the control.
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "costcap_session", value: viewer.split("=")[1], url: origin }]);
    const vp = await ctx.newPage();
    await vp.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await vp.goto(origin);
    await expect(vp.locator('#unknownRows [data-receipt="unk-1"]')).toContainText("(settled");
    await expect(vp.locator("#unknownRows form.settle")).toHaveCount(0);
    await ctx.close();
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});

test("viewer sees an unsettled unknown-cost row without a Settle control", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-settle-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const session = async (email) => {
    const c = await post("/auth/request", { email, turnstileToken: "x" }).then((r) => r.json());
    const v = await post("/auth/verify", { challengeId: c.challengeId, code: codes[email] });
    return v.headers.get("set-cookie").split(";")[0];
  };
  try {
    const owner = await session("v-owner@example.invalid");
    const token = await post("/v1/enrollment-tokens", {}, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "a" }) }).then((r) => r.json());
    await fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "unk-2", ts: new Date().toISOString(), cost_usd: null }] }) });
    await post("/v1/invitations", { email: "v-viewer@example.invalid", role: "viewer" }, { cookie: owner });
    const viewer = await session("v-viewer@example.invalid");
    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "costcap_session", value: viewer.split("=")[1], url: origin }]);
    await page.goto(origin);
    const row = page.locator('#unknownRows [data-receipt="unk-2"]');
    await expect(row).toContainText("cost unknown");
    await expect(row.getByRole("button", { name: "Settle" })).toHaveCount(0);
    await expect(page.locator("#unknown")).toHaveText("1");
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});
