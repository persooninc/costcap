import { test, expect } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

// Issue #225: agent card shows failed/killed spend (30d) and cost per successful run.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("agent card shows failed/killed share and cost per successful run with ≥ and —", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-outcome-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {},
  });
  await new Promise((r) => service.server.listen(port, "127.0.0.1", r));
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const c = await post("/auth/request", { email: "outcome-e2e@example.invalid", turnstileToken: "x" }).then((r) => r.json());
    const owner = (await post("/auth/verify", { challengeId: c.challengeId, code: codes["outcome-e2e@example.invalid"] })).headers.get("set-cookie").split(";")[0];
    const mint = async (name) => { const t = await post("/v1/enrollment-tokens", { caps: { day: 50 } }, { cookie: owner }).then((r) => r.json()); return post("/v1/enroll", { name }, { authorization: `Bearer ${t.token}` }).then((r) => r.json()); };
    const busy = await mint("busy-agent");
    const idle = await mint("idle-agent");
    const ts = (s) => new Date(Date.now() - s * 1000).toISOString();
    const auth = (a) => ({ authorization: `Bearer ${a.token}` });
    await post("/v1/receipts", { receipts: [
      { id: "s1", ts: ts(60), run_id: "ok", cost_usd: 1, model: "gpt-4o" },
      { id: "s2", ts: ts(55), run_id: "ok", cost_usd: null, model: "gpt-4o" },
      { id: "f1", ts: ts(50), run_id: "bad", cost_usd: 3, model: "gpt-4o" },
    ] }, auth(busy));
    const end = (run_id, exit_code) => ({ run_id, started_at: ts(70), ended_at: ts(40), exit_code, stop_reason: "exited", calls: 1, usd_known: 1, unknown_count: 0 });
    expect((await post("/v1/runs/end", end("ok", 0), auth(busy))).status).toBe(200);
    expect((await post("/v1/runs/end", end("bad", 1), auth(busy))).status).toBe(200);
    await post("/v1/receipts", { receipts: [{ id: "i1", ts: ts(30), run_id: "only", cost_usd: 2, model: "gpt-4o" }] }, auth(idle));
    expect((await post("/v1/runs/end", end("only", 2), auth(idle))).status).toBe(200);

    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "window.turnstile={render(){return 1},reset(){}}" }));
    await page.context().addCookies([{ name: "costcap_session", value: owner.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#workspace")).toBeVisible();
    const busyCard = page.locator(".agent", { hasText: "busy-agent" }).locator(".outcomes");
    await expect(busyCard).toContainText("Failed/killed runs (30d): $3.00 (75%)");
    await expect(busyCard).toContainText("Cost per successful run: ≥$1.00");
    const idleCard = page.locator(".agent", { hasText: "idle-agent" }).locator(".outcomes");
    await expect(idleCard).toContainText("Failed/killed runs (30d): $2.00 (100%)");
    await expect(idleCard).toContainText("Cost per successful run: —");
  } finally {
    service.server.closeAllConnections();
    await new Promise((r) => service.server.close(r));
  }
});
