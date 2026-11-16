// Issue #223: spend anomaly alerts (today vs the agent's/team's own 14-day median).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { evaluateAnomaly, anomalyError, resolveAnomaly, median, previousDays, dailySpend, DEFAULT_ANOMALY } from "../src/hosted/anomaly.js";
import { validatePolicy } from "../src/hosted/policy.js";
import { parseTeamInput } from "../src/hosted/teams.js";
import { webhookPayload } from "../src/hosted/delivery.js";
import { buildEvidence } from "../src/hosted/evidence.js";

const NOW = Date.parse("2026-11-16T15:00:00.000Z");
const DAY = 86_400_000;
// n days of history at usdPerDay, plus today's receipts.
function history(n, usdPerDay, today = [], nowMs = NOW) {
  const out = [];
  for (let i = 1; i <= n; i += 1) out.push({ ts: new Date(nowMs - i * DAY).toISOString(), cost_usd: usdPerDay, model: "m" });
  for (const r of today) out.push({ ts: new Date(nowMs - 60_000).toISOString(), model: "m", ...r });
  return out;
}

test("unit: median and the 14-day window in the org timezone", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const days = previousDays(NOW, null);
  assert.equal(days.length, 14);
  assert.equal(days[13], "2026-11-15");
  assert.equal(days[0], "2026-11-02");
  // 02:00 UTC Nov 16 is still Nov 15 in New York: yesterday there is Nov 14.
  const ny = { timezone: "America/New_York", monthStartDay: 1 };
  const early = Date.parse("2026-11-16T02:00:00Z");
  assert.equal(previousDays(early, ny)[13], "2026-11-14");
  // DST change (Nov 1 2026 in New York) does not skip or repeat a day.
  assert.equal(new Set(previousDays(early, ny)).size, 14);
  assert.equal(previousDays(early, ny)[0], "2026-11-01");
  // A receipt at 03:00Z Nov 16 is "today" in UTC but "yesterday" in New York.
  const r = [{ ts: "2026-11-16T03:30:00Z", cost_usd: 9 }];
  const late = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(dailySpend(r, late, null).today.usd, 9);
  assert.equal(dailySpend(r, late, ny).today.usd, 0);
  assert.equal(dailySpend(r, late, ny).history.at(-1).usd, 9);
});

test("unit: AC1/AC2 threshold math, min_usd and min_history_days", () => {
  const a = evaluateAnomaly({ id: "a1", receipts: history(14, 2, [{ cost_usd: 7 }]), nowMs: NOW });
  assert.equal(a.kind, "spend_anomaly");
  assert.equal(a.key, "spend_anomaly:a1:2026-11-16");
  assert.equal(a.today, 7);
  assert.equal(a.baseline, 2);
  assert.equal(a.multiplier, 3);
  assert.equal(a.lower_bound, false);
  assert.equal(a.baseline_lower_bound, false);
  assert.deepEqual(a.top_models, [{ model: "m", usd: 7 }]);
  assert.equal(evaluateAnomaly({ id: "a1", receipts: history(14, 2, [{ cost_usd: 5.5 }]), nowMs: NOW }), null);
  assert.equal(evaluateAnomaly({ id: "a1", receipts: history(14, 1, [{ cost_usd: 4 }]), nowMs: NOW }), null);
  assert.equal(evaluateAnomaly({ id: "a1", receipts: history(5, 0.1, [{ cost_usd: 50 }]), nowMs: NOW }), null);
  assert.ok(evaluateAnomaly({ id: "a1", receipts: history(7, 0.1, [{ cost_usd: 50 }]), nowMs: NOW }));
  // Zero-spend days after the first receipt are history and pull the median down.
  const sparse = history(14, 2).filter((_, i) => i % 2 === 0);
  assert.equal(dailySpend(sparse, NOW).history.length, 13);
  // Top 3 models by spend today.
  const many = history(14, 0.5, [{ cost_usd: 3, model: "a" }, { cost_usd: 2, model: "b" }, { cost_usd: 1, model: "c" }, { cost_usd: 0.5, model: "d" }, { cost_usd: null, model: "z" }]);
  assert.deepEqual(evaluateAnomaly({ id: "x", receipts: many, nowMs: NOW }).top_models.map((m) => m.model), ["a", "b", "c"]);
  // Disabled and zero spend never fire; future receipts are ignored.
  assert.equal(evaluateAnomaly({ id: "a1", receipts: history(14, 2, [{ cost_usd: 70 }]), nowMs: NOW, settings: { enabled: false } }), null);
  assert.equal(evaluateAnomaly({ id: "a1", receipts: [...history(14, 0), { ts: new Date(NOW + 1000).toISOString(), cost_usd: 99 }], nowMs: NOW, settings: { min_usd: 0 } }), null);
});

test("unit: AC3 unknown cost is a lower bound, never $0", () => {
  const recs = history(14, 0.9, [{ cost_usd: 3 }, { cost_usd: null }]);
  recs[0] = { ...recs[0], cost_usd: null };
  const a = evaluateAnomaly({ id: "a1", receipts: recs, nowMs: NOW, settings: { min_usd: 2 } });
  assert.equal(a.today, 3);
  assert.equal(a.unknown_count, 1);
  assert.equal(a.lower_bound, true);
  assert.equal(a.baseline_lower_bound, true);
  // Only unknown cost today: nothing to page on.
  assert.equal(evaluateAnomaly({ id: "a1", receipts: history(14, 0, [{ cost_usd: null }]), nowMs: NOW, settings: { min_usd: 0 } }), null);
});

test("unit: AC4 override validation and resolution", () => {
  assert.equal(anomalyError({}), null);
  assert.equal(anomalyError({ enabled: false, multiplier: 1.5, min_usd: 0 }), null);
  assert.equal(anomalyError({ multiplier: 20 }), null);
  for (const bad of [null, [], 3, { multiplier: 1 }, { multiplier: 50 }, { multiplier: "3" }, { min_usd: -1 }, { enabled: "no" }, { other: 1 }]) assert.ok(anomalyError(bad), JSON.stringify(bad));
  assert.deepEqual(resolveAnomaly(), DEFAULT_ANOMALY);
  assert.deepEqual(resolveAnomaly({ multiplier: 5 }, { min_usd: 1 }, { multiplier: 99 }), { enabled: true, multiplier: 5, min_usd: 1 });
  assert.equal(evaluateAnomaly({ id: "a1", receipts: history(14, 2, [{ cost_usd: 7 }]), nowMs: NOW, settings: { multiplier: 10 } }), null);
  const base = { version: 1, caps: {} };
  assert.deepEqual(validatePolicy({ ...base, anomaly: { multiplier: 4 } }), []);
  assert.deepEqual(validatePolicy({ ...base, anomaly: null }), []);
  assert.equal(validatePolicy({ ...base, anomaly: { multiplier: 1 } }).length, 1);
  const ctx = { orgId: "o", orgAgents: [{ id: "a", orgId: "o" }], teams: [] };
  assert.deepEqual(parseTeamInput({ name: "ops", agents: ["a"], month: 100, anomaly: { multiplier: 4 } }, ctx).anomaly, { multiplier: 4 });
  assert.equal(parseTeamInput({ name: "ops", agents: ["a"], month: 100, anomaly: null }, ctx).anomaly, null);
  assert.throws(() => parseTeamInput({ name: "ops", agents: ["a"], month: 100, anomaly: { min_usd: -1 } }, ctx), (e) => e.status === 400);
});

test("unit: webhook payload and evidence carry the anomaly fields", () => {
  const a = { id: "x", kind: "spend_anomaly", orgId: "o", agentId: "a1", key: "k", scope: "day", today: 7, baseline: 2, multiplier: 3, top_models: [{ model: "m", usd: 7 }], lower_bound: true, baseline_lower_bound: false, date: "2026-11-16", active: true };
  const p = webhookPayload(a);
  assert.equal(p.today_usd, 7);
  assert.equal(p.baseline_usd, 2);
  assert.equal(p.multiplier, 3);
  assert.equal(p.lower_bound, true);
  assert.deepEqual(p.top_models, [{ model: "m", usd: 7 }]);
  assert.equal(webhookPayload({ kind: "cap_hit" }).lower_bound, null);
  const ev = buildEvidence({ orgId: "o", alerts: [a], nowMs: NOW, spendFor: () => ({}) });
  assert.equal(ev.alerts[0].lower_bound, true);
  assert.equal(ev.alerts[0].baseline, 2);
});

async function fixture(t, clock) {
  let code;
  const delivered = [];
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-anom-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {}, now: () => clock.ms,
    verifyChallenge: async (v) => v === "ok", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {},
    deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth, method) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const login = async (email) => { const c = await request("/auth/request", { email, turnstileToken: "ok" }); const v = await fetch(`http://127.0.0.1:${service.server.address().port}/auth/verify`, { method: "POST", headers: { origin: "http://localhost", connection: "close", "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code }) }); return { cookie: v.headers.get("set-cookie")?.split(";")[0] }; };
  const agent = async (cookie, name, caps = {}) => { const e = await request("/v1/enrollment-tokens", { caps }, cookie); return (await request("/v1/enroll", { name }, null, e.body.token)).body; };
  let n = 0;
  const upload = (token, rows) => request("/v1/receipts", { receipts: rows.map((r) => ({ id: `r${++n}`, ...r })) }, null, token);
  return { request, login, agent, upload, delivered, sweep: () => service.evaluateFleetAlerts() };
}

test("server: AC1 fires once, dedupes the same day, resolves the next day; AC4 overrides audited", async (t) => {
  const clock = { ms: NOW };
  const f = await fixture(t, clock);
  const owner = await f.login("anom-owner@example.invalid");
  const a = await f.agent(owner.cookie, "nocap");
  assert.equal((await f.upload(a.token, history(14, 2, [{ cost_usd: 7 }]))).status, 200);
  await f.sweep(); await f.sweep();
  const fired = f.delivered.filter((d) => d.kind === "spend_anomaly");
  assert.equal(fired.length, 1);
  assert.equal(fired[0].today, 7);
  assert.equal(fired[0].baseline, 2);
  assert.equal(fired[0].multiplier, 3);
  const list = (await f.request("/v1/alerts?status=active", undefined, owner.cookie)).body.alerts.filter((x) => x.kind === "spend_anomaly");
  assert.equal(list.length, 1);
  // Next UTC day: today is $0, the alert resolves.
  clock.ms = NOW + DAY;
  Object.assign(owner, await f.login("anom-owner@example.invalid"));
  await f.sweep();
  assert.equal((await f.request("/v1/alerts?status=active", undefined, owner.cookie)).body.alerts.filter((x) => x.kind === "spend_anomaly").length, 0);
  assert.equal((await f.request("/v1/alerts?status=resolved", undefined, owner.cookie)).body.alerts.filter((x) => x.kind === "spend_anomaly").length, 1);

  // AC4: a per-agent override suppresses, enabled:false turns it off; audited; invalid -> 400.
  const b = await f.agent(owner.cookie, "override");
  await f.upload(b.token, history(14, 2, [{ cost_usd: 7 }], clock.ms));
  const url = `/v1/agents/${b.agentId}/policy`;
  assert.equal((await f.request(url, { anomaly: { multiplier: 10 } }, owner.cookie)).status, 200);
  await f.sweep();
  assert.equal(f.delivered.filter((d) => d.kind === "spend_anomaly" && d.agentId === b.agentId).length, 0);
  assert.equal((await f.request(url, { anomaly: { enabled: false } }, owner.cookie)).status, 200);
  await f.sweep();
  assert.equal(f.delivered.filter((d) => d.kind === "spend_anomaly" && d.agentId === b.agentId).length, 0);
  for (const bad of [{ multiplier: 1 }, { multiplier: 50 }, { min_usd: -1 }]) assert.equal((await f.request(url, { anomaly: bad }, owner.cookie)).status, 400, JSON.stringify(bad));
  const audits = (await f.request("/v1/evidence.json", undefined, owner.cookie)).body.audit.filter((e) => e.action === "anomaly.change");
  assert.deepEqual(audits.map((e) => [e.detail.before, e.detail.after]), [[null, { multiplier: 10 }], [{ multiplier: 10 }, { enabled: false }]]);
  // Clearing the override (null) brings the org default back.
  assert.equal((await f.request(url, { anomaly: null }, owner.cookie)).body.anomaly, undefined);
  await f.sweep();
  assert.equal(f.delivered.filter((d) => d.kind === "spend_anomaly" && d.agentId === b.agentId).length, 1);
});

test("server: org default settings route, AC3 evidence lower bound, AC5 team anomaly", async (t) => {
  const clock = { ms: NOW };
  const f = await fixture(t, clock);
  const owner = await f.login("anom-team@example.invalid");
  const got = await f.request("/v1/anomaly-settings", undefined, owner.cookie);
  assert.deepEqual(got.body.anomaly, DEFAULT_ANOMALY);
  assert.equal(got.body.canEdit, true);
  assert.equal((await f.request("/v1/anomaly-settings", { multiplier: 1 }, owner.cookie, null, "PUT")).status, 400);
  const put = await f.request("/v1/anomaly-settings", { min_usd: 2 }, owner.cookie, null, "PUT");
  assert.deepEqual(put.body.anomaly, { enabled: true, multiplier: 3, min_usd: 2 });

  // AC3: $3 known + one unknown vs $0.90 baseline fires with lower_bound.
  const u = await f.agent(owner.cookie, "unknown");
  await f.upload(u.token, history(14, 0.9, [{ cost_usd: 3 }, { cost_usd: null }]));
  // AC5: two members at $1/day each (team median $2), $3.5 each today (team $7) -> team alert.
  const m1 = await f.agent(owner.cookie, "m1"), m2 = await f.agent(owner.cookie, "m2");
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [m1.agentId, m2.agentId], month: 1000 }, owner.cookie)).status, 200);
  for (const m of [m1, m2]) await f.upload(m.token, history(14, 1, [{ cost_usd: 3.5 }]));
  await f.sweep(); await f.sweep();
  const ev = (await f.request("/v1/evidence.json", undefined, owner.cookie)).body;
  const ua = ev.alerts.find((x) => x.kind === "spend_anomaly" && x.agent_id === u.agentId);
  assert.equal(ua.lower_bound, true);
  assert.equal(ua.today, 3);
  const orgId = ev.org_id;
  const team = f.delivered.filter((d) => d.kind === "spend_anomaly" && d.team === "ops");
  assert.equal(team.length, 1);
  assert.equal(team[0].key, `spend_anomaly:team:${orgId}:ops:2026-11-16`);
  assert.equal(team[0].today, 7);
  assert.equal(team[0].baseline, 2);
  // Each member ($3.5 vs its own $1 median, threshold max($2, $3)) also alerts, independent of the team alert.
  assert.equal(f.delivered.filter((d) => d.kind === "spend_anomaly" && [m1.agentId, m2.agentId].includes(d.agentId)).length, 2);
  // Team override turns the team alert off and is audited; the next day resolves nothing twice.
  assert.equal((await f.request("/v1/teams", { name: "ops", agents: [m1.agentId, m2.agentId], month: 1000, anomaly: { enabled: false } }, owner.cookie)).status, 200);
  await f.sweep();
  assert.equal((await f.request("/v1/alerts?status=active", undefined, owner.cookie)).body.alerts.filter((x) => x.team === "ops").length, 0);
  const audit = (await f.request("/v1/evidence.json", undefined, owner.cookie)).body.audit.filter((e) => e.action === "anomaly.change").map((e) => e.detail.scope);
  assert.deepEqual(audit.sort(), ["org", "team"]);
});
