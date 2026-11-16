import test from "node:test";
import assert from "node:assert/strict";
import { createAlertDelivery } from "../src/hosted/delivery.js";

test("unconfigured delivery is explicit, never calls provider", async () => {
  const send = createAlertDelivery({ fetchImpl: () => { throw new Error("must not call"); } });
  assert.deepEqual(await send({ kind: "cap_hit" }), [{ channel: "email", status: "unconfigured" }, { channel: "slack", status: "unconfigured" }, { channel: "webhook", status: "unconfigured" }]);
});
test("each channel reports acceptance or failure independently", async () => {
  const requests = [];
  const send = createAlertDelivery({ emailKey: "test-key", emailFrom: "test@example.invalid", emailTo: ["admin@example.invalid"], slackWebhook: "https://hooks.slack.com/services/test/test/test",
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: url.includes("api.brevo.com"), status: url.includes("api.brevo.com") ? 200 : 503 }; } });
  const results = await send({ kind: "cap_hit", agentId: "worker", scope: "day" });
  assert.equal(results[0].status, "accepted");
  assert.equal(results[1].status, "failed");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.redirect, "error");
  assert.match(JSON.parse(requests[0].options.body).textContent, /not a billing guarantee/);
});
test("invalid webhook origins are rejected before delivery", () => {
  assert.throws(() => createAlertDelivery({ slackWebhook: "http://hooks.slack.com/services/a" }), /HTTPS/);
  assert.throws(() => createAlertDelivery({ slackWebhook: "https://evil.invalid/services/a" }), /Slack webhook/);
});

// Issue #121: per-org routing.
import { createOrgAlertRouter, maskWebhook, validSlackWebhook } from "../src/hosted/delivery.js";
test("org router delivers each org's alert only to that org's own channels", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, body: options.body }); return { ok: true, status: 200 }; };
  const route = createOrgAlertRouter({ emailKey: "k", emailFrom: "alerts@example.invalid", fetchImpl });
  const hookA = "https://hooks.slack.com/services/TA/BA/orgA0001", hookB = "https://hooks.slack.com/services/TB/BB/orgB0002";
  const a = await route({ kind: "cap_hit", orgId: "A" }, { emails: ["a@a.invalid"], slackWebhook: hookA });
  assert.deepEqual(a.map((r) => r.status), ["accepted", "accepted", "unconfigured"]);
  assert.deepEqual(calls.map((c) => c.url), ["https://api.brevo.com/v3/smtp/email", hookA]);
  assert.match(calls[0].body, /a@a\.invalid/);
  calls.length = 0;
  await route({ kind: "cap_hit", orgId: "B" }, { emails: [], slackWebhook: hookB });
  assert.deepEqual(calls.map((c) => c.url), [hookB]);
  calls.length = 0;
  assert.deepEqual(await route({ kind: "cap_hit", orgId: "C" }, null), [{ status: "unconfigured" }]);
  assert.equal(calls.length, 0);
});
test("env fallback applies only to its one org and only without saved settings", async () => {
  const calls = [];
  const route = createOrgAlertRouter({ emailKey: "k", emailFrom: "f@example.invalid", fetchImpl: async (url) => { calls.push(url); return { ok: true }; }, fallback: { orgId: "A", emailTo: ["ops@example.invalid"] } });
  assert.equal((await route({ kind: "x", orgId: "A" }, null))[0].status, "accepted");
  assert.deepEqual(await route({ kind: "x", orgId: "B" }, null), [{ status: "unconfigured" }]);
  assert.equal(calls.length, 1);
  const saved = await route({ kind: "x", orgId: "A" }, { emails: [], slackWebhook: "https://hooks.slack.com/services/T/B/own" });
  assert.equal(saved[1].status, "accepted");
  assert.equal(calls.at(-1), "https://hooks.slack.com/services/T/B/own");
});
test("webhook validation and masking", () => {
  assert.equal(validSlackWebhook("https://hooks.slack.com/services/T1/B2/abc"), true);
  for (const bad of ["http://hooks.slack.com/services/a", "https://hooks.slack.com.evil.invalid/services/a", "https://hooks.slack.com/workflows/a", "https://hooks.slack.com/services/a?x=1", "https://u@hooks.slack.com/services/a", 42, null]) assert.equal(validSlackWebhook(bad), false, String(bad));
  assert.equal(maskWebhook("https://hooks.slack.com/services/T1/B2/secretWXYZ"), "https://hooks.slack.com/services/…WXYZ");
  assert.equal(maskWebhook(null), null);
});

// Issue #199: signed generic webhook destination.
import { assertWebhookTarget, isBlockedAddress, maskAlertSettings, maskSignedWebhook, signWebhook, verifyWebhookSignature, webhookPayload, webhookUrlProblem } from "../src/hosted/delivery.js";
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const hookUrl = "https://alerts.example.com/costcap";
const secret = "whsec_" + "0123456789abcdef".repeat(3);
test("signed webhook: one POST per alert kind with documented fields and a verifiable signature", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; };
  const nowMs = () => Date.parse("2026-11-16T12:00:00Z");
  const send = createAlertDelivery({ webhook: { url: hookUrl, secret }, dashboardUrl: "https://app.costcap.dev", lookup: publicLookup, fetchImpl, nowMs });
  const alerts = [
    { id: "o1", kind: "cap_hit", orgId: "A", agentId: "ag1", agentName: "worker", scope: "day", period: "2026-11-16", spent: 2.5, cap: 2, fired_at: "2026-11-16T12:00:00.000Z" },
    { id: "o2", kind: "cap_approaching", orgId: "A", agentId: "ag1", scope: "run", run_id: "run-7", fraction: 0.8, spent: 0.8, cap: 1, unknown_count: 2 },
    { id: "o3", kind: "cap_hit", orgId: "A", agentId: null, team: "ops", scope: "month", spent: 31, cap: 30, unknown_count: 0 },
    { id: "o4", kind: "loop_detected", orgId: "A", agentId: "ag1" },
  ];
  for (const a of alerts) {
    const before = calls.length;
    const res = await send(a);
    assert.deepEqual(res.at(-1), { channel: "webhook", status: "accepted" });
    assert.equal(calls.length, before + 1);
  }
  for (const [i, { url, options }] of calls.entries()) {
    assert.equal(url, hookUrl);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body), ["id", "kind", "org_id", "agent_id", "agent_name", "team", "org", "run_id", "scope", "period", "fraction", "spent_usd", "cap_usd", "unknown_count", "today_usd", "baseline_usd", "multiplier", "top_models", "lower_bound", "fired_at", "dashboard_url"]);
    assert.equal(body.id, alerts[i].id);
    assert.equal(body.spent_usd, alerts[i].spent ?? null);
    assert.equal(body.cap_usd, alerts[i].cap ?? null);
    assert.equal(body.dashboard_url, "https://app.costcap.dev");
    assert.ok(verifyWebhookSignature(secret, options.body, options.headers["x-costcap-signature"], { nowMs: nowMs() }));
    assert.equal(verifyWebhookSignature("whsec_other", options.body, options.headers["x-costcap-signature"], { nowMs: nowMs() }), false);
  }
  assert.equal(JSON.parse(calls[1].options.body).unknown_count, 2);
  assert.equal(JSON.parse(calls[2].options.body).unknown_count, 0);
  assert.equal(JSON.parse(calls[3].options.body).unknown_count, null, "missing unknown count is null, never 0");
  assert.equal(JSON.parse(calls[1].options.body).run_id, "run-7");
  assert.equal(JSON.parse(calls[2].options.body).team, "ops");
});
test("signature format and verification edge cases", () => {
  const body = "{\"a\":1}";
  const header = signWebhook(secret, body, 1700000000);
  assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.ok(verifyWebhookSignature(secret, body, header, { nowMs: 1700000000_000 }));
  assert.equal(verifyWebhookSignature(secret, body + " ", header, { nowMs: 1700000000_000 }), false);
  assert.equal(verifyWebhookSignature(secret, body, header, { nowMs: 1700001000_000 }), false, "stale timestamp");
  for (const bad of [undefined, "", "t=x,v1=zz", "v1=" + "a".repeat(64)]) assert.equal(verifyWebhookSignature(secret, body, bad), false);
});
test("webhook failures: non-2xx, timeout and private resolution record failed", async () => {
  const mk = (fetchImpl, lookup = publicLookup) => createAlertDelivery({ webhook: { url: hookUrl, secret }, lookup, fetchImpl });
  assert.equal((await mk(async () => ({ ok: false, status: 500 }))({ kind: "cap_hit" })).at(-1).status, "failed");
  assert.equal((await mk(async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); })({ kind: "cap_hit" })).at(-1).status, "failed");
  let called = false;
  const rebound = await mk(async () => { called = true; return { ok: true }; }, async () => [{ address: "10.0.0.5", family: 4 }])({ kind: "cap_hit" });
  assert.equal(rebound.at(-1).status, "failed");
  assert.equal(called, false, "a host that now resolves privately is never contacted");
});
test("SSRF guard: URL shape and resolved addresses", async () => {
  for (const bad of ["http://alerts.example.com/x", "https://u:p@alerts.example.com/x", "https://alerts.example.com:8443/x", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://box.local/x", "https://meta.internal/x", "https://intranet/x", "not a url", 7, "https://" + "a".repeat(600) + ".com"]) assert.ok(webhookUrlProblem(bad), String(bad));
  assert.equal(webhookUrlProblem("https://alerts.example.com:443/x"), null);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fd00:ec2::254", "garbage"]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
  await assertWebhookTarget(hookUrl, publicLookup);
  await assertWebhookTarget(hookUrl, async () => ({ address: "93.184.216.34" }));
  for (const lookup of [async () => [{ address: "93.184.216.34" }, { address: "192.168.0.9" }], async () => [], async () => { throw new Error("ENOTFOUND"); }])
    await assert.rejects(assertWebhookTarget(hookUrl, lookup), (e) => e.status === 400);
  await assert.rejects(assertWebhookTarget("http://x.example.com", publicLookup), /https/);
});
test("signed webhook masking never reveals path or full secret", () => {
  const m = maskSignedWebhook({ url: "https://alerts.example.com/hooks/privatePath", secret });
  assert.deepEqual(m, { url: "https://alerts.example.com/…", secret: "whsec_…cdef" });
  assert.equal(maskSignedWebhook(null), null);
  assert.equal(maskSignedWebhook({ url: "::bad", secret: null }).secret, null);
  const all = maskAlertSettings({ emails: [], slackWebhook: null, webhook: { url: hookUrl, secret } });
  assert.equal(all.configured, true);
  assert.ok(!JSON.stringify(all).includes(secret) && !JSON.stringify(all).includes("/costcap"));
  assert.deepEqual(webhookPayload({ kind: "x", unknownCount: 3 }).unknown_count, 3);
});
test("org router sends org A's alert to org A's webhook only", async () => {
  const calls = [];
  const route = createOrgAlertRouter({ lookup: publicLookup, fetchImpl: async (url) => { calls.push(url); return { ok: true }; } });
  await route({ kind: "cap_hit", orgId: "A" }, { emails: [], slackWebhook: null, webhook: { url: "https://a.example.com/h", secret } });
  await route({ kind: "cap_hit", orgId: "B" }, { emails: [], slackWebhook: null, webhook: null });
  assert.deepEqual(calls, ["https://a.example.com/h"]);
});
