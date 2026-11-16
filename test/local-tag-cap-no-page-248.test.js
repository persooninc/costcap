// Issue #248: a fleet tag refusal bound by a stricter local --tag-cap is sent as
// fleet: false and never pages the fleet rule's cap_hit; equal caps still page.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { cachedFleetTagVerdict, mergeTagCapRules } from "../src/hosted/tag-caps.js";
import { evaluateTagAlerts } from "../src/hosted/alerts.js";

const NOW = Date.parse("2026-11-16T20:00:00Z");
const fleetRule = { key: "customer", scope: "day", usd: 5 };
const policyAt = (day) => ({ as_of: new Date(NOW).toISOString(), rules: [fleetRule], spend: { customer: { gamma: { day, month: day, unknown: 0 } } } });
const verdict = (day, local) => cachedFleetTagVerdict(policyAt(day), local, { customer: "gamma" }, [], NOW);

test("unit: mergeTagCapRules keeps the fleet rule's usd alongside the merged cap", () => {
  assert.deepEqual(mergeTagCapRules([fleetRule], [{ key: "customer", scope: "day", cap: 0.5 }]), [{ key: "customer", scope: "day", cap: 0.5, fleetUsd: 5 }]);
  assert.deepEqual(mergeTagCapRules([fleetRule], []), [{ key: "customer", scope: "day", cap: 5, fleetUsd: 5 }]);
});

test("unit: cachedFleetTagVerdict marks the binding cap (local stricter -> fleet: false; equal/none/looser -> fleet: true)", () => {
  const local = verdict(0.6, [{ key: "customer", scope: "day", cap: 0.5 }]);
  assert.deepEqual(local, { verdict: "tag_budget_exceeded", tag_key: "customer", tag_value: "gamma", scope: "day", spend_usd: 0.6, cap_usd: 0.5, fleet: false });
  assert.equal(verdict(5, [{ key: "customer", scope: "day", cap: 5 }]).fleet, true);
  assert.equal(verdict(5, []).fleet, true);
  assert.equal(verdict(5, [{ key: "customer", scope: "day", cap: 9 }]).fleet, true);
  assert.equal(verdict(0.6, []), null);
  const spend = { customer: { gamma: { day: 0.6, month: 0.6, unknown: 0 } } };
  assert.deepEqual(evaluateTagAlerts({ orgId: "o1", rules: [fleetRule], spend, blockedHits: [local] }), []);
  assert.deepEqual(evaluateTagAlerts({ orgId: "o1", rules: [fleetRule], spend, blockedHits: [{ ...local, fleet: true }] }), []);
});

async function fixture(t, clock) {
  let code;
  const delivered = [];
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-248-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {}, now: () => clock.ms,
    verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {},
    deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = () => `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, auth, method) => {
    const r = await fetch(`${base()}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const c = await request("/auth/request", { email: "local-tag-248@example.invalid", turnstileToken: "x" });
  const vr = await fetch(`${base()}/auth/verify`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code }) });
  const owner = vr.headers.get("set-cookie").split(";")[0];
  const e = await request("/v1/enrollment-tokens", { caps: { day: 100 } }, owner);
  const token = (await request("/v1/enroll", { name: "a" }, null, e.body.token)).body.token;
  let n = 0;
  const receipt = (fields) => request("/v1/receipts", { receipts: [{ id: `r${++n}`, ts: new Date(clock.ms).toISOString(), model: "m", ...fields }] }, null, token);
  return { request, owner, receipt, delivered, sweep: () => service.evaluateFleetAlerts() };
}

const tagHits = (f) => f.delivered.filter((a) => a.kind === "cap_hit" && a.tag).map((a) => a.key);
const syncBlock = (f, v) => f.receipt({ cost_usd: 0, blocked: true, reason: v.verdict, ...v, tags: { customer: "gamma" } });

test("regression: a wrapper with --tag-cap customer:day=0.5 refusing at $0.60 fleet spend does not page the $5 fleet rule", async (t) => {
  const clock = { ms: NOW };
  const f = await fixture(t, clock);
  assert.equal((await f.request("/v1/tag-caps", { tagCaps: [{ ...fleetRule, warnFractions: [] }] }, f.owner, null, "PUT")).status, 200);
  await f.receipt({ cost_usd: 0.6, tags: { customer: "gamma" } });
  const v = verdict(0.6, [{ key: "customer", scope: "day", cap: 0.5 }]);
  assert.equal(v.fleet, false);
  await syncBlock(f, v);
  await f.sweep();
  assert.deepEqual(tagHits(f), []);
});

test("regression: the same wrapper without a local rule at >= $5 synced spend fires exactly one cap_hit", async (t) => {
  const clock = { ms: NOW };
  const f = await fixture(t, clock);
  assert.equal((await f.request("/v1/tag-caps", { tagCaps: [{ ...fleetRule, warnFractions: [] }] }, f.owner, null, "PUT")).status, 200);
  await f.receipt({ cost_usd: 5, tags: { customer: "gamma" } });
  await syncBlock(f, verdict(5, []));
  await f.sweep();
  await f.sweep();
  assert.equal(tagHits(f).length, 1);
});

test("regression: equal local and fleet caps still page the fleet rule from the refusal alone", async (t) => {
  const clock = { ms: NOW };
  const f = await fixture(t, clock);
  assert.equal((await f.request("/v1/tag-caps", { tagCaps: [{ ...fleetRule, warnFractions: [] }] }, f.owner, null, "PUT")).status, 200);
  // Spend synced below cap; the refusal (pending local receipts pushed it over) carries cap_usd 5.
  await f.receipt({ cost_usd: 4, tags: { customer: "gamma" } });
  const v = { ...verdict(5, [{ key: "customer", scope: "day", cap: 5 }]), spend_usd: 5 };
  assert.equal(v.fleet, true);
  await syncBlock(f, v);
  await f.sweep();
  assert.equal(tagHits(f).length, 1);
});
