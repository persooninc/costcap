// Issue #209: GET/POST /v1/budget-period (owner/admin, audited), and the period
// reaching /v1/policy, /v1/spend, /v1/fleet and hosted verdicts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

async function fixture(t, nowMs) {
  const codes = {};
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-period-")), "store.json"), origin: "http://localhost", secureCookies: false, now: () => nowMs, stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [{ status: "accepted" }] });
  service.server.keepAliveTimeout = 60_000;
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}/auth/verify`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code: codes[email] }) });
    return r.headers.get("set-cookie").split(";")[0];
  };
  return { request, login };
}

test("#209 AC4/AC6/AC7: budget period API, validation, roles, audit, policy sync and spend buckets", async (t) => {
  const NOW = Date.parse("2026-11-16T09:00:00Z");
  const f = await fixture(t, NOW);
  const owner = await f.login("period-owner@example.invalid");
  // AC7: default UTC/day 1.
  assert.deepEqual((await f.request("/v1/budget-period", undefined, owner)).body, { budgetPeriod: { timezone: "UTC", monthStartDay: 1 }, canEdit: true });
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 4 } }, owner)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "la" }, null, token)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "a", ts: "2026-11-16T07:30:00Z", cost_usd: 2, model: "m" }, { id: "b", ts: "2026-11-16T08:30:00Z", cost_usd: 3, model: "m" }, { id: "c", ts: "2026-11-16T08:45:00Z", cost_usd: null, model: "m" }] }, null, agent.token)).status, 200);
  let policy = (await f.request("/v1/policy", undefined, null, agent.token)).body;
  assert.deepEqual(policy.budget_period, { timezone: "UTC", monthStartDay: 1 });
  assert.equal(policy.agent_spend.spent.day, 5);
  let spend = (await f.request("/v1/spend?group_by=day", undefined, owner)).body;
  assert.deepEqual(spend.buckets.map((b) => b.key), ["2026-11-16"]);

  // AC4: invalid input 400, viewer 403.
  assert.equal((await f.request("/v1/budget-period", { timezone: "Mars/Base" }, owner)).status, 400);
  assert.equal((await f.request("/v1/budget-period", { monthStartDay: 29 }, owner)).status, 400);
  assert.equal((await f.request("/v1/budget-period", { monthStartDay: 0 }, owner)).status, 400);
  assert.equal((await f.request("/v1/invitations", { email: "period-viewer@example.invalid", role: "viewer" }, owner)).status, 201);
  const viewer = await f.login("period-viewer@example.invalid");
  assert.equal((await f.request("/v1/budget-period", { timezone: "UTC" }, viewer)).status, 403);
  assert.equal((await f.request("/v1/budget-period", undefined, viewer)).body.canEdit, false);
  assert.equal((await f.request("/v1/budget-period", { timezone: "UTC" })).status, 401);

  const saved = await f.request("/v1/budget-period", { budgetPeriod: { timezone: "America/Los_Angeles" } }, owner);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.budgetPeriod, { timezone: "America/Los_Angeles", monthStartDay: 1 });
  // A partial update keeps the other field.
  assert.deepEqual((await f.request("/v1/budget-period", { monthStartDay: 15 }, owner)).body.budgetPeriod, { timezone: "America/Los_Angeles", monthStartDay: 15 });
  const fleet = (await f.request("/v1/fleet", undefined, owner)).body;
  const entries = fleet.audit.filter((a) => a.action === "budget_period.change");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].detail, { before: { timezone: "UTC", monthStartDay: 1 }, after: { timezone: "America/Los_Angeles", monthStartDay: 1 } });
  assert.deepEqual(entries[1].detail.after, { timezone: "America/Los_Angeles", monthStartDay: 15 });
  assert.deepEqual(fleet.budget_period, { timezone: "America/Los_Angeles", monthStartDay: 15 });
  assert.equal(fleet.agents[0].spend.day.usd, 3);

  // AC5: the wrapper receives budget_period and the LA-day spend.
  policy = (await f.request("/v1/policy", undefined, null, agent.token)).body;
  assert.deepEqual(policy.budget_period, { timezone: "America/Los_Angeles", monthStartDay: 15 });
  assert.equal(policy.agent_spend.spent.day, 3);
  assert.equal(policy.agent_spend.unknown, 1);

  // AC6: local day buckets; unknown cost still counted, never $0.
  spend = (await f.request("/v1/spend?group_by=day", undefined, owner)).body;
  assert.deepEqual(spend.budget_period, { timezone: "America/Los_Angeles", monthStartDay: 15 });
  assert.deepEqual(spend.buckets.map((b) => [b.key, b.usd_known, b.unknown_count]), [["2026-11-15", 2, 0], ["2026-11-16", 3, 1]]);
});
