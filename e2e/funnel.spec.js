// go-to-market#14: the hosted funnel (sign up -> first receipt -> Upgrade click -> paid webhook)
// emits sign_up, activation, begin_checkout and purchase to a hermetic GA4 sink, with no PII.
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createHostedServer } from "../src/hosted/server.js";
import { accountId, resetFunnelForTests } from "../src/hosted/funnel.js";

test("funnel events fire once each through the real hosted flow", async ({ page }) => {
  resetFunnelForTests();
  const sent = [];
  let code;
  const billing = {
    status: async () => ({ status: "free_beta", plans: ["workspace"] }),
    portal: async () => ({ url: "https://billing.stripe.com/p/session/fixture" }),
    checkout: async () => ({ url: "https://checkout.stripe.com/c/pay/fixture" }),
    webhook: async () => ({ received: true }),
  };
  const port = await new Promise((resolve) => { const probe = createServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const origin = `http://127.0.0.1:${port}`;
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-funnel-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key",
    verifyChallenge: async () => true, sendCode: async d => { code = d.code; }, billingFactory: () => billing,
    funnel: { env: { GA4_MEASUREMENT_ID: "G-FIXTURE1", GA4_API_SECRET: "fixture" }, fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 204 }; } },
  });
  await service.billingReady;
  await new Promise(r => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  await page.route("https://checkout.stripe.com/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Checkout fixture</h1>" }));
  await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", route => route.fulfill({ contentType: "application/javascript", body: "window.turnstile={render(s,o){o.callback('x');return 1},reset(){}}" }));
  try {
    const { challengeId } = await (await post("/auth/request", { email: "funnel-owner@example.invalid", turnstileToken: "x" })).json();
    const verified = await post("/auth/verify", { challengeId, code });
    const { orgId } = await verified.json();
    const session = verified.headers.get("set-cookie").split(";")[0];
    const { token } = await (await post("/v1/enrollment-tokens", { caps: { day: 1 } }, { cookie: session })).json();
    const agent = await (await post("/v1/enroll", { name: "funnel-agent" }, { authorization: `Bearer ${token}` })).json();
    expect((await post("/v1/receipts", { receipts: [{ id: "r-1", ts: new Date().toISOString(), cost_usd: 0.01, model: "m" }] }, { authorization: `Bearer ${agent.token}` })).status).toBe(200);
    await page.context().addCookies([{ name: "costcap_session", value: session.split("=")[1], url: origin }]);
    await page.goto(origin + "/");
    await expect(page.locator("#billingStatus")).toHaveText("Free beta. No verified subscription.");
    await page.locator("#upgrade").click();
    await expect(page.getByRole("heading", { name: "Checkout fixture" })).toBeVisible();
    const completed = { id: "evt_f", type: "checkout.session.completed", data: { object: { id: "cs_test_f", client_reference_id: orgId, currency: "usd", amount_total: 1900, payment_status: "paid", metadata: { app: "costcap", org_id: orgId, plan: "workspace" } } } };
    expect((await fetch(origin + "/billing/webhook", { method: "POST", body: JSON.stringify(completed) })).status).toBe(200);
    await expect.poll(() => sent.map(b => b.events[0].name)).toEqual(["sign_up", "activation", "begin_checkout", "purchase"]);
    for (const b of sent) expect(b.events[0].params.account_id).toBe(accountId(orgId));
    expect(JSON.stringify(sent)).not.toContain("example.invalid");
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});
