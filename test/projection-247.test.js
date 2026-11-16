// Issue #247: cap_projected for team budgets and month tag caps, plus the
// projected $ in email/Slack text, the signed webhook and the dashboard list.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { evaluateTeamAlerts, evaluateTagAlerts } from "../src/hosted/alerts.js";
import { teamVerdict } from "../src/hosted/teams.js";
import { createAlertDelivery, verifyWebhookSignature, webhookPayload } from "../src/hosted/delivery.js";

// Nov 2026 has 30 days; day 10.0 of the UTC month.
const DAY10 = Date.parse("2026-11-11T00:00:00.000Z");
const team = { name: "ops", agents: ["a"], month: 100 };
const verdictAt = (nowMs, cost, extra = []) => teamVerdict({ team, nowMs, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-02T00:00:00Z", cost_usd: cost }, ...extra] } });

test("unit AC1/AC2: team month projection, 24h floor, unknown cost suppresses", () => {
  const out = evaluateTeamAlerts({ orgId: "o", verdict: verdictAt(DAY10, 40), nowMs: DAY10 });
  assert.deepEqual(out, [{ kind: "cap_projected", key: "cap_projected:team:o:ops:month", team: "ops", scope: "month", cap: 100, spent: 40, projected: 120 }]);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: verdictAt(DAY10, 20), nowMs: DAY10 }), []);
  const early = Date.parse("2026-11-01T12:00:00.000Z");
  const v = teamVerdict({ team, nowMs: early, receiptsByAgent: { a: [{ id: "1", ts: "2026-11-01T01:00:00Z", cost_usd: 40 }] } });
  assert.equal(evaluateTeamAlerts({ orgId: "o", verdict: v, nowMs: early }).filter((a) => a.kind === "cap_projected").length, 0);
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: verdictAt(DAY10, 40, [{ id: "2", ts: "2026-11-03T00:00:00Z", cost_usd: null }]), nowMs: DAY10 }), []);
  // A month cap_hit wins over the projection.
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: verdictAt(DAY10, 100), nowMs: DAY10 }).map((a) => a.kind), ["cap_hit"]);
  // No nowMs (legacy callers): no projection.
  assert.deepEqual(evaluateTeamAlerts({ orgId: "o", verdict: verdictAt(DAY10, 40) }), []);
});

test("unit AC3: tag month rules project per value, day rules never", () => {
  const spend = { customer: { acme: { day: 1, month: 20, unknown: 0 }, beta: { day: 1, month: 5, unknown: 0 }, "(untagged)": { day: 0, month: 30, unknown: 1 } } };
  const out = evaluateTagAlerts({ orgId: "o", rules: [{ key: "customer", scope: "month", usd: 50, warnFractions: [] }], spend, nowMs: DAY10 });
  assert.deepEqual(out, [{ kind: "cap_projected", key: "cap_projected:tag:o:customer=acme:month", tag: { key: "customer", value: "acme" }, scope: "month", cap: 50, spent: 20, projected: 60 }]);
  const day = evaluateTagAlerts({ orgId: "o", rules: [{ key: "customer", scope: "day", usd: 3, warnFractions: [] }], spend: { customer: { acme: { day: 1, month: 20, unknown: 0 } } }, nowMs: DAY10 });
  assert.deepEqual(day, []);
});

test("unit AC5: text and signed webhook carry projected $ for every scope; cap_hit has null", async () => {
  const calls = [];
  const secret = "whsec_test247";
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; };
  const nowMs = () => DAY10;
  const send = createAlertDelivery({ emailKey: "k", emailFrom: "a@example.invalid", emailTo: ["b@example.invalid"], webhook: { url: "https://hooks.example.com/cc", secret }, lookup: async () => [{ address: "93.184.216.34", family: 4 }], fetchImpl, nowMs });
  const base = { kind: "cap_projected", orgId: "A", scope: "month", cap: 100, spent: 40, projected: 120 };
  for (const extra of [{ team: "ops" }, { tag: { key: "customer", value: "acme" } }, { org: true }, { agentId: "ag1" }]) {
    calls.length = 0;
    await send({ ...base, ...extra });
    const email = calls.find((c) => !c.url.includes("hooks.example.com"));
    assert.match(email.options.body, /projected \$120\.00 of \$100\.00 cap by period end/);
    const hook = calls.find((c) => c.url.includes("hooks.example.com"));
    assert.equal(JSON.parse(hook.options.body).projected_usd, 120);
    assert.ok(verifyWebhookSignature(secret, hook.options.body, hook.options.headers["x-costcap-signature"], { nowMs: DAY10 }));
  }
  assert.equal(webhookPayload({ kind: "cap_hit", spent: 1, cap: 1, projected: 5 }).projected_usd, null);
});

async function fixture(t, clock) {
  const codes = [];
  const delivered = [];
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-247-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {}, now: () => clock.ms,
    verifyChallenge: async () => true, sendCode: async (d) => { codes.push(d.code); }, sendInvite: async () => {},
    deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = () => `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, auth, method) => {
    const r = await fetch(base() + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    const vr = await fetch(base() + "/auth/verify", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code: codes.at(-1) }) });
    return vr.headers.get("set-cookie").split(";")[0];
  };
  const org = async (email) => {
    const cookie = await login(email);
    const e = await request("/v1/enrollment-tokens", { caps: {} }, cookie);
    const agent = (await request("/v1/enroll", { name: "a" }, null, e.body.token)).body;
    let n = 0;
    const receipt = (fields) => request("/v1/receipts", { receipts: [{ id: `r${++n}`, ts: new Date(clock.ms).toISOString(), model: "m", ...fields }] }, null, agent.token);
    return { cookie, agent, receipt };
  };
  return { request, org, login, delivered, sweep: () => service.evaluateFleetAlerts() };
}

test("regression AC4/AC6: hosted sweep fires team + tag projections once per period, hit resolves, rollover resolves, orgs isolated", async (t) => {
  const clock = { ms: Date.parse("2026-11-02T00:00:00.000Z") };
  const f = await fixture(t, clock);
  const A = await f.org("proj-a@example.invalid");
  const B = await f.org("proj-b@example.invalid");
  for (const o of [A, B]) {
    assert.equal((await f.request("/v1/teams", { name: "ops", agents: [o.agent.agentId], month: 100 }, o.cookie)).status, 200);
    assert.equal((await f.request("/v1/tag-caps", { tagCaps: [{ key: "customer", scope: "month", usd: 50, warnFractions: [] }] }, o.cookie, null, "PUT")).status, 200);
  }
  await A.receipt({ cost_usd: 20, tags: { customer: "acme" } });
  await A.receipt({ cost_usd: 20, tags: { customer: "beta" } });
  await B.receipt({ cost_usd: 1, tags: { customer: "acme" } });
  clock.ms = DAY10;
  await f.sweep();
  await f.sweep();
  const proj = () => f.delivered.filter((a) => a.kind === "cap_projected");
  const orgA = proj()[0]?.orgId;
  assert.deepEqual(proj().map((a) => a.key).sort(), [`cap_projected:tag:${orgA}:customer=acme:month`, `cap_projected:tag:${orgA}:customer=beta:month`, `cap_projected:team:${orgA}:ops:month`].sort());
  const teamAlert = proj().find((a) => a.team);
  assert.equal(teamAlert.projected, 120);
  assert.equal(teamAlert.spent, 40);
  assert.equal(teamAlert.cap, 100);
  // AC6: org B sees none of org A's projections.
  const listB = (await f.request("/v1/alerts?status=all", undefined, await f.login("proj-b@example.invalid"))).body;
  assert.equal((listB.alerts ?? listB).filter((a) => a.kind === "cap_projected").length, 0);
  // Run rate dips below the cap (day 20: 40 -> 60 projected), then climbs back: still one occurrence.
  clock.ms = Date.parse("2026-11-21T00:00:00.000Z");
  await f.sweep();
  const listA = async () => { const b = (await f.request("/v1/alerts?status=all", undefined, await f.login("proj-a@example.invalid"))).body; return b.alerts ?? b; };
  assert.ok((await listA()).find((a) => a.key === teamAlert.key).active, "projection stays active while the rate dips");
  await A.receipt({ cost_usd: 40 });
  await f.sweep();
  assert.equal(proj().filter((a) => a.team).length, 1);
  assert.equal((await listA()).filter((a) => a.key === teamAlert.key).length, 1);
  // Spend reaches the cap: cap_hit fires and the projection resolves.
  await A.receipt({ cost_usd: 30 });
  await f.sweep();
  assert.ok(f.delivered.some((a) => a.key === `cap_hit:team:${orgA}:ops:month`));
  assert.equal((await listA()).find((a) => a.key === teamAlert.key).active, false);
  // The tag projection for acme is still active; rollover resolves it.
  const acme = `cap_projected:tag:${orgA}:customer=acme:month`;
  assert.ok((await listA()).find((a) => a.key === acme).active);
  assert.ok(proj().some((a) => a.key === `cap_projected:tag:${orgA}:customer=(untagged):month`), "untagged values project too");
  const firedBefore = proj().length;
  clock.ms = Date.parse("2026-12-03T00:00:00.000Z");
  await f.sweep();
  assert.ok((await listA()).filter((a) => a.kind === "cap_projected").every((a) => !a.active));
  assert.equal(proj().length, firedBefore, "nothing new fires in the fresh period without spend");
});
