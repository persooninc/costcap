import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
// Issue #209: the Budget period card sets the org timezone; the Spend card then
// buckets a receipt by its local date, and a viewer cannot change the period.
test("Budget period card: timezone moves a receipt to its local day in the Spend card", async ({ page, browser }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-budget-period-e2e-")), "data.json"),
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
    const owner = await session("period-e2e@example.invalid");
    const token = await post("/v1/enrollment-tokens", {}, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "la" }) }).then((r) => r.json());
    // 03:00Z two days ago: the UTC date differs from the Los Angeles date (previous evening).
    const d = new Date();
    const ts = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 2, 3)).toISOString();
    const utcDay = ts.slice(0, 10);
    const laDay = new Date(Date.parse(ts) - 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ receipts: [{ id: "r1", ts, cost_usd: 1.5, model: "gpt-4.1" }, { id: "r2", ts, cost_usd: null, model: "o3" }] }) });
    expect(res.status).toBe(200);
    expect((await post("/v1/invitations", { email: "period-e2e-viewer@example.invalid", role: "viewer" }, { cookie: owner })).status).toBe(201);
    const viewer = await session("period-e2e-viewer@example.invalid");

    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#budgetPeriodCard")).toBeVisible();
    await expect(page.locator("#budgetPeriodNow")).toContainText("UTC, month starts on day 1");
    await expect(page.locator(`#spendDays [data-key="${utcDay}"]`)).toContainText("$1.50");
    await page.locator("#budgetTimezone").selectOption("America/Los_Angeles");
    await page.locator("#budgetMonthStartDay").fill("15");
    await page.locator("#budgetPeriodSave").click();
    await expect(page.locator("#budgetPeriodNow")).toContainText("America/Los_Angeles, month starts on day 15");
    const local = page.locator(`#spendDays [data-key="${laDay}"]`);
    await expect(local).toContainText("$1.50");
    await expect(local.locator(".incomplete")).toContainText("1 unknown");
    await expect(page.locator(`#spendDays [data-key="${utcDay}"]`)).toHaveCount(0);
    await expect(page.locator("#spendTotal")).toContainText("America/Los_Angeles");
    // #215: the period select asks the server for range=, never a browser-computed UTC since.
    const spendUrls = [];
    page.on("request", (r) => { if (r.url().includes("/v1/spend")) spendUrls.push(r.url()); });
    const monthReq = page.waitForResponse((r) => r.url().includes("/v1/spend?group_by=day") && r.url().includes("range=current_month"));
    await page.locator("#spendPeriodSelect").selectOption("month");
    const month = await (await monthReq).json();
    expect(month.range).toBe("current_month");
    await expect(page.locator("#spendTotal")).toContainText(`Total since ${month.since_local}`);
    expect(spendUrls.every((u) => u.includes("range=") && !u.includes("since="))).toBe(true);
    await expect(page.locator("#spendCsv")).toHaveAttribute("href", /range=current_month/);

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "costcap_session", value: viewer.split("=")[1], url: origin }]);
    const vp = await ctx.newPage();
    await vp.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await vp.goto(origin);
    await expect(vp.locator("#budgetPeriodNow")).toContainText("America/Los_Angeles");
    await expect(vp.locator("#budgetPeriodSave")).toBeDisabled();
    await expect(vp.locator(`#spendDays [data-key="${laDay}"]`)).toContainText("$1.50");
    await ctx.close();
    expect((await post("/v1/budget-period", { timezone: "UTC" }, { cookie: viewer })).status).toBe(403);
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});
