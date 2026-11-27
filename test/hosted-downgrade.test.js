// Issue #207: fleet `downgrade` policy: hosted validation (400), sync to an enrolled wrapper, offline cache.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import { mergeDowngrade } from "../src/downgrade.js";

test("hosted policy downgrade: 400 on invalid, saved, synced, cached offline", async (t) => {
  let code;
  const dir = mkdtempSync(join(tmpdir(), "cc-dg-hosted-"));
  const origin = "http://localhost";
  const service = createHostedServer({ storePath: join(dir, "store.json"), origin, secureCookies: false, stripeEnv: {},
    verifyChallenge: async (v) => v === "test-pass", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [{ status: "accepted" }] });
  service.server.keepAliveTimeout = 60_000;
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const ch = await request("/auth/request", { email: "dg-owner@example.invalid", turnstileToken: "test-pass" });
  const owner = await request("/auth/verify", { challengeId: ch.body.challengeId, code });
  const tok = await request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie);
  const agent = (await request("/v1/enroll", { name: "dg" }, null, tok.body.token)).body;
  const put = (downgrade) => request(`/v1/agents/${agent.agentId}/policy`, { downgrade }, owner.cookie);
  for (const bad of [{ at: 1.5, map: { a: "b" } }, { map: {} }, { map: { "gpt-4o": "gpt-4o" } }, "x"]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  const ok = await put({ at: 0.7, map: { "gpt-4o": "gpt-4o-mini" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.downgrade, { at: 0.7, map: { "gpt-4o": "gpt-4o-mini" } });
  // Omitted keeps it.
  assert.deepEqual((await request(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 2 } }, owner.cookie)).body.downgrade, { at: 0.7, map: { "gpt-4o": "gpt-4o-mini" } });
  assert.deepEqual((await request("/v1/policy", undefined, null, agent.token)).body.downgrade, { at: 0.7, map: { "gpt-4o": "gpt-4o-mini" } });

  // The wrapper's fleet client receives it through sync and keeps it offline.
  const enrollmentPath = join(dir, "enrollment.json"), receiptsPath = join(dir, "receipts.jsonl");
  const tok2 = await request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie);
  const origFetch = globalThis.fetch;
  // enroll() requires https; route the service URL to the local server for this test only.
  globalThis.fetch = (url, init) => origFetch(String(url).replace("https://dg.invalid", base), { ...init, headers: { ...(init?.headers ?? {}), origin } });
  t.after(() => { globalThis.fetch = origFetch; });
  await enroll({ url: "https://dg.invalid", token: tok2.body.token, name: "dg2", path: enrollmentPath });
  let synced;
  const client = createFleetClient({ path: enrollmentPath, receiptsPath, onPolicy: (p) => { synced = p; } });
  const agent2 = (await request("/v1/fleet", undefined, owner.cookie)).body.agents.find((a) => a.name === "dg2");
  await request(`/v1/agents/${agent2.id}/policy`, { downgrade: { map: { "gpt-4o": "gpt-4o-mini" } } }, owner.cookie);
  assert.equal((await client.sync()).online, true);
  assert.deepEqual(synced.downgrade, { map: { "gpt-4o": "gpt-4o-mini" } });
  globalThis.fetch = async () => { throw new Error("offline"); };
  const offline = createFleetClient({ path: enrollmentPath, receiptsPath });
  assert.deepEqual(offline.policy().downgrade, { map: { "gpt-4o": "gpt-4o-mini" } });
  // A local --downgrade-at can lower the fleet `at` but never raise it.
  assert.equal(mergeDowngrade(offline.policy().downgrade, { map: null, at: 0.9 }).at, 0.8);
  assert.equal(mergeDowngrade(offline.policy().downgrade, { map: null, at: 0.5 }).at, 0.5);
  // null clears it.
  globalThis.fetch = (url, init) => origFetch(String(url).replace("https://dg.invalid", base), init);
  assert.equal("downgrade" in (await put(null)).body, false);
});
