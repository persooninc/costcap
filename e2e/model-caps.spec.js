// Issue #238: an owner sets per-model caps through the agent policy API; the agent
// card shows them read-only, GET /v1/policy ships them, and a viewer API key cannot
// write them. Local server only; Turnstile is stubbed and no outbound call is made.
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

test("model caps: owner sets modelCaps by API, card shows them, policy sync ships them, viewer key gets 403", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-modelcaps-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key",
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
    deliverAlert: async () => [{ status: "accepted" }],
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await page.locator("#email").fill("modelcaps-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await expect(page.locator("#verify")).toBeVisible();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();

    const post = (path, data, headers = { origin }) => page.request.post(`${origin}${path}`, { data, headers });
    const tok = await (await post("/v1/enrollment-tokens", { caps: { day: 10 } })).json();
    const agent = await (await post("/v1/enroll", { name: "mixer" }, { authorization: `Bearer ${tok.token}` })).json();

    const bad = await post(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 10 }, modelCaps: [{ model: "claude-opus-4-8", scope: "run", usd: 1 }] });
    expect(bad.status()).toBe(400);
    expect((await post("/v1/agents/nope/policy", { caps: { day: 10 }, modelCaps: [{ model: "claude-opus-4-8", scope: "day", usd: 1 }] })).status()).toBe(404);
    const ok = await post(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 10 }, modelCaps: [{ model: "claude-opus-4-8", scope: "day", usd: 1 }] });
    expect(ok.status(), await ok.text()).toBe(200);

    const pol = await (await fetch(`${origin}/v1/policy`, { headers: { authorization: `Bearer ${agent.token}` } })).json();
    expect(pol.modelCaps).toEqual([{ model: "claude-opus-4-8", scope: "day", usd: 1 }]);

    await page.reload();
    await expect(page.locator("#agents .agent", { hasText: "mixer" })).toContainText("Model caps: claude-opus-4-8 day $1");

    const key = await (await post("/v1/api-keys", { name: "ro", role: "viewer" })).json();
    expect(key.key).toMatch(/^cck_/);
    const denied = await fetch(`${origin}/v1/agents/${agent.agentId}/policy`, { method: "POST", headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" }, body: JSON.stringify({ modelCaps: null }) });
    expect(denied.status).toBe(403);
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});
