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

    // #213: By team rows and the summary CSV that matches them.
    expect((await post("/v1/teams", { name: "core", agents: [a.agentId], day: 100 }, { cookie: owner })).status).toBe(200);
    await page.reload();
    await expect(page.locator('#spendTeams [data-key="core"]')).toContainText("$1.25");
    await expect(page.locator('#spendTeams [data-key="core"] .incomplete')).toContainText("1 unknown");
    await expect(page.locator('#spendTeams [data-key="(no team)"]')).toContainText("$0.50");
    await expect(page.locator("#spendCsv")).toHaveAttribute("href", /group_by=team&period=day/);
    await page.locator("#spendPeriodSelect").selectOption("month");
    await expect(page.locator("#spendCsv")).toHaveAttribute("href", /group_by=team&period=month/);
    const href = await page.locator("#spendCsv").getAttribute("href");
    const csv = await fetch(origin + href, { headers: { cookie: owner } }).then((r) => r.text());
    const month = today.slice(0, 7);
    expect(csv).toContain(`${month},team,core,core,1.25,2,1,false,0`);
    // b2 is seeded 20 days back: from the 21st on it falls inside this month too.
    const noTeam = old.toISOString().slice(0, 7) === month ? "4.5,2" : "0.5,1";
    expect(csv).toContain(`${month},team,(no team),(no team),${noTeam},0,true,0`);
    await page.locator("#spendPeriodSelect").selectOption("30d");

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

// #184: a synced cache_hit receipt adds "Saved $X on N cached calls" to the Spend total.
test("Spend card: cached calls show the saved spend", async ({ page }) => {
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
    const res = await fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ receipts: [{ id: "miss1", ts, cost_usd: 0.3, cache: "miss", model: "gpt-4.1" },
        { id: "hit1", ts, cost_usd: 0, reason: "cache_hit", cache: "hit", saved_usd: 0.3, cache_source_receipt: "miss1", model: "gpt-4.1" }] }) });
    expect(res.status).toBe(200);
    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#spendTotal")).toContainText("$0.30");
    await expect(page.locator("#spendTotal")).toContainText("Saved $0.30 on 1 cached calls");
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});

// #189: user_prices receipts add "$X at your prices (N receipts)" and a custom prices badge.
test("Spend card: receipts at the customer's own prices are labelled", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-spend-userprices-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const email = "spend-userprices-e2e@example.invalid";
    const c = await post("/auth/request", { email, turnstileToken: "x" }).then((r) => r.json());
    const owner = (await post("/auth/verify", { challengeId: c.challengeId, code: codes[email] })).headers.get("set-cookie").split(";")[0];
    const token = await post("/v1/enrollment-tokens", {}, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "negotiated" }) }).then((r) => r.json());
    const ts = new Date().toISOString();
    const res = await fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ receipts: [{ id: "t1", ts, cost_usd: 0.5, cost_source: "table", model: "gpt-4.1" },
        { id: "u1", ts, cost_usd: 0.24, cost_source: "user_prices", prices_sha256: "a".repeat(64), model: "claude-sonnet-4-5" },
        { id: "n1", ts, cost_usd: null, reason: "stream_incomplete", model: "o3" }] }) });
    expect(res.status).toBe(200);
    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#spendTotal")).toContainText("$0.74 plus 1 unknown-cost receipts");
    await expect(page.locator("#spendTotal")).toContainText("$0.24 at your prices (1 receipts)");
    await expect(page.locator('#spendModels [data-key="claude-sonnet-4-5"] .custom-prices')).toContainText("custom prices");
    await expect(page.locator('#spendModels [data-key="gpt-4.1"] .custom-prices')).toHaveCount(0);
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});

// #257: a synced Gemini context-cache storage receipt counts in /v1/spend and the Spend card under its model.
test("Spend card: a cache_storage receipt appears under its model", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-spend-257-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const c = await post("/auth/request", { email: "cache-257@example.invalid", turnstileToken: "x" }).then((r) => r.json());
    const owner = (await post("/auth/verify", { challengeId: c.challengeId, code: codes["cache-257@example.invalid"] })).headers.get("set-cookie").split(";")[0];
    const token = await post("/v1/enrollment-tokens", {}, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "cache" }) }).then((r) => r.json());
    const ts = new Date().toISOString();
    const synced = await fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ receipts: [{ id: "s1", ts, provider: "gemini", cost_usd: 0.2, model: "gemini-2.5-flash", kind: "cache_storage", cache_name: "cachedContents/abc123", cache_tokens: 200000, storage_hours: 1 }] }) });
    expect(synced.status).toBeLessThan(300);
    const spend = await fetch(origin + "/v1/spend?group_by=model", { headers: { cookie: owner, origin } }).then((r) => r.json());
    expect(JSON.stringify(spend)).toContain("gemini-2.5-flash");
    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator('#spendModels [data-key="gemini-2.5-flash"]')).toContainText("$0.20");
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});

// #294 AC6: projected budget-month-end spend on the total and on agent rows, month only.
test("Spend card: This month shows the linear projection; 7 days doesn't; viewer sees the same", async ({ page, browser }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-spend-fc-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {}, now: () => Date.parse("2026-11-11T00:00:00Z"),
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
    const owner = await session("spend-fc@example.invalid");
    const other = await session("spend-fc-other@example.invalid");
    const a = await enroll(owner, "A"), b = await enroll(owner, "B"), x = await enroll(other, "X");
    await sync(a, [{ id: "a1", ts: "2026-11-02T00:00:00Z", cost_usd: 30, model: "m" }]);
    await sync(b, [{ id: "b1", ts: "2026-11-05T00:00:00Z", cost_usd: 10, model: "m" }]);
    await sync(x, [{ id: "x1", ts: "2026-11-05T00:00:00Z", cost_usd: 500, model: "m" }]);
    expect((await post("/v1/invitations", { email: "spend-fc-viewer@example.invalid", role: "viewer" }, { cookie: owner })).status).toBe(201);
    const viewer = await session("spend-fc-viewer@example.invalid");
    for (const [p, cookie] of [[page, owner], [await (await browser.newContext()).newPage(), viewer]]) {
      await p.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
      await p.context().addCookies([{ name: "costcap_session", value: cookie.split("=")[1], url: origin }]);
      await p.goto(origin);
      await p.locator("#spendPeriodSelect").selectOption("month");
      await expect(p.locator("#spendTotal")).toContainText("Projected by 2026-12-01: $120.00");
      await expect(p.locator(`#spendAgents [data-key="${a.agentId}"]`)).toContainText("→ $90.00 projected");
      await expect(p.locator(`#spendAgents [data-key="${b.agentId}"]`)).toContainText("→ $30.00 projected");
      await p.locator("#spendPeriodSelect").selectOption("7d");
      await expect(p.locator("#spendTotal")).not.toContainText("Projected");
      await expect(p.locator("#spendAgents")).not.toContainText("projected");
    }
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});
