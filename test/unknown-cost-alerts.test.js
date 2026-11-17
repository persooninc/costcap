// Issue #279: page when unknown cost pauses agents (cost_unknown alert kind).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { ALERT_KINDS, evaluateUnknownCostAlerts, unsettledUnknown } from "../src/hosted/alerts.js";
import { createAlertDelivery, createOrgAlertRouter, verifyWebhookSignature, webhookPayload, unknownCostText } from "../src/hosted/delivery.js";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const item = (agentId, receipt, extra = {}) => ({ orgId: "O", agentId, receipt: { ts: iso(NOW - 600_000), ...receipt }, ...extra });

test("unit: ALERT_KINDS includes cost_unknown", () => {
  assert.ok(ALERT_KINDS.includes("cost_unknown"));
});

test("unit: unsettledUnknown excludes known, settled, pending batch, refusals and earlier periods", () => {
  assert.equal(unsettledUnknown(item("A", { id: "u", cost_usd: null }), NOW), true);
  assert.equal(unsettledUnknown(item("A", { id: "k", cost_usd: 1 }), NOW), false);
  assert.equal(unsettledUnknown(item("A", { id: "s", cost_usd: null }, { settlement: { cost_usd: 2 } }), NOW), false);
  assert.equal(unsettledUnknown(item("A", { id: "p", cost_usd: null, reason: "batch_pending" }), NOW), false);
  assert.equal(unsettledUnknown(item("A", { id: "bg", cost_usd: null, reason: "background_pending" }), NOW), false);
  assert.equal(unsettledUnknown(item("A", { id: "b", cost_usd: 0, blocked: true, reason: "accounting_unavailable" }), NOW), false);
  assert.equal(unsettledUnknown(item("A", { id: "old", cost_usd: null, ts: "2026-10-30T00:00:00.000Z" }), NOW), false, "period rollover");
  assert.equal(unsettledUnknown(item("A", { id: "bad", cost_usd: null, ts: "nope" }), NOW), false);
  assert.equal(unsettledUnknown({}, NOW), false);
});

test("unit: agent, team and org keys with counts", () => {
  const items = [
    item("A", { id: "u1", cost_usd: null, model: "gpt-realtime-2", reason: "modality_unpriced", ts: iso(NOW - 900_000) }),
    item("A", { id: "u2", cost_usd: null, model: "x", reason: "cloud_model_unpriced" }),
    item("A", { id: "r1", cost_usd: 0, blocked: true, reason: "accounting_unavailable", ts: iso(NOW - 60_000) }),
    item("A", { id: "r2", cost_usd: 0, blocked: true, reason: "accounting_unavailable", ts: iso(NOW - 120_000) }),
    item("A", { id: "r-old", cost_usd: 0, blocked: true, reason: "accounting_unavailable", ts: iso(NOW - 2 * 3600_000) }),
    item("B", { id: "b1", cost_usd: 0, blocked: true, reason: "unreconciled_receipt", org: true, team: "ops", ts: iso(NOW - 60_000) }),
    item("B", { id: "b2", cost_usd: 0, blocked: true, reason: "unreconciled_receipt", org: true, ts: iso(NOW - 30_000) }),
    item("C", { id: "c1", cost_usd: 0, blocked: true, reason: "unreconciled_receipt", scope: "org", ts: iso(NOW - 60_000) }),
    item("D", { id: "d1", cost_usd: null, reason: "batch_pending" }),
  ];
  const agents = [{ id: "A", name: "alpha" }, { id: "B", name: "beta" }, { id: "C", name: "gamma" }, { id: "D", name: "delta" }];
  const out = evaluateUnknownCostAlerts({ orgId: "O", items, agents, nowMs: NOW,
    teams: [{ name: "ops", agents: ["A", "B"], verdict: { verdict: "accounting_unavailable", spend: { unknown_count: 2 } } }, { name: "calm", agents: ["D"], verdict: { verdict: "ok", spend: { unknown_count: 0 } } }],
    orgVerdict: { verdict: "accounting_unavailable", spend: { unknown_count: 2 } } });
  assert.deepEqual(out.map((a) => a.key), ["cost_unknown:A", "cost_unknown:team:O:ops", "cost_unknown:org:O"]);
  assert.deepEqual(out[0], { kind: "cost_unknown", key: "cost_unknown:A", unknown_count: 2, first: { receipt_id: "u1", ts: iso(NOW - 900_000), model: "gpt-realtime-2", reason: "modality_unpriced" }, blocked_calls_1h: 2 });
  assert.deepEqual([out[1].team, out[1].source_agents, out[1].paused_agents, out[1].unknown_count], ["ops", ["alpha"], 1, 2]);
  assert.deepEqual([out[2].org, out[2].source_agents, out[2].paused_agents], [true, ["alpha"], 2]);
  // Pending batch only: nothing.
  assert.deepEqual(evaluateUnknownCostAlerts({ orgId: "O", items: [items.at(-1)], agents, nowMs: NOW, orgVerdict: { verdict: "ok" } }), []);
  // Settled: nothing for the agent.
  const settled = items.slice(0, 2).map((i) => ({ ...i, settlement: { cost_usd: 1 } }));
  assert.deepEqual(evaluateUnknownCostAlerts({ orgId: "O", items: settled, agents, nowMs: NOW }), []);
  // Team scope matching by scope string, unknown fallback counts.
  const t = evaluateUnknownCostAlerts({ orgId: "O", items: [item("Z", { id: "z", blocked: true, reason: "unreconciled_receipt", scope: "team:ops", ts: iso(NOW - 1000) })], agents: [], nowMs: NOW, teams: [{ name: "ops", agents: ["Z"], verdict: { verdict: "accounting_unavailable", spend: {} } }] });
  assert.deepEqual([t[0].paused_agents, t[0].unknown_count, t[0].source_agents], [1, 0, []]);
});

test("delivery: text names agent, model, paused count and Settle link; webhook carries the new fields", async () => {
  const agentAlert = { id: "al1", kind: "cost_unknown", orgId: "O", agentId: "A", agentName: "alpha", unknown_count: 1, first: { receipt_id: "u1", ts: iso(NOW), model: "gpt-realtime-2", reason: "modality_unpriced" }, blocked_calls_1h: 2 };
  const text = unknownCostText(agentAlert, "https://app.example/dash");
  assert.match(text, /agent alpha/);
  assert.match(text, /model gpt-realtime-2, modality_unpriced/);
  assert.match(text, /pausing 1 agent, 2 calls refused/);
  assert.match(text, /Settle it in the dashboard: https:\/\/app\.example\/dash#unknownCard/);
  const orgText = unknownCostText({ kind: "cost_unknown", org: true, unknown_count: 2, source_agents: ["alpha"], paused_agents: 2 });
  assert.match(orgText, /org budget is paused by 2 unknown-cost receipts from agent alpha; it is pausing 2 agents/);
  assert.match(unknownCostText({ kind: "cost_unknown", team: "ops", source_agents: [], paused_agents: 1 }), /team ops .* from agent unknown; it is pausing 1 agent\./);
  assert.match(unknownCostText({ kind: "cost_unknown" }), /agent unknown .*model unknown, unpriced.*0 calls/);

  const sent = [];
  const fetchImpl = async (url, o) => { sent.push({ url, body: o.body, headers: o.headers }); return { ok: true, status: 200 }; };
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const hook = { url: "https://hooks.receiver.example.com/cc", secret: "whsec_test" };
  const deliver = createAlertDelivery({ emailKey: "k", emailFrom: "a@x.invalid", emailTo: ["o@x.invalid"], slackWebhook: "https://hooks.slack.com/services/T0/B0/x", webhook: hook, dashboardUrl: "https://app.example/", fetchImpl, lookup });
  const res = await deliver(agentAlert);
  assert.ok(res.every((r) => r.status === "accepted"), JSON.stringify(res));
  const email = sent.find((s) => s.url.includes("brevo"));
  assert.match(JSON.parse(email.body).textContent ?? email.body, /alpha/);
  const slack = sent.find((s) => s.url.includes("hooks.slack.com"));
  assert.match(JSON.parse(slack.body).text, /gpt-realtime-2.*#unknownCard/);
  const wh = sent.find((s) => s.url === hook.url);
  const sig = wh.headers["costcap-signature"] ?? wh.headers["CostCap-Signature"] ?? Object.entries(wh.headers).find(([k]) => /signature/i.test(k))[1];
  assert.equal(verifyWebhookSignature(hook.secret, wh.body, sig), true);
  const payload = JSON.parse(wh.body);
  assert.deepEqual([payload.kind, payload.unknown_count, payload.first_receipt_id, payload.blocked_calls_1h, payload.source_agents, payload.paused_agents], ["cost_unknown", 1, "u1", 2, null, null]);
  const orgPayload = webhookPayload({ kind: "cost_unknown", org: true, unknown_count: 2, source_agents: ["alpha"], paused_agents: 2 });
  assert.deepEqual([orgPayload.first_receipt_id, orgPayload.source_agents, orgPayload.paused_agents], [null, ["alpha"], 2]);
  assert.equal("paused_agents" in webhookPayload({ kind: "cap_hit" }), false, "other kinds unchanged");
});

test("routing: a route with kinds [cost_unknown] receives it, a route without it does not", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
  const route = createOrgAlertRouter({ fetchImpl });
  const S1 = "https://hooks.slack.com/services/T1/B1/unknownS1", S2 = "https://hooks.slack.com/services/T2/B2/capsS2";
  await route({ orgId: "O", kind: "cost_unknown", agentId: "A", unknown_count: 1 }, { emails: [], slackWebhook: null, kinds: [], routes: [
    { id: "rt_1", name: "u", kinds: ["cost_unknown"], teams: null, emails: [], slackWebhook: S1 },
    { id: "rt_2", name: "c", kinds: ["cap_hit"], teams: null, emails: [], slackWebhook: S2 }] });
  assert.deepEqual(calls, [S1]);
});

async function fixture(t) {
  let code; let clock = NOW;
  const delivered = [];
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-279-")), "store.json");
  const service = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, now: () => clock, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth, method) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    return (await request("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  };
  const enroll = async (owner, name) => {
    const token = (await request("/v1/enrollment-tokens", { caps: { day: 50, month: 500 } }, owner)).body.token;
    return (await request("/v1/enroll", { name }, null, token)).body;
  };
  const sync = (agent, receipts) => request("/v1/receipts", { receipts }, null, agent.token);
  const sweep = async () => { const before = delivered.length; await service.evaluateFleetAlerts(); return delivered.slice(before).filter((a) => a.kind === "cost_unknown"); };
  return { request, login, enroll, sync, sweep, tick: (ms) => { clock += ms; }, now: () => clock };
}

test("AC1-AC3, AC5: sweep fires agent/team/org cost_unknown once, settle resolves and cap_hit follows; org isolation and metrics", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("u279-owner@example.invalid");
  const A = await f.enroll(owner, "A"), B = await f.enroll(owner, "B"), C = await f.enroll(owner, "C");
  const ts = (ago) => iso(f.now() - ago);
  // AC1: one unknown receipt plus two accounting_unavailable refusals.
  assert.equal((await f.sync(A, [
    { id: "known", ts: ts(900_000), cost_usd: 0.5, model: "gpt-4o" },
    { id: "unk", ts: ts(600_000), cost_usd: null, model: "gpt-realtime-2", reason: "modality_unpriced" },
    { id: "r1", ts: ts(300_000), cost_usd: 0, blocked: true, reason: "accounting_unavailable", model: "gpt-4o" },
    { id: "r2", ts: ts(200_000), cost_usd: 0, blocked: true, reason: "accounting_unavailable", model: "gpt-4o" },
  ])).status, 200);
  let fired = await f.sweep();
  assert.deepEqual(fired.map((a) => a.key), [`cost_unknown:${A.agentId}`]);
  assert.equal(fired[0].unknown_count, 1);
  assert.equal(fired[0].first.reason, "modality_unpriced");
  assert.equal(fired[0].first.model, "gpt-realtime-2");
  assert.equal(fired[0].blocked_calls_1h, 2);
  assert.equal(fired[0].agentName, "A");
  assert.deepEqual(await f.sweep(), [], "second sweep fires nothing new");

  // AC2: org budget + team ops; B and C refused with unreconciled_receipt.
  assert.equal((await f.request("/v1/org-budget", { day: 1 }, owner, null, "PUT")).status, 200);
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [A.agentId, B.agentId], day: 10 }, owner)).status, 200);
  await f.sync(B, [{ id: "b1", ts: ts(60_000), cost_usd: 0, blocked: true, reason: "unreconciled_receipt", org: true, team: "ops" }]);
  await f.sync(C, [{ id: "c1", ts: ts(60_000), cost_usd: 0, blocked: true, reason: "unreconciled_receipt", org: true }]);
  fired = await f.sweep();
  const byKey = Object.fromEntries(fired.map((a) => [a.key, a]));
  const orgId = Object.keys(byKey).find((k) => k.startsWith("cost_unknown:org:")).slice("cost_unknown:org:".length);
  assert.deepEqual(Object.keys(byKey).sort(), [`cost_unknown:org:${orgId}`, `cost_unknown:team:${orgId}:ops`].sort());
  assert.deepEqual([byKey[`cost_unknown:org:${orgId}`].source_agents, byKey[`cost_unknown:org:${orgId}`].paused_agents], [["A"], 2]);
  assert.deepEqual([byKey[`cost_unknown:team:${orgId}:ops`].source_agents, byKey[`cost_unknown:team:${orgId}:ops`].paused_agents], [["A"], 1]);
  assert.deepEqual(await f.sweep(), []);

  // AC4 settings: kinds [cost_unknown] is accepted.
  assert.equal((await f.request("/v1/alert-settings", { kinds: ["cost_unknown"] }, owner)).status, 200);

  // AC5: org B never sees org A's alert; metrics shows it open.
  const other = await f.login("u279-other@example.invalid");
  const otherAlerts = (await f.request("/v1/alerts?status=all", undefined, other)).body.alerts ?? [];
  assert.equal(otherAlerts.filter((a) => a.kind === "cost_unknown").length, 0);
  const key = (await f.request("/v1/api-keys", { name: "prom", role: "viewer" }, owner)).body.key;
  const metric = async () => { const r = await f.request("/v1/metrics", undefined, null, key); return [...String(r.body).matchAll(/^costcap_alerts_open\{kind="cost_unknown",[^}]*\} (\d+)$/gm)].reduce((n, m) => n + Number(m[1]), 0); };
  assert.equal(await metric(), 2, "agent A and team ops series (org alerts carry no agent/team scope_name)");
  const otherKey = (await f.request("/v1/api-keys", { name: "prom", role: "viewer" }, other)).body.key;
  assert.doesNotMatch(String((await f.request("/v1/metrics", undefined, null, otherKey)).body), /costcap_alerts_open\{kind="cost_unknown",[^}]*\} 1/);

  // AC3: settle resolves all three; spend now over the org day cap fires cap_hit.
  assert.equal((await f.request("/v1/receipts/unk/settle", { cost_usd: 2, source: "provider_invoice", reason: "INV-279" }, owner)).status, 200);
  await f.sweep();
  const all = (await f.request("/v1/alerts?status=all", undefined, owner)).body.alerts;
  const unknown = all.filter((a) => a.kind === "cost_unknown");
  assert.equal(unknown.length, 3);
  assert.ok(unknown.every((a) => a.resolved_at), JSON.stringify(unknown));
  assert.ok(all.some((a) => a.kind === "cap_hit" && a.org && !a.resolved_at), "org cap_hit fires once unknown cost is settled");
  assert.equal(await metric(), 0);
});

test("AC6 regression: an org with no unknown receipts gets no cost_unknown alerts", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("u279-clean@example.invalid");
  const A = await f.enroll(owner, "clean");
  await f.request("/v1/org-budget", { day: 1 }, owner, null, "PUT");
  await f.sync(A, [{ id: "k", ts: iso(f.now() - 1000), cost_usd: 0.1, model: "m" }, { id: "p", ts: iso(f.now() - 1000), cost_usd: null, reason: "batch_pending", model: "m" }]);
  assert.deepEqual(await f.sweep(), []);
  // Period rollover resolves an agent alert from last month.
  await f.sync(A, [{ id: "u", ts: iso(f.now() - 1000), cost_usd: null, model: "m" }]);
  assert.equal((await f.sweep()).length, 2);
  f.tick(20 * 24 * 3600_000);
  await f.sweep();
  const again = await f.login("u279-clean@example.invalid");
  const open = (await f.request("/v1/alerts?status=active", undefined, again)).body.alerts.filter((a) => a.kind === "cost_unknown");
  assert.deepEqual(open, []);
});
