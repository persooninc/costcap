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
  return { raw, login, storePath, tick: (ms) => { clock += ms; }, evaluate: () => service.evaluateFleetAlerts() };
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
  for (const p of ["/v1/spend", "/v1/metrics", "/v1/receipts.csv", "/v1/evidence.json", "/v1/alerts", "/v1/audit.csv", "/v1/fleet", `/v1/agents/${agent.agentId}/budget`, `/v1/agents/${agent.agentId}/runs`]) {
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

// Issue #220: GET /v1/metrics (Prometheus) auth, isolation, parity with /v1/spend, alerts and freeze.
test("#220 /v1/metrics: viewer key scrape, 401s, org isolation, /v1/spend parity, alerts, freeze", async (t) => {
  const { parseProm, value, find } = await import("./support/prom.js");
  const f = await fixture(t);
  const owner = await f.login("m-owner@example.invalid");
  const other = await f.login("m-other@example.invalid");
  const enroll = async (cookie, name, caps) => {
    const tok = (await f.raw("/v1/enrollment-tokens", { body: { caps }, cookie })).body.token;
    return (await f.raw("/v1/enroll", { body: { name }, bearer: tok })).body;
  };
  const a = await enroll(owner.cookie, "a", { day: 5 });
  const b = await enroll(owner.cookie, "b", {});
  const ts = new Date(T0 - 3600_000).toISOString();
  assert.equal((await f.raw("/v1/receipts", { body: { receipts: [{ id: "a1", ts, cost_usd: 1, model: "m1" }, { id: "a2", ts, cost_usd: 0.25, model: "m2" }] }, bearer: a.token })).status, 200);
  assert.equal((await f.raw("/v1/receipts", { body: { receipts: [{ id: "b1", ts, cost_usd: 0.5, model: "m1" }, { id: "b2", ts, cost_usd: null, model: "m1" }] }, bearer: b.token })).status, 200);
  assert.equal((await f.raw("/v1/teams", { body: { name: "t", agents: [a.agentId, b.agentId], day: 100 }, cookie: owner.cookie })).status, 200);
  const viewerKey = (await f.raw("/v1/api-keys", { body: { name: "prom", role: "viewer" }, cookie: owner.cookie })).body.key;

  // AC1
  const scrape = async (bearer, q = "") => f.raw(`/v1/metrics${q}`, { bearer });
  const r = await scrape(viewerKey);
  assert.equal(r.status, 200);
  const rows = parseProm(r.text);
  assert.equal(value(rows, "costcap_spend_usd", { agent: "a", team: "t", window: "day" }), 1.25);
  assert.equal(value(rows, "costcap_cap_remaining_usd", { scope: "agent", name: "a", window: "day" }), 3.75);
  assert.equal(value(rows, "costcap_spend_complete", { agent: "b", window: "day" }), 0);
  assert.equal(value(rows, "costcap_unknown_cost_receipts", { agent: "b" }), 1);
  assert.equal((await f.raw("/v1/metrics", { cookie: owner.cookie })).status, 200, "member session works");
  assert.equal((await scrape(viewerKey, "?by=team")).status, 400);

  // AC3: parity with /v1/spend (month, by agent) to the cent.
  const spend = (await f.raw("/v1/spend?group_by=agent&range=current_month", { bearer: viewerKey })).body;
  for (const bucket of spend.buckets) {
    assert.equal(value(rows, "costcap_spend_usd", { agent: bucket.label, window: "month" }).toFixed(2), bucket.usd_known.toFixed(2));
  }
  // by=model sums to the agent total.
  const byModel = parseProm((await scrape(viewerKey, "?by=model")).text);
  assert.equal(find(byModel, "costcap_spend_usd", { agent: "a", window: "day" }).reduce((s, x) => s + x.value, 0), 1.25);

  // AC2: isolation. The other org's key sees none of org A's series.
  const otherKey = (await f.raw("/v1/api-keys", { body: { name: "o" }, cookie: other.cookie })).body.key;
  const otherRows = parseProm((await scrape(otherKey)).text);
  assert.equal(find(otherRows, "costcap_spend_usd").length, 0);
  assert.ok(!(await scrape(otherKey)).text.includes('agent="a"'));

  // AC4: an open cap_hit alert shows 1, then 0 after ack; freeze -> frozen 1 for every agent.
  assert.equal((await f.raw("/v1/receipts", { body: { receipts: [{ id: "a3", ts, cost_usd: 4, model: "m1" }] }, bearer: a.token })).status, 200);
  await f.evaluate();
  let open = parseProm((await scrape(viewerKey)).text);
  assert.equal(value(open, "costcap_alerts_open", { kind: "cap_hit", scope: "agent", scope_name: "a" }), 1);
  const alert = (await f.raw("/v1/alerts?status=active", { cookie: owner.cookie })).body.alerts.find((x) => x.kind === "cap_hit");
  assert.equal((await f.raw(`/v1/alerts/${alert.id}/ack`, { body: {}, cookie: owner.cookie })).status, 200);
  open = parseProm((await scrape(viewerKey)).text);
  assert.equal(value(open, "costcap_alerts_open", { kind: "cap_hit", scope: "agent", scope_name: "a" }), 0);
  assert.equal((await f.raw("/v1/fleet/freeze", { body: { reason: "drill" }, cookie: owner.cookie })).status, 200);
  assert.deepEqual(find(parseProm((await scrape(viewerKey)).text), "costcap_agent_frozen").map((x) => x.value), [1, 1]);

  // AC2: no auth, unknown, revoked and expired keys get 401.
  assert.equal((await f.raw("/v1/metrics", { withOrigin: false })).status, 401);
  assert.equal((await scrape("cck_unknown")).status, 401);
  assert.equal((await scrape(a.token)).status, 401, "agent token is not a scrape credential");
  const id = (await f.raw("/v1/api-keys", { cookie: owner.cookie })).body.keys.find((k) => k.name === "prom").id;
  assert.equal((await f.raw(`/v1/api-keys/${id}/revoke`, { body: {}, cookie: owner.cookie })).status, 200);
  assert.equal((await scrape(viewerKey)).status, 401);
  const short = (await f.raw("/v1/api-keys", { body: { name: "short", expires_at: new Date(T0 + 60_000).toISOString() }, cookie: owner.cookie })).body.key;
  assert.equal((await scrape(short)).status, 200);
  f.tick(61_000);
  assert.equal((await scrape(short)).status, 401);
});

test("#220 /v1/metrics on the Postgres store: org-scoped series", async (t) => {
  const { openPostgresStore } = await import("../src/hosted/store-postgres.js");
  const { parseProm, find } = await import("./support/prom.js");
  const pool = { async connect() { return { async query(sql) { return { rows: [] }; }, release() {} }; } };
  const store = await openPostgresStore({ pool, log: () => {} });
  const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b1";
  const keys = {};
  store.transaction((s) => {
    for (const org of [A, B]) {
      s.orgs[org] = { id: org, name: org };
      s.agents[`ag-${org}`] = { id: `ag-${org}`, orgId: org, name: `agent-${org.slice(-2)}`, policy: { caps: {}, version: 1, killed: false }, lastSeen: T0, revoked: false };
      s.receipts[`ag-${org}:r`] = { orgId: org, agentId: `ag-${org}`, receipt: { id: "r", ts: new Date(T0 - 60_000).toISOString(), cost_usd: org === A ? 2 : 3, model: "m" } };
      keys[org] = createApiKey(s, { orgId: org, createdBy: "u", name: "prom", role: "viewer", expiresAt: null }, T0).raw;
    }
  });
  await store.flush();
  const service = createHostedServer({ store, origin: "http://localhost", secureCookies: false, now: () => T0, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async () => {} });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const get = (key) => fetch(`http://127.0.0.1:${service.server.address().port}/v1/metrics`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  const ra = await get(keys[A]);
  assert.equal(ra.status, 200);
  assert.match(ra.headers.get("content-type"), /^text\/plain; version=0\.0\.4/);
  const rows = find(parseProm(await ra.text()), "costcap_spend_usd");
  assert.deepEqual(rows.map((r) => [r.labels.agent, r.value]), [["agent-a1", 2], ["agent-a1", 2]]);
  const rb = find(parseProm(await (await get(keys[B])).text()), "costcap_spend_usd");
  assert.deepEqual([...new Set(rb.map((r) => r.labels.agent))], ["agent-b1"]);
  assert.equal((await get(null)).status, 401);
});
