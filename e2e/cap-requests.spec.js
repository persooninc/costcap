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
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-capreq-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {}, now: () => Date.now() + skew,
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
    await post("/v1/receipts", { receipts: [{ id: "k-1", ts: new Date().toISOString(), cost_usd: 6, model: "m" }] }, asAgent);
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
