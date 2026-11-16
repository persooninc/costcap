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
// Issue #211: an admin sets 30-day retention, sees the preview count, the sweep runs on a
// fake clock, and the old receipt is gone from the dashboard totals and the CSV export.
test("Receipt retention card: preview, sweep and CSV", async ({ page }) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const codes = {};
  const clock = { now: Date.now() };
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-retention-e2e-")), "data.json"),
    origin, secureCookies: false, turnstileSiteKey: "fixture-key", stripeEnv: {}, now: () => clock.now,
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
    const owner = await session("retention-e2e@example.invalid");
    const token = await post("/v1/enrollment-tokens", {}, { cookie: owner }).then((r) => r.json());
    const agent = await fetch(origin + "/v1/enroll", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "ret" }) }).then((r) => r.json());
    const ago = (d) => new Date(clock.now - d * 86_400_000).toISOString();
    const res = await fetch(origin + "/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ receipts: [{ id: "oldreceipt", ts: ago(60), cost_usd: 2, model: "gpt-4.1" }, { id: "newreceipt", ts: ago(1), cost_usd: 1, model: "gpt-4.1" }, { id: "unkreceipt", ts: ago(61), cost_usd: null, model: "o3" }] }) });
    expect(res.status).toBe(200);
    expect((await post("/v1/invitations", { email: "retention-e2e-admin@example.invalid", role: "admin" }, { cookie: owner })).status).toBe(201);
    const admin = await session("retention-e2e-admin@example.invalid");

    await page.route("**/challenges.cloudflare.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "costcap_session", value: admin.split("=")[1], url: origin }]);
    await page.goto(origin);
    await expect(page.locator("#retentionNow")).toContainText("Keeping all receipts");
    await expect(page.locator("#cost")).toContainText("$3.00");
    await page.locator("#retentionDays").fill("30");
    await page.locator("#retentionSave").click();
    await expect(page.locator("#retentionNow")).toContainText("Keeping 30 days. Next sweep deletes 1 receipt older than");

    clock.now += 3_600_000; // the nightly sweep runs later on the fake clock
    expect(service.purgeExpiredReceipts()).toEqual([expect.objectContaining({ count: 1 })]);
    await page.reload();
    await expect(page.locator("#cost")).toContainText("$1.00");
    await expect(page.locator("#unknown")).toHaveText("1");
    await expect(page.locator("#retentionNow")).toContainText("deletes 0 receipts");
    const csv = await page.evaluate(() => fetch("/v1/receipts.csv", { credentials: "same-origin" }).then((r) => r.text()));
    expect(csv).toContain("newreceipt");
    expect(csv).toContain("unkreceipt");
    expect(csv).not.toContain("oldreceipt");
  } finally {
    service.server.closeAllConnections?.();
    await new Promise((r) => service.server.close(r));
  }
});
