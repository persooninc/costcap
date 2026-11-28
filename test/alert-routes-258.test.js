// Issue #258: alert routes (per-team / per-kind destinations) and default kinds.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer, applyDeliveryResult, dueRetryChannels, ALERT_MAX_ATTEMPTS } from "../src/hosted/server.js";
import { createAlertDelivery, createOrgAlertRouter, maskAlertSettings } from "../src/hosted/delivery.js";
import { parseKinds, parseRoutes, routeMatches, routeDisabled, dropTeamFromRoutes, dropEmailFromRoutes, MAX_ALERT_ROUTES } from "../src/hosted/alert-routes.js";
import { validSlackWebhook } from "../src/hosted/delivery.js";

const S0 = "https://hooks.slack.com/services/T0/B0/defaultzero";
const S1 = "https://hooks.slack.com/services/T1/B1/paymentsone";
const R1 = "rt_000000000001", R2 = "rt_000000000002";
const pubLookup = async () => [{ address: "93.184.216.34", family: 4 }];

// Fake fetch: records Slack URLs and email recipients; `fail` maps URL -> status.
function recorder(fail = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).includes("hooks.slack.com")) calls.push({ slack: url });
    else if (body.to) calls.push({ email: body.to.map((x) => x.email).sort() });
    else calls.push({ webhook: url });
    const status = fail[url] ?? 200;
    return { ok: status < 400, status, json: async () => ({ id: "x" }), text: async () => "" };
  };
  return { calls, fetchImpl };
}
const matrixSettings = () => ({
  emails: ["o@x.example"], slackWebhook: S0, kinds: ["cap_hit", "agent_silent"],
  webhook: { url: "https://hooks.example.com/costcap", secret: "whsec_test" },
  routes: [
    { id: R1, name: "payments", kinds: null, teams: ["payments"], emails: [], slackWebhook: S1 },
    { id: R2, name: "finops anomalies", kinds: ["spend_anomaly"], teams: null, emails: ["f@x.example"], slackWebhook: null },
  ],
});
const dests = (calls) => calls.map((c) => c.slack ?? c.webhook ?? c.email.join(",")).sort();

test("unit: parseKinds and parseRoutes validation", () => {
  assert.equal(parseKinds(null), null);
  assert.deepEqual(parseKinds(["agent_silent", "cap_hit", "cap_hit"]), ["cap_hit", "agent_silent"]);
  assert.deepEqual(parseKinds([]), []);
  for (const bad of ["cap_hit", ["nope"], [1]]) assert.throws(() => parseKinds(bad), (e) => e.status === 400);
  const ctx = { current: [{ id: R1, name: "p", kinds: null, teams: ["payments"], emails: [], slackWebhook: S1 }], teamNames: new Set(["payments"]), members: new Set(["f@x.example"]), validSlack: validSlackWebhook };
  const [kept, fresh] = parseRoutes([{ id: R1, name: " p2 ", teams: ["payments"] }, { name: "new", emails: ["F@x.example"], kinds: ["spend_anomaly"] }], ctx);
  assert.deepEqual(kept, { id: R1, name: "p2", kinds: null, teams: ["payments"], emails: [], slackWebhook: S1 }); // webhook kept
  assert.match(fresh.id, /^rt_[a-f0-9]{12}$/);
  assert.deepEqual(fresh.emails, ["f@x.example"]);
  assert.deepEqual(parseRoutes([{ id: R1, name: "p", slackWebhook: null, emails: ["f@x.example"] }], ctx)[0].slackWebhook, null);
  const bads = [
    "x", [null], [{ name: "", emails: ["f@x.example"] }], [{ name: "x".repeat(41), emails: ["f@x.example"] }],
    [{ name: "k", kinds: ["nope"], emails: ["f@x.example"] }], [{ name: "t", teams: ["ghost"], emails: ["f@x.example"] }],
    [{ name: "t", teams: [], emails: ["f@x.example"] }], [{ name: "e", emails: ["stranger@x.example"] }],
    [{ name: "s", slackWebhook: "https://evil.example/services/x" }], [{ name: "none" }], [{ name: "none", id: R1, slackWebhook: null }],
    [{ id: "rt_ffffffffffff", name: "u", emails: ["f@x.example"] }], [{ name: "f", emails: ["f@x.example"], extra: 1 }],
    [{ id: R1, name: "a" }, { id: R1, name: "b" }],
    Array.from({ length: MAX_ALERT_ROUTES + 1 }, (_, i) => ({ name: `r${i}`, emails: ["f@x.example"] })),
  ];
  for (const bad of bads) assert.throws(() => parseRoutes(bad, ctx), (e) => e.status === 400, JSON.stringify(bad).slice(0, 80));
  assert.equal(parseRoutes(Array.from({ length: MAX_ALERT_ROUTES }, (_, i) => ({ name: `r${i}`, emails: ["f@x.example"] })), ctx).length, MAX_ALERT_ROUTES);
  // A disabled route (teams []) can be re-saved as is.
  const disabled = { ...ctx, current: [{ ...ctx.current[0], teams: [] }] };
  assert.deepEqual(parseRoutes([{ id: R1, name: "p", teams: [] }], disabled)[0].teams, []);
});

test("unit: matching, disabled routes and lifecycle helpers", () => {
  const r = { kinds: ["cap_hit"], teams: ["payments"] };
  assert.equal(routeMatches(r, { kind: "cap_hit" }, "payments"), true);
  assert.equal(routeMatches(r, { kind: "cap_hit" }, null), false);
  assert.equal(routeMatches(r, { kind: "agent_silent" }, "payments"), false);
  assert.equal(routeMatches({ kinds: null, teams: null }, { kind: "cap_hit" }, null), true);
  const routes = dropTeamFromRoutes([{ id: R1, teams: ["payments"] }, { id: R2, teams: null }], "payments");
  assert.deepEqual(routes.map((x) => x.teams), [[], null]);
  assert.equal(routeDisabled(routes[0]), true);
  assert.equal(routeMatches(routes[0], { kind: "cap_hit" }, "payments"), false); // never widened
  assert.deepEqual(dropEmailFromRoutes([{ emails: ["f@x.example", "g@x.example"] }], "f@x.example")[0].emails, ["g@x.example"]);
  // Masking never shows a route webhook in full.
  const masked = maskAlertSettings(matrixSettings());
  assert.ok(!JSON.stringify(masked).includes(S1) && !JSON.stringify(masked).includes("paymentsone"));
  assert.equal(masked.routes[0].slackWebhook, "https://hooks.slack.com/services/…sone");
  assert.deepEqual(masked.kinds, ["cap_hit", "agent_silent"]);
  // Without kinds/routes the #121 shape is unchanged.
  assert.deepEqual(Object.keys(maskAlertSettings({ emails: [], slackWebhook: null })), ["emails", "slackWebhook", "webhook", "configured"]);
});

test("acceptance: routing matrix (defaults with kinds, team route, kind route, signed webhook)", async () => {
  const cases = [
    [{ kind: "cap_hit", team: "payments", scope: "month" }, ["o@x.example", S0, S1]],
    [{ kind: "cap_approaching", agentId: "a1", routeTeam: "payments", scope: "day" }, [S1]],
    [{ kind: "cap_approaching", agentId: "a2", scope: "day" }, []],
    [{ kind: "spend_anomaly", agentId: "a2" }, ["f@x.example"]],
    [{ kind: "cap_hit", org: true, scope: "month" }, ["o@x.example", S0]],
  ];
  for (const [alert, want] of cases) {
    const { calls, fetchImpl } = recorder();
    const deliver = createOrgAlertRouter({ emailKey: "k", emailFrom: "alerts@x.example", fetchImpl, lookup: pubLookup });
    const result = await deliver({ id: "id", orgId: "o", ...alert }, matrixSettings());
    assert.deepEqual(dests(calls), [...want, "https://hooks.example.com/costcap"].sort(), JSON.stringify(alert));
    // Without the signed webhook: nothing configured means `unconfigured`.
    const { calls: c2, fetchImpl: f2 } = recorder();
    const noHook = { ...matrixSettings(), webhook: null };
    const rows = await createOrgAlertRouter({ emailKey: "k", emailFrom: "alerts@x.example", fetchImpl: f2 })({ id: "id", ...alert }, noHook);
    assert.deepEqual(dests(c2), [...want].sort());
    const rec = {};
    applyDeliveryResult(rec, rows, null, 0);
    assert.equal(rec.delivery, want.length ? "accepted" : "unconfigured", JSON.stringify(alert));
    assert.ok(result.every((r) => r.status !== "failed"));
  }
});

test("acceptance: with no kinds and no routes every alert reaches the same channels as before", async () => {
  const { calls, fetchImpl } = recorder();
  const rows = await createAlertDelivery({ emailKey: "k", emailFrom: "a@x.example", emailTo: ["o@x.example"], slackWebhook: S0, fetchImpl })({ kind: "cap_approaching", agentId: "a2" });
  assert.deepEqual(rows.map((r) => [r.channel, r.status]), [["email", "accepted"], ["slack", "accepted"], ["webhook", "unconfigured"]]);
  assert.deepEqual(dests(calls), ["o@x.example", S0].sort());
});

test("acceptance: only the failing route channel is retried, gives up after 10, S0 never resent; shared URL posts once", async () => {
  const { calls, fetchImpl } = recorder({ [S1]: 500 });
  const settings = { ...matrixSettings(), webhook: null };
  const deliver = createOrgAlertRouter({ emailKey: "k", emailFrom: "a@x.example", fetchImpl });
  const alert = { id: "occ", kind: "cap_hit", team: "payments", scope: "month" };
  const rec = { delivery: "pending" };
  let now = 0, requested = null;
  const gaveUp = [];
  for (let i = 0; i < ALERT_MAX_ATTEMPTS; i++) {
    const rows = await deliver(alert, settings, requested ? { channels: requested } : undefined);
    gaveUp.push(...applyDeliveryResult(rec, rows, requested, now));
    if (i < ALERT_MAX_ATTEMPTS - 1) {
      assert.deepEqual(dueRetryChannels(rec, now), []);
      assert.equal(rec.deliveryRetry[`route:${R1}:slack`].next_at, now + Math.min(2 ** i, 30) * 60_000);
      now = rec.deliveryRetry[`route:${R1}:slack`].next_at;
      requested = dueRetryChannels(rec, now);
      assert.deepEqual(requested, [`route:${R1}:slack`]);
    }
  }
  assert.deepEqual(gaveUp, [`route:${R1}:slack`]);
  assert.equal(rec.deliveryChannels[`route:${R1}:slack`], "gave_up");
  assert.equal(calls.filter((c) => c.slack === S0).length, 1);
  assert.equal(calls.filter((c) => c.slack === S1).length, ALERT_MAX_ATTEMPTS);
  // Same URL on the default and the route: one POST per occurrence.
  const shared = recorder();
  const same = { ...settings, routes: [{ ...settings.routes[0], slackWebhook: S0 }] };
  const rows = await createOrgAlertRouter({ emailKey: "k", emailFrom: "a@x.example", fetchImpl: shared.fetchImpl })(alert, same);
  assert.equal(shared.calls.filter((c) => c.slack === S0).length, 1);
  assert.ok(!rows.some((r) => r.channel === `route:${R1}:slack`));
  // A route-only settings object (no defaults) is still delivered.
  const only = recorder();
  await createOrgAlertRouter({ emailKey: "k", emailFrom: "a@x.example", fetchImpl: only.fetchImpl })(alert, { emails: [], slackWebhook: null, routes: settings.routes });
  assert.deepEqual(dests(only.calls), [S1]);
});

async function fixture(t, deliverAlert) {
  let code;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-routes-")), "store.json");
  const service = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, stripeEnv: {}, verifyChallenge: async (v) => v === "ok", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(auth ? {} : { origin: "http://localhost" }), connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => { const c = await request("/auth/request", { email, turnstileToken: "ok" }); return request("/auth/verify", { challengeId: c.body.challengeId, code }); };
  const agent = async (cookie, name, caps = {}) => { const e = await request("/v1/enrollment-tokens", { caps }, cookie); return (await request("/v1/enroll", { name }, null, e.body.token)).body; };
  return { request, login, agent, sweep: () => service.evaluateFleetAlerts() };
}

test("regression: /v1/alert-settings kinds and routes: access, validation, masking, lifecycle and worker routing", async (t) => {
  const { calls, fetchImpl } = recorder();
  const f = await fixture(t, createOrgAlertRouter({ emailKey: "k", emailFrom: "alerts@x.example", fetchImpl }));
  const owner = await f.login("o@routes.example");
  for (const [email, role] of [["f@routes.example", "admin"], ["v@routes.example", "viewer"]]) await f.request("/v1/invitations", { email, role }, owner.cookie);
  const fin = await f.login("f@routes.example");
  const viewer = await f.login("v@routes.example");
  const other = await f.login("other@elsewhere.example");
  const a1 = await f.agent(owner.cookie, "a1", { day: 10 });
  assert.equal((await f.request("/v1/teams", { name: "payments", agents: [a1.agentId], month: 1000 }, owner.cookie)).status, 200);
  const good = { emails: ["o@routes.example"], slackWebhook: S0, kinds: ["cap_hit", "agent_silent"], routes: [{ name: "payments", teams: ["payments"], slackWebhook: S1 }, { name: "anomalies", kinds: ["spend_anomaly"], emails: ["f@routes.example"] }] };
  // Access.
  assert.equal((await f.request("/v1/alert-settings", good, viewer.cookie)).status, 403);
  const vkey = (await f.request("/v1/api-keys", { name: "ro", role: "viewer" }, owner.cookie)).body.key;
  assert.equal((await f.request("/v1/alert-settings", good, null, vkey)).status, 403);
  // Validation.
  const bads = [{ kinds: ["nope"] }, { routes: [{ name: "x", teams: ["ghost"], slackWebhook: S1 }] }, { routes: [{ name: "x", emails: ["stranger@routes.example"] }] },
    { routes: [{ name: "x", slackWebhook: "https://evil.example/services/x" }] }, { routes: [{ name: "x" }] },
    { routes: Array.from({ length: 11 }, (_, i) => ({ name: `r${i}`, slackWebhook: S1 })) }];
  for (const bad of bads) assert.equal((await f.request("/v1/alert-settings", bad, owner.cookie)).status, 400, JSON.stringify(bad).slice(0, 60));
  const saved = await f.request("/v1/alert-settings", good, owner.cookie);
  assert.equal(saved.status, 200);
  const [r1, r2] = saved.body.routes;
  assert.match(r1.id, /^rt_/);
  assert.deepEqual(saved.body.kinds, ["cap_hit", "agent_silent"]);
  // Another org never sees these routes; a viewer reads them masked.
  const theirs = await f.request("/v1/alert-settings", undefined, other.cookie);
  assert.equal(theirs.body.routes, undefined);
  assert.equal((await f.request("/v1/alert-settings", undefined, viewer.cookie)).body.routes.length, 2);
  // Re-saving R1 without slackWebhook keeps S1.
  assert.equal((await f.request("/v1/alert-settings", { routes: [{ id: r1.id, name: "payments", teams: ["payments"] }, { id: r2.id, name: "anomalies", kinds: ["spend_anomaly"], emails: ["f@routes.example"] }] }, fin.cookie)).status, 200);
  // Worker: a team month cap_hit reaches o@, S0 and S1.
  await f.request("/v1/teams", { name: "payments", agents: [a1.agentId], month: 1 }, owner.cookie);
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts: new Date().toISOString(), cost_usd: 2 }] }, null, a1.token);
  await f.sweep();
  const teamHit = calls.splice(0);
  assert.ok(teamHit.some((c) => c.slack === S1), JSON.stringify(teamHit));
  assert.ok(teamHit.some((c) => c.slack === S0));
  // Masked everywhere: no response or audit body carries a route webhook in full.
  const bodies = [];
  for (const p of ["/v1/alert-settings", "/v1/fleet", "/v1/evidence.json", "/v1/alerts", "/v1/audit.csv"]) bodies.push((await f.request(p, undefined, owner.cookie)).text);
  for (const b of bodies) assert.ok(!b.includes("paymentsone"), "route webhook leaked");
  // Lifecycle: removing member f@ drops them from R2.
  const members = (await f.request("/v1/fleet", undefined, owner.cookie)).body.members;
  const fid = members.find((m) => m.email === "f@routes.example").id;
  assert.equal((await f.request(`/v1/members/${fid}/remove`, {}, owner.cookie)).status, 200);
  const afterRemove = (await f.request("/v1/alert-settings", undefined, owner.cookie)).body;
  assert.deepEqual(afterRemove.routes.find((r) => r.id === r2.id).emails, []);
  assert.equal(afterRemove.routes.find((r) => r.id === r1.id).slackWebhook, "https://hooks.slack.com/services/…sone");
  // Deleting team payments leaves R1 disabled; a1's next alert does not reach S1.
  assert.equal((await f.request("/v1/teams", { name: "payments", remove: true }, owner.cookie)).status, 200);
  const disabled = (await f.request("/v1/alert-settings", undefined, owner.cookie)).body.routes.find((r) => r.id === r1.id);
  assert.deepEqual([disabled.teams, disabled.disabled], [[], true]);
  await f.request("/v1/receipts", { receipts: [{ id: "r2", ts: new Date().toISOString(), cost_usd: 10 }] }, null, a1.token);
  await f.sweep();
  const after = calls.splice(0);
  assert.ok(after.length > 0, "a1 day cap_hit still delivered to defaults");
  assert.ok(!after.some((c) => c.slack === S1), JSON.stringify(after));
});
