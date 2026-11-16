// Issue #203: org API keys (cck_) for hosted spend, export, alerts and fleet freeze.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { bearerApiKey, parseApiKeyInput, createApiKey, maskApiKey, findApiKey, apiKeyPrincipal } from "../src/hosted/api-keys.js";
import { labelAudit } from "../src/hosted/audit-log.js";

const T0 = Date.parse("2026-11-16T12:00:00Z");

async function fixture(t) {
  let code, clock = T0;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-keys-")), "store.json");
  const origin = "http://localhost";
  const service = createHostedServer({ storePath, origin, secureCookies: false, now: () => clock, stripeEnv: {}, verifyChallenge: async (v) => v === "test-pass", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [{ status: "accepted" }] });
  service.server.keepAliveTimeout = 60_000;
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  // withOrigin=false models a script: no Origin header at all.
  const raw = async (path, { body, cookie, bearer, withOrigin = !bearer } = {}) => {
    const headers = { "content-type": "application/json", ...(withOrigin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: r.status, text, body: json, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => {
    const c = await raw("/auth/request", { body: { email, turnstileToken: "test-pass" } });
    const v = await raw("/auth/verify", { body: { challengeId: c.body.challengeId, code } });
    assert.equal(v.status, 200);
    return v;
  };
  return { raw, login, storePath, tick: (ms) => { clock += ms; } };
}

test("unit: bearer parsing, input validation, hashing, masking, expiry and principal", () => {
  assert.equal(bearerApiKey({ headers: { authorization: "Bearer cck_abc" } }), "cck_abc");
  assert.equal(bearerApiKey({ headers: { authorization: "Bearer agenttoken" } }), null);
  assert.equal(bearerApiKey({ headers: {} }), null);
  assert.deepEqual(parseApiKeyInput({ name: " ci " }, T0), { name: "ci", role: "viewer", expiresAt: null });
  assert.equal(parseApiKeyInput({ name: "x", role: "admin", expires_at: "2027-01-01T00:00:00Z" }, T0).expiresAt, "2027-01-01T00:00:00.000Z");
  for (const bad of [{}, { name: "" }, { name: "x".repeat(101) }, { name: "x", role: "owner" }, { name: "x", expires_at: "nope" }, { name: "x", expires_at: 5 }, { name: "x", expires_at: "2020-01-01T00:00:00Z" }]) {
    assert.throws(() => parseApiKeyInput(bad, T0), (e) => e.status === 400);
  }
  const s = {};
  const { record, raw } = createApiKey(s, { orgId: "o1", createdBy: "u1", name: "ci", role: "viewer", expiresAt: new Date(T0 + 1000).toISOString() }, T0);
  assert.match(raw, /^cck_/);
  assert.ok(!JSON.stringify(s).includes(raw), "store holds only a hash");
  const masked = maskApiKey(record, T0);
  assert.equal(masked.masked, `cck_…${raw.slice(-4)}`);
  assert.equal(masked.hash, undefined);
  assert.equal(masked.status, "active");
  assert.equal(maskApiKey(record, T0 + 1000).status, "expired");
  assert.equal(findApiKey(s, raw, T0).id, record.id);
  assert.throws(() => findApiKey(s, raw, T0 + 1000), (e) => e.status === 401);
  assert.throws(() => findApiKey(s, "cck_unknown", T0), (e) => e.status === 401);
  record.revokedAt = new Date(T0).toISOString();
  assert.equal(maskApiKey(record, T0).status, "revoked");
  assert.throws(() => findApiKey(s, raw, T0), (e) => e.status === 401);
  assert.throws(() => findApiKey({}, raw, T0), (e) => e.status === 401);
  const p = apiKeyPrincipal(record);
  assert.deepEqual([p.id, p.orgId, p.role, p.email], [record.id, "o1", "viewer", "api_key:ci"]);
  // Audit labels resolve key ids inside the org only.
  const state = { apiKeys: s.apiKeys, users: {}, agents: {}, orgs: { o1: { name: "o" } } };
  const [row] = labelAudit(state, "o1", [{ org_id: "o1", actor: record.id, target: record.id }]);
  assert.equal(row.actor_label, "api_key:ci");
  assert.equal(row.target_label, "api_key:ci");
  assert.equal(labelAudit(state, "o2", [{ org_id: "o2", actor: record.id }])[0].actor_label, "unknown");
});

test("AC1-AC6: create once, role matrix, freeze without Origin, revoke/expiry/isolation, session-only management", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("owner@example.invalid");
  const other = await f.login("other@example.invalid");
  assert.equal((await f.raw("/v1/invitations", { body: { email: "viewer@example.invalid", role: "viewer" }, cookie: owner.cookie })).status, 201);
  const viewer = await f.login("viewer@example.invalid");
  const enrollment = await f.raw("/v1/enrollment-tokens", { body: { caps: { day: 5 } }, cookie: owner.cookie });
  const agent = (await f.raw("/v1/enroll", { body: { name: "worker" }, bearer: enrollment.body.token })).body;
  assert.equal((await f.raw("/v1/receipts", { body: { receipts: [{ id: "r-1", ts: new Date(T0).toISOString(), cost_usd: null, model: "m" }] }, bearer: agent.token })).status, 200);

  // AC5: viewers can't create; no session -> 401; Origin still enforced for browser mutation.
  assert.equal((await f.raw("/v1/api-keys", { body: { name: "v" }, cookie: viewer.cookie })).status, 403);
  assert.equal((await f.raw("/v1/api-keys", { body: { name: "v" } })).status, 401);
  assert.equal((await f.raw("/v1/api-keys", { body: { name: "bad", role: "owner" }, cookie: owner.cookie })).status, 400);

  // AC1: full value only in the create response.
  const vk = await f.raw("/v1/api-keys", { body: { name: "grafana", role: "viewer" }, cookie: owner.cookie });
  assert.equal(vk.status, 201);
  const viewerKey = vk.body.key;
  assert.match(viewerKey, /^cck_/);
  const ak = (await f.raw("/v1/api-keys", { body: { name: "pagerduty", role: "admin" }, cookie: owner.cookie })).body;
  const adminKey = ak.key;
  const list = await f.raw("/v1/api-keys", { cookie: owner.cookie });
  assert.equal(list.body.keys.length, 2);
  assert.ok(!list.text.includes(viewerKey) && !list.text.includes(adminKey));
  assert.equal(list.body.keys[0].key, undefined);
  assert.equal((await f.raw("/v1/api-keys", { cookie: other.cookie })).body.keys.length, 0);
  assert.equal((await f.raw("/v1/api-keys", { cookie: viewer.cookie })).status, 403);
  const store = readFileSync(f.storePath, "utf8");
  assert.ok(!store.includes(viewerKey) && !store.includes(adminKey), "store holds only hashes");

  // AC2: viewer key reads, never writes.
  for (const p of ["/v1/spend", "/v1/receipts.csv", "/v1/evidence.json", "/v1/alerts", "/v1/audit.csv", "/v1/fleet", `/v1/agents/${agent.agentId}/budget`, `/v1/agents/${agent.agentId}/runs`]) {
    const r = await f.raw(p, { bearer: viewerKey });
    assert.equal(r.status, 200, p);
    assert.ok(!r.text.includes(viewerKey) && !r.text.includes(adminKey), `${p} leaks a key`);
  }
  assert.equal((await f.raw("/v1/fleet/freeze", { body: { reason: "x" }, bearer: viewerKey })).status, 403);
  assert.equal((await f.raw(`/v1/agents/${agent.agentId}/policy`, { body: { caps: { day: 9 } }, bearer: viewerKey })).status, 403);
  assert.equal((await f.raw(`/v1/agents/${agent.agentId}/revoke`, { body: {}, bearer: viewerKey })).status, 403);
  assert.equal((await f.raw("/v1/receipts/r-1/settle", { body: { cost_usd: 1, source: "manual_evidence", reason: "x" }, bearer: viewerKey })).status, 403);
  assert.equal((await f.raw("/v1/alerts/none/ack", { body: {}, bearer: viewerKey })).status, 403);

  // AC5: a key can't manage keys, billing or enrollment.
  for (const [p, body] of [["/v1/api-keys", { name: "k" }], ["/v1/api-keys", undefined], [`/v1/api-keys/${ak.id}/revoke`, {}], ["/v1/enrollment-tokens", { caps: {} }]]) {
    assert.equal((await f.raw(p, { body, bearer: adminKey })).status, 403, p);
  }
  assert.equal((await f.raw("/v1/invitations", { body: { email: "x@example.invalid", role: "viewer" }, bearer: adminKey })).status, 401);

  // AC3: admin key freezes with no Origin; audit names the key.
  const frozen = await f.raw("/v1/fleet/freeze", { body: { reason: "webhook: daily cap" }, bearer: adminKey });
  assert.equal(frozen.status, 200);
  assert.equal(frozen.body.frozen, true);
  const auditCsv = (await f.raw("/v1/audit.csv", { cookie: owner.cookie })).text;
  const freezeRow = auditCsv.split("\n").find((l) => l.includes("fleet.freeze"));
  assert.ok(freezeRow.includes(ak.id) && freezeRow.includes("api_key:pagerduty"), freezeRow);
  assert.ok(auditCsv.includes("api_key.create"));
  assert.ok(!auditCsv.includes(adminKey));
  assert.equal((await f.raw("/v1/fleet/resume", { body: { reason: "ok" }, bearer: adminKey })).status, 200);
  assert.equal((await f.raw(`/v1/agents/${agent.agentId}/policy`, { body: { caps: { day: 9 } }, bearer: adminKey })).status, 200);
  assert.equal((await f.raw("/v1/receipts/r-1/settle", { body: { cost_usd: 0.5, source: "provider_invoice", reason: "inv" }, bearer: adminKey })).status, 200);
  const keys = (await f.raw("/v1/api-keys", { cookie: owner.cookie })).body.keys;
  assert.ok(keys.find((k) => k.id === ak.id).last_used_at);

  // AC4: other org sees nothing; agent token rejected on human routes; cck_ rejected as agent token.
  const ok = (await f.raw("/v1/api-keys", { body: { name: "other" }, cookie: other.cookie })).body.key;
  assert.equal((await f.raw(`/v1/agents/${agent.agentId}/budget`, { bearer: ok })).status, 404);
  assert.equal((await f.raw("/v1/fleet", { bearer: ok })).body.receipts.length, 0);
  assert.equal((await f.raw(`/v1/api-keys/${ak.id}/revoke`, { body: {}, cookie: other.cookie })).status, 404);
  assert.equal((await f.raw("/v1/spend", { bearer: agent.token })).status, 401);
  assert.equal((await f.raw("/v1/policy", { bearer: adminKey })).status, 401);
  assert.equal((await f.raw("/v1/receipts", { body: { receipts: [] }, bearer: adminKey })).status, 401);
  assert.equal((await f.raw("/v1/spend", { bearer: "cck_unknown" })).status, 401);

  // Revoke and expiry.
  const rv = await f.raw(`/v1/api-keys/${vk.body.id}/revoke`, { body: {}, cookie: owner.cookie });
  assert.equal(rv.body.status, "revoked");
  assert.equal((await f.raw(`/v1/api-keys/${vk.body.id}/revoke`, { body: {}, cookie: owner.cookie })).status, 200);
  assert.equal((await f.raw("/v1/spend", { bearer: viewerKey })).status, 401);
  const short = (await f.raw("/v1/api-keys", { body: { name: "short", expires_at: new Date(T0 + 60_000).toISOString() }, cookie: owner.cookie })).body.key;
  assert.equal((await f.raw("/v1/spend", { bearer: short })).status, 200);
  f.tick(61_000);
  assert.equal((await f.raw("/v1/spend", { bearer: short })).status, 401);

  // AC6: sessions keep working unchanged.
  assert.equal((await f.raw("/v1/spend", { cookie: viewer.cookie })).status, 200);
  assert.equal((await f.raw("/v1/fleet/freeze", { body: { reason: "s" }, cookie: owner.cookie })).status, 200);
});
