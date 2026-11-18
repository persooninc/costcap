// go-to-market#14: GA4 funnel events (sign_up, activation, begin_checkout, purchase).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountId, buildEvent, funnelConfig, trackFunnel, purchaseParams, resetFunnelForTests, PRODUCT } from "../src/hosted/funnel.js";
import { createHostedServer } from "../src/hosted/server.js";

const ENV = { GA4_MEASUREMENT_ID: "G-TEST1234", GA4_API_SECRET: "test-secret" };
const sink = () => { const calls = []; const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 204 }; }; return { calls, fetchImpl }; };

test("config is null unless both GA4 vars are valid", () => {
  assert.equal(funnelConfig({}), null);
  assert.equal(funnelConfig({ GA4_MEASUREMENT_ID: "bad", GA4_API_SECRET: "x" }), null);
  assert.equal(funnelConfig({ GA4_MEASUREMENT_ID: "G-TEST1234" }), null);
  assert.deepEqual(funnelConfig({ GA_MEASUREMENT_ID: "G-TEST1234", GA4_API_SECRET: "s" }), { measurementId: "G-TEST1234", apiSecret: "s" });
});

test("buildEvent allowlists events and params, accountId is opaque", () => {
  assert.equal(PRODUCT, "costcap");
  assert.equal(buildEvent("page_view"), null);
  const b = buildEvent("sign_up", { account_id: accountId("org-1"), email: "a@b.c", method: "email_code", value: 5, plan: "" });
  assert.deepEqual(b.events[0].params, { product: "costcap", account_id: accountId("org-1"), method: "email_code", value: 5 });
  assert.equal(b.client_id, `${accountId("org-1")}.0`);
  assert.match(accountId("org-1"), /^[0-9a-f]{16}$/);
  assert.equal(buildEvent("purchase").client_id, "server.0");
});

test("trackFunnel: silent when unconfigured, dedupes once-events, retries after failure, never throws", async () => {
  resetFunnelForTests();
  assert.deepEqual(await trackFunnel("bogus"), { sent: false, reason: "unknown_event" });
  assert.deepEqual(await trackFunnel("sign_up", {}, { env: {} }), { sent: false, reason: "not_configured" });
  const s = sink();
  assert.deepEqual(await trackFunnel("sign_up", { account_id: "a" }, { env: ENV, fetchImpl: s.fetchImpl }), { sent: true });
  assert.deepEqual(await trackFunnel("sign_up", { account_id: "a" }, { env: ENV, fetchImpl: s.fetchImpl }), { sent: false, reason: "duplicate" });
  assert.match(s.calls[0].url, /measurement_id=G-TEST1234/);
  assert.deepEqual(await trackFunnel("activation", { account_id: "b" }, { env: ENV, fetchImpl: async () => ({ ok: false, status: 500 }) }), { sent: false, reason: "http_500" });
  assert.deepEqual(await trackFunnel("activation", { account_id: "b" }, { env: ENV, fetchImpl: async () => { throw new Error("down"); } }), { sent: false, reason: "network" });
  assert.deepEqual(await trackFunnel("activation", { account_id: "b" }, { env: ENV, fetchImpl: s.fetchImpl }), { sent: true });
  // durable claim hooks
  let released = 0;
  assert.deepEqual(await trackFunnel("activation", { account_id: "c" }, { env: ENV, fetchImpl: s.fetchImpl, claim: async () => false }), { sent: false, reason: "duplicate" });
  assert.deepEqual(await trackFunnel("activation", { account_id: "d" }, { env: ENV, fetchImpl: s.fetchImpl, claim: async () => { throw new Error("x"); } }), { sent: false, reason: "claim_failed" });
  assert.deepEqual(await trackFunnel("activation", { account_id: "e" }, { env: ENV, fetchImpl: async () => ({ ok: false, status: 503 }), claim: async () => true, release: async () => { released++; throw new Error("ignored"); } }), { sent: false, reason: "http_503" });
  assert.deepEqual(await trackFunnel("activation", { account_id: "f" }, { env: ENV, fetchImpl: async () => { throw new Error("x"); }, claim: async () => true, release: async () => { released++; } }), { sent: false, reason: "network" });
  assert.equal(released, 2);
  // non-once events are not deduped
  assert.deepEqual(await trackFunnel("begin_checkout", { account_id: "a" }, { env: ENV, fetchImpl: s.fetchImpl }), { sent: true });
  assert.deepEqual(await trackFunnel("begin_checkout", { account_id: "a" }, { env: ENV, fetchImpl: s.fetchImpl }), { sent: true });
});

test("purchaseParams maps a checkout session", () => {
  assert.deepEqual(purchaseParams({ id: "cs_1", client_reference_id: "org", currency: "usd", amount_total: 1900 }, "workspace"),
    { account_id: accountId("org"), plan: "workspace", currency: "USD", value: 19, transaction_id: "cs_1" });
  assert.equal(purchaseParams(null, "x").value, undefined);
});

test("hosted flow emits sign_up -> activation -> begin_checkout -> purchase with no PII", async (t) => {
  resetFunnelForTests();
  const s = sink();
  let code;
  let webhookOut = { received: true };
  const billing = {
    status: async () => ({}), portal: async () => ({}),
    checkout: async () => ({ url: "https://checkout.stripe.com/c/test" }),
    webhook: async () => webhookOut,
  };
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-funnel-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, billingFactory: () => billing, funnel: { env: ENV, fetchImpl: s.fetchImpl } });
  service.server.keepAliveTimeout = 60_000;
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const req = async (path, body, cookie, auth, raw) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : raw ?? JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => { const c = await req("/auth/request", { email, turnstileToken: "x" }); return req("/auth/verify", { challengeId: c.body.challengeId, code }); };
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const owner = await login("owner@example.invalid");
  await login("owner@example.invalid"); // returning login: no second sign_up
  const token = (await req("/v1/enrollment-tokens", { caps: { day: 1 } }, owner.cookie)).body.token;
  const agent = (await req("/v1/enroll", { name: "w" }, null, token)).body;
  const r = (id) => ({ id, ts: new Date().toISOString(), cost_usd: 0.1, model: "m" });
  assert.equal((await req("/v1/receipts", { receipts: [r("r1")] }, null, agent.token)).status, 200);
  assert.equal((await req("/v1/receipts", { receipts: [r("r2")] }, null, agent.token)).status, 200); // not first
  assert.equal((await req("/billing/checkout", { plan: "team" }, owner.cookie)).status, 200);
  const session = { id: "cs_test_1", client_reference_id: owner.body.orgId, currency: "usd", amount_total: 1900, payment_status: "paid", metadata: { app: "costcap", org_id: owner.body.orgId, plan: "team" }, customer_email: "owner@example.invalid" };
  const event = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: session } });
  assert.equal((await req("/billing/webhook", {}, null, null, event)).status, 200);
  webhookOut = { received: true, duplicate: true };
  await req("/billing/webhook", {}, null, null, event); // duplicate: no second purchase
  webhookOut = { received: true };
  await req("/billing/webhook", {}, null, null, JSON.stringify({ id: "evt_2", type: "invoice.paid", data: { object: {} } }));
  await req("/billing/webhook", {}, null, null, "not json");
  await settle();
  const events = s.calls.map((c) => c.body.events[0]);
  assert.deepEqual(events.map((e) => e.name), ["sign_up", "activation", "begin_checkout", "purchase"]);
  const acct = accountId(owner.body.orgId);
  for (const e of events) assert.equal(e.params.account_id, acct);
  assert.equal(events[1].params.activation_kind, "first_receipt");
  assert.equal(events[2].params.plan, "team");
  assert.deepEqual(events[3].params, { product: "costcap", account_id: acct, plan: "team", currency: "USD", value: 19, transaction_id: "cs_test_1" });
  assert.ok(!JSON.stringify(s.calls.map((c) => c.body)).includes("example.invalid"), "no email in GA4 payloads");
});
