// Issue #203: org API keys (scoped bearer credentials for hosted spend, export, alerts, freeze).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { hashToken } from "../src/hosted/policy.js";
import { createApiKey, findApiKey, isApiKey, maskApiKey, parseApiKeyInput, publicApiKey, apiKeyPrincipal } from "../src/hosted/api-keys.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");

test("api-keys module: shape, hashing, masking, input validation, expiry and revoke lookup", () => {
  const { raw, record } = createApiKey({ orgId: "o1", createdBy: "u1", name: "ci", role: "viewer", nowMs: NOW, hash: hashToken });
  assert.match(raw, /^cck_[A-Za-z0-9_-]{43}$/);
  assert.ok(isApiKey(raw));
  assert.equal(isApiKey("agent-token"), false);
  assert.equal(record.hash, hashToken(raw));
  assert.ok(!JSON.stringify(record).includes(raw));
  assert.equal(maskApiKey(record.last4), `cck_…${raw.slice(-4)}`);
  const pub = publicApiKey(record, NOW);
  assert.equal(pub.key, `cck_…${raw.slice(-4)}`);
  assert.equal(pub.status, "active");
  assert.ok(!("hash" in pub));
  const s = { apiKeys: { [record.id]: record } };
  assert.equal(findApiKey(s, raw, NOW, hashToken).id, record.id);
  assert.equal(findApiKey(s, raw + "x", NOW, hashToken), null);
  assert.equal(findApiKey(s, "cck_short", NOW, hashToken), null);
  assert.equal(findApiKey({ apiKeys: { [record.id]: { ...record, revoked_at: "x" } } }, raw, NOW, hashToken), null);
  const exp = { ...record, expires_at: new Date(NOW).toISOString() };
  assert.equal(findApiKey({ apiKeys: { [record.id]: exp } }, raw, NOW, hashToken), null);
  assert.equal(publicApiKey(exp, NOW).status, "expired");
  assert.deepEqual(apiKeyPrincipal(record), { id: `apikey:${record.id}`, orgId: "o1", role: "viewer", email: "api-key:ci", verified: true, apiKey: { id: record.id, name: "ci" } });
  assert.deepEqual(parseApiKeyInput({ name: " ci ", role: "admin", expires_at: "2026-12-01T00:00:00Z" }, NOW), { name: "ci", role: "admin", expiresAt: "2026-12-01T00:00:00.000Z" });
  for (const bad of [{}, { name: "x", role: "owner" }, { name: "", role: "viewer" }, { name: "x".repeat(101), role: "viewer" }, { name: "x", role: "viewer", expires_at: "2026-01-01T00:00:00Z" }, { name: "x", role: "viewer", expires_at: 5 }]) {
    assert.throws(() => parseApiKeyInput(bad, NOW), (e) => e.status === 400, JSON.stringify(bad));
  }
});

async function serve(t) {
  let code;
  let clock = NOW;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-keys-")), "store.json");
  const service = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, stripeEnv: {}, now: () => clock,
    verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {} });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  // `origin: false` omits the Origin header, as a script would.
  const request = async (path, body, { cookie, auth, origin = true } = {}) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { ...(origin ? { origin: "http://localhost" } : {}), "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text(), cookie: r.headers.get("set-cookie")?.split(";")[0], get body() { return JSON.parse(this.text); } };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    return (await request("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  };
  const agent = async (cookie, name) => {
    const tok = await request("/v1/enrollment-tokens", {}, { cookie });
    return (await request("/v1/enroll", { name }, { auth: tok.body.token })).body;
  };
  return { request, login, agent, storePath, setNow: (v) => { clock = v; } };
}

test("API keys: create once, hash only, role matrix, freeze with no Origin, audit actor, isolation, revoke and expiry", async (t) => {
  const f = await serve(t);
  const owner = await f.login("keys-owner@example.invalid");
  const outsider = await f.login("keys-outsider@example.invalid");
  const a1 = await f.agent(owner, "worker");
  await f.agent(outsider, "theirs");
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts: "2026-11-16T10:00:00Z", cost_usd: 1.5, model: "gpt-4.1" }] }, { auth: a1.token });
  assert.equal((await f.request("/v1/invitations", { email: "keys-viewer@example.invalid", role: "viewer" }, { cookie: owner })).status, 201);
  const viewerSession = await f.login("keys-viewer@example.invalid");

  // AC1/AC5: create needs an owner/admin session; viewers cannot create.
  assert.equal((await f.request("/v1/api-keys", { name: "x", role: "viewer" })).status, 401);
  assert.equal((await f.request("/v1/api-keys", { name: "x", role: "viewer" }, { cookie: viewerSession })).status, 403);
  assert.equal((await f.request("/v1/api-keys", undefined, { cookie: viewerSession })).status, 403);
  assert.equal((await f.request("/v1/api-keys", { name: "x", role: "owner" }, { cookie: owner })).status, 400);
  const v = await f.request("/v1/api-keys", { name: "bi", role: "viewer" }, { cookie: owner });
  const ad = await f.request("/v1/api-keys", { name: "pagerduty", role: "admin" }, { cookie: owner });
  assert.equal(v.status, 201, v.text);
  const viewerKey = v.body.secret, adminKey = ad.body.secret;
  assert.match(viewerKey, /^cck_/);
  assert.equal(v.body.key, `cck_…${viewerKey.slice(-4)}`);
  const listed = await f.request("/v1/api-keys", undefined, { cookie: owner });
  assert.deepEqual(listed.body.keys.map((k) => k.name).sort(), ["bi", "pagerduty"]);
  const stored = readFileSync(f.storePath, "utf8");
  for (const secret of [viewerKey, adminKey]) {
    assert.ok(!listed.text.includes(secret));
    assert.ok(!stored.includes(secret), "store holds only a hash");
    assert.ok(stored.includes(hashToken(secret)));
  }

  // AC2: viewer key reads; mutations are 403.
  for (const p of ["/v1/spend", "/v1/receipts.csv", "/v1/evidence.json", "/v1/alerts", "/v1/audit.csv"]) {
    const r = await f.request(p, undefined, { auth: viewerKey, origin: false });
    assert.equal(r.status, 200, `${p} ${r.text}`);
    assert.ok(!r.text.includes(viewerKey) && !r.text.includes(adminKey), p);
  }
  assert.equal((await f.request("/v1/spend", undefined, { auth: viewerKey })).body.total.usd_known, 1.5);
  assert.equal((await f.request("/v1/fleet/freeze", { reason: "x" }, { auth: viewerKey, origin: false })).status, 403);
  assert.equal((await f.request(`/v1/agents/${a1.agentId}/policy`, { caps: { day: 1 } }, { auth: viewerKey, origin: false })).status, 403);
  assert.equal((await f.request("/v1/receipts/r1/settle", { cost_usd: 1, source: "manual_evidence", reason: "x" }, { auth: viewerKey, origin: false })).status, 403);
  assert.equal((await f.request("/v1/alerts/nope/ack", {}, { auth: viewerKey, origin: false })).status, 403);
  assert.equal((await f.request("/v1/alerts/nope/ack", {}, { auth: adminKey, origin: false })).status, 404);

  // AC3: admin key freezes with no Origin header; the audit names the key.
  const frozen = await f.request("/v1/fleet/freeze", { reason: "webhook: cap_hit" }, { auth: adminKey, origin: false });
  assert.equal(frozen.status, 200, frozen.text);
  assert.deepEqual(frozen.body.agentIds, [a1.agentId]);
  const evidence = (await f.request("/v1/evidence.json", undefined, { cookie: owner })).text;
  assert.ok(!evidence.includes(viewerKey) && !evidence.includes(adminKey));
  const auditCsv = (await f.request("/v1/audit.csv", undefined, { cookie: owner })).text;
  const freezeLine = auditCsv.split("\n").find((l) => l.includes("fleet.freeze"));
  assert.ok(freezeLine.includes(`apikey:${ad.body.id}`) && freezeLine.includes("api-key:pagerduty"), freezeLine);
  assert.ok(auditCsv.split("\n").some((l) => l.includes("api_key.create") && l.includes("api-key:bi")));
  assert.ok(!auditCsv.includes(viewerKey) && !auditCsv.includes(adminKey));
  assert.equal((await f.request("/v1/fleet/resume", { reason: "ok" }, { auth: adminKey, origin: false })).status, 200);
  assert.equal((await f.request(`/v1/agents/${a1.agentId}/policy`, { caps: { day: 5 } }, { auth: adminKey, origin: false })).status, 200);

  // last_used_at is recorded.
  const used = (await f.request("/v1/api-keys", undefined, { cookie: owner })).body.keys.find((k) => k.name === "bi");
  assert.equal(used.last_used_at, new Date(NOW).toISOString());

  // AC4: unknown key, other org, agent token on human routes, cck_ key as agent token.
  assert.equal((await f.request("/v1/spend", undefined, { auth: "cck_" + "A".repeat(43) })).status, 401);
  assert.equal((await f.request("/v1/spend", undefined, { auth: a1.token })).status, 401);
  assert.equal((await f.request("/v1/policy", undefined, { auth: viewerKey })).status, 401);
  assert.equal((await f.request("/v1/receipts", { receipts: [] }, { auth: adminKey, origin: false })).status, 401);
  const theirKey = (await f.request("/v1/api-keys", { name: "theirs", role: "admin" }, { cookie: outsider })).body;
  assert.equal((await f.request(`/v1/agents/${a1.agentId}/policy`, { caps: { day: 1 } }, { auth: theirKey.secret, origin: false })).status, 404);
  assert.equal((await f.request("/v1/spend", undefined, { auth: theirKey.secret })).body.total.usd_known, 0);
  assert.equal((await f.request(`/v1/api-keys/${theirKey.id}/revoke`, {}, { cookie: owner })).status, 404);
  assert.equal((await f.request("/v1/api-keys", undefined, { cookie: owner })).body.keys.length, 2);

  // AC5: a key cannot create, list or revoke keys, nor reach billing or members.
  assert.equal((await f.request("/v1/api-keys", { name: "y", role: "admin" }, { auth: adminKey, origin: false })).status, 401);
  assert.equal((await f.request("/v1/api-keys", undefined, { auth: adminKey })).status, 401);
  assert.equal((await f.request(`/v1/api-keys/${v.body.id}/revoke`, {}, { auth: adminKey, origin: false })).status, 401);
  assert.equal((await f.request("/v1/fleet", undefined, { auth: adminKey })).status, 401);
  assert.equal((await f.request("/v1/invitations", { email: "z@example.invalid", role: "admin" }, { auth: adminKey, origin: false })).status, 401);

  // Revoke and expiry.
  const revoked = await f.request(`/v1/api-keys/${v.body.id}/revoke`, {}, { cookie: owner });
  assert.equal(revoked.body.key.status, "revoked");
  assert.equal((await f.request("/v1/spend", undefined, { auth: viewerKey })).status, 401);
  const audit2 = (await f.request("/v1/audit.csv", undefined, { cookie: owner })).text;
  assert.ok(audit2.includes("api_key.revoke"));
  const short = await f.request("/v1/api-keys", { name: "temp", role: "viewer", expires_at: "2026-11-17T00:00:00Z" }, { cookie: owner });
  assert.equal((await f.request("/v1/spend", undefined, { auth: short.body.secret })).status, 200);
  f.setNow(Date.parse("2026-11-17T00:00:01Z"));
  assert.equal((await f.request("/v1/spend", undefined, { auth: short.body.secret })).status, 401);
  assert.equal((await f.request("/v1/api-keys", undefined, { cookie: owner })).body.keys.find((k) => k.name === "temp").status, "expired");
});
