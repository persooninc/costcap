// Issue #220: create a viewer API key in the UI, scrape /v1/metrics with it, assert the Prometheus series.
// Local server only; Turnstile is stubbed and no outbound call is made.
import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { parseProm, value } from "../test/support/prom.js";

const fixtureToken = "fixture-" + "pass";
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("Metrics: viewer key from the UI scrapes Prometheus series", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = [];
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-pw-metrics-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-public-key",
    verifyChallenge: async (token) => token === fixtureToken,
    sendCode: async (message) => { codes.push(message); },
    sendInvite: async () => {},
    deliverAlert: async () => [{ status: "accepted" }],
  });
  await new Promise((resolve) => service.server.listen(port, "127.0.0.1", resolve));
  try {
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.fulfill({
      status: 200, contentType: "application/javascript",
      body: `window.turnstile={render(selector,opts){opts.callback(${JSON.stringify(fixtureToken)});return 1},reset(){}};`,
    }));
    await page.goto(origin);
    await page.locator("#email").fill("metrics-owner@example.invalid");
    await expect(page.locator("#requestButton")).toBeEnabled();
    await page.locator("#requestButton").click();
    await expect(page.locator("#verify")).toBeVisible();
    await page.locator("#code").fill(codes.at(-1).code);
    await page.locator("#verify button[type=submit]").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#apiKeysCard")).toBeVisible();

    await page.locator("#apiKeyForm input[name=name]").fill("prometheus");
    await page.locator("#apiKeyCreate").click();
    await expect(page.locator("#apiKeyNew")).toBeVisible();
    const key = (await page.locator("#apiKeyValue").innerText()).trim();
    expect(key).toMatch(/^cck_/);

    // Seed two agents through the real API: the session cookie for admin calls, agent tokens for receipts.
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const post = (path, body, auth) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : { cookie, origin }) }, body: JSON.stringify(body) }).then((r) => r.json());
    const enroll = async (name, caps) => post("/v1/enroll", { name }, (await post("/v1/enrollment-tokens", { caps })).token);
    const a = await enroll("a", { day: 5 });
    const b = await enroll("b", {});
    const ts = new Date(Date.now() - 1000).toISOString();
    await post("/v1/receipts", { receipts: [{ id: "a1", ts, cost_usd: 1.25, model: "m" }] }, a.token);
    await post("/v1/receipts", { receipts: [{ id: "b1", ts, cost_usd: 0.5, model: "m" }, { id: "b2", ts, cost_usd: null, model: "m" }] }, b.token);
    await post("/v1/teams", { name: "t", agents: [a.agentId, b.agentId], day: 100 });

    const res = await fetch(`${origin}/v1/metrics`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    const rows = parseProm(await res.text());
    expect(value(rows, "costcap_spend_usd", { agent: "a", team: "t", window: "day" })).toBe(1.25);
    expect(value(rows, "costcap_cap_remaining_usd", { scope: "agent", name: "a", window: "day" })).toBe(3.75);
    expect(value(rows, "costcap_spend_complete", { agent: "b", window: "day" })).toBe(0);
    expect(value(rows, "costcap_unknown_cost_receipts", { agent: "b" })).toBe(1);
    expect((await fetch(`${origin}/v1/metrics`)).status).toBe(401);
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});
