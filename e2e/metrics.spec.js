// Issue #220: create a viewer API key in the UI, scrape /v1/metrics with it.
// Local server only; Turnstile is stubbed and no outbound call is made.
import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { validateExposition } from "../src/hosted/metrics.js";

const fixtureToken = "fixture-" + "pass";
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("metrics: viewer key scrapes spend, cap headroom and unknown-cost honesty", async ({ page }) => {
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

    // Two agents in team "t": a has a $5 day cap and $1.25 spend; b has a settled-cost and an unknown-cost receipt.
    const post = (path, data, headers = { origin }) => page.request.post(`${origin}${path}`, { data, headers });
    const enroll = async (name, caps) => {
      const tok = await (await post("/v1/enrollment-tokens", { caps })).json();
      return (await post("/v1/enroll", { name }, { authorization: `Bearer ${tok.token}` })).json();
    };
    const a = await enroll("a", { day: 5 });
    const b = await enroll("b", {});
    const ts = new Date().toISOString();
    expect((await post("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 1.25, model: "m" }] }, { authorization: `Bearer ${a.token}` })).status()).toBe(200);
    expect((await post("/v1/receipts", { receipts: [{ id: "r2", ts, cost_usd: 0.5, model: "m" }, { id: "r3", ts, cost_usd: null, model: "m" }] }, { authorization: `Bearer ${b.token}` })).status()).toBe(200);
    const team = await post("/v1/teams", { name: "t", agents: [a.agentId, b.agentId], month: 100 });
    expect(team.status(), await team.text()).toBe(200);

    await page.reload();
    await expect(page.locator("#apiKeysCard")).toBeVisible();
    await page.locator("#apiKeyForm input[name=name]").fill("grafana");
    await page.locator("#apiKeyCreate").click();
    await expect(page.locator("#apiKeyNew")).toBeVisible();
    const key = (await page.locator("#apiKeyValue").innerText()).trim();
    expect(key).toMatch(/^cck_/);

    expect((await fetch(`${origin}/v1/metrics`)).status).toBe(401);
    const r = await fetch(`${origin}/v1/metrics`, { headers: { authorization: `Bearer ${key}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    const body = await r.text();
    expect(validateExposition(body)).toEqual([]);
    expect(body).toContain('costcap_spend_usd{agent="a",team="t",window="day"} 1.25');
    expect(body).toContain('costcap_cap_remaining_usd{scope="agent",name="a",window="day"} 3.75');
    expect(body).toContain('costcap_spend_complete{agent="b",window="day"} 0');
    expect(body).toContain('costcap_unknown_cost_receipts{agent="b"} 1');
    expect(body).toContain('costcap_cap_remaining_usd{scope="team",name="t",window="month"} 98.25');
  } finally {
    service.server.closeAllConnections();
    service.server.close();
  }
});
