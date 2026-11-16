import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

// Issue #159: per-run drill-down in the hosted dashboard.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("agent card lists recent runs, click-through shows receipts, CSV carries run_id", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-runs-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const c = await post("/auth/request", { email: "runs-e2e@example.invalid", turnstileToken: "x" }).then((r) => r.json());
    const owner = (await post("/auth/verify", { challengeId: c.challengeId, code: codes["runs-e2e@example.invalid"] })).headers.get("set-cookie").split(";")[0];
    const token = await post("/v1/enrollment-tokens", { caps: { day: 5 } }, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "runs-agent" }) }).then((r) => r.json());
    const ts = (s) => new Date(Date.now() - s * 1000).toISOString();
    await fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [
      { id: "o1", ts: ts(60), run_id: "run-old", cost_usd: 0.25, model: "gpt-4o" },
      { id: "n1", ts: ts(30), run_id: "run-new", cost_usd: 1, model: "gpt-4o" },
      { id: "n2", ts: ts(20), run_id: "run-new", cost_usd: null, model: "claude-sonnet-4" },
    ] }) });

    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "window.turnstile={render(){return 1},reset(){}}" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#workspace")).toBeVisible();
    const runs = page.locator(".agent").first().locator(".runList li");
    await expect(runs).toHaveCount(2);
    await expect(runs.nth(0)).toHaveAttribute("data-run", "run-new");
    await expect(runs.nth(0)).toContainText("2 calls");
    await expect(runs.nth(0)).toContainText("incomplete");
    await expect(runs.nth(1)).toHaveAttribute("data-run", "run-old");
    await runs.nth(0).getByRole("button", { name: "run-new" }).click();
    const detail = page.locator(".agent").first().locator(".runDetail");
    await expect(detail.locator("li")).toHaveCount(2);
    await expect(detail.locator('[data-receipt="n2"]')).toContainText("cost unknown");
    await expect(detail).toContainText("incomplete: 1 unknown-cost");
    const [download] = await Promise.all([page.waitForEvent("download"), detail.getByRole("link", { name: "Download this run (CSV)" }).click()]);
    const csv = readFileSync(await download.path(), "utf8").trim().split("\n");
    expect(csv[0]).toMatch(/^ts,agent_id,receipt_id,run_id,model,/);
    expect(csv.length).toBe(3);
    expect(csv.slice(1).every((l) => l.includes(",run-new,"))).toBe(true);
  } finally {
    service.server.closeAllConnections();
    await new Promise((r) => service.server.close(r));
  }
});
