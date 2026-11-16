import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

// Issue #156: the Spend card shows day, model and agent rows from /v1/spend, flags unknown cost and follows the period.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("Spend card: day, model and agent rows, incomplete badge, period switch, viewer access", async ({ page, browser }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-spend-e2e-")), "data.json"),
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
  const enroll = async (cookie, name) => {
    const token = await post("/v1/enrollment-tokens", {}, { cookie }).then((r) => r.json());
    return fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => r.json());
  };
  const sync = (agent, receipts) => fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts }) });
  try {
    const owner = await session("spend-e2e@example.invalid");
    const a = await enroll(owner, "<img src=x onerror=alert(1)>"), b = await enroll(owner, "batch");
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const old = new Date(now.getTime() - 20 * 86_400_000);
    await sync(a, [{ id: "a1", ts: now.toISOString(), cost_usd: 1.25, model: "gpt-4.1" }, { id: "a2", ts: now.toISOString(), cost_usd: null, model: "o3" }]);
    await sync(b, [{ id: "b1", ts: now.toISOString(), cost_usd: 0.5, model: "claude-sonnet-4" }, { id: "b2", ts: old.toISOString(), cost_usd: 4, model: "claude-sonnet-4" }]);
    expect((await post("/v1/invitations", { email: "spend-e2e-viewer@example.invalid", role: "viewer" }, { cookie: owner })).status).toBe(201);
    const viewer = await session("spend-e2e-viewer@example.invalid");

    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    let dialogs = 0;
    page.on("dialog", (d) => { dialogs++; d.dismiss(); });
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#spendCard")).toBeVisible();
    const day = page.locator(`#spendDays [data-key="${today}"]`);
    await expect(day).toContainText("$1.75");
    await expect(day).toContainText("3 calls");
    await expect(day.locator(".incomplete")).toContainText("1 unknown");
    await expect(page.locator('#spendModels [data-key="o3"] .incomplete')).toBeVisible();
    await expect(page.locator('#spendModels [data-key="gpt-4.1"] .incomplete')).toHaveCount(0);
    await expect(page.locator('#spendModels [data-key="claude-sonnet-4"]')).toContainText("$0.50");
    const agentRow = page.locator(`#spendAgents [data-key="${a.agentId}"]`);
    await expect(agentRow).toContainText("<img src=x onerror=alert(1)>");
    await expect(page.locator("#spendAgents img")).toHaveCount(0);
    await expect(page.locator("#spendTotal")).toContainText("$1.75 plus 1 unknown-cost receipts (incomplete)");
    await expect(page.locator(`#spendDays [data-key="${old.toISOString().slice(0, 10)}"]`)).toHaveCount(0);

    await page.locator("#spendPeriodSelect").selectOption("30d");
    await expect(page.locator(`#spendDays [data-key="${old.toISOString().slice(0, 10)}"]`)).toContainText("$4.00");
    await expect(page.locator('#spendModels [data-key="claude-sonnet-4"]')).toContainText("$4.50");
    expect(dialogs).toBe(0);

    // #169: By tag. Tagged receipts, one unknown-cost, one untagged.
    await sync(a, [{ id: "t1", ts: now.toISOString(), cost_usd: 2, model: "gpt-4.1", tags: { customer: "acme" } },
      { id: "t2", ts: now.toISOString(), cost_usd: null, model: "o3", tags: { customer: "beta" } }]);
    await page.locator("#spendTagKey").fill("customer");
    await page.locator("#spendTagForm button").click();
    await expect(page.locator('#spendTags [data-key="acme"]')).toContainText("$2.00");
    await expect(page.locator('#spendTags [data-key="beta"] .incomplete')).toContainText("1 unknown");
    await expect(page.locator('#spendTags [data-key="(untagged)"]')).toBeVisible();
    await expect(page.locator('#spendTags [data-key="acme"] .incomplete')).toHaveCount(0);

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "costcap_session", value: viewer.split("=")[1], url: origin }]);
    const vp = await ctx.newPage();
    await vp.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await vp.goto(origin);
    await expect(vp.locator(`#spendDays [data-key="${today}"]`)).toContainText("$3.75"); // includes the #169 tagged receipts
    await expect(vp.locator('#spendAgents [data-key]')).toHaveCount(2);
    await vp.locator("#spendTagKey").fill("customer");
    await vp.locator("#spendTagForm button").click();
    await expect(vp.locator('#spendTags [data-key="acme"]')).toContainText("$2.00");
    await expect(vp.locator('#spendTags [data-key="beta"] .incomplete')).toBeVisible();
    await ctx.close();
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});

// #184: a synced cache_hit receipt shows "Saved $… on 1 cached calls" on the Spend card.
test("Spend card shows saved spend from response-cache hits", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-spend-cache-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const email = "spend-cache-e2e@example.invalid";
    const c = await post("/auth/request", { email, turnstileToken: "x" }).then((r) => r.json());
    const owner = (await post("/auth/verify", { challengeId: c.challengeId, code: codes[email] })).headers.get("set-cookie").split(";")[0];
    const token = await post("/v1/enrollment-tokens", {}, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "cached" }) }).then((r) => r.json());
    const ts = new Date().toISOString();
    const synced = await fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [
      { id: "miss1", ts, cost_usd: 0.25, model: "gpt-4o-mini", cache: "miss" },
      { id: "hit1", ts, cost_usd: 0, model: "gpt-4o-mini", reason: "cache_hit", cache: "hit", saved_usd: 0.25, cache_source_receipt: "miss1" },
    ] }) });
    expect(synced.status).toBe(200);
    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#spendTotal")).toContainText("$0.25");
    await expect(page.locator("#spendTotal")).toContainText("Saved $0.25 on 1 cached calls");
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});
