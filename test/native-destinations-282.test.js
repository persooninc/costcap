// Issue #282: native PagerDuty (Events v2), Microsoft Teams (Workflows) and Discord alert destinations.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer, ALERT_MAX_ATTEMPTS } from "../src/hosted/server.js";
import { ALERT_KINDS } from "../src/hosted/alerts.js";
import {
  createAlertDelivery, createOrgAlertRouter, maskAlertSettings, hasDestination,
  pagerDutyProblem, teamsWebhookProblem, discordWebhookProblem, pagerDutyUrl, pagerDutySeverity,
  pagerDutyPayload, teamsPayload, discordPayload, maskRoutingKey, maskTeamsWebhook, maskDiscordWebhook, maskPagerDuty,
} from "../src/hosted/delivery.js";

const PD_KEY = "R0utingKeyAbCdEfGhIjKlMnOpQr9z8Y"; // 32 chars, fake
const TEAMS = "https://prod-12.westus.logic.azure.com:443/workflows/abc123/triggers/manual/paths/invoke?api-version=2016-06-01&sig=TeamsSigSecretValue77";
const DISCORD = "https://discord.com/api/webhooks/123456789012345678/DiscordTokenSecret_XY-42";
const SLACK = "https://hooks.slack.com/services/T0/B0/slackSecret0001";
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

function recorder(status = () => 200) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url, body: JSON.parse(o.body), redirect: o.redirect, signal: o.signal });
    const code = status(url);
    return { ok: code >= 200 && code < 300, status: code };
  };
  return { calls, fetchImpl, urls: () => calls.map((c) => c.url) };
}

test("unit: validators accept the documented shapes and reject the rest", () => {
  assert.equal(pagerDutyProblem({ routingKey: PD_KEY, region: "us", kinds: null }, ALERT_KINDS), null);
  assert.equal(pagerDutyProblem({ routingKey: PD_KEY }, ALERT_KINDS), null);
  assert.equal(pagerDutyProblem({ routingKey: PD_KEY, region: "eu", kinds: ["cap_hit", "loop_detected"] }, ALERT_KINDS), null);
  assert.match(pagerDutyProblem({ routingKey: PD_KEY.slice(1) }, ALERT_KINDS), /32-character/);
  assert.match(pagerDutyProblem({ routingKey: PD_KEY.slice(1) + "-" }, ALERT_KINDS), /32-character/);
  assert.match(pagerDutyProblem({ routingKey: PD_KEY, region: "ap" }, ALERT_KINDS), /us or eu/);
  assert.match(pagerDutyProblem({ routingKey: PD_KEY, kinds: ["bogus"] }, ALERT_KINDS), /kinds/);
  assert.match(pagerDutyProblem({ routingKey: PD_KEY, kinds: "cap_hit" }, ALERT_KINDS), /kinds/);
  for (const bad of [null, [], "x"]) assert.match(pagerDutyProblem(bad, ALERT_KINDS), /object/);

  assert.equal(teamsWebhookProblem(TEAMS), null);
  assert.equal(teamsWebhookProblem("https://default1234.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke?sig=s"), null);
  assert.match(teamsWebhookProblem("http://prod-1.westus.logic.azure.com/workflows/x"), /https/);
  assert.match(teamsWebhookProblem("https://acme.webhook.office.com/webhookb2/x"), /retired; use a Workflows webhook/);
  assert.match(teamsWebhookProblem("https://example.com/hook"), /Workflows URL/);
  assert.match(teamsWebhookProblem("https://logic.azure.com.evil.example/x"), /Workflows URL/);
  assert.match(teamsWebhookProblem("https://u:p@prod-1.westus.logic.azure.com/x"), /credentials/);
  assert.match(teamsWebhookProblem("https://prod-1.westus.logic.azure.com:8443/x"), /port 443/);
  assert.match(teamsWebhookProblem("not a url"), /https URL/);
  assert.match(teamsWebhookProblem(42), /https URL/);

  assert.equal(discordWebhookProblem(DISCORD), null);
  assert.equal(discordWebhookProblem("https://discordapp.com/api/webhooks/1/abc"), null);
  for (const bad of [DISCORD + "?wait=true", DISCORD + "#x", "https://evil.example/api/webhooks/1/abc", "http://discord.com/api/webhooks/1/abc", "https://discord.com/api/channels/1/abc", "https://discord.com:8443/api/webhooks/1/abc", "nope", null]) assert.ok(discordWebhookProblem(bad), String(bad));
});

test("unit: masks never contain the secret part", () => {
  assert.equal(maskRoutingKey(PD_KEY), "…8Y".replace("8Y", PD_KEY.slice(-4)));
  assert.equal(maskRoutingKey(null), null);
  assert.equal(maskTeamsWebhook(TEAMS), "https://prod-12.westus.logic.azure.com/…");
  assert.equal(maskTeamsWebhook("::bad"), "https://invalid/…");
  assert.equal(maskTeamsWebhook(""), null);
  assert.equal(maskDiscordWebhook(DISCORD), "https://discord.com/api/webhooks/…-42".replace("…-42", "…" + DISCORD.slice(-4)));
  assert.equal(maskDiscordWebhook(null), null);
  assert.deepEqual(maskPagerDuty({ routingKey: PD_KEY, kinds: ["cap_hit"] }), { routingKey: `…${PD_KEY.slice(-4)}`, region: "us", kinds: ["cap_hit"] });
  assert.equal(maskPagerDuty(null), null);
  const masked = JSON.stringify(maskAlertSettings({ emails: [], pagerduty: { routingKey: PD_KEY, region: "eu", kinds: null }, teamsWebhook: TEAMS, discordWebhook: DISCORD }));
  for (const secret of [PD_KEY, "TeamsSigSecretValue77", "DiscordTokenSecret"]) assert.equal(masked.includes(secret), false, secret);
  assert.equal(JSON.parse(masked).configured, true);
  // Legacy shape unchanged when none of the new fields is set.
  assert.deepEqual(Object.keys(maskAlertSettings({ emails: [] })).sort(), ["configured", "emails", "slackWebhook", "webhook"]);
  for (const only of [{ pagerduty: { routingKey: PD_KEY } }, { teamsWebhook: TEAMS }, { discordWebhook: DISCORD }]) assert.equal(hasDestination(only), true);
  assert.equal(hasDestination({ emails: [] }), false);
});

test("unit: payload builders, severity map and truncation", () => {
  assert.equal(pagerDutyUrl("us"), "https://events.pagerduty.com/v2/enqueue");
  assert.equal(pagerDutyUrl(undefined), "https://events.pagerduty.com/v2/enqueue");
  assert.equal(pagerDutyUrl("eu"), "https://events.eu.pagerduty.com/v2/enqueue");
  assert.deepEqual(["cap_hit", "loop_detected", "agent_silent", "test", "cap_approaching", "cap_projected", "spend_anomaly", "cost_unknown"].map(pagerDutySeverity), ["critical", "error", "error", "info", "warning", "warning", "warning", "warning"]);
  const alert = { id: "al_1", kind: "cap_hit", agentId: "a1", agentName: "builder", routeTeam: "ops", scope: "month", spent: 12, cap: 10, fired_at: "2026-11-17T00:00:00.000Z" };
  const pd = pagerDutyPayload(alert, { routingKey: PD_KEY, text: "x".repeat(5000), dashboardUrl: "https://app.costcap.dev/" });
  assert.equal(pd.event_action, "trigger");
  assert.equal(pd.dedup_key, "costcap:al_1");
  assert.equal(pd.payload.summary.length, 1024);
  assert.deepEqual([pd.payload.source, pd.payload.severity, pd.payload.class, pd.payload.component, pd.payload.group], ["costcap", "critical", "cap_hit", "builder", "ops"]);
  assert.deepEqual([pd.payload.custom_details.kind, pd.payload.custom_details.spent_usd, pd.payload.custom_details.cap_usd], ["cap_hit", 12, 10]);
  assert.deepEqual(pd.links, [{ href: "https://app.costcap.dev/", text: "CostCap dashboard" }]);
  const comps = [{ org: true }, { tag: { key: "k", value: "v" } }, { team: "payments" }, { agentId: "a9" }, {}, { kind: "test" }].map((a) => pagerDutyPayload({ kind: "cap_hit", ...a }, {}).payload.component);
  assert.deepEqual(comps, ["org", "tag:k=v", "payments", "a9", "unknown", "test"]);
  assert.equal(pagerDutyPayload({ kind: "x" }, {}).links, undefined);

  const teams = teamsPayload({ ...alert, kind: "cap_projected", projected: 20 }, { text: "hello", dashboardUrl: "https://app.costcap.dev/" });
  assert.equal(teams.type, "message");
  const card = teams.attachments[0].content;
  assert.equal(teams.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
  assert.match(card.body[0].text, /builder/);
  assert.ok(card.body.some((b) => b.type === "FactSet" && b.facts.some((f) => f.title === "Projected" && f.value === "$20.00")));
  assert.deepEqual(card.actions[0], { type: "Action.OpenUrl", title: "Open dashboard", url: "https://app.costcap.dev/" });
  const anomaly = teamsPayload({ kind: "spend_anomaly", today: 9, baseline: 3, multiplier: 3 }, {}).attachments[0].content;
  assert.ok(anomaly.body[2].facts.some((f) => f.title === "Today vs baseline"));
  assert.equal(anomaly.actions, undefined);
  assert.equal(teamsPayload({ kind: "test" }, {}).attachments[0].content.body[0].text, "CostCap test alert");

  const d = discordPayload(alert, { text: "@everyone " + "y".repeat(3000) });
  assert.equal(d.content.length, 2000);
  assert.deepEqual([d.username, d.allowed_mentions], ["CostCap", { parse: [] }]);
});

test("AC3: one POST per destination with the right shapes; eu region; cap_approaching is warning; 2xx incl. 202/204 accepted", async () => {
  const rec = recorder((url) => (url.includes("discord") ? 204 : url.includes("logic.azure") ? 202 : 200));
  const send = createAlertDelivery({ pagerduty: { routingKey: PD_KEY, region: "us", kinds: null }, teamsWebhook: TEAMS, discordWebhook: DISCORD, dashboardUrl: "https://app.costcap.dev/", fetchImpl: rec.fetchImpl, lookup });
  const results = await send({ id: "al_9", kind: "cap_hit", agentId: "a1", agentName: "builder", scope: "month", spent: 12, cap: 10 });
  assert.deepEqual(results.filter((r) => ["pagerduty", "teams", "discord"].includes(r.channel)).map((r) => [r.channel, r.status]), [["pagerduty", "accepted"], ["teams", "accepted"], ["discord", "accepted"]]);
  assert.deepEqual(rec.urls(), ["https://events.pagerduty.com/v2/enqueue", TEAMS, DISCORD]);
  assert.ok(rec.calls.every((c) => c.redirect === "error" && c.signal));
  const [pd, teams, discord] = rec.calls.map((c) => c.body);
  assert.equal(pd.routing_key, PD_KEY);
  assert.deepEqual([pd.event_action, pd.dedup_key, pd.payload.severity, pd.payload.custom_details.kind, pd.payload.custom_details.spent_usd, pd.payload.custom_details.cap_usd], ["trigger", "costcap:al_9", "critical", "cap_hit", 12, 10]);
  assert.match(JSON.stringify(teams), /builder/);
  assert.match(JSON.stringify(teams), /app\.costcap\.dev/);
  assert.deepEqual(discord.allowed_mentions, { parse: [] });

  const eu = recorder();
  await createAlertDelivery({ pagerduty: { routingKey: PD_KEY, region: "eu" }, fetchImpl: eu.fetchImpl })({ id: "al_2", kind: "cap_approaching", agentId: "a1" });
  assert.deepEqual(eu.urls(), ["https://events.eu.pagerduty.com/v2/enqueue"]);
  assert.equal(eu.calls[0].body.payload.severity, "warning");
});

test("AC4: kind filters (default kinds vs pagerduty.kinds); PagerDuty-only org is accepted, not unconfigured", async () => {
  const rec = recorder();
  const route = createOrgAlertRouter({ emailKey: "k", emailFrom: "alerts@example.invalid", fetchImpl: rec.fetchImpl, lookup });
  const settings = { emails: ["o@x.invalid"], slackWebhook: SLACK, webhook: { url: "https://receiver.example.com/cc", secret: "whsec_x" }, kinds: ["cap_hit"], pagerduty: { routingKey: PD_KEY, region: "us", kinds: ["loop_detected"] }, teamsWebhook: TEAMS, discordWebhook: DISCORD };
  await route({ id: "l1", kind: "loop_detected", agentId: "a" }, settings);
  assert.deepEqual(rec.urls().sort(), ["https://events.pagerduty.com/v2/enqueue", "https://receiver.example.com/cc"]);
  rec.calls.length = 0;
  await route({ id: "c1", kind: "cap_hit", agentId: "a" }, settings);
  assert.deepEqual(rec.urls().sort(), ["https://api.brevo.com/v3/smtp/email", "https://receiver.example.com/cc", DISCORD, SLACK, TEAMS].sort());
  rec.calls.length = 0;
  const only = await route({ id: "c2", kind: "cap_hit", agentId: "a" }, { emails: [], slackWebhook: null, webhook: null, pagerduty: { routingKey: PD_KEY, region: "us", kinds: null } });
  assert.deepEqual(only.find((r) => r.channel === "pagerduty"), { channel: "pagerduty", status: "accepted" });
  assert.equal(only.some((r) => r.status === "accepted"), true);
  // Explicitly requested but unset channels report unconfigured; failures are scrubbed.
  const failing = createAlertDelivery({ teamsWebhook: TEAMS, discordWebhook: DISCORD, fetchImpl: async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); } });
  const res = await failing({ id: "x", kind: "cap_hit" }, { channels: ["pagerduty", "teams", "discord"] });
  assert.deepEqual(res.map((r) => [r.channel, r.status]), [["pagerduty", "unconfigured"], ["teams", "failed"], ["discord", "failed"]]);
  assert.equal(JSON.stringify(res).includes("TeamsSigSecretValue77"), false);
  assert.equal(JSON.stringify(res).includes("DiscordTokenSecret"), false);
  assert.match(res[1].error, /\[redacted\]/);
  // Invalid stored values are never sent.
  const bad = recorder();
  const r2 = await createAlertDelivery({ pagerduty: { routingKey: "short" }, teamsWebhook: "https://example.com/x", discordWebhook: "https://evil.example/api/webhooks/1/a", fetchImpl: bad.fetchImpl })({ kind: "cap_hit" });
  assert.equal(bad.calls.length, 0);
  assert.deepEqual(r2.map((r) => r.channel), ["email", "slack", "webhook"]);
});

async function fixture(t, { now, deliverAlert }) {
  let code;
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-282-")), "store.json"), origin: "http://localhost", secureCookies: false, now, stripeEnv: {}, verifyChallenge: async (v) => v === "test-pass", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert, resolveHost: lookup });
  service.server.keepAliveTimeout = 60_000;
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = () => `http://127.0.0.1:${service.server.address().port}`;
  const raw = (path, body, cookie, auth) => fetch(base() + path, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const request = async (...a) => { const r = await raw(...a); return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] }; };
  const text = async (...a) => (await raw(...a)).text();
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "test-pass" });
    return request("/auth/verify", { challengeId: c.body.challengeId, code });
  };
  return { request, text, login, service };
}
const SECRETS = [PD_KEY, "TeamsSigSecretValue77", "DiscordTokenSecret_XY"];
const noSecrets = (s, where) => { for (const x of SECRETS) assert.equal(String(s).includes(x), false, `${where} leaks ${x.slice(0, 6)}`); };

test("AC1 + AC2 + AC6: access, validation, null removes, masked audit/GET/test/alerts/evidence", async (t) => {
  let clock = Date.parse("2026-11-16T12:00:00Z");
  const rec = recorder();
  // Transport error echoes the URL: must be scrubbed everywhere.
  const fetchImpl = async (url, o) => { if (url === TEAMS) throw new Error(`fetch failed for ${url}`); return rec.fetchImpl(url, o); };
  const deliverAlert = createOrgAlertRouter({ fetchImpl, lookup, dashboardUrl: "https://app.costcap.dev/", nowMs: () => clock });
  const f = await fixture(t, { now: () => clock, deliverAlert });
  const owner = await f.login("own282@a.invalid");
  assert.equal((await f.request("/v1/invitations", { email: "view282@a.invalid", role: "viewer" }, owner.cookie)).status, 201);
  assert.equal((await f.request("/v1/invitations", { email: "adm282@a.invalid", role: "admin" }, owner.cookie)).status, 201);
  const viewer = await f.login("view282@a.invalid");
  const adminU = await f.login("adm282@a.invalid");
  const all = { pagerduty: { routingKey: PD_KEY, region: "us", kinds: null }, teamsWebhook: TEAMS, discordWebhook: DISCORD };
  // Access.
  assert.equal((await f.request("/v1/alert-settings", all, viewer.cookie)).status, 403);
  const key = (await f.request("/v1/api-keys", { name: "k", role: "admin" }, owner.cookie)).body.key;
  assert.equal((await f.request("/v1/alert-settings", all, null, key)).status, 403);
  // Validation.
  for (const bad of [
    { pagerduty: { routingKey: PD_KEY.slice(1) } }, { pagerduty: { routingKey: PD_KEY.slice(1) + "!" } }, { pagerduty: { routingKey: PD_KEY, region: "ap" } }, { pagerduty: { routingKey: PD_KEY, kinds: ["nope"] } },
    { teamsWebhook: "http://prod-1.westus.logic.azure.com/workflows/x" }, { teamsWebhook: "https://acme.webhook.office.com/webhookb2/x" }, { teamsWebhook: "https://example.com/x" },
    { discordWebhook: DISCORD + "?wait=true" }, { discordWebhook: "https://evil.example/api/webhooks/1/abc" },
  ]) assert.equal((await f.request("/v1/alert-settings", bad, owner.cookie)).status, 400, JSON.stringify(bad));
  const office = await f.request("/v1/alert-settings", { teamsWebhook: "https://acme.webhook.office.com/webhookb2/x" }, owner.cookie);
  assert.match(office.body.error, /retired; use a Workflows webhook/);
  // Owner and admin save.
  let r = await f.request("/v1/alert-settings", all, owner.cookie);
  assert.equal(r.status, 200);
  noSecrets(JSON.stringify(r.body), "save");
  assert.deepEqual(r.body.pagerduty, { routingKey: `…${PD_KEY.slice(-4)}`, region: "us", kinds: null });
  assert.equal(r.body.teamsWebhook, "https://prod-12.westus.logic.azure.com/…");
  assert.equal(r.body.discordWebhook, `https://discord.com/api/webhooks/…${DISCORD.slice(-4)}`);
  assert.equal(r.body.configured, true);
  assert.equal((await f.request("/v1/alert-settings", { pagerduty: { routingKey: PD_KEY, region: "eu", kinds: ["cap_hit", "cap_hit"] } }, adminU.cookie)).status, 200);
  r = await f.request("/v1/alert-settings", undefined, viewer.cookie);
  assert.deepEqual([r.body.pagerduty.region, r.body.pagerduty.kinds, r.body.canEdit], ["eu", ["cap_hit"], false]);
  assert.ok(r.body.teamsWebhook && r.body.discordWebhook, "omitted fields keep their saved value");
  noSecrets(JSON.stringify(r.body), "GET");
  // AC6: test send to the three new channels.
  r = await f.request("/v1/alert-settings/test", { channels: ["pagerduty", "teams", "discord"] }, owner.cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => [x.channel, x.status]), [["pagerduty", "accepted"], ["teams", "failed"], ["discord", "accepted"]]);
  assert.deepEqual(r.body.results.map((x) => x.destination), [`…${PD_KEY.slice(-4)}`, "https://prod-12.westus.logic.azure.com/…", `https://discord.com/api/webhooks/…${DISCORD.slice(-4)}`]);
  noSecrets(JSON.stringify(r.body), "test-send");
  const pdCall = rec.calls.find((c) => c.url.includes("pagerduty"));
  assert.equal(pdCall.url, "https://events.eu.pagerduty.com/v2/enqueue");
  assert.equal(pdCall.body.payload.severity, "info");
  assert.match(pdCall.body.dedup_key, /^costcap:test_/);
  assert.equal((await f.request("/v1/alert-settings/test", { channels: ["opsgenie"] }, owner.cookie)).status, 400);
  // Default test send includes configured new channels.
  r = await f.request("/v1/alert-settings/test", {}, owner.cookie);
  assert.deepEqual(r.body.results.map((x) => x.channel), ["email", "slack", "webhook", "pagerduty", "teams", "discord"]);
  assert.equal((await f.request("/v1/alerts", undefined, owner.cookie)).body.alerts.length, 0, "test sends write no alert rows");
  // Fire a real alert so /v1/alerts and evidence carry delivery data.
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "pd-agent" }, null, token)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "o1", ts: new Date(clock).toISOString(), cost_usd: 2, model: "m" }] }, null, agent.token)).status, 200);
  await f.service.evaluateFleetAlerts();
  noSecrets(JSON.stringify((await f.request("/v1/alerts", undefined, owner.cookie)).body), "/v1/alerts");
  noSecrets(JSON.stringify((await f.request("/v1/evidence.json", undefined, owner.cookie)).body), "evidence");
  noSecrets(JSON.stringify((await f.request("/v1/fleet", undefined, owner.cookie)).body), "fleet");
  const csv = await f.text("/v1/audit.csv", undefined, owner.cookie);
  assert.match(csv, /alert_settings\.change/);
  noSecrets(csv, "audit.csv");
  // null removes each field.
  r = await f.request("/v1/alert-settings", { pagerduty: null, teamsWebhook: null, discordWebhook: null }, owner.cookie);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.pagerduty, r.body.teamsWebhook, r.body.discordWebhook], [undefined, undefined, undefined]);
  assert.equal(r.body.configured, false);
});

test("AC5: PagerDuty 500 retries alone with the same dedup_key, then gives up and is audited; routes unchanged", async (t) => {
  let clock = Date.parse("2026-01-15T01:00:00Z");
  const rec = recorder((url) => (url.includes("pagerduty") ? 500 : 200));
  const deliverAlert = createOrgAlertRouter({ fetchImpl: rec.fetchImpl, lookup, nowMs: () => clock });
  const f = await fixture(t, { now: () => clock, deliverAlert });
  const owner = await f.login("retry282@a.invalid");
  assert.equal((await f.request("/v1/alert-settings", { pagerduty: { routingKey: PD_KEY }, teamsWebhook: TEAMS, discordWebhook: DISCORD }, owner.cookie)).status, 200);
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "retry" }, null, token)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "o1", ts: new Date(clock).toISOString(), cost_usd: 2, model: "m" }] }, null, agent.token)).status, 200);
  const sweep = () => f.service.evaluateFleetAlerts();
  await sweep();
  const count = (needle) => rec.calls.filter((c) => c.url.includes(needle)).length;
  assert.deepEqual([count("pagerduty"), count("logic.azure"), count("discord")], [1, 1, 1]);
  const capHit = async () => (await f.request("/v1/fleet", undefined, owner.cookie)).body.alerts.find((a) => a.agentId === agent.agentId && a.kind === "cap_hit");
  assert.equal((await capHit()).delivery, "failed");
  for (let i = 0; i < 14; i++) { clock += 31 * 60_000; await sweep(); }
  const capId = (await capHit()).id;
  const pdFor = rec.calls.filter((c) => c.url.includes("pagerduty") && c.body.dedup_key === `costcap:${capId}`);
  assert.equal(pdFor.length, ALERT_MAX_ATTEMPTS, "cap_hit PagerDuty attempts (agent_silent fires separately)");
  assert.equal(rec.calls.filter((c) => !c.url.includes("pagerduty") && JSON.stringify(c.body).includes("cap_hit")).length, 2, "Teams and Discord sent once for cap_hit");
  const keys = new Set(pdFor.map((c) => c.body.dedup_key));
  assert.equal(keys.size, 1);
  const audit = (await f.request("/v1/fleet", undefined, owner.cookie)).body.audit.filter((e) => e.action === "alert.delivery_gave_up");
  assert.deepEqual(audit.filter((e) => e.detail.alert_id === capId).map((e) => e.detail.channel), ["pagerduty"]);
  // #258 routes still work alongside the new destinations.
  const S1 = "https://hooks.slack.com/services/T1/B1/routeHook1";
  const saved = await f.request("/v1/alert-settings", { routes: [{ name: "all", slackWebhook: S1 }] }, owner.cookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.routes.length, 1);
  assert.ok(saved.body.pagerduty && saved.body.teamsWebhook && saved.body.discordWebhook);
});
