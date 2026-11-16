import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

async function fixture(t, { now } = {}) {
  let code, delivery = [], failDelivery = false, deliveryResult = null, invites = [], failInvite = false, failCode = false;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-service-")), "store.json");
  let service;
  const origin = "http://localhost";
  const start = async () => {
    service = createHostedServer({ storePath, origin, secureCookies: false, now, stripeEnv: {}, verifyChallenge: async (value) => value === "test-pass", sendCode: async (data) => { if (failCode) throw new Error("mail down"); code = data.code; }, sendInvite: async (data) => { if (failInvite) throw new Error("mail down"); invites.push(data); }, deliverAlert: async (a) => { delivery.push(a); return deliveryResult ?? [{ status: failDelivery ? "failed" : "accepted" }]; } });
    // Regression: on slow runners undici reused a socket the server had just
    // idle-closed (5s default) and fetch failed mid-test. Outlive the client.
    service.server.keepAliveTimeout = 60_000;
    await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  };
  await start();
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth, originValue = origin) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: originValue, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => {
    const challenge = await request("/auth/request", { email, turnstileToken: "test-pass" });
    assert.equal(challenge.status, 200);
    const r = await request("/auth/verify", { challengeId: challenge.body.challengeId, code });
    assert.equal(r.status, 200);
    return r;
  };
  return { request, login, service: () => service, delivery, invites: () => invites, setFail: (v) => { failDelivery = v; }, setDeliveryResult: (v) => { deliveryResult = v; }, setInviteFail: (v) => { failInvite = v; }, setCodeFail: (v) => { failCode = v; }, storePath, restart: async () => { service.server.closeAllConnections(); await new Promise((r) => service.server.close(r)); await start(); } };
}

test("verified org-first login, tenant isolation, enrollment, receipt sync and restart", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/v1/fleet")).status, 401);
  assert.equal((await f.request("/auth/request", { email: "a@example.invalid", turnstileToken: "bad" })).status, 403);
  assert.equal((await f.request("/auth/request", { email: "a@example.invalid", turnstileToken: "test-pass" }, null, null, "https://evil.invalid")).status, 403);
  const owner = await f.login("owner@example.invalid");
  const outsider = await f.login("outsider@example.invalid");
  assert.notEqual(owner.body.orgId, outsider.body.orgId); // domain match is not membership
  const enrollment = await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie);
  const enrolled = await f.request("/v1/enroll", { name: "worker" }, null, enrollment.body.token);
  assert.equal(enrolled.status, 201);
  assert.equal((await f.request("/v1/enroll", { name: "replay" }, null, enrollment.body.token)).status, 401);
  const agent = enrolled.body;
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/policy`, { caps: { day: 100 } }, outsider.cookie)).status, 404);
  const updated = await f.request(`/v1/agents/${agent.agentId}/policy`, { killed: true }, owner.cookie);
  assert.equal(updated.body.version, 2);
  const receipt = { id: "r-1", ts: new Date().toISOString(), cost_usd: 0.9, model: "test-model" };
  assert.equal((await f.request("/v1/receipts", { receipts: [receipt] }, null, agent.token)).status, 200);
  assert.equal((await f.request("/v1/receipts", { receipts: [receipt] }, null, agent.token)).status, 200);
  assert.equal((await f.request("/v1/receipts", { receipts: [{ ...receipt, cost_usd: 3 }] }, null, agent.token)).status, 409);
  let fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(fleet.body.receipts.length, 1);
  assert.equal(fleet.body.agents[0].hash, undefined);
  assert.equal((await f.request("/v1/fleet", undefined, outsider.cookie)).body.receipts.length, 0);
  await f.restart();
  assert.equal((await f.request("/v1/policy", undefined, null, agent.token)).body.killed, true);
  f.setFail(true);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  f.setFail(false);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 2);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 2);
  fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.ok(fleet.body.audit.some((e) => e.action === "alert.delivery"));
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/revoke`, {}, owner.cookie)).status, 200);
  assert.equal((await f.request("/v1/policy", undefined, null, agent.token)).status, 401);
  await f.request("/auth/logout", {}, owner.cookie);
  assert.equal((await f.request("/v1/fleet", undefined, owner.cookie)).status, 401);
});

test("billing stays disabled and there is no charge route", async (t) => {
  const f = await fixture(t);
  const health = await f.request("/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.billing, "disabled");
  assert.equal(health.body.beta, true);
  assert.equal(health.body.persistence, "single-process-file");
  assert.equal(health.body.sha, null);
  // /health reports the real package version, never a hardcoded copy that can drift.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(health.body.version, pkg.version);
  const owner = await f.login("billing@example.invalid");
  const fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(fleet.body.billing, "disabled");
  assert.equal((await f.request("/billing")).status, 404);
  assert.equal((await f.request("/stripe/checkout", {})).status, 404);
  const stripe = await f.request("/api/health/stripe");
  assert.equal(stripe.status, 200);
  assert.equal(stripe.body.status, "ok");
  assert.equal(stripe.body.stripe, "disabled");
  assert.deepEqual(stripe.body.checks, { secretKey: false, webhookSecret: false, accountId: false, priceId: false });
  const raw = JSON.stringify(stripe.body);
  assert.equal(raw.includes("sk_"), false);
  assert.equal(raw.includes("rk_"), false);
  assert.equal(raw.includes("whsec_"), false);
});

test("an invitation joins that org and a viewer cannot change policy or invite", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("owner@example.invalid");
  assert.equal((await f.request("/v1/invitations", { email: "not-an-email", role: "viewer" }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/invitations", { email: "viewer@example.invalid", role: "owner" }, owner.cookie)).status, 400);
  const invited = await f.request("/v1/invitations", { email: "viewer@example.invalid", role: "viewer" }, owner.cookie);
  assert.equal(invited.status, 201);
  assert.equal(f.invites().length, 1);
  assert.equal(f.invites()[0].orgName, "example.invalid");
  assert.equal((await f.request("/v1/invitations", { email: "viewer@example.invalid", role: "viewer" }, owner.cookie)).status, 409);
  const stranger = await f.login("stranger@example.invalid");
  assert.notEqual(stranger.body.orgId, owner.body.orgId);
  const viewer = await f.login("viewer@example.invalid");
  assert.equal(viewer.body.orgId, owner.body.orgId);
  assert.equal(viewer.body.role, "viewer");
  const fleet = await f.request("/v1/fleet", undefined, viewer.cookie);
  assert.equal(fleet.body.role, "viewer");
  assert.equal(fleet.body.invitations.length, 0);
  assert.equal((await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, viewer.cookie)).status, 403);
  assert.equal((await f.request("/v1/invitations", { email: "other@example.invalid", role: "viewer" }, viewer.cookie)).status, 403);
  const enrollment = await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie);
  const agent = await f.request("/v1/enroll", { name: "worker" }, null, enrollment.body.token);
  assert.equal((await f.request(`/v1/agents/${agent.body.agentId}/policy`, { killed: true }, viewer.cookie)).status, 403);
  const ownerFleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(ownerFleet.body.invitations.length, 0);
  const pending = await f.request("/v1/invitations", { email: "later@example.invalid", role: "admin" }, owner.cookie);
  assert.equal(pending.status, 201);
  assert.equal((await f.request(`/v1/invitations/${pending.body.id}/revoke`, {}, owner.cookie)).status, 200);
  const later = await f.login("later@example.invalid");
  assert.notEqual(later.body.orgId, owner.body.orgId);
  assert.equal(later.body.role, "owner");
  f.setInviteFail(true);
  assert.equal((await f.request("/v1/invitations", { email: "second@example.invalid", role: "admin" }, owner.cookie)).status, 503);
  assert.equal((await f.request("/v1/fleet", undefined, owner.cookie)).body.invitations.length, 0);
  assert.equal((await f.request("/v1/invitations", { email: "owner@example.invalid", role: "admin" }, owner.cookie)).status, 409);
});

test("verification wrong-code attempt limit persists and challenge is one-use", async (t) => {
  const f = await fixture(t);
  const challenge = await f.request("/auth/request", { email: "attempt@example.invalid", turnstileToken: "test-pass" });
  for (let i = 0; i < 6; i++) assert.equal((await f.request("/auth/verify", { challengeId: challenge.body.challengeId, code: "wrong" })).status, 401);
  const result = await f.request("/auth/verify", { challengeId: challenge.body.challengeId, code: "wrong" });
  assert.match(result.body.error, /expired/);
  assert.equal((await f.request("/v1/enrollment-tokens", { caps: {} })).status, 401);
});

test("auth/request is rate limited per IP after five sends in the window", async (t) => {
  const f = await fixture(t);
  // Each turnstile-passing request records one send against the caller IP.
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.request("/auth/request", { email: "flood@example.invalid", turnstileToken: "test-pass" })).status, 200);
  }
  // The sixth within the hour is refused before any code is sent, so the
  // metered mailer and the brute-force surface stay bounded per IP.
  const limited = await f.request("/auth/request", { email: "flood@example.invalid", turnstileToken: "test-pass" });
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /later/i);
});

test("a failed verification-code send returns 503 and rolls back the challenge", async (t) => {
  const f = await fixture(t);
  f.setCodeFail(true);
  const result = await f.request("/auth/request", { email: "bounce@example.invalid", turnstileToken: "test-pass" });
  assert.equal(result.status, 503);
  assert.match(result.body.error, /unavailable/i);
  assert.equal(result.body.challengeId, undefined); // the caller never receives an id it cannot verify
  // The half-created challenge must be deleted, not left dangling in the store.
  const stored = JSON.parse(readFileSync(f.storePath, "utf8"));
  assert.equal(Object.keys(stored.challenges).length, 0);
  // Delivery recovered: a subsequent request issues a usable challenge.
  f.setCodeFail(false);
  const ok = await f.request("/auth/request", { email: "bounce@example.invalid", turnstileToken: "test-pass" });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.challengeId);
});

test("a synced run-scope budget block is delivered once", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("run-cap@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { run: 1, day: 50 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "runner" }, null, token)).body;
  const ts = new Date().toISOString();
  const sync = await f.request("/v1/receipts", { receipts: [
    { id: "under", ts, cost_usd: 0.4, model: "test" },
    { id: "blocked", ts, cost_usd: 0, blocked: true, reason: "budget_exceeded", scope: "run", model: "test" },
  ] }, null, agent.token);
  assert.equal(sync.status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  assert.equal(f.delivery[0].kind, "cap_hit");
  assert.equal(f.delivery[0].scope, "run");
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
});

test("a month-scope budget block pages as cap_hit and is not a loop", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("month-cap@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { month: 20 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "month" }, null, token)).body;
  const ts = new Date().toISOString();
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "month-block", ts, cost_usd: 0, blocked: true, reason: "budget_exceeded", scope: "month", model: "test" },
  ] }, null, agent.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  assert.equal(f.delivery[0].kind, "cap_hit");
  assert.equal(f.delivery[0].scope, "month");
  assert.equal(f.delivery.filter((d) => d.kind === "loop_detected").length, 0);
});

test("fixture server outlives the client keep-alive window (fetch reuse race)", async (t) => {
  const f = await fixture(t);
  assert.ok(f.service().server.keepAliveTimeout > 5000);
  assert.equal((await f.request("/v1/fleet")).status, 401);
});

test("a step-budget receipt pages once, ages out, and re-arms", async (t) => {
  let clock = Date.parse("2026-10-12T12:00:00.000Z");
  const f = await fixture(t, { now: () => clock });
  const owner = await f.login("steps@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 5 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "steps" }, null, token)).body;
  const stamp = () => new Date(clock).toISOString();
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "steps-1", ts: stamp(), cost_usd: 0, blocked: true, reason: "step_budget", model: "test" },
  ] }, null, agent.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  assert.equal(f.delivery[0].kind, "loop_detected");
  assert.equal(f.delivery[0].reason, "step_budget");
  assert.equal(f.delivery.filter((d) => d.kind === "cap_hit").length, 0);
  assert.equal(f.delivery[0].key, `loop_detected:${agent.agentId}`);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  clock += 3600_000 + 1;
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  const fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(fleet.body.alerts.find((a) => a.kind === "loop_detected").active, false);
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "steps-2", ts: stamp(), cost_usd: 0, blocked: true, reason: "step_budget", model: "test" },
  ] }, null, agent.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 2);
  assert.equal(f.delivery[1].kind, "loop_detected");
});

test("an unconfigured channel does not retry an accepted or empty delivery", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("channels@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "channels" }, null, token)).body;
  const ts = new Date().toISOString();
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "near", ts, cost_usd: 0.9, model: "test" },
  ] }, null, agent.token)).status, 200);
  f.setDeliveryResult([{ channel: "email", status: "unconfigured" }, { channel: "slack", status: "accepted" }]);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  let fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(fleet.body.alerts.find((a) => a.kind === "cap_approaching").delivery, "accepted");

  f.setDeliveryResult([{ channel: "email", status: "unconfigured" }, { channel: "slack", status: "unconfigured" }]);
  const tokenB = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agentB = (await f.request("/v1/enroll", { name: "quiet-channel" }, null, tokenB)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "near-b", ts, cost_usd: 0.9, model: "test" },
  ] }, null, agentB.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 2);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 2);
  fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(fleet.body.alerts.find((a) => a.agentId === agentB.agentId).delivery, "unconfigured");

  f.setDeliveryResult([{ channel: "email", status: "accepted" }, { channel: "slack", status: "failed" }]);
  const tokenC = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agentC = (await f.request("/v1/enroll", { name: "retry-channel" }, null, tokenC)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "near-c", ts, cost_usd: 0.9, model: "test" },
  ] }, null, agentC.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 3);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 4);
  fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(fleet.body.alerts.find((a) => a.agentId === agentC.agentId).delivery, "failed");
});

test("agent silence arms, clears after a policy poll, and re-arms", async (t) => {
  let clock = Date.parse("2026-10-12T12:00:00.000Z");
  const f = await fixture(t, { now: () => clock });
  const owner = await f.login("silent@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 5 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "quiet" }, null, token)).body;
  clock += 6 * 3600_000 + 1;
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  assert.equal(f.delivery[0].kind, "agent_silent");
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  assert.equal((await f.request("/v1/policy", undefined, null, agent.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  const fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(fleet.body.alerts.find((a) => a.kind === "agent_silent").active, false);
  clock += 6 * 3600_000 + 1;
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 2);
  assert.equal(f.delivery[1].kind, "agent_silent");
});

test("revoking an agent clears its alert and blocks another receipt", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("revoke@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "gone" }, null, token)).body;
  const ts = new Date().toISOString();
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "near", ts, cost_usd: 0.9, model: "test" },
  ] }, null, agent.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  assert.equal(f.delivery[0].kind, "cap_approaching");
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/revoke`, {}, owner.cookie)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  const fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(fleet.body.alerts.find((a) => a.agentId === agent.agentId).active, false);
  assert.equal(fleet.body.agents.find((a) => a.id === agent.agentId).revoked, true);
  assert.equal((await f.request("/v1/policy", undefined, null, agent.token)).status, 401);
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "after", ts, cost_usd: 1, model: "test" },
  ] }, null, agent.token)).status, 401);
  const otherToken = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const other = (await f.request("/v1/enroll", { name: "still-here" }, null, otherToken)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "near-other", ts, cost_usd: 0.9, model: "test" },
  ] }, null, other.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 2);
  assert.equal(f.delivery[1].agentId, other.agentId);
  assert.equal(f.delivery[1].kind, "cap_approaching");
});

test("an offset timestamp counts on its UTC day and the next day clears the alert", async (t) => {
  let clock = Date.parse("2026-10-12T18:00:00.000Z");
  const f = await fixture(t, { now: () => clock });
  const owner = await f.login("offset@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 2, month: 10 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "offset" }, null, token)).body;
  // 23:30-04:00 is 03:30Z on 2026-10-13, not the 12th in the string.
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "shifted", ts: "2026-10-12T23:30:00-04:00", cost_usd: 2, model: "test" },
    { id: "shifted-unknown", ts: "2026-10-12T23:45:00-04:00", cost_usd: null, model: "test" },
  ] }, null, agent.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 0);
  let fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  let spend = fleet.body.agents.find((a) => a.id === agent.agentId).spend;
  assert.equal(spend.day.usd, 0);
  assert.equal(spend.day.unknown, 0);
  assert.equal(spend.month.usd, 2);
  assert.equal(spend.month.unknown, 1);
  clock = Date.parse("2026-10-13T12:00:00.000Z");
  assert.equal((await f.request("/v1/policy", undefined, null, agent.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  assert.equal(f.delivery[0].kind, "cap_hit");
  assert.equal(f.delivery[0].scope, "day");
  fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  spend = fleet.body.agents.find((a) => a.id === agent.agentId).spend;
  assert.equal(spend.day.usd, 2);
  assert.equal(spend.day.unknown, 1);
  clock = Date.parse("2026-10-14T12:00:00.000Z");
  assert.equal((await f.request("/v1/policy", undefined, null, agent.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  const ownerAgain = await f.login("offset@example.invalid");
  fleet = await f.request("/v1/fleet", undefined, ownerAgain.cookie);
  assert.equal(fleet.body.alerts.find((a) => a.kind === "cap_hit").active, false);
  assert.equal(fleet.body.agents.find((a) => a.id === agent.agentId).spend.day.usd, 0);
});

test("fleet spend is per agent, UTC day and month, and unknown cost is not zero", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("spend@example.invalid");
  const other = await f.login("other-spend@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 5, month: 20 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "meter" }, null, token)).body;
  const now = new Date();
  const today = now.toISOString();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12)).toISOString();
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "today", ts: today, cost_usd: 1.25, model: "test" },
    { id: "old", ts: lastMonth, cost_usd: 4, model: "test" },
    { id: "unk", ts: today, cost_usd: null, model: "test" },
  ] }, null, agent.token)).status, 200);
  const fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  const spend = fleet.body.agents.find((a) => a.id === agent.agentId).spend;
  assert.equal(spend.day.usd, 1.25);
  assert.equal(spend.day.unknown, 1);
  assert.equal(spend.month.usd, 1.25);
  assert.equal(spend.month.unknown, 1);
  assert.equal(spend.all.usd, 5.25);
  assert.equal(spend.all.unknown, 1);
  const hidden = await f.request("/v1/fleet", undefined, other.cookie);
  assert.equal(hidden.body.agents.length, 0);
  assert.equal(hidden.body.receipts.length, 0);
});

test("receipt csv is the signed-in org only and ignores an agent bearer", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("csv@example.invalid");
  const other = await f.login("csv-other@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 5 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "meter" }, null, token)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "safe", ts: "2026-10-13T01:00:00.000Z", cost_usd: 0.5, model: "plain" },
    { id: "formula", ts: "2026-10-13T02:00:00.000Z", cost_usd: null, model: "=1+1", reason: "budget_exceeded", scope: "day" },
  ] }, null, agent.token)).status, 200);
  const port = f.service().server.address().port;
  const pull = async (cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/receipts.csv`, { headers: { ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) } });
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  };
  assert.equal((await pull()).status, 401);
  assert.equal((await pull(null, agent.token)).status, 401);
  const mine = await pull(owner.cookie);
  assert.equal(mine.status, 200);
  assert.match(mine.type, /text\/csv/);
  assert.match(mine.body, /plain,0\.5/);
  assert.match(mine.body, /'=1\+1,,budget_exceeded,day/);
  const theirs = await pull(other.cookie);
  assert.equal(theirs.body.trim(), "ts,agent_id,receipt_id,model,cost_usd,reason,scope");
});

test("regression #109: month burn-rate projection pages once through the fleet worker", async (t) => {
  let clock = Date.parse("2026-11-16T00:00:00.000Z");
  const f = await fixture(t, { now: () => clock });
  const owner = await f.login("burn@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { month: 20 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "burn" }, null, token)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "burn-1", ts: "2026-11-10T00:00:00.000Z", cost_usd: 11, model: "test" },
    { id: "burn-2", ts: "2026-11-11T00:00:00.000Z", cost_usd: null, model: "test" },
  ] }, null, agent.token)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  assert.equal(f.delivery[0].kind, "cap_projected");
  assert.equal(f.delivery[0].lowerBound, true);
  assert.equal(f.delivery[0].projected, 22);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
});

test("#112 GET /v1/agents/:id/budget: cited verdicts, unknown-cost honesty, tenant isolation", async (t) => {
  const { agentBudgetStatus } = await import("../src/check.js");
  const f = await fixture(t);
  const owner = await f.login("verdict-owner@example.invalid");
  const outsider = await f.login("verdict-outsider@example.invalid");
  const enroll = async (caps, name) => {
    const tok = (await f.request("/v1/enrollment-tokens", { caps }, owner.cookie)).body.token;
    return (await f.request("/v1/enroll", { name }, null, tok)).body;
  };
  const ts = new Date().toISOString();
  const sync = (agent, receipts) => f.request("/v1/receipts", { receipts }, null, agent.token);
  const budget = (id, cookie, auth) => f.request(`/v1/agents/${id}/budget`, undefined, cookie, auth);

  // AC1: under caps
  const a = await enroll({ day: 5, month: 20 }, "under");
  await sync(a, [{ id: "r1", ts, cost_usd: 1.5 }]);
  let r = await budget(a.agentId, owner.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.verdict, "ok");
  assert.equal(r.body.reason, null);
  assert.equal(r.body.agent_id, a.agentId);
  assert.deepEqual(r.body.budget_remaining, { day_usd: 3.5, month_usd: 18.5 });
  // AC7: key parity with local agent-status
  const local = agentBudgetStatus({ receiptsPath: join(mkdtempSync(join(tmpdir(), "cc-par-")), "none.jsonl"), policy: { agents: { x: { day: 5 } } }, agent_id: "x" });
  assert.deepEqual(Object.keys(r.body).sort(), Object.keys(local).sort());
  assert.deepEqual(Object.keys(r.body.budget_remaining).every((k) => k in local.budget_remaining), true);
  // agent token may read itself
  assert.equal((await budget(a.agentId, null, a.token)).body.verdict, "ok");

  // Regression: one null-cost receipt flips the passing verdict (AC3)
  await sync(a, [{ id: "r2", ts, cost_usd: null }]);
  r = await budget(a.agentId, owner.cookie);
  assert.equal(r.body.verdict, "accounting_unavailable");
  assert.equal(r.body.reason, "unreconciled_receipt");
  assert.equal(r.body.unknown_receipts, 1);
  assert.equal(r.body.ok, false);

  // AC2: over a cap
  const b = await enroll({ day: 1 }, "over");
  await sync(b, [{ id: "r1", ts, cost_usd: 1 }]);
  r = await budget(b.agentId, owner.cookie);
  assert.equal(r.body.verdict, "budget_exceeded");
  assert.equal(r.body.scope, "day");
  assert.equal(r.body.cap_usd, 1);
  assert.equal(r.body.spent_usd, 1);
  assert.deepEqual(r.body.budget_remaining, { day_usd: 0, month_usd: null });

  // AC6: no caps
  const c = await enroll({}, "nocap");
  r = await budget(c.agentId, owner.cookie);
  assert.equal(r.body.verdict, "no_budget_policy");
  assert.equal(r.body.budget_remaining, null);

  // AC5: isolation and auth
  const cross = await budget(a.agentId, outsider.cookie);
  const unknown = await budget("does-not-exist", outsider.cookie);
  assert.equal(cross.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(cross.body, unknown.body);
  assert.equal((await budget(b.agentId, null, a.token)).status, 404);
  assert.equal((await budget(a.agentId)).status, 401);

  // AC4: killed, then revoked
  await f.request(`/v1/agents/${b.agentId}/policy`, { killed: true }, owner.cookie);
  assert.equal((await budget(b.agentId, owner.cookie)).body.verdict, "killed");
  await f.request(`/v1/agents/${c.agentId}/revoke`, {}, owner.cookie);
  r = await budget(c.agentId, owner.cookie);
  assert.equal(r.body.verdict, "revoked");
  assert.equal(r.body.ok, false);
  assert.equal((await budget(c.agentId, null, c.token)).status, 401);
});

test("#112 a viewer may read an agent budget verdict", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("vb-owner@example.invalid");
  const tok = (await f.request("/v1/enrollment-tokens", { caps: { month: 2 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "v" }, null, tok)).body;
  await f.request("/v1/invitations", { email: "vb-viewer@example.invalid", role: "viewer" }, owner.cookie);
  const viewer = await f.login("vb-viewer@example.invalid");
  assert.equal(viewer.body.role, "viewer");
  const r = await f.request(`/v1/agents/${agent.agentId}/budget`, undefined, viewer.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.verdict, "ok");
  assert.deepEqual(r.body.budget_remaining, { day_usd: null, month_usd: 2 });
});

test("#113 fleet freeze: admin only, required reason, org-scoped, audited, idempotent", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("freeze-owner@example.invalid");
  const outsider = await f.login("freeze-outsider@example.invalid");
  const enrollAgent = async (who, name) => {
    const e = await f.request("/v1/enrollment-tokens", { caps: { day: 5 } }, who.cookie);
    return (await f.request("/v1/enroll", { name }, null, e.body.token)).body;
  };
  const a = await enrollAgent(owner, "a"), b = await enrollAgent(owner, "b"), gone = await enrollAgent(owner, "gone");
  const other = await enrollAgent(outsider, "other");
  await f.request(`/v1/agents/${gone.agentId}/revoke`, {}, owner.cookie);
  await f.request("/v1/invitations", { email: "freeze-viewer@example.invalid", role: "viewer" }, owner.cookie);
  const viewer = await f.login("freeze-viewer@example.invalid");
  const snapshot = async () => JSON.stringify((await f.request("/v1/fleet", undefined, owner.cookie)).body.agents.map((x) => x.policy));
  const before = await snapshot();
  // Criterion 2: no state change on 401/403/400.
  assert.equal((await f.request("/v1/fleet/freeze", { reason: "x" })).status, 401);
  assert.equal((await f.request("/v1/fleet/freeze", { reason: "x" }, viewer.cookie)).status, 403);
  assert.equal((await f.request("/v1/fleet/resume", { reason: "x" }, viewer.cookie)).status, 403);
  assert.equal((await f.request("/v1/fleet/freeze", {}, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/fleet/freeze", { reason: "   " }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/fleet/freeze", { reason: "y".repeat(501) }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/fleet/freeze", { reason: 7 }, owner.cookie)).status, 400);
  assert.equal(await snapshot(), before);
  // Criterion 5 setup: b killed individually, with a recorded reason (criterion 3).
  assert.equal((await f.request(`/v1/agents/${b.agentId}/policy`, { killed: true, reason: "b loops" }, owner.cookie)).status, 200);
  assert.equal((await f.request(`/v1/agents/${b.agentId}/policy`, { killed: true, reason: "" }, owner.cookie)).status, 400);
  // Criterion 1.
  const frozen = await f.request("/v1/fleet/freeze", { reason: "runaway spend" }, owner.cookie);
  assert.equal(frozen.status, 200);
  assert.deepEqual(frozen.body, { frozen: true, alreadyFrozen: false, count: 1, agentIds: [a.agentId] });
  let fleet = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  assert.equal(fleet.fleetFrozen, true);
  const byId = Object.fromEntries(fleet.agents.map((x) => [x.id, x.policy]));
  assert.deepEqual([byId[a.agentId].killed, byId[a.agentId].version], [true, 2]);
  assert.equal(byId[b.agentId].killed, true);
  assert.equal(byId[gone.agentId].killed, false);
  const otherPolicy = (await f.request("/v1/policy", undefined, null, other.token)).body;
  assert.deepEqual([otherPolicy.killed, otherPolicy.version], [false, 1]);
  assert.equal((await f.request("/v1/fleet", undefined, outsider.cookie)).body.fleetFrozen, false);
  // Criterion 6: idempotent.
  const again = await f.request("/v1/fleet/freeze", { reason: "again" }, owner.cookie);
  assert.equal(again.body.alreadyFrozen, true);
  assert.equal((await f.request("/v1/policy", undefined, null, a.token)).body.version, 2);
  // Criterion 5: resume revives only what the freeze killed.
  const resumed = await f.request("/v1/fleet/resume", { reason: "fixed" }, owner.cookie);
  assert.deepEqual(resumed.body, { frozen: false, notFrozen: false, count: 1, agentIds: [a.agentId] });
  assert.equal((await f.request("/v1/policy", undefined, null, a.token)).body.killed, false);
  assert.equal((await f.request("/v1/policy", undefined, null, b.token)).body.killed, true);
  assert.equal((await f.request("/v1/fleet/resume", { reason: "noop" }, owner.cookie)).body.notFrozen, true);
  // Criterion 3: one audit entry each, with actor, reason and agent ids; survives restart.
  await f.restart();
  fleet = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  const freezes = fleet.audit.filter((e) => e.action === "fleet.freeze"), resumes = fleet.audit.filter((e) => e.action === "fleet.resume");
  assert.equal(freezes.length, 1);
  assert.deepEqual(freezes[0].detail, { reason: "runaway spend", agentIds: [a.agentId] });
  assert.equal(freezes[0].actor, owner.body.id ?? freezes[0].actor);
  assert.ok(freezes[0].actor);
  assert.deepEqual(resumes.map((e) => e.detail), [{ reason: "fixed", agentIds: [a.agentId] }]);
  assert.ok(fleet.audit.some((e) => e.action === "policy.change" && e.target === b.agentId && e.detail.reason === "b loops"));
  assert.equal((await f.request("/v1/fleet", undefined, outsider.cookie)).body.audit.some((e) => e.action.startsWith("fleet.")), false);
});

test("regression #113: an enrolled wrapper honors a fleet freeze at its next poll and runs after resume", async (t) => {
  const { createFleetClient, enroll } = await import("../src/hosted/client.js");
  const f = await fixture(t);
  const owner = await f.login("freeze-client@example.invalid");
  const e = await f.request("/v1/enrollment-tokens", { caps: { day: 5 } }, owner.cookie);
  const dir = mkdtempSync(join(tmpdir(), "cc-freeze-client-"));
  const path = join(dir, "enrollment.json");
  await enroll({ url: `http://127.0.0.1:${f.service().server.address().port}`, token: e.body.token, name: "wrapped", path });
  const client = createFleetClient({ path, receiptsPath: join(dir, "receipts.jsonl") });
  assert.equal(client.policy().killed, false);
  await f.request("/v1/fleet/freeze", { reason: "incident" }, owner.cookie);
  assert.equal(client.policy().killed, false); // not instant: cached until the next poll
  assert.equal((await client.sync()).online, true);
  assert.equal(client.policy().killed, true);
  await f.request("/v1/fleet/resume", { reason: "resolved" }, owner.cookie);
  await client.sync();
  assert.equal(client.policy().killed, false);
});

test("#113 fleet freeze state round-trips through the Postgres record mapping", async () => {
  const { toRecords, fromRecords } = await import("../src/hosted/store-records.js");
  const { EMPTY_STATE } = await import("../src/hosted/store.js");
  const state = { ...structuredClone(EMPTY_STATE), fleetFreezes: { org1: { orgId: "org1", active: true, reason: "r", agentIds: ["x"] } } };
  const recs = toRecords(state);
  assert.equal(recs.get("fleetFreezes\u0000org1").orgId, "org1");
  assert.deepEqual(fromRecords([...recs.values()], EMPTY_STATE), state);
});

test("#114 hosted maxSteps: validation, versioning, clearing, budget run steps", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("steps-owner@example.invalid");
  const tok = (await f.request("/v1/enrollment-tokens", { caps: {}, maxSteps: 4 }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "stepper" }, null, tok)).body;
  assert.equal(agent.policy.maxSteps, 4);
  assert.equal((await f.request("/v1/enrollment-tokens", { maxSteps: 0 }, owner.cookie)).status, 400);
  const set = (body) => f.request(`/v1/agents/${agent.agentId}/policy`, body, owner.cookie);
  let r = await set({ maxSteps: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 2);
  assert.equal(r.body.maxSteps, 5);
  for (const bad of [0, -1, 2.5, "5"]) assert.equal((await set({ maxSteps: bad })).status, 400, String(bad));
  const policy = (await f.request("/v1/policy", undefined, null, agent.token)).body;
  assert.equal(policy.version, 2);
  assert.equal(policy.maxSteps, 5);
  // Omitting maxSteps keeps it; null clears it.
  assert.equal((await set({ caps: { day: 9 } })).body.maxSteps, 5);
  const fleet = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  assert.equal(fleet.audit.filter((x) => x.action === "policy.change").at(-1).detail.policy.maxSteps, 5);
  // Budget reports run steps.
  const ts = new Date().toISOString();
  await f.request("/v1/receipts", { receipts: [1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, ts, cost_usd: 0.01, run_id: "run-a" })) }, null, agent.token);
  r = await f.request(`/v1/agents/${agent.agentId}/budget?run_id=run-a`, undefined, owner.cookie);
  assert.equal(r.body.max_steps, 5);
  assert.equal(r.body.steps, 5);
  assert.equal(r.body.verdict, "breaker_open");
  assert.equal(r.body.reason, "step_budget");
  r = await f.request(`/v1/agents/${agent.agentId}/budget?run_id=run-b`, undefined, owner.cookie);
  assert.equal(r.body.steps, 0);
  assert.equal(r.body.verdict, "ok");
  r = await set({ maxSteps: null });
  assert.equal(r.status, 200);
  assert.equal("maxSteps" in r.body, false);
});
test("#114 enrolled wrapper enforces hosted maxSteps per run, offline from cache, tighter-wins", async (t) => {
  const http = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { enroll } = await import("../src/hosted/client.js");
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; req.resume(); req.on("end", () => res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 0 } }))); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => up.close());
  const f = await fixture(t);
  const owner = await f.login("steps-wrap@example.invalid");
  const tok = (await f.request("/v1/enrollment-tokens", { caps: {} }, owner.cookie)).body.token;
  const dir = mkdtempSync(join(tmpdir(), "cc-steps-"));
  const enrollment = join(dir, "enrollment.json");
  const receipts = join(dir, "r.jsonl");
  const { agentId } = await enroll({ url: `http://127.0.0.1:${f.service().server.address().port}`, token: tok, name: "looper", path: enrollment });
  assert.equal((await f.request(`/v1/agents/${agentId}/policy`, { maxSteps: 5 }, owner.cookie)).status, 200);
  const script = `for (let i = 0; i < 12; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: "{}" }); await r.text(); if (r.status !== 200) { console.log("blocked " + i); break; } }`;
  const run = (extra = []) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "wrap", ...extra, "--agent", agentId, "--enrollment", enrollment, "--receipts", receipts, "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.address().port}` } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out: out.trim(), err }));
  });
  // Criterion 2: the 6th call is refused with a step_budget receipt; a new run starts at 0.
  let r = await run();
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "blocked 5");
  assert.equal(hits, 5);
  const blocked = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.blocked);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, "step_budget");
  assert.equal(blocked[0].max_steps, 5);
  assert.equal(blocked[0].agent_id, agentId);
  hits = 0;
  r = await run();
  assert.equal(r.out, "blocked 5");
  assert.equal(hits, 5);
  // Criterion 4: a local value tightens, never loosens.
  r = await run(["--max-steps", "3"]);
  assert.equal(r.out, "blocked 3");
  r = await run(["--max-steps", "10"]);
  assert.equal(r.out, "blocked 5");
  // Criterion 3: hosted API stopped, the cached maxSteps still applies.
  f.service().server.closeAllConnections();
  await new Promise((res) => f.service().server.close(res));
  hits = 0;
  r = await run();
  assert.match(r.err, /fleet offline; cached policy enforced/);
  assert.equal(r.out, "blocked 5");
  assert.equal(hits, 5);
});

test("#114 maxSteps round-trips through the Postgres record mapping", async () => {
  const { toRecords, fromRecords } = await import("../src/hosted/store-records.js");
  const { EMPTY_STATE } = await import("../src/hosted/store.js");
  const state = { ...structuredClone(EMPTY_STATE), agents: { a1: { id: "a1", orgId: "o", name: "n", hash: "h", policy: { version: 2, caps: {}, killed: false, maxSteps: 5 }, lastSeen: 1, revoked: false } } };
  assert.deepEqual(fromRecords([...toRecords(state).values()], EMPTY_STATE), state);
});
