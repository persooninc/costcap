import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

// Issue #208: the agent files a cap raise request, an admin approves it in the dashboard,
// the verdict shows the raised cap, and after expiry the verdict shows the base cap again.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("agent requests a raise, admin approves in the dashboard, raise expires", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  let skew = 0; // fake clock offset for the server
  // The +4h expiry skew must not cross UTC midnight (a day rollover resets day spend, so the run
  // failed after ~20:00 UTC). If it would, move the server clock forward to just after midnight.
  const d0 = new Date(); d0.setUTCHours(24, 5, 0, 0);
  const anchor = Date.now() + 5 * 3600_000 >= d0.getTime() - 5 * 60_000 ? d0.getTime() - Date.now() : 0;
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-capreq-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {}, now: () => Date.now() + anchor + skew,
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
    const owner = await session("capreq-admin@example.invalid");
    const token = await post("/v1/enrollment-tokens", { caps: { day: 5 } }, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "batch-agent" }) }).then((r) => r.json());
    const asAgent = { authorization: `Bearer ${agent.token}` };
    await post("/v1/receipts", { receipts: [{ id: "k-1", ts: new Date(Date.now() + anchor).toISOString(), cost_usd: 6, model: "m" }] }, asAgent);
    const verdict = () => fetch(`${origin}/v1/agents/${agent.agentId}/budget`, { headers: asAgent }).then((r) => r.json());
    expect((await verdict()).verdict).toBe("budget_exceeded");

    // 1. The agent files a request.
    const req = await post(`/v1/agents/${agent.agentId}/cap-requests`, { scope: "day", amount_usd: 20, duration_hours: 4, reason: "finish nightly batch" }, asAgent);
    expect(req.status).toBe(201);

    // 2. An admin approves it in the dashboard.
    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "window.turnstile={render(){return 1},reset(){}}" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    const card = page.locator("#capRequests .cap-request").first();
    await expect(card).toContainText("batch-agent · day +$20.00 for 4h · finish nightly batch");
    await expect(card).toContainText("PENDING");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card).toContainText("ACTIVE until");
    await expect(page.locator("#audit")).toContainText("cap_request.approve");

    // 3. The verdict shows the raised cap.
    const during = await verdict();
    expect(during.verdict).toBe("ok");
    expect(during.budget_remaining.day_usd).toBe(19);

    // 3b. #212: a second approved raise stacks (base 5 + 20 + 5), each card entry stays active.
    const r2 = await post(`/v1/agents/${agent.agentId}/cap-requests`, { scope: "day", amount_usd: 5, duration_hours: 1, reason: "rerun failed shard" }, asAgent).then((r) => r.json());
    expect((await post(`/v1/cap-requests/${r2.id}/approve`, {}, { cookie: owner })).status).toBe(200);
    expect((await verdict()).budget_remaining.day_usd).toBe(24);
    // Lowering the base during the raises lowers the effective cap at once (2 + 25 = 27).
    expect((await post(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 2 } }, { cookie: owner })).status).toBe(200);
    expect((await verdict()).budget_remaining.day_usd).toBe(21);
    // r2 expires on its own; r1 keeps applying and the card no longer shows r2 as active.
    skew = 3600_000 + 1000;
    expect((await verdict()).budget_remaining.day_usd).toBe(16);
    await page.reload();
    await expect(page.locator(`#capRequests [data-request="${r2.id}"]`)).toHaveCount(0);
    await expect(page.locator("#capRequests .cap-request")).toHaveCount(1);
    expect((await post(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 5 } }, { cookie: owner })).status).toBe(200);

    // 4. The clock passes expiry and the verdict shows the base cap.
    skew = 4 * 3600_000 + 1000;
    const after = await verdict();
    expect(after.verdict).toBe("budget_exceeded");
    expect(after.cap_usd).toBe(5);
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});

// Issue #271: a week raise is requested, approved in the dashboard and shown as ACTIVE.
test("#271 week raise is requested, approved in the dashboard and shown as ACTIVE", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-capreq-week-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const c = await post("/auth/request", { email: "capreq-week@example.invalid", turnstileToken: "x" }).then((r) => r.json());
    const owner = (await post("/auth/verify", { challengeId: c.challengeId, code: codes["capreq-week@example.invalid"] })).headers.get("set-cookie").split(";")[0];
    const token = await post("/v1/enrollment-tokens", { caps: { week: 10 } }, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "week-agent" }) }).then((r) => r.json());
    const asAgent = { authorization: `Bearer ${agent.token}` };
    await post("/v1/receipts", { receipts: [{ id: "w-1", ts: new Date().toISOString(), cost_usd: 9.5, model: "m" }] }, asAgent);
    expect((await post(`/v1/agents/${agent.agentId}/cap-requests`, { scope: "week", amount_usd: 20, duration_hours: 24, reason: "weekly backfill" }, asAgent)).status).toBe(201);
    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "window.turnstile={render(){return 1},reset(){}}" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    const card = page.locator("#capRequests .cap-request").first();
    await expect(card).toContainText("week-agent · week +$20.00 for 24h · weekly backfill");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card).toContainText("ACTIVE until");
    const verdict = await fetch(`${origin}/v1/agents/${agent.agentId}/budget`, { headers: asAgent }).then((r) => r.json());
    expect(verdict.budget_remaining.week_usd).toBe(20.5);
    const pol = await fetch(`${origin}/v1/policy`, { headers: asAgent }).then((r) => r.json());
    expect(pol.raise?.week).toBeUndefined();
    expect(pol.raise_week).toHaveLength(1);
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});

test("#287 total raise is requested, approved in the dashboard and the agent card reads left against the raised cap", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-capreq-total-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const c = await post("/auth/request", { email: "capreq-total@example.invalid", turnstileToken: "x" }).then((r) => r.json());
    const owner = (await post("/auth/verify", { challengeId: c.challengeId, code: codes["capreq-total@example.invalid"] })).headers.get("set-cookie").split(";")[0];
    const token = await post("/v1/enrollment-tokens", { caps: { total: 200 } }, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "total-agent" }) }).then((r) => r.json());
    const asAgent = { authorization: `Bearer ${agent.token}` };
    await post("/v1/receipts", { receipts: [{ id: "t-1", ts: new Date().toISOString(), cost_usd: 200, model: "m" }] }, asAgent);
    expect((await fetch(`${origin}/v1/agents/${agent.agentId}/budget`, { headers: asAgent }).then((r) => r.json())).ok).toBe(false);
    expect((await post(`/v1/agents/${agent.agentId}/cap-requests`, { scope: "total", amount_usd: 50, duration_hours: 48, reason: "finish eval" }, asAgent)).status).toBe(201);
    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "window.turnstile={render(){return 1},reset(){}}" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    const card = page.locator("#capRequests .cap-request").first();
    await expect(card).toContainText("total-agent · total +$50.00 for 48h · finish eval");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card).toContainText("ACTIVE until");
    await expect(page.locator("#agents .agent").first()).toContainText("total $200.00 of $250.00 (left $50.00) +$50.00 raise until");
    const verdict = await fetch(`${origin}/v1/agents/${agent.agentId}/budget`, { headers: asAgent }).then((r) => r.json());
    expect(verdict.ok).toBe(true);
    expect(verdict.budget_remaining.total_usd).toBe(50);
    const pol = await fetch(`${origin}/v1/policy`, { headers: asAgent }).then((r) => r.json());
    expect(pol.raise?.total).toBeUndefined();
    expect(pol.raise_total).toHaveLength(1);
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});
