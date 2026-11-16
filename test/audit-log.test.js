// Issue #133: audit log shows who (actor_label/target_label), full CSV export.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { auditLabeler, labelAudit, auditCsv, parseAuditRange, AUDIT_CSV_COLUMNS } from "../src/hosted/audit-log.js";
import { buildEvidence } from "../src/hosted/evidence.js";

const state = {
  orgs: { o1: { id: "o1", name: "acme.test" }, o2: { id: "o2", name: "other.test" } },
  users: { u1: { id: "u1", email: "admin@acme.test", orgId: "o1", verified: true }, u2: { id: "u2", email: "spy@other.test", orgId: "o2", verified: true }, u3: { id: "u3", email: "pending@acme.test", orgId: "o1", verified: false } },
  agents: { a1: { id: "a1", name: "builder", orgId: "o1" }, a2: { id: "a2", name: "foreign", orgId: "o2" } },
  teams: { "o1:core": { name: "core", orgId: "o1" } },
  invitations: { i1: { id: "i1", email: "new@acme.test", orgId: "o1" } },
};

test("unit: labeler resolves users, agents, system, teams, invites, org and unknown within one org", () => {
  const l = auditLabeler(state, "o1");
  assert.deepEqual([l({ actor: "u1", target: "a1" }).actor_label, l({ actor: "u1", target: "a1" }).target_label], ["admin@acme.test", "builder"]);
  assert.equal(l({ actor: "a1", target: "a1" }).actor_label, "builder");
  assert.equal(l({ actor: "alert-worker", target: "a1" }).actor_label, "system:alert-worker");
  assert.equal(l({ actor: "u2", target: "a2" }).actor_label, "unknown", "other org's user never resolves");
  assert.equal(l({ actor: "u2", target: "a2" }).target_label, "a2", "other org's agent never resolves");
  assert.equal(l({ actor: "u3", target: null }).actor_label, "unknown", "unverified user is not labelled");
  assert.equal(l({ actor: "u1", target: null }).target_label, null);
  assert.equal(l({ actor: "u1", target: "core" }).target_label, "core");
  assert.equal(l({ actor: "u1", target: "i1" }).target_label, "new@acme.test");
  assert.equal(l({ actor: "u1", target: "o1" }).target_label, "acme.test");
  assert.equal(l({ actor: "u1", target: "u1" }).target_label, "admin@acme.test");
  assert.equal(auditLabeler({}, "o1")({ actor: "x", target: "o1" }).target_label, "o1");
  const rows = labelAudit(state, "o1", [{ org_id: "o1", actor: "u1", action: "x" }, { org_id: "o2", actor: "u2", action: "y" }, null]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, "u1", "raw actor kept");
});

test("unit: audit csv escapes formulas, sorts oldest first, filters by range", () => {
  const entries = [
    { ts: "2026-11-02T00:00:00.000Z", actor: "u1", actor_label: "=evil()", action: "policy.change", target: "a1", target_label: "@x", detail: { reason: "+raise", policy: { caps: { day: 5 } } } },
    { ts: "2026-11-01T00:00:00.000Z", actor: "u1", actor_label: "admin@acme.test", action: "fleet.freeze", target: null, target_label: null, detail: { reason: "-runaway" } },
    { ts: "2026-11-03T00:00:00.000Z", actor: "alert-worker", actor_label: "system:alert-worker", action: "alert.delivery", target: "a1", target_label: "builder" },
  ];
  const { body, count } = auditCsv(entries);
  assert.equal(count, 3);
  const lines = body.trim().split("\n");
  assert.equal(lines[0], AUDIT_CSV_COLUMNS.join(","));
  assert.match(lines[1], /^2026-11-01.*fleet\.freeze,,,'-runaway,/);
  assert.match(lines[2], /,'=evil\(\),policy\.change,a1,'@x,'\+raise,"\{""reason""/);
  assert.match(lines[3], /system:alert-worker,alert\.delivery,a1,builder,,\{\}$/);
  const r = auditCsv(entries, parseAuditRange(new URLSearchParams("since=2026-11-02T00:00:00Z&until=2026-11-02T12:00:00Z")));
  assert.equal(r.count, 1);
  assert.deepEqual(parseAuditRange(new URLSearchParams("")), {});
  for (const bad of ["since=nope", "until=", "since=2026-13-45"]) assert.throws(() => parseAuditRange(new URLSearchParams(bad)), (e) => e.status === 400);
});

test("unit: evidence audit carries actor_label and target_label", () => {
  const ev = buildEvidence({ orgId: "o1", nowMs: 0, spendFor: () => ({}), audit: [
    { ts: "t", org_id: "o1", actor: "u1", actor_label: "admin@acme.test", action: "a", target: "a1", target_label: "builder", detail: {} },
    { ts: "t", org_id: "o1", actor: "u9", action: "b", target: "x", detail: {} }] });
  assert.equal(ev.audit[0].actor_label, "admin@acme.test");
  assert.equal(ev.audit[0].target_label, "builder");
  assert.equal(ev.audit[1].actor_label, "unknown");
  assert.equal(ev.audit[1].target_label, "x");
});

async function fixture(t) {
  const codes = {};
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-audit-")), "store.json");
  const origin = "http://localhost";
  const service = createHostedServer({ storePath, origin, secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [{ status: "accepted" }] });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, headers: r.headers, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    return (await request("/auth/verify", { challengeId: c.body.challengeId, code: codes[email] })).cookie;
  };
  return { request, login };
}

test("integration: fleet, evidence and audit.csv label who did what; org isolation; viewer read-only", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("audit-owner@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 5 } }, owner)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "=builder" }, null, token)).body;
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 9 }, reason: "launch week" }, owner)).status, 200);
  assert.equal((await f.request("/v1/teams", { name: "core", agents: [agent.agentId], day: 5 }, owner)).status, 200);
  assert.equal((await f.request("/v1/fleet/freeze", { reason: "runaway" }, owner)).status, 200);
  assert.equal((await f.request("/v1/fleet/resume", { reason: "fixed" }, owner)).status, 200);
  assert.equal((await f.request("/v1/alert-settings", { emails: ["audit-owner@example.invalid"] }, owner)).status, 200);
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "u", ts: new Date().toISOString(), cost_usd: null, model: "m" }] }, null, agent.token)).status, 200);
  assert.equal((await f.request("/v1/receipts/u/settle", { agent_id: agent.agentId, cost_usd: 1, source: "manual_evidence", reason: "r" }, owner)).status, 200);
  assert.equal((await f.request("/v1/invitations", { email: "audit-viewer@example.invalid", role: "viewer" }, owner)).status, 201);
  const fleet = (await f.request("/v1/fleet", undefined, owner)).body;
  const policy = fleet.audit.find((e) => e.action === "policy.change");
  assert.equal(policy.actor_label, "audit-owner@example.invalid");
  assert.equal(policy.target_label, "=builder");
  assert.equal(policy.actor.length > 10, true, "raw actor kept");
  for (const action of ["fleet.freeze", "fleet.resume", "team.change", "receipt.settle", "alert_settings.change", "agent.enroll", "receipts.sync"]) {
    const e = fleet.audit.find((x) => x.action === action);
    assert.ok(e, action);
    assert.notEqual(e.actor_label, "unknown", action);
  }
  assert.equal(fleet.audit.find((e) => e.action === "agent.enroll").actor_label, "=builder");
  const ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
  assert.equal(ev.audit.find((e) => e.action === "policy.change").actor_label, "audit-owner@example.invalid");

  // Viewer: CSV ok, caps still forbidden.
  const viewer = await f.login("audit-viewer@example.invalid");
  const csv = await f.request("/v1/audit.csv", undefined, viewer);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.headers.get("content-disposition"), /costcap-audit\.csv/);
  const lines = csv.body.trim().split("\n");
  assert.equal(lines[0], "ts,actor,actor_label,action,target,target_label,reason,detail_json");
  assert.ok(lines.some((l) => /audit-owner@example\.invalid,policy\.change,[^,]+,'=builder,launch week,/.test(l)), "formula escaped, reason exported");
  const times = lines.slice(1).map((l) => l.split(",")[0]);
  assert.deepEqual(times, [...times].sort(), "oldest first");
  assert.ok([403, 401].includes((await f.request(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 99 } }, viewer)).status));

  // More than 25 entries all exported.
  for (let i = 0; i < 15; i++) {
    await f.request("/v1/fleet/freeze", { reason: `r${i}` }, owner);
    await f.request("/v1/fleet/resume", { reason: `r${i}` }, owner);
  }
  const all = (await f.request("/v1/audit.csv", undefined, owner)).body.trim().split("\n").length - 1;
  const fleetCount = (await f.request("/v1/fleet", undefined, owner)).body.audit.length;
  assert.ok(all > 25);
  assert.equal(all, fleetCount);

  // Range filters and bad dates.
  assert.equal((await f.request("/v1/audit.csv?since=2000-01-01T00:00:00Z&until=2000-01-02T00:00:00Z", undefined, owner)).body.trim().split("\n").length, 1);
  assert.equal((await f.request("/v1/audit.csv?since=garbage", undefined, owner)).status, 400);

  // Isolation and auth.
  const other = await f.login("audit-other@elsewhere.invalid");
  const otherCsv = (await f.request("/v1/audit.csv", undefined, other)).body;
  assert.doesNotMatch(otherCsv, /audit-owner@example\.invalid|builder|policy\.change/);
  assert.equal((await f.request("/v1/audit.csv")).status, 401);
});

// Issue #240: org_budget.change rows label the org target and keep before/after in the CSV.
test("unit: org_budget.change audit row labels the org and exports before/after", () => {
  const rows = labelAudit(state, "o1", [{ ts: "2026-11-16T00:00:00Z", org_id: "o1", actor: "u1", action: "org_budget.change", target: "o1", detail: { before: null, after: { day: 1 } } }]);
  assert.equal(rows[0].target_label, "acme.test");
  assert.equal(rows[0].actor_label, "admin@acme.test");
  const csv = auditCsv(rows, {});
  assert.match(csv.body ?? csv, /org_budget\.change/);
  assert.match(csv.body ?? csv, /""after"":\{""day"":1\}/);
});
