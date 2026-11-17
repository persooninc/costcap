// Issue #258: per-team and per-kind alert routes plus a default-kinds filter.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer, ALERT_MAX_ATTEMPTS } from "../src/hosted/server.js";
import { createAlertDelivery, createOrgAlertRouter, matchingRoutes, maskAlertSettings, alertRouteTeam } from "../src/hosted/delivery.js";

const S0 = "https://hooks.slack.com/services/T0/B0/defaultS0aa";
const S1 = "https://hooks.slack.com/services/T1/B1/paymentsS1bb";
const S2 = "https://hooks.slack.com/services/T2/B2/otherS2cc";
const R1 = { id: "rt_r1", name: "payments", kinds: null, teams: ["payments"], emails: [], slackWebhook: S1 };
const R2 = { id: "rt_r2", name: "finance", kinds: ["spend_anomaly"], teams: null, emails: ["f@x.invalid"], slackWebhook: null };
const HOOK = { url: "https://hooks.receiver.example.com/cc", secret: "whsec_test" };
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

function recorder(status = () => 200) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    const body = JSON.parse(o.body);
    calls.push(url.includes("api.brevo.com") ? { to: body.to.map((x) => x.email).sort().join(",") } : { url });
    const code = status(url);
    return { ok: code < 300, status: code };
  };
  return { calls, fetchImpl, targets: () => calls.map((c) => c.to ?? c.url).sort() };
}
const settings = (extra = {}) => ({ emails: ["o@x.invalid"], slackWebhook: S0, kinds: ["cap_hit", "agent_silent"], routes: [R1, R2], ...extra });

test("unit: route matching by kind and team; org/tag alerts only match teams:null; teams:[] matches nothing", () => {
  assert.deepEqual(matchingRoutes([R1, R2], { kind: "cap_hit", team: "payments" }).map((r) => r.id), ["rt_r1"]);
  assert.deepEqual(matchingRoutes([R1, R2], { kind: "spend_anomaly", agentId: "a1", routeTeam: "payments" }).map((r) => r.id), ["rt_r1", "rt_r2"]);
  assert.deepEqual(matchingRoutes([R1, R2], { kind: "cap_hit", org: true, team: "payments" }).map((r) => r.id), []);
  assert.deepEqual(matchingRoutes([R1, { ...R2, kinds: null }], { kind: "cap_hit", tag: { key: "c", value: "v" } }).map((r) => r.id), ["rt_r2"]);
  assert.deepEqual(matchingRoutes([{ ...R1, teams: [] }], { kind: "cap_hit", team: "payments" }), []);
  assert.deepEqual(matchingRoutes(undefined, { kind: "cap_hit" }), []);
  assert.equal(alertRouteTeam({ tag: {}, team: "x" }), null);
});

test("AC2 routing matrix: defaults filtered by kinds, routes additive, signed webhook gets all five", async () => {
  const r = recorder();
  const route = createOrgAlertRouter({ emailKey: "k", emailFrom: "alerts@x.invalid", fetchImpl: r.fetchImpl, lookup });
  const cfg = settings({ webhook: HOOK });
  const send = async (alert) => { r.calls.length = 0; const res = await route({ orgId: "o", ...alert }, cfg); return { res, t: r.targets().filter((u) => u !== HOOK.url), hook: r.calls.some((c) => c.url === HOOK.url) }; };
  let out = await send({ kind: "cap_hit", team: "payments", scope: "month", spent: 2, cap: 1 });
  assert.deepEqual(out.t, ["o@x.invalid", S0, S1].sort());
  assert.ok(out.hook);
  assert.ok(out.res.some((x) => x.channel === "route:rt_r1:slack" && x.status === "accepted"));
  out = await send({ kind: "cap_approaching", agentId: "a1", routeTeam: "payments", scope: "day" });
  assert.deepEqual(out.t, [S1]);
  assert.ok(out.hook);
  out = await send({ kind: "cap_approaching", agentId: "a2", scope: "day" });
  assert.deepEqual(out.t, []);
  assert.ok(out.hook);
  out = await send({ kind: "spend_anomaly", agentId: "a2", today: 9, baseline: 1, multiplier: 9 });
  assert.deepEqual(out.t, ["f@x.invalid"]);
  out = await send({ kind: "cap_hit", org: true, scope: "month", spent: 2, cap: 1 });
  assert.deepEqual(out.t, ["o@x.invalid", S0].sort());
  assert.ok(out.hook);
  // Without the signed webhook, an a2 cap_approaching is unconfigured everywhere.
  r.calls.length = 0;
  const res = await route({ orgId: "o", kind: "cap_approaching", agentId: "a2" }, settings());
  assert.deepEqual(res.map((x) => x.status), ["unconfigured", "unconfigured", "unconfigured"]);
  assert.equal(r.calls.length, 0);
});

test("AC3 parity: no kinds and no routes sends exactly the three default channels; kinds:[] silences defaults", async () => {
  const r = recorder();
  const send = createAlertDelivery({ emailKey: "k", emailFrom: "a@x.invalid", emailTo: ["o@x.invalid"], slackWebhook: S0, fetchImpl: r.fetchImpl });
  assert.deepEqual((await send({ kind: "loop_detected", agentId: "a" })).map((x) => [x.channel, x.status]), [["email", "accepted"], ["slack", "accepted"], ["webhook", "unconfigured"]]);
  const quiet = createAlertDelivery({ emailKey: "k", emailFrom: "a@x.invalid", emailTo: ["o@x.invalid"], slackWebhook: S0, kinds: [], fetchImpl: r.fetchImpl });
  r.calls.length = 0;
  assert.deepEqual((await quiet({ kind: "cap_hit" })).map((x) => x.status), ["unconfigured", "unconfigured", "unconfigured"]);
  assert.equal(r.calls.length, 0);
  // A router with only routes (no defaults) is configured.
  const router = createOrgAlertRouter({ fetchImpl: r.fetchImpl });
  assert.ok((await router({ kind: "cap_hit", team: "payments" }, { emails: [], slackWebhook: null, routes: [R1] })).some((x) => x.channel === "route:rt_r1:slack"));
});

test("dedupe: an address or Slack URL in several matched destinations is sent once per occurrence; retries honour channels", async () => {
  const r = recorder();
  const send = createAlertDelivery({ emailKey: "k", emailFrom: "a@x.invalid", emailTo: ["o@x.invalid"], slackWebhook: S0, fetchImpl: r.fetchImpl,
    routes: [{ ...R1, slackWebhook: S0, emails: ["o@x.invalid", "p@x.invalid"] }, { id: "rt_b", name: "b", kinds: null, teams: null, emails: ["p@x.invalid"], slackWebhook: S2 }] });
  const res = await send({ kind: "cap_hit", team: "payments" });
  assert.deepEqual(r.targets(), ["o@x.invalid", "p@x.invalid", S0, S2].sort());
  assert.deepEqual(res.map((x) => x.channel), ["email", "slack", "webhook", "route:rt_r1:email", "route:rt_b:slack"]);
  r.calls.length = 0;
  assert.deepEqual((await send({ kind: "cap_hit", team: "payments" }, { channels: ["route:rt_b:slack"] })).map((x) => x.channel), ["route:rt_b:slack"]);
  assert.deepEqual(r.targets(), [S2]);
  // A failing route channel reports failed independently.
  const bad = recorder((u) => (u === S1 ? 500 : 200));
  const res2 = await createAlertDelivery({ slackWebhook: S0, routes: [R1], fetchImpl: bad.fetchImpl })({ kind: "cap_hit", team: "payments" });
  assert.deepEqual(res2.filter((x) => x.channel !== "webhook").map((x) => [x.channel, x.status]), [["email", "unconfigured"], ["slack", "accepted"], ["route:rt_r1:slack", "failed"]]);
  // Route emails need an email provider; without one the route email is not attempted.
  const noKey = recorder();
  await createAlertDelivery({ routes: [R2], fetchImpl: noKey.fetchImpl })({ kind: "spend_anomaly" });
  assert.equal(noKey.calls.length, 0);
});

test("masking: route webhooks never appear in full", () => {
  const m = maskAlertSettings(settings({ routes: [R1, { ...R2, teams: [] }] }));
  assert.equal(JSON.stringify(m).includes("paymentsS1bb"), false);
  assert.equal(m.routes[0].slackWebhook, "https://hooks.slack.com/services/…S1bb");
  assert.equal(m.routes[1].disabled, true);
  assert.deepEqual(m.kinds, ["cap_hit", "agent_silent"]);
  // Unset kinds/routes are omitted, so the pre-#258 shape is unchanged.
  assert.deepEqual(maskAlertSettings(undefined), { emails: [], slackWebhook: null, webhook: null, configured: false });
});

async function fixture(t, { now, deliverAlert } = {}) {
  let code;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-258-")), "store.json");
  let service;
  const start = async () => {
    service = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, now, stripeEnv: {}, verifyChallenge: async (v) => v === "test-pass", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert });
    service.server.keepAliveTimeout = 60_000;
    await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  };
  await start();
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const login = async (email) => {
    const c = await fetch(`http://127.0.0.1:${service.server.address().port}/auth/request`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ email, turnstileToken: "test-pass" }) });
    const { challengeId } = await c.json();
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}/auth/verify`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ challengeId, code }) });
    assert.equal(r.status, 200);
    return { cookie: r.headers.get("set-cookie").split(";")[0], body: await r.json() };
  };
  const restart = async () => { service.server.closeAllConnections(); await new Promise((r) => service.server.close(r)); await start(); };
  return { request, login, restart, service: () => service, storePath };
}

test("API + worker: roles, isolation, validation, masking, retry/gave_up, dedupe, lifecycle, restart", async (t) => {
  let skew = 0;
  let s1Status = 500;
  const posts = [];
  const router = createOrgAlertRouter({ lookup, fetchImpl: async (url) => { posts.push(url); const st = url === S1 ? s1Status : 200; return { ok: st < 300, status: st }; } });
  const f = await fixture(t, { now: () => Date.now() + skew, deliverAlert: router });
  const owner = await f.login("owner@w.invalid");
  const other = await f.login("owner@x.invalid");
  for (const [email, role] of [["viewer@w.invalid", "viewer"], ["admin@w.invalid", "admin"], ["f@w.invalid", "viewer"], ["pending@w.invalid", "viewer"]])
    assert.equal((await f.request("/v1/invitations", { email, role }, owner.cookie)).status, 201);
  const viewer = await f.login("viewer@w.invalid");
  const adminU = await f.login("admin@w.invalid");
  await f.login("f@w.invalid");
  const enroll = async (u, name) => { const tok = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, u.cookie)).body.token; return (await f.request("/v1/enroll", { name }, null, tok)).body; };
  const a1 = await enroll(owner, "pay-bot");
  assert.equal((await f.request("/v1/teams", { name: "payments", agents: [a1.agentId], month: 100 }, owner.cookie)).status, 200);
  const r1 = { name: "Payments", teams: ["payments"], slackWebhook: S1 };
  const r2 = { name: "Finance", kinds: ["spend_anomaly"], emails: ["f@w.invalid"] };
  // AC1: access.
  assert.equal((await f.request("/v1/alert-settings", { routes: [r1] }, viewer.cookie)).status, 403);
  assert.equal((await f.request("/v1/alert-settings", { routes: [r1] })).status, 401);
  const viewerKey = (await f.request("/v1/api-keys", { name: "ro", role: "viewer" }, owner.cookie)).body.key;
  assert.match(viewerKey, /^cck_/);
  assert.equal((await f.request("/v1/alert-settings", { routes: [r1] }, null, viewerKey)).status, 403);
  // AC1: validation.
  const bads = [
    { kinds: ["nope"] }, { kinds: "cap_hit" }, { routes: {} }, { routes: [null] },
    { routes: [{ ...r1, kinds: ["nope"] }] }, { routes: [{ ...r1, teams: ["ghost"] }] }, { routes: [{ ...r1, teams: "payments" }] },
    { routes: [{ ...r2, emails: ["pending@w.invalid"] }] }, { routes: [{ ...r2, emails: ["owner@x.invalid"] }] }, { routes: [{ ...r2, emails: "f@w.invalid" }] },
    { routes: [{ ...r1, slackWebhook: "https://evil.invalid/services/x" }] }, { routes: Array.from({ length: 11 }, (_, i) => ({ ...r1, name: `r${i}` })) },
    { routes: [{ name: "empty" }] }, { routes: [{ ...r1, name: "" }] }, { routes: [{ ...r1, name: "x".repeat(41) }] },
    { routes: [{ ...r1, id: "rt_unknown" }] }, { routes: [{ ...r1, id: "bad id" }] },
  ];
  for (const bad of bads) assert.equal((await f.request("/v1/alert-settings", bad, owner.cookie)).status, 400, JSON.stringify(bad).slice(0, 80));
  const saved = await f.request("/v1/alert-settings", { emails: ["owner@w.invalid"], slackWebhook: S0, kinds: ["cap_hit", "agent_silent"], routes: [r1, r2] }, adminU.cookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.routes.length, 2);
  const [R1id, R2id] = saved.body.routes.map((r) => r.id);
  assert.match(R1id, /^rt_[0-9a-f]{18}$/);
  assert.equal(saved.body.routes[0].slackWebhook, "https://hooks.slack.com/services/…S1bb");
  assert.deepEqual(saved.body.kinds, ["cap_hit", "agent_silent"]);
  assert.equal((await f.request("/v1/alert-settings", { routes: [{ ...r1, id: R1id }, { ...r1, id: R1id }] }, owner.cookie)).status, 400);
  const asViewer = await f.request("/v1/alert-settings", undefined, viewer.cookie);
  assert.equal(asViewer.body.canEdit, false);
  assert.equal(asViewer.body.routes[0].name, "Payments");
  // Isolation: the other org sees none of it and cannot reference W's teams.
  assert.equal((await f.request("/v1/alert-settings", undefined, other.cookie)).body.routes, undefined);
  assert.equal((await f.request("/v1/alert-settings", { routes: [r1] }, other.cookie)).status, 400);
  // AC4: S1 fails, S0 succeeds; only route:R1:slack retries, then gives up after 10.
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts: new Date().toISOString(), cost_usd: 2 }] }, null, a1.token);
  await f.service().evaluateFleetAlerts();
  assert.deepEqual(posts.filter((u) => u !== S1).sort(), [S0]); // a1 day cap_hit: defaults (cap_hit allowed) + R1
  assert.equal(posts.filter((u) => u === S1).length, 1);
  for (let i = 0; i < 40 && posts.filter((u) => u === S1).length < ALERT_MAX_ATTEMPTS; i += 1) { skew += 31 * 60_000; await f.service().evaluateFleetAlerts(); }
  assert.equal(posts.filter((u) => u === S1).length, ALERT_MAX_ATTEMPTS);
  assert.equal(posts.filter((u) => u === S0).length, 1);
  skew += 31 * 60_000; await f.service().evaluateFleetAlerts();
  assert.equal(posts.filter((u) => u === S1).length, ALERT_MAX_ATTEMPTS);
  const gaveUp = JSON.parse(readFileSync(f.storePath, "utf8")).audit.filter((e) => e.action === "alert.delivery_gave_up");
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].detail.channel, `route:${R1id}:slack`);
  // Masking grep over API, CSV and audit bodies, and the store's audit.
  const store = JSON.parse(readFileSync(f.storePath, "utf8"));
  assert.ok(!JSON.stringify(store.audit).includes("paymentsS1bb"));
  for (const path of ["/v1/alert-settings", "/v1/fleet", "/v1/audit.csv", "/v1/alerts", "/v1/evidence.json", "/v1/metrics"]) {
    const r = await fetch(`http://127.0.0.1:${f.service().server.address().port}${path}`, { headers: { cookie: owner.cookie } });
    const text = await r.text();
    assert.ok(!text.includes("paymentsS1bb") && !text.includes(S0.slice(-8)), path);
  }
  // AC5: re-saving R1 without slackWebhook keeps S1.
  assert.equal((await f.request("/v1/alert-settings", { routes: [{ id: R1id, name: "Payments", teams: ["payments"] }, { ...r2, id: R2id }] }, owner.cookie)).status, 200);
  const kept = await f.request("/v1/alert-settings", undefined, owner.cookie);
  assert.equal(kept.body.routes[0].slackWebhook, "https://hooks.slack.com/services/…S1bb");
  assert.equal(kept.body.routes[0].id, R1id);
  // AC6 (JSON store): settings survive a restart.
  await f.restart();
  const afterRestart = await f.request("/v1/alert-settings", undefined, owner.cookie);
  assert.deepEqual(afterRestart.body.routes, kept.body.routes);
  assert.deepEqual(afterRestart.body.kinds, ["cap_hit", "agent_silent"]);
  // AC5: removing member f@ drops them from R2.
  const fId = Object.values(JSON.parse(readFileSync(f.storePath, "utf8")).users).find((u) => u.email === "f@w.invalid").id;
  assert.equal((await f.request(`/v1/members/${fId}/remove`, {}, owner.cookie)).status, 200);
  assert.deepEqual((await f.request("/v1/alert-settings", undefined, owner.cookie)).body.routes[1].emails, []);
  // AC5: deleting team payments leaves R1 disabled, never widened.
  assert.equal((await f.request("/v1/teams", { name: "payments", remove: true }, owner.cookie)).status, 200);
  const after = await f.request("/v1/alert-settings", undefined, owner.cookie);
  assert.deepEqual(after.body.routes[0].teams, []);
  assert.equal(after.body.routes[0].disabled, true);
  s1Status = 200;
  posts.length = 0;
  const raw = JSON.parse(readFileSync(f.storePath, "utf8"));
  const orgId = Object.values(raw.users).find((u) => u.email === "owner@w.invalid").orgId;
  const rawSettings = raw.orgs[orgId].alertSettings;
  const res = await router({ orgId, kind: "cap_approaching", agentId: a1.agentId, team: "payments" }, rawSettings);
  assert.ok(!posts.includes(S1));
  assert.ok(!res.some((x) => x.channel.startsWith("route:")));
});

