import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidence, EVIDENCE_SCHEMA } from "../src/hosted/evidence.js";
import { createHostedServer, spendSummary } from "../src/hosted/server.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const spendFor = (rs) => spendSummary(rs, NOW);

test("evidence keeps unknown cost null and marks spend incomplete", () => {
  const doc = buildEvidence({ orgId: "o1", nowMs: NOW, spendFor,
    agents: [{ id: "a1", name: "w", policy: { caps: { day: 1 }, killed: true }, revoked: false }, { id: "a2" }],
    receipts: [
      { agentId: "a1", receipt: { id: "r1", ts: "2026-11-15T01:00:00.000Z", cost_usd: 0.25, model: "m" } },
      { agentId: "a1", receipt: { id: "r2", ts: "2026-11-15T02:00:00.000Z", cost_usd: null } },
      { agentId: "a1" },
    ],
    alerts: [{ kind: "cap_hit", key: "cap_hit:a1:day", agentId: "a1", scope: "day" }, {}] });
  assert.equal(doc.schema, EVIDENCE_SCHEMA);
  assert.equal(doc.generated_at, "2026-11-15T12:00:00.000Z");
  const [a1, a2] = doc.agents;
  assert.deepEqual(a1.caps, { day: 1 });
  assert.equal(a1.killed, true);
  assert.deepEqual(a1.spend.day, { usd_known: 0.25, unknown_count: 1, cost_complete: false });
  assert.deepEqual(a2, { agent_id: "a2", name: null, revoked: false, killed: false, caps: {}, spend: { day: { usd_known: 0, unknown_count: 0, cost_complete: true }, month: { usd_known: 0, unknown_count: 0, cost_complete: true } } });
  assert.equal(doc.receipts[1].cost_usd, null);
  assert.deepEqual(doc.receipts[2], { agent_id: "a1", receipt_id: null, ts: null, model: null, cost_usd: null });
  assert.deepEqual(doc.alerts[1], { kind: null, key: null, agent_id: null, scope: null });
  assert.deepEqual(doc.totals, { agents: 2, receipts: 3, unknown_cost_receipts: 2, cost_complete: false });
});

test("evidence with no unknowns is complete and defaults are empty", () => {
  const doc = buildEvidence({ orgId: "o", nowMs: NOW, spendFor });
  assert.deepEqual(doc.totals, { agents: 0, receipts: 0, unknown_cost_receipts: 0, cost_complete: true });
});

test("evidence rejects missing inputs", () => {
  assert.throws(() => buildEvidence({ nowMs: NOW, spendFor }), /orgId/);
  assert.throws(() => buildEvidence({ orgId: "o", spendFor }), /nowMs/);
  assert.throws(() => buildEvidence({ orgId: "o", nowMs: NOW }), /spendFor/);
});

test("sample fixture matches the v1 shape", () => {
  const doc = JSON.parse(readFileSync(new URL("../docs/fixtures/srm-evidence.sample.json", import.meta.url), "utf8"));
  assert.equal(doc.schema, EVIDENCE_SCHEMA);
  for (const k of ["generated_at", "org_id", "agents", "alerts", "receipts", "totals"]) assert.ok(k in doc, k);
  assert.ok(doc.receipts.some((r) => r.cost_usd === null));
  assert.equal(doc.totals.cost_complete, false);
});

test("regression: GET /v1/evidence.json is session-only, org-scoped and keeps null cost", async (t) => {
  let code;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-evidence-")), "store.json");
  const svc = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, stripeEnv: {},
    verifyChallenge: async (v) => v === "ok", sendCode: async (d) => { code = d.code; }, deliverAlert: async () => [{ status: "accepted" }] });
  await new Promise((r) => svc.server.listen(0, "127.0.0.1", r));
  t.after(() => { svc.server.closeAllConnections(); svc.server.close(); });
  const req = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${svc.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => {
    const c = await req("/auth/request", { email, turnstileToken: "ok" });
    return req("/auth/verify", { challengeId: c.body.challengeId, code });
  };
  assert.equal((await req("/v1/evidence.json")).status, 401);
  const owner = await login("owner@example.invalid");
  const other = await login("other@example.invalid");
  const tok = await req("/v1/enrollment-tokens", { caps: { day: 0.5 } }, owner.cookie);
  const agent = (await req("/v1/enroll", { name: "w" }, null, tok.body.token)).body;
  assert.equal((await req("/v1/evidence.json", undefined, null, agent.token)).status, 401);
  const ts = new Date().toISOString();
  await req("/v1/receipts", { receipts: [{ id: "r-1", ts, cost_usd: 0.6, model: "m" }, { id: "r-2", ts, cost_usd: null, model: "m" }] }, null, agent.token);
  await svc.evaluateFleetAlerts();
  const doc = (await req("/v1/evidence.json", undefined, owner.cookie)).body;
  assert.equal(doc.schema, EVIDENCE_SCHEMA);
  assert.equal(doc.agents.length, 1);
  assert.equal(doc.agents[0].spend.day.unknown_count, 1);
  assert.equal(doc.agents[0].spend.day.cost_complete, false);
  assert.ok(doc.receipts.some((r) => r.cost_usd === null));
  assert.ok(doc.alerts.some((a) => a.kind === "cap_hit"));
  assert.equal(JSON.stringify(doc).includes("hash"), false);
  const outsider = (await req("/v1/evidence.json", undefined, other.cookie)).body;
  assert.equal(outsider.agents.length, 0);
  assert.equal(outsider.receipts.length, 0);
});
