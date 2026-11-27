import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

async function fixture(t, { now, extra = {} } = {}) {
  let code, delivery = [], failDelivery = false, deliveryResult = null, invites = [], failInvite = false, failCode = false;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-service-")), "store.json");
  let service;
  const origin = "http://localhost";
  const start = async () => {
    service = createHostedServer({ storePath, origin, secureCookies: false, now, stripeEnv: {}, verifyChallenge: async (value) => value === "test-pass", sendCode: async (data) => { if (failCode) throw new Error("mail down"); code = data.code; }, sendInvite: async (data) => { if (failInvite) throw new Error("mail down"); invites.push(data); }, deliverAlert: async (a) => { /* #279: cost_unknown pages are covered in unknown-cost-alerts.test.js */ if (a.kind !== "cost_unknown") delivery.push(a); return deliveryResult ?? [{ status: failDelivery ? "failed" : "accepted" }]; }, ...extra });
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
  const rawVerify = (challengeId) => request("/auth/verify", { challengeId, code });
  return { request, login, rawVerify, service: () => service, delivery, invites: () => invites, setFail: (v) => { failDelivery = v; }, setDeliveryResult: (v) => { deliveryResult = v; }, setInviteFail: (v) => { failInvite = v; }, setCodeFail: (v) => { failCode = v; }, storePath, restart: async () => { service.server.closeAllConnections(); await new Promise((r) => service.server.close(r)); await start(); } };
}

test("verified org-first login, tenant isolation, enrollment, receipt sync and restart", async (t) => {
  let skew = 0;
  const f = await fixture(t, { now: () => Date.now() + skew });
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
  skew += 61_000;
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
  let skew = 0;
  const f = await fixture(t, { now: () => Date.now() + skew });
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
  assert.equal(f.delivery.length, 3, "issue #206: backoff, not every sweep");
  skew += 61_000;
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
  assert.match(mine.body, /'=1\+1,,,,,budget_exceeded,day/);
  const theirs = await pull(other.cookie);
  assert.equal(theirs.body.trim(), "ts,agent_id,receipt_id,run_id,model,cost_usd,cost_source,settled_cost_usd,settle_source,reason,scope,outcome,tags");
});

test("#149: receipts.csv since/until/agent_id filters, 400s, tenant isolation and total header", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("csv149@example.invalid");
  const other = await f.login("csv149-other@example.invalid");
  const enrol = async (cookie, name) => (await f.request("/v1/enroll", { name }, null, (await f.request("/v1/enrollment-tokens", { caps: { day: 5 } }, cookie)).body.token)).body;
  const a = await enrol(owner.cookie, "a"), b = await enrol(owner.cookie, "b"), foreign = await enrol(other.cookie, "z");
  await f.request("/v1/receipts", { receipts: [{ id: "a-old", ts: "2026-10-01T01:00:00.000Z", cost_usd: 1 }, { id: "a-new", ts: "2026-10-20T01:00:00.000Z", cost_usd: 1 }] }, null, a.token);
  await f.request("/v1/receipts", { receipts: [{ id: "b-new", ts: "2026-10-20T02:00:00.000Z", cost_usd: 1 }] }, null, b.token);
  await f.request("/v1/receipts", { receipts: [{ id: "z-secret", ts: "2026-10-20T03:00:00.000Z", cost_usd: 1 }] }, null, foreign.token);
  const port = f.service().server.address().port;
  const pull = async (q, cookie = owner.cookie) => { const r = await fetch(`http://127.0.0.1:${port}/v1/receipts.csv${q}`, { headers: { cookie } }); return { status: r.status, type: r.headers.get("content-type"), total: r.headers.get("x-costcap-total"), truncated: r.headers.get("x-costcap-truncated"), body: await r.text() }; };
  const all = await pull("");
  assert.equal(all.total, "3");
  assert.equal(all.truncated, null);
  const recent = await pull("?since=2026-10-15T00:00:00Z");
  assert.equal(recent.total, "2");
  assert.doesNotMatch(recent.body, /a-old/);
  const early = await pull("?until=2026-10-02T00:00:00Z");
  assert.match(early.body, /a-old/);
  assert.doesNotMatch(early.body, /a-new|b-new/);
  const onlyB = await pull(`?agent_id=${encodeURIComponent(b.agentId)}`);
  assert.equal(onlyB.total, "1");
  assert.match(onlyB.body, /b-new/);
  assert.doesNotMatch(onlyB.body, /a-new/);
  for (const q of ["?since=garbage", "?since=2026-10-20&until=2026-10-01", `?agent_id=${encodeURIComponent(foreign.agentId)}`, "?agent_id=unknown"]) {
    const r = await pull(q);
    assert.equal(r.status, 400, q);
    assert.match(r.type, /json/, q);
    assert.doesNotMatch(r.body, /z-secret|ts,agent_id/, q);
  }
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

test("#114 hosted maxSteps: validated, versioned, audited, and reported per run", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("steps-owner@example.invalid");
  const tok = (await f.request("/v1/enrollment-tokens", { caps: { day: 50 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "steps" }, null, tok)).body;
  const path = `/v1/agents/${agent.agentId}/policy`;
  const ok = await f.request(path, { maxSteps: 5 }, owner.cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, 2);
  assert.equal(ok.body.maxSteps, 5);
  assert.deepEqual(ok.body.caps, { day: 50 });
  for (const bad of [0, -3, 2.5, "5"]) {
    const r = await f.request(path, { maxSteps: bad }, owner.cookie);
    assert.equal(r.status, 400, String(bad));
  }
  assert.deepEqual((await f.request("/v1/policy", undefined, null, agent.token)).body, ok.body);
  // Changing caps keeps the step budget; null clears it.
  assert.equal((await f.request(path, { caps: { day: 40 } }, owner.cookie)).body.maxSteps, 5);
  const fleet = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  assert.ok(fleet.audit.some((e) => e.action === "policy.change" && e.detail.policy.maxSteps === 5));

  const ts = new Date().toISOString();
  await f.request("/v1/receipts", { receipts: [
    ...[1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, ts, cost_usd: 0.01, agent_id: agent.agentId, run_id: "run-a" })),
    { id: "s6", ts, cost_usd: 0, blocked: true, reason: "step_budget", agent_id: agent.agentId, run_id: "run-a" },
    { id: "o1", ts, cost_usd: 0.01, agent_id: agent.agentId, run_id: "run-b" },
  ] }, null, agent.token);
  const budget = (q = "") => f.request(`/v1/agents/${agent.agentId}/budget${q}`, undefined, owner.cookie);
  let r = await budget("?run_id=run-a");
  assert.equal(r.body.verdict, "breaker_open");
  assert.equal(r.body.reason, "step_budget");
  assert.equal(r.body.max_steps, 5);
  assert.equal(r.body.steps, 5);
  r = await budget("?run_id=run-b");
  assert.equal(r.body.verdict, "ok");
  assert.equal(r.body.steps, 1);
  assert.equal(r.body.max_steps, 5);
  r = await budget();
  assert.equal(r.body.verdict, "ok");
  assert.ok(!("max_steps" in r.body));
  const cleared = await f.request(path, { maxSteps: null }, owner.cookie);
  assert.equal(cleared.status, 200);
  assert.ok(!("maxSteps" in cleared.body));
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

test("regression #118: evidence export carries the audit trail with before/after caps, freeze reason, org isolation", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("ev-owner@example.invalid");
  const outsider = await f.login("ev-outsider@example.invalid");
  const enroll = async (who, name) => {
    const e = await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, who.cookie);
    return (await f.request("/v1/enroll", { name }, null, e.body.token)).body;
  };
  const a = await enroll(owner, "a");
  const other = await enroll(outsider, "other");
  assert.equal((await f.request(`/v1/agents/${a.agentId}/policy`, { caps: { day: 5 }, maxSteps: 9, reason: "batch" }, owner.cookie)).status, 200);
  assert.equal((await f.request(`/v1/agents/${other.agentId}/policy`, { caps: { day: 2 } }, outsider.cookie)).status, 200);
  assert.equal((await f.request("/v1/fleet/freeze", { reason: "incident 7" }, owner.cookie)).status, 200);
  await f.request("/v1/invitations", { email: "ev-viewer@example.invalid", role: "viewer" }, owner.cookie);
  const viewer = await f.login("ev-viewer@example.invalid");
  await f.restart();
  assert.equal((await f.request("/v1/evidence.json")).status, 401);
  const doc = (await f.request("/v1/evidence.json", undefined, viewer.cookie)).body;
  const change = doc.audit.find((e) => e.action === "policy.change" && e.target === a.agentId);
  assert.deepEqual(change.detail.previous, { caps: { day: 1 }, killed: false, maxSteps: null, silentAfterHours: null, models: null });
  assert.deepEqual(change.detail.policy.caps, { day: 5 });
  assert.equal(change.detail.policy.maxSteps, 9);
  assert.equal(change.detail.reason, "batch");
  assert.equal(change.actor, owner.body.userId ?? change.actor);
  const freeze = doc.audit.find((e) => e.action === "fleet.freeze");
  assert.equal(freeze.detail.reason, "incident 7");
  assert.deepEqual(freeze.detail.agent_ids, [a.agentId]);
  for (const e of doc.audit) for (const k of ["ts", "actor", "action", "target", "detail"]) assert.ok(k in e, k);
  const ts = doc.audit.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort());
  assert.equal(JSON.stringify(doc).includes(other.agentId), false);
  const theirs = (await f.request("/v1/evidence.json", undefined, outsider.cookie)).body;
  assert.ok(theirs.audit.some((e) => e.action === "policy.change" && e.detail.previous.caps.day === 1 && e.detail.policy.caps.day === 2));
  assert.equal(theirs.audit.some((e) => e.action === "fleet.freeze"), false);
});

// Issue #121: per-org alert destinations.
test("alert settings: roles, isolation, validation, masking, audit, per-org routing, no webhook leak", async (t) => {
  const f = await fixture(t);
  const hook = "https://hooks.slack.com/services/T000/B000/fullSecretHookValue9";
  const owner = await f.login("owner@a.invalid");
  const other = await f.login("owner@b.invalid");
  assert.equal((await f.request("/v1/invitations", { email: "viewer@a.invalid", role: "viewer" }, owner.cookie)).status, 201);
  const viewer = await f.login("viewer@a.invalid");
  assert.equal(viewer.body.role, "viewer");
  assert.deepEqual((await f.request("/v1/alert-settings", undefined, owner.cookie)).body, { emails: [], slackWebhook: null, webhook: null, configured: false, canEdit: true });
  assert.equal((await f.request("/v1/alert-settings")).status, 401);
  assert.equal((await f.request("/v1/alert-settings", { slackWebhook: "https://evil.invalid/services/x" }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/alert-settings", { slackWebhook: "http://hooks.slack.com/services/x" }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/alert-settings", { emails: ["owner@b.invalid"] }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/alert-settings", { emails: ["stranger@a.invalid"] }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/alert-settings", { emails: "owner@a.invalid" }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/alert-settings", { emails: ["owner@a.invalid"], slackWebhook: hook }, viewer.cookie)).status, 403);
  const saved = await f.request("/v1/alert-settings", { emails: ["Owner@a.invalid", "viewer@a.invalid"], slackWebhook: hook }, owner.cookie);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { emails: ["owner@a.invalid", "viewer@a.invalid"], slackWebhook: "https://hooks.slack.com/services/…lue9", webhook: null, configured: true, canEdit: true });
  const asViewer = await f.request("/v1/alert-settings", undefined, viewer.cookie);
  assert.equal(asViewer.body.slackWebhook, "https://hooks.slack.com/services/…lue9");
  assert.equal(asViewer.body.canEdit, false);
  // Another org sees its own (empty) settings, never org A's.
  assert.deepEqual((await f.request("/v1/alert-settings", undefined, other.cookie)).body.emails, []);
  // Omitted webhook keeps the stored one; audit holds masked before/after only.
  await f.request("/v1/alert-settings", { emails: ["owner@a.invalid"] }, owner.cookie);
  await f.request("/v1/alert-settings", { slackWebhook: null }, owner.cookie);
  await f.request("/v1/alert-settings", { slackWebhook: hook }, owner.cookie);
  const fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  const changes = fleet.body.audit.filter((e) => e.action === "alert_settings.change");
  assert.equal(changes.length, 4);
  assert.equal(changes[0].detail.previous.slackWebhook, null);
  assert.equal(changes[0].detail.next.slackWebhook, "https://hooks.slack.com/services/…lue9");
  assert.equal(changes[1].detail.next.slackWebhook, "https://hooks.slack.com/services/…lue9");
  assert.equal(changes[2].detail.next.slackWebhook, null);
  // Alerts route with org A's settings; org B with none gets null settings.
  const enrollA = await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie);
  const agentA = (await f.request("/v1/enroll", { name: "a" }, null, enrollA.body.token)).body;
  const enrollB = await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, other.cookie);
  const agentB = (await f.request("/v1/enroll", { name: "b" }, null, enrollB.body.token)).body;
  const ts = new Date().toISOString();
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 2 }] }, null, agentA.token);
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 2 }] }, null, agentB.token);
  f.setDeliveryResult([{ status: "unconfigured" }]);
  await f.service().evaluateFleetAlerts();
  assert.ok(f.delivery.some((a) => a.agentId === agentA.agentId));
  f.setDeliveryResult(null);
  await f.restart();
  assert.equal((await f.request("/v1/alert-settings", undefined, owner.cookie)).body.slackWebhook, "https://hooks.slack.com/services/…lue9");
  // Regression scan: the full webhook appears in no response body.
  const bodies = [];
  for (const p of ["/v1/fleet", "/v1/evidence.json", "/v1/alert-settings"]) bodies.push(JSON.stringify((await f.request(p, undefined, owner.cookie)).body));
  const port = f.service().server.address().port;
  bodies.push(await (await fetch(`http://127.0.0.1:${port}/v1/receipts.csv`, { headers: { cookie: owner.cookie } })).text());
  for (const b of bodies) assert.ok(!b.includes("fullSecretHookValue9"), "full webhook leaked");
});

test("alert worker passes each org's own settings (members only) and none for unconfigured orgs", async (t) => {
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-route-")), "store.json");
  const seen = [];
  let code;
  const service = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, deliverAlert: async (a, settings) => { seen.push({ orgId: a.orgId, settings }); return settings ? [{ status: "accepted" }] : [{ status: "unconfigured" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const req = async (path, body, cookie, auth) => { const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] }; };
  const login = async (email) => { const c = await req("/auth/request", { email, turnstileToken: "x" }); return req("/auth/verify", { challengeId: c.body.challengeId, code }); };
  const a = await login("a@a.invalid"), b = await login("b@b.invalid");
  assert.equal((await req("/v1/alert-settings", { emails: ["a@a.invalid"], slackWebhook: "https://hooks.slack.com/services/T/B/aaaa" }, a.cookie)).status, 200);
  for (const u of [a, b]) {
    const tok = (await req("/v1/enrollment-tokens", { caps: { day: 1 } }, u.cookie)).body.token;
    const ag = (await req("/v1/enroll", { name: "x" }, null, tok)).body;
    await req("/v1/receipts", { receipts: [{ id: "r", ts: new Date().toISOString(), cost_usd: 5 }] }, null, ag.token);
  }
  await service.evaluateFleetAlerts();
  const forA = seen.filter((x) => x.orgId === a.body.orgId), forB = seen.filter((x) => x.orgId === b.body.orgId);
  assert.ok(forA.length && forB.length);
  for (const x of forA) assert.deepEqual(x.settings, { emails: ["a@a.invalid"], slackWebhook: "https://hooks.slack.com/services/T/B/aaaa", webhook: null });
  for (const x of forB) assert.equal(x.settings, null);
  // Unconfigured org B is not retried on the next sweep; accepted A is not resent.
  seen.length = 0;
  await service.evaluateFleetAlerts();
  assert.equal(seen.length, 0);
});

test("regression #130: legacy receipt with ?key= is stored, listed, exported and backfilled without the secret", async (t) => {
  const { scrubStoredReceipts } = await import("../src/hosted/server.js");
  const { memoryCore } = await import("../src/hosted/store.js");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const f = await fixture(t);
  const owner = await f.login("owner130@example.invalid");
  const enrollment = await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie);
  const agent = (await f.request("/v1/enroll", { name: "gemini" }, null, enrollment.body.token)).body;
  const legacy = { id: "r-130", ts: new Date().toISOString(), cost_usd: 0, blocked: true, reason: "cap_exceeded", provider: "gemini", path: "/v1beta/models/x:generateContent?alt=sse&KEY=SECRET123" };
  assert.equal((await f.request("/v1/receipts", { receipts: [legacy] }, null, agent.token)).status, 200);
  assert.equal((await f.request("/v1/receipts", { receipts: [legacy] }, null, agent.token)).status, 200, "legacy retry is idempotent after redaction");
  const fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  assert.equal(fleet.body.receipts[0].receipt.path, "/v1beta/models/x:generateContent?alt=sse&KEY=REDACTED");
  const port = f.service().server.address().port;
  const csv = await (await fetch(`http://127.0.0.1:${port}/v1/receipts.csv`, { headers: { cookie: owner.cookie } })).text();
  assert.match(csv, /r-130/);
  const evidence = await (await fetch(`http://127.0.0.1:${port}/v1/evidence.json`, { headers: { cookie: owner.cookie } })).text();
  for (const text of [JSON.stringify(fleet.body), csv, evidence, readFileSync(f.storePath, "utf8")]) assert.doesNotMatch(text, /SECRET123/);

  // Backfill: a row written by an older server is scrubbed on startup.
  const raw = JSON.parse(readFileSync(f.storePath, "utf8"));
  const key = Object.keys(raw.receipts).find((k) => k.endsWith(":r-130"));
  raw.receipts[key].receipt.path = "/v1beta/models/x:generateContent?key=SECRET123";
  writeFileSync(f.storePath, JSON.stringify(raw));
  await f.restart();
  assert.doesNotMatch(readFileSync(f.storePath, "utf8"), /SECRET123/);
  assert.equal((await f.request("/v1/fleet", undefined, owner.cookie)).body.receipts[0].receipt.path, "/v1beta/models/x:generateContent?key=REDACTED");

  // Exactly once: a second pass changes nothing and writes nothing.
  let commits = 0;
  const store = memoryCore({ receipts: { a: { receipt: { path: "/p?token=SECRET123&x=1" } }, b: { receipt: {} } } }, () => { commits++; });
  assert.equal(scrubStoredReceipts(store), 1);
  assert.equal(store.read((s) => s.receipts.a.receipt.path), "/p?token=REDACTED&x=1");
  assert.equal(scrubStoredReceipts(store), 0);
  assert.equal(commits, 1);
});

test("#134 per-agent silentAfterHours: validation, audit, worker threshold, off, clears without re-send", async (t) => {
  let clock = Date.parse("2026-10-12T12:00:00.000Z");
  const f = await fixture(t, { now: () => clock });
  const owner = await f.login("silent134@example.invalid");
  const enroll = async (name) => { const tok = (await f.request("/v1/enrollment-tokens", { caps: {} }, owner.cookie)).body.token; return (await f.request("/v1/enroll", { name }, null, tok)).body; };
  const nightly = await enroll("nightly"), off = await enroll("off"), dflt = await enroll("default");
  const set = (id, body, cookie = owner.cookie) => f.request(`/v1/agents/${id}/policy`, body, cookie);
  for (const bad of [-1, 721, "24", true]) assert.equal((await set(nightly.agentId, { silentAfterHours: bad })).status, 400, String(bad));
  let r = await set(nightly.agentId, { silentAfterHours: 24 });
  assert.equal(r.status, 200);
  assert.equal(r.body.silentAfterHours, 24);
  assert.equal(r.body.version, 2);
  assert.equal((await set(off.agentId, { silentAfterHours: 0 })).body.silentAfterHours, 0);
  // Omitting keeps it; /v1/policy and /v1/fleet return it.
  assert.equal((await set(nightly.agentId, { caps: { day: 3 } })).body.silentAfterHours, 24);
  assert.equal((await f.request("/v1/policy", undefined, null, nightly.token)).body.silentAfterHours, 24);
  let fleet = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  assert.equal(fleet.agents.find((a) => a.id === nightly.agentId).policy.silentAfterHours, 24);
  // null resets to the default (round-trip on a throwaway agent).
  const tmp = await enroll("tmp");
  await set(tmp.agentId, { silentAfterHours: 3 });
  assert.equal("silentAfterHours" in (await set(tmp.agentId, { silentAfterHours: null })).body, false);
  assert.equal((await f.request(`/v1/agents/${tmp.agentId}/revoke`, {}, owner.cookie)).status, 200);
  const change = fleet.audit.filter((x) => x.action === "policy.change" && x.target === off.agentId).at(-1);
  assert.equal(change.detail.previous.silentAfterHours, null);
  assert.equal(change.detail.policy.silentAfterHours, 0);
  // Viewer 403, other org 404.
  assert.equal((await f.request("/v1/invitations", { email: "viewer134@example.invalid", role: "viewer" }, owner.cookie)).status, 201);
  const viewer = await f.login("viewer134@example.invalid");
  assert.equal((await set(nightly.agentId, { silentAfterHours: 1 }, viewer.cookie)).status, 403);
  const other = await f.login("other134@example.invalid");
  assert.equal((await set(nightly.agentId, { silentAfterHours: 1 }, other.cookie)).status, 404);
  // 7h: only the default agent pages.
  clock += 7 * 3600_000;
  await f.service().evaluateFleetAlerts();
  assert.deepEqual(f.delivery.map((d) => d.kind), ["agent_silent"]);
  // Raising the default agent's threshold clears its alert on the next tick, no re-send.
  assert.equal((await set(dflt.agentId, { silentAfterHours: 48 })).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 1);
  fleet = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  assert.equal(fleet.alerts.find((a) => a.agentId === dflt.agentId && a.kind === "agent_silent").active, false);
  // >24h: nightly pages; the 0 agent never does.
  clock += 18 * 3600_000;
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, 2);
  clock += 1000 * 3600_000;
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.filter((d) => d.kind === "agent_silent").length, 3); // default re-arms past 48h; off never
  assert.equal(f.delivery.some((d) => d.agentId === off.agentId), false);
});

// Issue #137: member list, removal and role change.
test("#137 members: list, remove, role change, last-owner guard, isolation, audit, sessions, alert recipients", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("owner@m.invalid");
  const outsider = await f.login("owner@n.invalid");
  await f.request("/v1/invitations", { email: "admin@m.invalid", role: "admin" }, owner.cookie);
  await f.request("/v1/invitations", { email: "viewer@m.invalid", role: "viewer" }, owner.cookie);
  const adm = await f.login("admin@m.invalid");
  const viewer = await f.login("viewer@m.invalid");
  const fleet = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  assert.deepEqual(fleet.members.map((m) => [m.email, m.role, m.verified]), [["admin@m.invalid", "admin", true], ["owner@m.invalid", "owner", true], ["viewer@m.invalid", "viewer", true]]);
  assert.deepEqual(Object.keys(fleet.members[0]).sort(), ["email", "id", "role", "verified"]);
  const outsiderFleet = (await f.request("/v1/fleet", undefined, outsider.cookie)).body;
  assert.deepEqual(outsiderFleet.members.map((m) => m.email), ["owner@n.invalid"]);
  const id = (email) => fleet.members.find((m) => m.email === email).id;
  // Role rules.
  assert.equal((await f.request(`/v1/members/${id("admin@m.invalid")}/remove`, {}, viewer.cookie)).status, 403);
  assert.equal((await f.request(`/v1/members/${id("owner@m.invalid")}/remove`, {}, adm.cookie)).status, 403);
  assert.equal((await f.request(`/v1/members/${id("owner@m.invalid")}/remove`, {}, owner.cookie)).status, 409);
  assert.equal((await f.request(`/v1/members/${id("owner@m.invalid")}/role`, { role: "admin" }, owner.cookie)).status, 409);
  assert.equal((await f.request(`/v1/members/${id("viewer@m.invalid")}/role`, { role: "admin" }, adm.cookie)).status, 403);
  assert.equal((await f.request(`/v1/members/${id("viewer@m.invalid")}/role`, { role: "owner" }, owner.cookie)).status, 400);
  assert.equal((await f.request(`/v1/members/${id("viewer@m.invalid")}/remove`, {}, outsider.cookie)).status, 404);
  assert.equal((await f.request("/v1/members/nope/remove", {}, owner.cookie)).status, 404);
  assert.equal((await f.request(`/v1/members/${id("viewer@m.invalid")}/remove`, {})).status, 401);
  // Role change.
  const changed = await f.request(`/v1/members/${id("viewer@m.invalid")}/role`, { role: "admin" }, owner.cookie);
  assert.deepEqual([changed.status, changed.body.role], [200, "admin"]);
  assert.equal((await f.request("/v1/fleet", undefined, viewer.cookie)).body.role, "admin");
  await f.request(`/v1/members/${id("viewer@m.invalid")}/role`, { role: "viewer" }, owner.cookie);
  // Alert recipient cleanup on removal.
  assert.equal((await f.request("/v1/alert-settings", { emails: ["owner@m.invalid", "viewer@m.invalid"] }, owner.cookie)).status, 200);
  const removed = await f.request(`/v1/members/${id("viewer@m.invalid")}/remove`, {}, adm.cookie);
  assert.deepEqual([removed.status, removed.body.removed], [200, true]);
  assert.equal((await f.request("/v1/fleet", undefined, viewer.cookie)).status, 401);
  assert.deepEqual((await f.request("/v1/alert-settings", undefined, owner.cookie)).body.emails, ["owner@m.invalid"]);
  const after = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  assert.equal(after.members.length, 2);
  assert.equal(after.plan.usage.seats, 2);
  const rm = after.audit.find((e) => e.action === "member.remove");
  assert.equal(rm.detail.email, "viewer@m.invalid");
  assert.equal(rm.actor, adm.body.id);
  assert.ok(after.audit.some((e) => e.action === "member.role" && e.detail.previous === "viewer" && e.detail.role === "admin"));
  assert.equal(outsiderFleet.audit.some((e) => e.action.startsWith("member.")), false);
  // Removal survives restart and the address can be re-invited.
  await f.restart();
  assert.equal((await f.request("/v1/fleet", undefined, owner.cookie)).body.members.length, 2);
  assert.equal((await f.request("/v1/invitations", { email: "viewer@m.invalid", role: "viewer" }, owner.cookie)).status, 201);
});

test("#137 removing a member frees a seat so an over-limit invite succeeds", async (t) => {
  const f = await fixture(t, { extra: { enforceEntitlements: true, billingFactory: async () => ({ status: async () => ({ status: "free_beta" }), checkout: async () => ({}), portal: async () => ({}), webhook: async () => ({ received: true }) }) } });
  const owner = await f.login("owner@seat.invalid");
  const limit = (await f.request("/v1/fleet", undefined, owner.cookie)).body.plan.limits.seats;
  for (let i = 1; i < limit; i++) assert.equal((await f.request("/v1/invitations", { email: `m${i}@seat.invalid`, role: "viewer" }, owner.cookie)).status, 201);
  for (let i = 1; i < limit; i++) await f.login(`m${i}@seat.invalid`);
  assert.equal((await f.request("/v1/invitations", { email: "late@seat.invalid", role: "viewer" }, owner.cookie)).status, 402);
  const target = (await f.request("/v1/fleet", undefined, owner.cookie)).body.members.find((m) => m.email === "m1@seat.invalid");
  assert.equal((await f.request(`/v1/members/${target.id}/remove`, {}, owner.cookie)).status, 200);
  assert.equal((await f.request("/v1/invitations", { email: "late@seat.invalid", role: "viewer" }, owner.cookie)).status, 201);
});

// Issue #143: alert lifecycle (occurrences, resolve, re-fire, ack, status filter, legacy records).
test("alert lifecycle: fired_at/resolved_at history, re-fire is a new occurrence, ack is audited and role-checked", async (t) => {
  let clock = Date.parse("2026-11-15T10:00:00.000Z");
  const f = await fixture(t, { now: () => clock });
  const owner = await f.login("life-owner@example.invalid");
  const outsider = await f.login("life-outsider@example.invalid");
  const invited = await f.request("/v1/invitations", { email: "life-viewer@example.invalid", role: "viewer" }, owner.cookie);
  assert.equal(invited.status, 201);
  const viewer = await f.login("life-viewer@example.invalid");
  const enrollment = await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie);
  const agent = (await f.request("/v1/enroll", { name: "spender" }, null, enrollment.body.token)).body;
  const spend = (id) => f.request("/v1/receipts", { receipts: [{ id, ts: new Date(clock).toISOString(), cost_usd: 1.5, model: "m" }] }, null, agent.token);
  assert.equal((await spend("r-day1")).status, 200);
  await f.service().evaluateFleetAlerts();
  const capHits = async (status = "all", cookie = owner.cookie) => (await f.request(`/v1/alerts?status=${status}`, undefined, cookie)).body.alerts.filter((a) => a.kind === "cap_hit");
  let hits = await capHits();
  assert.equal(hits.length, 1);
  const first = hits[0];
  assert.equal(first.fired_at, "2026-11-15T10:00:00.000Z");
  assert.equal(first.resolved_at, null);
  assert.equal(first.acknowledged_at, null);
  assert.equal(first.active, true);
  assert.ok(first.id);
  // Ack: viewer 403, outsider 404, admin 200 once, repeat is a no-op.
  assert.equal((await f.request(`/v1/alerts/${first.id}/ack`, {}, viewer.cookie)).status, 403);
  assert.equal((await f.request(`/v1/alerts/${first.id}/ack`, {}, outsider.cookie)).status, 404);
  assert.equal((await f.request("/v1/alerts/nope/ack", {}, owner.cookie)).status, 404);
  assert.equal((await f.request(`/v1/alerts?status=all`, undefined, outsider.cookie)).body.alerts.length, 0);
  clock += 60_000;
  const acked = await f.request(`/v1/alerts/${first.id}/ack`, {}, owner.cookie);
  assert.equal(acked.status, 200);
  assert.equal(acked.body.alert.acknowledged_by, "life-owner@example.invalid");
  assert.equal(acked.body.alert.acknowledged_at, "2026-11-15T10:01:00.000Z");
  assert.equal((await f.request(`/v1/alerts/${first.id}/ack`, {}, owner.cookie)).status, 200);
  let fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  const ackRows = fleet.body.audit.filter((e) => e.action === "alert.ack");
  assert.equal(ackRows.length, 1);
  assert.equal(ackRows[0].actor_label, "life-owner@example.invalid");
  // Ack does not resolve and does not re-deliver.
  const delivered = f.delivery.length;
  await f.service().evaluateFleetAlerts();
  assert.equal(f.delivery.length, delivered);
  assert.equal((await capHits("acknowledged")).length, 1);
  assert.equal((await capHits("active")).length, 0);
  assert.equal((await capHits("resolved")).length, 0);
  assert.equal((await f.request("/v1/alerts?status=bogus", undefined, owner.cookie)).status, 400);
  // New UTC day: spend clears, the occurrence resolves and stays in history.
  clock = Date.parse("2026-11-16T09:00:00.000Z");
  await f.service().evaluateFleetAlerts();
  hits = await capHits("resolved");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, first.id);
  assert.equal(hits[0].resolved_at, "2026-11-16T09:00:00.000Z");
  assert.equal(hits[0].fired_at, first.fired_at);
  // Re-fire after resolve: a second occurrence with a distinct id.
  assert.equal((await spend("r-day2")).status, 200);
  await f.service().evaluateFleetAlerts();
  hits = await capHits("all");
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0].id, hits[1].id);
  assert.equal(hits[0].active, true); // active first
  assert.equal(hits[0].fired_at, "2026-11-16T09:00:00.000Z");
  assert.equal(hits[1].resolved_at, "2026-11-16T09:00:00.000Z");
  assert.equal(hits[1].fired_at, "2026-11-15T10:00:00.000Z");
  assert.equal((await capHits("all", viewer.cookie)).length, 2);
  // since/until filter by fired_at.
  assert.equal((await f.request("/v1/alerts?status=all&since=2026-11-16T00:00:00Z", undefined, owner.cookie)).body.alerts.filter((a) => a.kind === "cap_hit").length, 1);
  assert.equal((await f.request("/v1/alerts?status=all&until=2026-11-15T23:00:00Z", undefined, owner.cookie)).body.alerts.filter((a) => a.kind === "cap_hit").length, 1);
  // Evidence carries the lifecycle.
  const evidence = await f.request("/v1/evidence.json", undefined, owner.cookie);
  const ev = evidence.body.alerts.filter((a) => a.kind === "cap_hit");
  assert.equal(ev.length, 2);
  assert.ok(ev.every((a) => "fired_at" in a && "resolved_at" in a && "acknowledged_at" in a && "acknowledged_by" in a && a.id));
});

test("legacy alert records (keyed by alert key, no timestamps) are kept with fired_at null", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("legacy-owner@example.invalid");
  const { writeFileSync } = await import("node:fs");
  const state = JSON.parse(readFileSync(f.storePath, "utf8"));
  state.alerts["cap_hit:old:day"] = { kind: "cap_hit", key: "cap_hit:old:day", scope: "day", orgId: owner.body.orgId, agentId: "old", active: false, delivery: "accepted" };
  writeFileSync(f.storePath, JSON.stringify(state));
  await f.restart();
  const list = (await f.request("/v1/alerts?status=all", undefined, owner.cookie)).body.alerts;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "cap_hit:old:day");
  assert.equal(list[0].fired_at, null);
  assert.equal(list[0].resolved_at, null);
  const ev = (await f.request("/v1/evidence.json", undefined, owner.cookie)).body.alerts;
  assert.deepEqual(ev.map((a) => [a.id, a.fired_at]), [["cap_hit:old:day", null]]);
  // A since/until filter cannot place an unknown time, so it excludes legacy rows.
  assert.equal((await f.request("/v1/alerts?since=2020-01-01T00:00:00Z", undefined, owner.cookie)).body.alerts.length, 0);
  assert.equal((await f.request(`/v1/alerts/${encodeURIComponent("cap_hit:old:day")}/ack`, {}, owner.cookie)).status, 200);
});

test("#153 hosted models allowlist: validation, versioning, keep/clear, audited before/after, synced to the agent", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("models-owner@example.invalid");
  assert.equal((await f.request("/v1/enrollment-tokens", { caps: {}, models: [] }, owner.cookie)).status, 400);
  const tok = (await f.request("/v1/enrollment-tokens", { caps: {}, models: ["gpt-4o-mini"] }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "modeler" }, null, tok)).body;
  assert.deepEqual(agent.policy.models, ["gpt-4o-mini"]);
  const set = (body) => f.request(`/v1/agents/${agent.agentId}/policy`, body, owner.cookie);
  for (const bad of [[], [""], "gpt-4o", [1]]) assert.equal((await set({ models: bad })).status, 400, JSON.stringify(bad));
  let r = await set({ models: ["gpt-4o-mini", "claude-haiku-4-5"] });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 2);
  assert.equal((await f.request("/v1/policy", undefined, null, agent.token)).body.models.length, 2);
  // Omitting models keeps it; null clears it.
  assert.deepEqual((await set({ caps: { day: 3 } })).body.models, ["gpt-4o-mini", "claude-haiku-4-5"]);
  const fleet = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  const change = fleet.audit.filter((x) => x.action === "policy.change").at(-2);
  assert.deepEqual(change.detail.previous.models, ["gpt-4o-mini"]);
  assert.deepEqual(change.detail.policy.models, ["gpt-4o-mini", "claude-haiku-4-5"]);
  r = await set({ models: null });
  assert.equal("models" in r.body, false);
  // Blocked-model receipts show in evidence and the CSV.
  await f.request("/v1/receipts", { receipts: [{ id: "bm1", ts: new Date().toISOString(), cost_usd: 0, blocked: true, reason: "model_not_allowed", outcome: "blocked_model", model: "gpt-4o" }] }, null, agent.token);
  const ev = (await f.request("/v1/evidence.json", undefined, owner.cookie)).body;
  assert.equal(ev.receipts.find((x) => x.receipt_id === "bm1").outcome, "blocked_model");
});

// Issue #161: seats are re-checked when an invite is accepted, not only when it is issued.
test("#161 accepting an invite after a downgrade to free is refused with 402 seats; removing a member lets it accept", async (t) => {
  const f = await fixture(t, { extra: { enforceEntitlements: true, billingFactory: async () => ({ status: async () => ({ status: "free_beta" }), checkout: async () => ({}), portal: async () => ({}), webhook: async () => ({ received: true }) }) } });
  const owner = await f.login("owner@down.invalid");
  const setPlan = async (billing) => {
    const raw = JSON.parse(readFileSync(f.storePath, "utf8"));
    raw.orgs[owner.body.orgId].billing = billing;
    writeFileSync(f.storePath, JSON.stringify(raw));
    await f.restart();
  };
  await setPlan({ status: "active", plan: "team" });
  for (const e of ["m1", "m2", "late"]) assert.equal((await f.request("/v1/invitations", { email: `${e}@down.invalid`, role: "viewer" }, owner.cookie)).status, 201);
  await f.login("m1@down.invalid");
  await f.login("m2@down.invalid");
  await setPlan(null);
  const fleet = async () => (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  assert.equal((await fleet()).plan.limits.seats, 3);
  const challenge = await f.request("/auth/request", { email: "late@down.invalid", turnstileToken: "test-pass" });
  const refused = await f.rawVerify(challenge.body.challengeId);
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, "plan_limit");
  assert.equal(refused.body.feature, "seats");
  assert.match(refused.body.error ?? JSON.stringify(refused.body), /people limit|upgrade/i);
  assert.equal(refused.cookie, undefined);
  const raw = JSON.parse(readFileSync(f.storePath, "utf8"));
  assert.equal(Object.keys(raw.orgs).length, 1, "no fallback org created");
  assert.equal(Object.values(raw.users).some((u) => u.email === "late@down.invalid"), false);
  const before = await fleet();
  assert.equal(before.members.length, 3);
  assert.ok(before.invitations.some((i) => i.email === "late@down.invalid"), "invite kept");
  // Under the limit again: the same invite accepts and is audited.
  const m1 = before.members.find((m) => m.email === "m1@down.invalid");
  assert.equal((await f.request(`/v1/members/${m1.id}/remove`, {}, owner.cookie)).status, 200);
  const accepted = await f.login("late@down.invalid");
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.orgId, owner.body.orgId);
  const after = await fleet();
  assert.equal(after.members.length, 3);
  assert.ok(after.audit.some((e) => e.action === "invitation.accept"));
});

test("#161 without enforced entitlements an invite still accepts past the free seat count", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("owner@beta.invalid");
  for (let i = 1; i <= 4; i++) assert.equal((await f.request("/v1/invitations", { email: `b${i}@beta.invalid`, role: "viewer" }, owner.cookie)).status, 201);
  for (let i = 1; i <= 4; i++) { const r = await f.login(`b${i}@beta.invalid`); assert.equal(r.status, 200); assert.equal(r.body.orgId, owner.body.orgId); }
});

test("#184 receipt ingest accepts saved_usd only on a $0 cache_hit receipt; /v1/spend reports it", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("cache-owner@example.invalid");
  const enrollment = await f.request("/v1/enrollment-tokens", {}, owner.cookie);
  const agent = (await f.request("/v1/enroll", { name: "cached" }, null, enrollment.body.token)).body;
  const ts = new Date().toISOString();
  const hit = { id: "h-1", ts, cost_usd: 0, reason: "cache_hit", cache: "hit", saved_usd: 0.3, model: "gpt-4.1" };
  for (const bad of [{ ...hit, id: "b1", saved_usd: -1 }, { ...hit, id: "b2", saved_usd: "x" }, { id: "b3", ts, cost_usd: 0.3, saved_usd: 0.3, model: "gpt-4.1" }, { ...hit, id: "b4", cost_usd: 0.1 }, { ...hit, id: "b5", saved_usd: null }]) {
    assert.equal((await f.request("/v1/receipts", { receipts: [bad] }, null, agent.token)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "m-1", ts, cost_usd: 0.3, cache: "miss", model: "gpt-4.1" }, hit] }, null, agent.token)).status, 200);
  for (const g of ["day", "model", "agent"]) {
    const s = await f.request(`/v1/spend?group_by=${g}`, undefined, owner.cookie);
    assert.equal(s.status, 200);
    assert.equal(s.body.total.cache_hits, 1);
    assert.equal(s.body.total.saved_usd, 0.3);
    assert.equal(s.body.total.usd_known, 0.3);
    assert.equal(s.body.buckets[0].cache_hits, 1);
  }
});

// Issue #199: signed generic webhook alert destination.
import { createOrgAlertRouter as routerFor199, verifyWebhookSignature as verify199 } from "../src/hosted/delivery.js";
test("signed webhook: roles, isolation, SSRF, masking, rotation, audit, delivery, retry, restart, no secret leak", async (t) => {
  const posts = [];
  let receiverStatus = 200;
  const resolveHost = async (host) => (host.startsWith("private.") ? [{ address: "10.0.0.8", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
  const router = routerFor199({ lookup: resolveHost, dashboardUrl: "https://app.costcap.dev", fetchImpl: async (url, o) => { posts.push({ url, body: o.body, sig: o.headers["x-costcap-signature"] }); return { ok: receiverStatus < 300, status: receiverStatus }; } });
  let skew = 0;
  const f = await fixture(t, { now: () => Date.now() + skew, extra: { resolveHost, deliverAlert: router } });
  const owner = await f.login("owner@w.invalid");
  const other = await f.login("owner@x.invalid");
  assert.equal((await f.request("/v1/invitations", { email: "viewer@w.invalid", role: "viewer" }, owner.cookie)).status, 201);
  assert.equal((await f.request("/v1/invitations", { email: "admin@w.invalid", role: "admin" }, owner.cookie)).status, 201);
  const viewer = await f.login("viewer@w.invalid");
  const adminU = await f.login("admin@w.invalid");
  const url = "https://hooks.receiver.example.com/costcap/privatePathQ7";
  assert.equal((await f.request("/v1/alert-settings", { webhook: url }, viewer.cookie)).status, 403);
  for (const bad of ["http://hooks.receiver.example.com/x", "https://u:p@hooks.receiver.example.com/x", "https://hooks.receiver.example.com:8443/x", "https://127.0.0.1/x", "https://localhost/x", "https://private.example.com/x"])
    assert.equal((await f.request("/v1/alert-settings", { webhook: bad }, owner.cookie)).status, 400, bad);
  assert.equal((await f.request("/v1/alert-settings", { rotateWebhookSecret: true }, owner.cookie)).status, 400);
  assert.equal((await f.request("/v1/alert-settings", { rotateWebhookSecret: "yes" }, owner.cookie)).status, 400);
  const created = await f.request("/v1/alert-settings", { webhook: url }, adminU.cookie);
  assert.equal(created.status, 200);
  const secret1 = created.body.webhookSecret;
  assert.match(secret1, /^whsec_[0-9a-f]{48}$/);
  assert.deepEqual(created.body.webhook, { url: "https://hooks.receiver.example.com/…", secret: `whsec_…${secret1.slice(-4)}` });
  // Re-saving the same URL keeps the secret and does not re-issue it.
  const same = await f.request("/v1/alert-settings", { webhook: url }, owner.cookie);
  assert.equal(same.body.webhookSecret, undefined);
  const asViewer = await f.request("/v1/alert-settings", undefined, viewer.cookie);
  assert.equal(asViewer.body.webhook.url, "https://hooks.receiver.example.com/…");
  assert.equal(asViewer.body.canEdit, false);
  assert.equal((await f.request("/v1/alert-settings", undefined, other.cookie)).body.webhook, null);
  // Delivery: org W's agent alert reaches W's webhook, signed with secret1. Org X has nothing.
  const enroll = async (u, name) => { const tok = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, u.cookie)).body.token; return (await f.request("/v1/enroll", { name }, null, tok)).body; };
  const agentW = await enroll(owner, "spender"), agentX = await enroll(other, "other");
  const ts = new Date().toISOString();
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 2 }] }, null, agentW.token);
  await f.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 2 }] }, null, agentX.token);
  receiverStatus = 503;
  await f.service().evaluateFleetAlerts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, url);
  const payload = JSON.parse(posts[0].body);
  assert.equal(payload.kind, "cap_hit");
  assert.equal(payload.agent_id, agentW.agentId);
  assert.equal(payload.agent_name, "spender");
  assert.equal(payload.spent_usd, 2);
  assert.equal(payload.cap_usd, 1);
  assert.equal(payload.dashboard_url, "https://app.costcap.dev");
  assert.ok(verify199(secret1, posts[0].body, posts[0].sig));
  const firstId = payload.id;
  let alerts = (await f.request("/v1/fleet", undefined, owner.cookie)).body.alerts.filter((a) => a.agentId === agentW.agentId);
  assert.equal(alerts[0].delivery, "failed");
  // Retry on the next sweep, same occurrence id; then 2xx is not resent.
  receiverStatus = 200;
  skew += 61_000;
  await f.service().evaluateFleetAlerts();
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[1].body).id, firstId);
  await f.service().evaluateFleetAlerts();
  assert.equal(posts.length, 2);
  // Rotation: new secret only.
  const rotated = await f.request("/v1/alert-settings", { rotateWebhookSecret: true }, owner.cookie);
  const secret2 = rotated.body.webhookSecret;
  assert.ok(secret2 && secret2 !== secret1);
  await f.request("/v1/receipts", { receipts: [{ id: "r2", ts, cost_usd: 1, run_id: "run-1" }] }, null, agentW.token);
  const enrollTeam = await f.request("/v1/teams", { name: "ops", agents: [agentW.agentId], day: 1 }, owner.cookie);
  assert.equal(enrollTeam.status, 200);
  await f.service().evaluateFleetAlerts();
  const later = posts.slice(2);
  assert.ok(later.length >= 1);
  assert.ok(later.some((p) => JSON.parse(p.body).team === "ops"), "team alert delivered");
  for (const p of later) { assert.ok(verify199(secret2, p.body, p.sig)); assert.equal(verify199(secret1, p.body, p.sig), false); }
  // Audit holds masked values only.
  const fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  const changes = fleet.body.audit.filter((e) => e.action === "alert_settings.change");
  assert.equal(changes.at(-1).detail.previous.webhook.secret, `whsec_…${secret1.slice(-4)}`);
  assert.equal(changes.at(-1).detail.next.webhook.secret, `whsec_…${secret2.slice(-4)}`);
  // Restart keeps the setting.
  await f.restart();
  assert.equal((await f.request("/v1/alert-settings", undefined, owner.cookie)).body.webhook.secret, `whsec_…${secret2.slice(-4)}`);
  // No response body ever carries a full secret or the URL path.
  const bodies = [];
  for (const p of ["/v1/fleet", "/v1/evidence.json", "/v1/alert-settings"]) for (const u of [owner, viewer, other]) bodies.push(JSON.stringify((await f.request(p, undefined, u.cookie)).body));
  const port = f.service().server.address().port;
  bodies.push(await (await fetch(`http://127.0.0.1:${port}/v1/receipts.csv`, { headers: { cookie: owner.cookie } })).text());
  for (const b of bodies) { assert.ok(!b.includes(secret1) && !b.includes(secret2), "secret leaked"); assert.ok(!b.includes("privatePathQ7"), "webhook path leaked"); }
  // Clear.
  const cleared = await f.request("/v1/alert-settings", { webhook: null }, owner.cookie);
  assert.equal(cleared.body.webhook, null);
});

// Issue #204: fleet tag caps API, roles, audit and the /v1/policy payload.
test("#204: PUT /v1/tag-caps validates, enforces roles, audits, and ships tag_caps in /v1/policy", async (t) => {
  const f = await fixture(t);
  const put = async (body, cookie) => {
    const r = await fetch(`http://127.0.0.1:${f.service().server.address().port}/v1/tag-caps`, { method: "PUT", headers: { origin: "http://localhost", "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const owner = await f.login("owner@example.invalid");
  await f.request("/v1/invitations", { email: "viewer@example.invalid", role: "viewer" }, owner.cookie);
  const viewer = await f.login("viewer@example.invalid");
  const rule = (key, scope, usd) => ({ key, scope, usd });
  for (const bad of [rule("Bad Key", "day", 1), rule("customer", "hour", 1), rule("customer", "run", 1), rule("customer", "day", 0), rule("customer", "day", -1)]) assert.equal((await put({ tagCaps: [bad] }, owner.cookie)).status, 400, JSON.stringify(bad));
  assert.equal((await put({ tagCaps: [rule("customer", "day", 1), rule("customer", "day", 2)] }, owner.cookie)).status, 400);
  assert.equal((await put({ tagCaps: Array.from({ length: 11 }, (_, i) => rule(`k${i}`, "day", 1)) }, owner.cookie)).status, 400);
  assert.equal((await put({ tagCaps: "nope" }, owner.cookie)).status, 400);
  assert.equal((await put({ tagCaps: [rule("customer", "day", 1)] }, viewer.cookie)).status, 403);
  const ok = await put({ tagCaps: [rule("customer", "day", 1), rule("customer", "month", 20)] }, owner.cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tagCaps.length, 2);
  const read = await f.request("/v1/tag-caps", undefined, viewer.cookie);
  assert.equal(read.status, 200);
  assert.equal(read.body.canEdit, false);
  assert.equal(read.body.tagCaps.length, 2);
  assert.equal((await f.request("/v1/tag-caps", undefined, owner.cookie)).body.canEdit, true);
  const fleet = await f.request("/v1/fleet", undefined, owner.cookie);
  const entry = fleet.body.audit.find((e) => e.action === "tag_caps.change");
  assert.deepEqual(entry.detail.previous, []);
  assert.deepEqual(entry.detail.next, [rule("customer", "day", 1), rule("customer", "month", 20)]);

  const enrollment = await f.request("/v1/enrollment-tokens", { caps: { day: 100 } }, owner.cookie);
  const agent = (await f.request("/v1/enroll", { name: "worker" }, null, enrollment.body.token)).body;
  const ts = new Date().toISOString();
  const receipts = [
    { id: "t1", ts, cost_usd: 0.4, model: "m", tags: { customer: "acme" } },
    { id: "t2", ts, cost_usd: 0.4, model: "m", tags: { customer: "acme" } },
    { id: "t3", ts, cost_usd: null, model: "m", tags: { customer: "globex" } },
    { id: "t4", ts, cost_usd: 0.1, model: "m" },
  ];
  assert.equal((await f.request("/v1/receipts", { receipts }, null, agent.token)).status, 200);
  const policy = (await f.request("/v1/policy", undefined, null, agent.token)).body;
  assert.equal(policy.tag_caps.truncated, false);
  assert.deepEqual(policy.tag_caps.spend.customer.acme, { day: 0.8, month: 0.8, unknown: 0 });
  assert.equal(policy.tag_caps.spend.customer.globex.unknown, 1);
  assert.equal(policy.tag_caps.spend.customer["(untagged)"].month, 0.1);
  assert.equal((await put({ tagCaps: [] }, owner.cookie)).status, 200);
  assert.equal((await f.request("/v1/policy", undefined, null, agent.token)).body.tag_caps, null);
});

// Issue #206: per-channel retry, backoff and attempt cap.
test("issue #206: only failed channels retry, with backoff and a give-up cap; a new occurrence resends all", async (t) => {
  let clock = Date.parse("2026-01-15T01:00:00Z"); // fixed UTC morning: retries must not cross a day rollover (#228)
  const calls = { email: 0, slack: 0, webhook: 0 };
  const status = { email: "accepted", slack: "accepted", webhook: "failed" };
  const deliverAlert = async (_a, _settings, opts) => {
    const want = opts?.channels ?? ["email", "slack", "webhook"];
    return want.map((channel) => { calls[channel]++; return { channel, status: status[channel] }; });
  };
  const f = await fixture(t, { now: () => clock, extra: { deliverAlert } });
  const owner = await f.login("perchannel@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "perchannel" }, null, token)).body;
  const ts = () => new Date(clock).toISOString();
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "over-1", ts: ts(), cost_usd: 2, model: "test" }] }, null, agent.token)).status, 200);
  const sweep = () => f.service().evaluateFleetAlerts();
  const activeCapHit = async () => (await f.request("/v1/fleet", undefined, owner.cookie)).body.alerts.find((a) => a.agentId === agent.agentId && a.kind === "cap_hit" && a.status !== "resolved");
  // AC1: webhook 500, email ok. Over 5 sweeps (each a due retry), email once.
  await sweep();
  assert.deepEqual(calls, { email: 1, slack: 1, webhook: 1 });
  await sweep(); // not due yet (1 min backoff)
  assert.equal(calls.webhook, 1);
  for (let i = 0; i < 3; i++) { clock += 31 * 60_000; await sweep(); }
  assert.deepEqual(calls, { email: 1, slack: 1, webhook: 4 });
  let alert = await activeCapHit();
  assert.equal(alert.delivery, "failed");
  // AC2: webhook recovers: called once more, then never again.
  status.webhook = "accepted";
  clock += 31 * 60_000; await sweep();
  clock += 31 * 60_000; await sweep();
  assert.deepEqual(calls, { email: 1, slack: 1, webhook: 5 });
  alert = await activeCapHit();
  assert.equal(alert.delivery, "accepted");
});

test("issue #206: email failing retries only email; cap writes one gave_up row; re-fire resends all", async (t) => {
  let clock = Date.parse("2026-01-15T01:00:00Z"); // fixed UTC morning: retries must not cross a day rollover (#228)
  const calls = { email: 0, slack: 0, webhook: 0 };
  const status = { email: "failed", slack: "accepted", webhook: "accepted" };
  const deliverAlert = async (_a, _settings, opts) => (opts?.channels ?? ["email", "slack", "webhook"]).map((channel) => { calls[channel]++; return { channel, status: status[channel] }; });
  const f = await fixture(t, { now: () => clock, extra: { deliverAlert } });
  const owner = await f.login("emailfail@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "emailfail" }, null, token)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "over-1", ts: new Date(clock).toISOString(), cost_usd: 2, model: "test" }] }, null, agent.token)).status, 200);
  const sweep = () => f.service().evaluateFleetAlerts();
  for (let i = 0; i < 15; i++) { await sweep(); clock += 31 * 60_000; if (i === 10) assert.equal((await f.request("/v1/receipts", { receipts: [{ id: `keep-${i}`, ts: new Date(clock).toISOString(), cost_usd: 0.01, model: "test" }] }, null, agent.token)).status, 200); }
  // AC3 + AC4: only email retried, stops at the cap, one gave_up row.
  assert.equal(calls.slack, 1);
  assert.equal(calls.webhook, 1);
  assert.equal(calls.email, 10);
  const fleet = (await f.request("/v1/fleet", undefined, owner.cookie)).body;
  const gaveUp = fleet.audit.filter((e) => e.action === "alert.delivery_gave_up");
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].detail.channel, "email");
  assert.equal(gaveUp[0].detail.attempts, 10);
  // AC5: a new occurrence after the alert resolves delivers everywhere again.
  clock += 2 * 86_400_000;
  await sweep(); // day rolled over: cap_hit resolves
  const before = { ...calls };
  status.email = "accepted";
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "over-2", ts: new Date(clock).toISOString(), cost_usd: 2, model: "test" }] }, null, agent.token)).status, 200);
  await sweep();
  assert.deepEqual(calls, { email: before.email + 1, slack: before.slack + 1, webhook: before.webhook + 1 });
});

// Issue #210: a pending occurrence interrupted by a restart is re-sent after the claim lease.
// Pinned to midday UTC: the #210 tests advance the clock by up to 2.5h, and crossing UTC
// midnight rolls the day cap period (#245), which resolves the cap_hit under test.
const middayUtc = () => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); return d.getTime(); };

async function pendingFixture(t, deliverAlert, clockRef) {
  const f = await fixture(t, { now: () => clockRef.now, extra: { deliverAlert } });
  const owner = await f.login(`pending${Math.random().toString(36).slice(2, 8)}@example.invalid`);
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "pending" }, null, token)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "over-p", ts: new Date(clockRef.now).toISOString(), cost_usd: 2, model: "test" }] }, null, agent.token)).status, 200);
  const capHit = async () => (await f.request("/v1/fleet", undefined, owner.cookie)).body.alerts.find((a) => a.agentId === agent.agentId && a.kind === "cap_hit" && a.status !== "resolved");
  return { f, capHit };
}

test("issue #210: hung send then restart re-sends once after the lease, audited recovered", async (t) => {
  const clock = { now: middayUtc() };
  let calls = 0; let hang = true;
  const deliverAlert = async () => { calls++; if (hang) return new Promise(() => {}); return [{ status: "accepted" }]; };
  const { f, capHit } = await pendingFixture(t, deliverAlert, clock);
  void f.service().evaluateFleetAlerts(); // first send never returns (process dies mid-send)
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
  hang = false;
  await f.restart();
  await f.service().evaluateFleetAlerts(); // within lease: no resend
  assert.equal(calls, 1);
  assert.equal((await capHit()).delivery, "pending");
  for (let i = 0; i < 5; i++) { clock.now += 30 * 60_000; await f.service().evaluateFleetAlerts(); }
  assert.equal(calls, 2);
  const alert = await capHit();
  assert.equal(alert.delivery, "accepted");
  const audit = JSON.parse(readFileSync(f.storePath, "utf8")).audit.filter((r) => r.action === "alert.delivery");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.recovered, true);
});

test("issue #210: legacy pending record without a claim is re-sent; concurrent sweeps never double-page", async (t) => {
  const clock = { now: middayUtc() };
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const deliverAlert = async () => { calls++; await gate; return [{ status: "accepted" }]; };
  const { f, capHit } = await pendingFixture(t, deliverAlert, clock);
  // AC2: two overlapping sweeps send once.
  const p1 = f.service().evaluateFleetAlerts();
  const p2 = f.service().evaluateFleetAlerts();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
  release(); await Promise.all([p1, p2]);
  assert.equal((await capHit()).delivery, "accepted");
  // Legacy: force the record back to pending with no claim, then restart.
  const raw = JSON.parse(readFileSync(f.storePath, "utf8"));
  for (const a of Object.values(raw.alerts)) if (a.kind === "cap_hit") { a.delivery = "pending"; delete a.delivery_claimed_at; delete a.deliveryChannels; delete a.deliveryRetry; }
  writeFileSync(f.storePath, JSON.stringify(raw));
  await f.restart();
  await f.service().evaluateFleetAlerts();
  assert.equal(calls, 2);
  assert.equal((await capHit()).delivery, "accepted");
  await f.service().evaluateFleetAlerts();
  assert.equal(calls, 2);
});

test("issue #210: dueRetryChannels honours the claim lease", async () => {
  const { dueRetryChannels, pendingRecovered, ALERT_CLAIM_LEASE_MS } = await import("../src/hosted/server.js");
  const now = Date.parse("2026-11-16T12:00:00Z");
  const fresh = new Date(now - 1000).toISOString();
  const stale = new Date(now - ALERT_CLAIM_LEASE_MS).toISOString();
  assert.deepEqual(dueRetryChannels({ delivery: "pending", delivery_claimed_at: fresh }, now), []);
  assert.equal(dueRetryChannels({ delivery: "pending", delivery_claimed_at: stale }, now), null);
  assert.equal(dueRetryChannels({ delivery: "pending" }, now), null);
  assert.equal(pendingRecovered({ delivery: "pending", delivery_claimed_at: "junk" }, now), true);
  assert.equal(pendingRecovered({ delivery: "accepted" }, now), false);
  assert.deepEqual(dueRetryChannels({ delivery: "failed", delivery_claimed_at: fresh }, now), []);
  assert.deepEqual(dueRetryChannels({ delivery: "accepted" }, now), []);
});

// Issue #240 AC1 + AC5: /v1/org-budget validation, roles, audit, restart, and org alerts.
test("#240 /v1/org-budget: validation, viewer 403 (session and key), audit, restart and alert lifecycle", async (t) => {
  let clock = Date.parse("2026-11-16T12:00:00.000Z");
  const f = await fixture(t, { now: () => clock });
  const owner = await f.login("ob-owner@example.invalid");
  await f.request("/v1/invitations", { email: "ob-viewer@example.invalid", role: "viewer" }, owner.cookie);
  const viewer = await f.login("ob-viewer@example.invalid");
  const outsider = await f.login("ob-out@example.invalid");
  const put = async (body, { cookie, key } = {}) => {
    const r = await fetch(`http://127.0.0.1:${f.service().server.address().port}/v1/org-budget`, { method: "PUT", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  for (const bad of [{ day: 0 }, { day: -5 }, { hour: 1 }, { day: 1, bogus: true }]) assert.equal((await put(bad, { cookie: owner.cookie })).status, 400);
  assert.equal((await put({ day: 1 }, { cookie: viewer.cookie })).status, 403);
  const viewerKey = (await f.request("/v1/api-keys", { name: "ro", role: "viewer" }, owner.cookie)).body.key;
  const adminKey = (await f.request("/v1/api-keys", { name: "rw", role: "admin" }, owner.cookie)).body.key;
  assert.equal((await put({ day: 1 }, { key: viewerKey })).status, 403);
  assert.equal((await put({ day: 1 })).status, 401);
  const saved = await put({ day: 1, month: 10 }, { key: adminKey });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.org_budget.caps, { day: 1, month: 10 });
  const view = await f.request("/v1/org-budget", undefined, viewer.cookie);
  assert.equal(view.body.canEdit, false);
  assert.deepEqual(view.body.org_budget.caps, { day: 1, month: 10 });
  assert.equal((await f.request("/v1/org-budget", undefined, outsider.cookie)).body.org_budget, null);
  const entries = (await f.request("/v1/evidence.json", undefined, owner.cookie)).body.audit.filter((e) => e.action === "org_budget.change");
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].detail, { before: null, after: { day: 1, month: 10 } });
  await f.restart();
  assert.deepEqual((await f.request("/v1/org-budget", undefined, owner.cookie)).body.org_budget.caps, { day: 1, month: 10 });
  // AC5: $0.85 -> cap_approaching once; $1.10 -> cap_hit once; raising the cap resolves it.
  const token = (await f.request("/v1/enrollment-tokens", { caps: {} }, owner.cookie)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "ob" }, null, token)).body;
  await f.request("/v1/receipts", { receipts: [{ id: "o1", ts: new Date(clock).toISOString(), cost_usd: 0.85, model: "test" }] }, null, agent.token);
  await f.service().evaluateFleetAlerts();
  await f.service().evaluateFleetAlerts();
  const orgAlerts = () => f.delivery.filter((a) => a.org);
  assert.deepEqual(orgAlerts().map((a) => a.key), [`cap_approaching:org:${owner.body.orgId}:day`]);
  await f.request("/v1/receipts", { receipts: [{ id: "o2", ts: new Date(clock).toISOString(), cost_usd: 0.25, model: "test" }] }, null, agent.token);
  await f.service().evaluateFleetAlerts();
  await f.service().evaluateFleetAlerts();
  assert.deepEqual(orgAlerts().map((a) => a.kind), ["cap_approaching", "cap_hit"]);
  assert.equal((await put({ day: 5 }, { cookie: owner.cookie })).status, 200);
  await f.service().evaluateFleetAlerts();
  const list = (await f.request("/v1/alerts?status=all", undefined, owner.cookie)).body;
  const recs = (list.alerts ?? list).filter((a) => a.org);
  assert.ok(recs.every((a) => !a.active), "raising the cap resolves the org alerts");
  // Month projection: $6 of a $10 month cap by mid-month pages cap_projected once.
  await f.request("/v1/receipts", { receipts: [{ id: "o3", ts: new Date(clock).toISOString(), cost_usd: 4.9, model: "test" }] }, null, agent.token);
  assert.equal((await put({ day: null }, { cookie: owner.cookie })).status, 200);
  await f.service().evaluateFleetAlerts();
  await f.service().evaluateFleetAlerts();
  assert.equal(orgAlerts().filter((a) => a.kind === "cap_projected").length, 1);
  // The day rolls over: a fresh day starts clean.
  clock += 86_400_000;
  await f.service().evaluateFleetAlerts();
});

// Issue #244: hosted modelCaps page cap_approaching / cap_hit per model on fleet-wide spend.
test("#244 AC4/AC5: per-model cap alerts fire once, resolve on rule removal, rollover and revoke; org-isolated", async (t) => {
  let nowMs = Date.parse("2026-11-16T22:30:00Z");
  const f = await fixture(t, { now: () => nowMs });
  const OPUS = "claude-opus-4-8";
  const owner = await f.login("model-244@example.invalid");
  const other = await f.login("model-244-other@example.invalid");
  const enrollAs = async (who, name) => (await f.request("/v1/enroll", { name }, null, (await f.request("/v1/enrollment-tokens", { caps: {} }, who.cookie)).body.token)).body;
  const A = await enrollAs(owner, "opus-agent");
  const X = await enrollAs(other, "other-org");
  const setCaps = (agent, who, modelCaps) => f.request(`/v1/agents/${agent.agentId}/policy`, { modelCaps, warnFractions: [0.5, 0.8] }, who.cookie);
  assert.equal((await setCaps(A, owner, [{ model: OPUS, scope: "day", usd: 5 }, { model: "claude-haiku-4-5", scope: "day", usd: 1 }])).status, 200);
  assert.equal((await setCaps(X, other, [{ model: OPUS, scope: "day", usd: 5 }])).status, 200);
  const ts = () => new Date(nowMs - 60_000).toISOString();
  const sync = (agent, receipts) => f.request("/v1/receipts", { receipts }, null, agent.token);
  assert.equal((await sync(A, [{ id: "o1", ts: ts(), model: OPUS, cost_usd: 3 }, { id: "o2", ts: ts(), model: "anthropic/claude-opus-4.8", provider: "openrouter", cost_usd: 1.1 }, { id: "h1", ts: ts(), model: "claude-haiku-4-5", cost_usd: null, reason: "usage_unavailable" }])).status, 200);
  assert.equal((await sync(X, [{ id: "x1", ts: ts(), model: OPUS, cost_usd: 40 }])).status, 200);
  // The policy snapshot: this agent's own org receipts only, dotted OpenRouter id in the Opus bucket.
  const pol = (await f.request("/v1/policy", undefined, null, A.token)).body;
  assert.deepEqual(pol.agent_spend.models, { [OPUS]: { day: 4.1, month: 4.1, unknown: 0 }, "claude-haiku-4-5": { day: 0, month: 0, unknown: 1 } });
  const alerts = async (status = "active") => (await f.request(`/v1/alerts?status=${status}`, undefined, owner.cookie)).body.alerts.filter((a) => a.model);
  await f.service().evaluateFleetAlerts();
  let act = await alerts();
  assert.equal(act.length, 1); // the unknown-cost Haiku model raises nothing
  assert.equal(act[0].kind, "cap_approaching");
  assert.equal(act[0].fraction, 0.8);
  assert.match(act[0].key, /:model:claude-opus-4-8:day/);
  assert.equal(act[0].key, `cap_approaching:${A.agentId}:model:${OPUS}:day`);
  await f.service().evaluateFleetAlerts();
  assert.equal((await alerts("all")).length, 1); // not re-sent
  // A synced fleet refusal fires cap_hit.
  assert.equal((await sync(A, [{ id: "b1", ts: ts(), blocked: true, reason: "model_budget_exceeded", model: OPUS, scope: "day", spend_usd: 5.1, cap_usd: 5, fleet: true, cost_usd: 0 }])).status, 200);
  await f.service().evaluateFleetAlerts();
  act = await alerts();
  assert.deepEqual(act.map((a) => a.kind).sort(), ["cap_hit"]);
  assert.equal(act[0].key, `cap_hit:${A.agentId}:model:${OPUS}:day`);
  // Removing the rule resolves.
  assert.equal((await setCaps(A, owner, null)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal((await alerts()).length, 0);
  // Re-adding it fires again; the next org day resolves it.
  await setCaps(A, owner, [{ model: OPUS, scope: "day", usd: 5 }]);
  await f.service().evaluateFleetAlerts();
  assert.equal((await alerts()).length, 1);
  nowMs += 2 * 3600_000; // next org (UTC) day
  await f.service().evaluateFleetAlerts();
  assert.equal((await alerts()).length, 0);
  // Back in a hot period, revoking the agent resolves.
  await sync(A, [{ id: "o3", ts: ts(), model: OPUS, cost_usd: 6 }]);
  await f.service().evaluateFleetAlerts();
  assert.deepEqual((await alerts()).map((a) => a.kind), ["cap_hit"]);
  assert.equal((await f.request(`/v1/agents/${A.agentId}/revoke`, {}, owner.cookie)).status, 200);
  await f.service().evaluateFleetAlerts();
  assert.equal((await alerts()).length, 0);
  // The other org's $40 never reached this org's alert list.
  assert.ok((await alerts("all")).every((a) => a.agentId === A.agentId));
  // Agent card: fleet spend per rule (the other org's agent shows only its own spend).
  const card = (await f.request("/v1/fleet", undefined, other.cookie)).body.agents.find((a) => a.id === X.agentId);
  assert.deepEqual(card.modelSpend, { [OPUS]: { day: 0, month: 40, unknown: 0 } });
});
