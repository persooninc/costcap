import test from "node:test";
import assert from "node:assert/strict";
import { createAlertDelivery } from "../src/hosted/delivery.js";

test("unconfigured delivery is explicit, never calls provider", async () => {
  const send = createAlertDelivery({ fetchImpl: () => { throw new Error("must not call"); } });
  assert.deepEqual(await send({ kind: "cap_hit" }), [{ channel: "email", status: "unconfigured" }, { channel: "slack", status: "unconfigured" }]);
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
  assert.deepEqual(a.map((r) => r.status), ["accepted", "accepted"]);
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
