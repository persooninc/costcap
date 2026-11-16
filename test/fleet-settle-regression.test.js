// Issue #129 regression: unknown-cost receipt -> sync -> reconcile --apply -> sync,
// against the real local hosted server. The hosted verdict moves off accounting_unavailable.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import { applyReconciliation } from "../src/reconcile.js";

test("regression #129: local settlement reaches hosted budget, team verdict and evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-129-"));
  let code;
  const origin = "http://localhost";
  const service = createHostedServer({ storePath: join(dir, "store.json"), origin, secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [] });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const req = async (path, body, cookie) => {
    const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const c = await req("/auth/request", { email: "reg-129@example.invalid", turnstileToken: "x" });
  const owner = (await req("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  const enrollToken = (await req("/v1/enrollment-tokens", { caps: { day: 10, month: 50 } }, owner)).body.token;
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "receipts.jsonl"), providerPath = join(dir, "provider.jsonl");
  const { agentId } = await enroll({ url: base, token: enrollToken, name: "reg", path });
  await req("/v1/teams", { name: "core", agents: [agentId], day: 10 }, owner);

  const ts = new Date().toISOString();
  appendFileSync(receiptsPath, JSON.stringify({ id: "unk-1", ts, cost_usd: null, reason: "usage_unavailable" }) + "\n");
  const client = createFleetClient({ path, receiptsPath });
  assert.equal((await client.sync()).online, true);
  assert.equal((await req(`/v1/agents/${agentId}/budget`, undefined, owner)).body.verdict, "accounting_unavailable");
  assert.equal(client.agentCheck().verdict, "accounting_unavailable");

  writeFileSync(providerPath, JSON.stringify({ id: "unk-1", cost_usd: 0.4 }) + "\n");
  assert.equal(applyReconciliation({ receiptsPath, providerPath }).ok, true);
  assert.equal((await client.sync()).online, true);
  assert.notEqual((await req(`/v1/agents/${agentId}/budget`, undefined, owner)).body.verdict, "accounting_unavailable");
  assert.notEqual((await req("/v1/teams", undefined, owner)).body.teams[0].verdict, "accounting_unavailable");
  assert.equal(client.agentCheck(), null);
  assert.equal(client.teamCheck(), null);
  const ev = (await req("/v1/evidence.json", undefined, owner)).body;
  assert.equal(ev.totals.cost_complete, true);
  assert.equal(ev.receipts[0].settled_cost_usd, 0.4);
  assert.equal(ev.audit.filter((e) => e.action === "receipt.settle" && e.actor === agentId).length, 1);
  // A second sync sends nothing new and stays consistent.
  assert.equal((await client.sync()).online, true);
  assert.equal((await req("/v1/evidence.json", undefined, owner)).body.audit.filter((e) => e.action === "receipt.settle").length, 1);
});
