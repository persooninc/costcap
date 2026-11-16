// Issue #243: fleet tag cap alerts (cap_approaching/cap_hit per tag value) with per-rule warning fractions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { evaluateTagAlerts } from "../src/hosted/alerts.js";
import { parseFleetTagCaps, validFleetTagCaps, fleetTagCapsPolicy } from "../src/hosted/tag-caps.js";
import { createAlertDelivery, webhookPayload } from "../src/hosted/delivery.js";
import { buildEvidence } from "../src/hosted/evidence.js";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const rule = (extra = {}) => ({ key: "customer", scope: "day", usd: 5, ...extra });
const sp = (values) => ({ customer: values });

test("unit: cap_hit at the cap, cap_approaching at 0.8 by default, key and record shape", () => {
  const out = evaluateTagAlerts({ orgId: "o", rules: [rule()], spend: sp({ acme: { day: 5, month: 5, unknown: 0 }, beta: { day: 4, month: 4, unknown: 0 }, gamma: { day: 1, month: 9, unknown: 0 } }) });
  assert.deepEqual(out, [
    { kind: "cap_hit", key: "cap_hit:tag:o:customer=acme:day", tag: { key: "customer", value: "acme" }, scope: "day", cap: 5, spent: 5 },
    { kind: "cap_approaching", key: "cap_approaching:tag:o:customer=beta:day", tag: { key: "customer", value: "beta" }, scope: "day", cap: 5, spent: 4, fraction: 0.8 },
  ]);
});

test("unit: per-rule fractions, untagged value, month scope, [] turns warnings off", () => {
  const out = evaluateTagAlerts({ orgId: "o", rules: [rule({ scope: "month", usd: 10, warnFractions: [0.5, 0.9] })], spend: sp({ "(untagged)": { day: 0, month: 6, unknown: 0 } }) });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "cap_approaching:tag:o:customer=(untagged):month:p50");
  assert.equal(out[0].fraction, 0.5);
  assert.deepEqual(evaluateTagAlerts({ orgId: "o", rules: [rule({ warnFractions: [] })], spend: sp({ a: { day: 4.9, month: 4.9, unknown: 0 } }) }), []);
});

test("unit: a synced block hits even under the cap; unknown cost raises nothing; other rules ignored", () => {
  const blockedHits = [{ tag_key: "customer", tag_value: "acme", scope: "day" }, { tag_key: "customer", tag_value: "zeta", scope: "month" }];
  const out = evaluateTagAlerts({ orgId: "o", rules: [rule()], spend: sp({ acme: { day: 1, month: 1, unknown: 0 } }), blockedHits });
  assert.deepEqual(out.map((a) => a.key), ["cap_hit:tag:o:customer=acme:day"]);
  assert.deepEqual(evaluateTagAlerts({ orgId: "o", rules: [rule()], spend: sp({ acme: { day: 9, month: 9, unknown: 1 } }), blockedHits }), []);
});

test("unit: parseFleetTagCaps accepts, sorts and validates warnFractions; policy still valid", () => {
  assert.deepEqual(parseFleetTagCaps([rule({ warnFractions: [0.9, 0.5] })]).rules, [rule({ warnFractions: [0.5, 0.9] })]);
  assert.deepEqual(parseFleetTagCaps([rule()]).rules, [rule()]);
  for (const bad of [[0], [1], [0.5, 0.5], "x", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]]) assert.match(parseFleetTagCaps([rule({ warnFractions: bad })]).error, /warnFractions/, JSON.stringify(bad));
  assert.equal(validFleetTagCaps(fleetTagCapsPolicy([rule({ warnFractions: [0.5] })], [], NOW)), true);
});

test("unit: delivery text, webhook payload and evidence carry the tag", async () => {
  const alert = { id: "x", kind: "cap_hit", orgId: "o", agentId: null, tag: { key: "customer", value: "acme" }, scope: "day", cap: 5, spent: 5.2 };
  const sent = [];
  const deliver = createAlertDelivery({ slackWebhook: "https://hooks.slack.com/services/T/B/x", fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; } });
  await deliver(alert);
  assert.match(sent[0].text, /CostCap cap_hit: tag customer=acme, day \(spent \$5\.2 of \$5 cap\)/);
  assert.deepEqual(webhookPayload(alert).tag, { key: "customer", value: "acme" });
  assert.equal(webhookPayload({ ...alert, tag: undefined }).tag, null);
  const ev = buildEvidence({ orgId: "o", alerts: [alert], nowMs: NOW, spendFor: () => ({}) });
  assert.deepEqual(ev.alerts[0].tag, { key: "customer", value: "acme" });
});

async function fixture(t, clock) {
  let code;
  const delivered = [];
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-243-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {}, now: () => clock.ms,
    verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {},
    deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth, method) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const c = await request("/auth/request", { email: "tag-243@example.invalid", turnstileToken: "x" });
  const vr = await fetch(`http://127.0.0.1:${service.server.address().port}/auth/verify`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code }) });
  const owner = vr.headers.get("set-cookie").split(";")[0];
  const e = await request("/v1/enrollment-tokens", { caps: { day: 100 } }, owner);
  const token = (await request("/v1/enroll", { name: "a" }, null, e.body.token)).body.token;
  let n = 0;
  const receipt = (fields) => request("/v1/receipts", { receipts: [{ id: `r${++n}`, ts: new Date(clock.ms).toISOString(), model: "m", ...fields }] }, null, token);
  return { request, owner, receipt, delivered, sweep: () => service.evaluateFleetAlerts() };
}

test("regression: hosted sweep fires, gates once per period, resolves on rule removal and rollover", async (t) => {
  const clock = { ms: NOW };
  const f = await fixture(t, clock);
  assert.equal((await f.request("/v1/tag-caps", { tagCaps: [rule({ warnFractions: [2] })] }, f.owner, null, "PUT")).status, 400);
  const put = await f.request("/v1/tag-caps", { tagCaps: [rule({ warnFractions: [0.8, 0.5] })] }, f.owner, null, "PUT");
  assert.deepEqual(put.body.tagCaps[0].warnFractions, [0.5, 0.8]);
  const audit = (await f.request("/v1/evidence.json", undefined, f.owner)).body.audit.find((x) => x.action === "tag_caps.change");
  assert.deepEqual(audit.detail.next[0].warnFractions, [0.5, 0.8]);

  assert.equal((await f.receipt({ cost_usd: 3, tags: { customer: "acme" } })).status, 200);
  await f.receipt({ cost_usd: null, tags: { customer: "unk" } });
  await f.receipt({ cost_usd: 4.9 });
  await f.sweep();
  const keys = () => f.delivered.filter((a) => a.tag).map((a) => a.key);
  assert.deepEqual(keys().sort(), ["cap_approaching:tag:" + f.delivered[0].orgId + ":customer=(untagged):day", "cap_approaching:tag:" + f.delivered[0].orgId + ":customer=acme:day:p50"].sort());
  const org = f.delivered[0].orgId;
  // Same state: no re-delivery.
  await f.sweep();
  assert.equal(keys().length, 2);
  // Synced block under the cap pages cap_hit with tag fields on the record.
  await f.receipt({ cost_usd: 0, blocked: true, reason: "tag_budget_exceeded", tag_key: "customer", tag_value: "acme", scope: "day", tags: { customer: "acme" } });
  await f.sweep();
  const hit = f.delivered.find((a) => a.key === `cap_hit:tag:${org}:customer=acme:day`);
  assert.ok(hit);
  assert.deepEqual(hit.tag, { key: "customer", value: "acme" });
  assert.equal(hit.cap, 5);
  const fleet = (await f.request("/v1/fleet", undefined, f.owner)).body;
  assert.ok(fleet.alerts.some((a) => a.key === hit.key && a.active && a.tag.value === "acme"));
  // Removing the rule resolves every tag alert.
  await f.request("/v1/tag-caps", { tagCaps: [] }, f.owner, null, "PUT");
  await f.sweep();
  const after = (await f.request("/v1/fleet", undefined, f.owner)).body.alerts.filter((a) => a.tag);
  assert.ok(after.length >= 3 && after.every((a) => !a.active));
  // Rule back, next day: yesterday's spend no longer counts, nothing fires.
  await f.request("/v1/tag-caps", { tagCaps: [rule()] }, f.owner, null, "PUT");
  clock.ms = NOW + 86_400_000 + 3_700_000;
  const tagged = () => f.delivered.filter((a) => a.tag);
  const before = tagged().length;
  await f.sweep();
  assert.equal(tagged().length, before);
  // A fresh 4.1 on the new day fires the default 0.8 warning once.
  await f.receipt({ cost_usd: 4.1, tags: { customer: "acme" } });
  await f.sweep();
  await f.sweep();
  assert.deepEqual(tagged().slice(before).map((a) => a.key), [`cap_approaching:tag:${org}:customer=acme:day`]);
});
