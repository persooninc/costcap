// Issue #245: org/team/tag cap_hit must not re-fire from last period's block after
// rollover, and a local --tag-cap refusal must not page the fleet tag rule.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { blocksInCurrentPeriod, isFleetTagBlock, evaluateTagAlerts } from "../src/hosted/alerts.js";

const at = (iso) => Date.parse(iso);
const rule = { key: "customer", scope: "day", usd: 5 };

test("unit: blocksInCurrentPeriod drops last period's blocks (UTC day, non-UTC tz, month start day)", () => {
  const b = (ts, scope = "day", reason = "budget_exceeded") => ({ ts, scope, reason });
  const now = at("2026-11-17T00:06:00Z");
  const rs = [b("2026-11-16T23:50:00Z"), b("2026-11-17T00:01:00Z"), b("2026-11-17T00:02:00Z", "day", "tag_budget_exceeded"), b("bad"), null, b("2026-11-16T22:00:00Z")];
  assert.deepEqual(blocksInCurrentPeriod(rs, { reason: "budget_exceeded", nowMs: now }).map((r) => r.ts), ["2026-11-17T00:01:00Z"]);
  // Los Angeles: 23:50 PST and 00:06 PST straddle the local midnight (08:00 UTC).
  const la = { timezone: "America/Los_Angeles", monthStartDay: 1 };
  assert.equal(blocksInCurrentPeriod([b("2026-11-17T07:50:00Z")], { reason: "budget_exceeded", nowMs: at("2026-11-17T08:06:00Z"), budgetPeriod: la }).length, 0);
  assert.equal(blocksInCurrentPeriod([b("2026-11-17T07:50:00Z")], { reason: "budget_exceeded", nowMs: at("2026-11-17T07:59:00Z"), budgetPeriod: la }).length, 1);
  // Month with monthStartDay 15: a block on the 14th does not count on the 15th.
  const m15 = { timezone: "UTC", monthStartDay: 15 };
  assert.equal(blocksInCurrentPeriod([b("2026-11-14T23:50:00Z", "month")], { reason: "budget_exceeded", nowMs: at("2026-11-15T00:06:00Z"), budgetPeriod: m15 }).length, 0);
  assert.equal(blocksInCurrentPeriod([b("2026-11-15T00:01:00Z", "month")], { reason: "budget_exceeded", nowMs: at("2026-11-15T00:06:00Z"), budgetPeriod: m15 }).length, 1);
  // Unknown scopes are dropped via scopeOf.
  assert.equal(blocksInCurrentPeriod([b("2026-11-17T00:01:00Z", "org:day")], { reason: "budget_exceeded", nowMs: now }).length, 0);
  assert.equal(blocksInCurrentPeriod([b("2026-11-17T00:01:00Z", "org:day")], { reason: "budget_exceeded", nowMs: now, scopeOf: (r) => r.scope.slice(4) }).length, 1);
  assert.deepEqual(blocksInCurrentPeriod(undefined, { reason: "x", nowMs: now }), []);
});

test("unit: isFleetTagBlock accepts fleet refusals at or above the rule cap (#248: a fleet block at a stricter local cap does not page) and legacy blocks at the rule cap only", () => {
  assert.equal(isFleetTagBlock({ fleet: true, cap_usd: 0.5 }, rule), false);
  assert.equal(isFleetTagBlock({ fleet: true, cap: 0.5 }, rule), false);
  assert.equal(isFleetTagBlock({ fleet: true, cap_usd: 5 }, rule), true);
  assert.equal(isFleetTagBlock({ fleet: true, cap_usd: 6 }, rule), true);
  assert.equal(isFleetTagBlock({ fleet: true }, rule), true);
  assert.equal(isFleetTagBlock({ fleet: false }, rule), false);
  assert.equal(isFleetTagBlock({}, rule), true);
  assert.equal(isFleetTagBlock({ cap_usd: 5 }, rule), true);
  assert.equal(isFleetTagBlock({ cap: 5 }, rule), true);
  assert.equal(isFleetTagBlock({ cap_usd: 0.5 }, rule), false);
  const hits = [{ tag_key: "customer", tag_value: "gamma", scope: "day", cap_usd: 0.5 }];
  assert.deepEqual(evaluateTagAlerts({ orgId: "o", rules: [rule], spend: { customer: { gamma: { day: 0.5, month: 0.5, unknown: 0 } } }, blockedHits: hits }), []);
});

async function fixture(t, clock) {
  let code;
  const delivered = [];
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-245-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {}, now: () => clock.ms,
    verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {},
    deliverAlert: async (a) => { delivered.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth, method) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const c = await request("/auth/request", { email: "rollover-245@example.invalid", turnstileToken: "x" });
  const vr = await fetch(`http://127.0.0.1:${service.server.address().port}/auth/verify`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code }) });
  const owner = vr.headers.get("set-cookie").split(";")[0];
  const e = await request("/v1/enrollment-tokens", { caps: { day: 100 } }, owner);
  const token = (await request("/v1/enroll", { name: "a" }, null, e.body.token)).body.token;
  let n = 0;
  const receipt = (fields) => request("/v1/receipts", { receipts: [{ id: `r${++n}`, ts: new Date(clock.ms).toISOString(), model: "m", ...fields }] }, null, token);
  return { request, owner, receipt, delivered, sweep: () => service.evaluateFleetAlerts() };
}

test("regression: 23:50 -> 00:05 -> 00:06 -> 00:55 rollover pages cap_hit once per key per period; local tag-cap block never pages", async (t) => {
  const clock = { ms: at("2026-11-16T20:00:00Z") };
  const f = await fixture(t, clock);
  assert.equal((await f.request("/v1/org-budget", { day: 10 }, f.owner, null, "PUT")).status, 200);
  assert.equal((await f.request("/v1/tag-caps", { tagCaps: [{ ...rule, warnFractions: [] }] }, f.owner, null, "PUT")).status, 200);
  await f.receipt({ cost_usd: 6, tags: { customer: "acme" } });
  await f.receipt({ cost_usd: 5, tags: { customer: "beta" } });
  clock.ms = at("2026-11-16T23:50:00Z");
  await f.receipt({ cost_usd: 0, blocked: true, reason: "tag_budget_exceeded", tag_key: "customer", tag_value: "acme", scope: "day", spend_usd: 6, cap_usd: 5, fleet: true, tags: { customer: "acme" } });
  await f.receipt({ cost_usd: 0, blocked: true, reason: "budget_exceeded", scope: "org:day" });
  await f.sweep();
  const hits = () => f.delivered.filter((a) => a.kind === "cap_hit" && (a.org || a.tag)).map((a) => a.key);
  const org = f.delivered[0].orgId;
  assert.deepEqual(hits().sort(), [`cap_hit:org:${org}:day`, `cap_hit:tag:${org}:customer=acme:day`, `cap_hit:tag:${org}:customer=beta:day`]);
  for (const ms of ["2026-11-17T00:05:00Z", "2026-11-17T00:06:00Z", "2026-11-17T00:55:00Z"]) { clock.ms = at(ms); await f.sweep(); }
  assert.equal(hits().length, 3, `no re-fire after rollover: ${hits()}`);
  const active = (await f.request("/v1/fleet", undefined, f.owner)).body.alerts.filter((a) => (a.org || a.tag) && a.active);
  assert.deepEqual(active, []);
  // 00:56: a local --tag-cap customer:day=0.5 refusal (no fleet flag) under the fleet $5 cap.
  clock.ms = at("2026-11-17T00:56:00Z");
  await f.receipt({ cost_usd: 0.5, tags: { customer: "gamma" } });
  await f.receipt({ cost_usd: 0, blocked: true, reason: "tag_budget_exceeded", tag_key: "customer", tag_value: "gamma", scope: "day", spend_usd: 0.5, cap_usd: 0.5, tags: { customer: "gamma" } });
  await f.sweep();
  assert.equal(hits().length, 3);
  // Same period: a fleet refusal under the cap still pages, exactly once.
  await f.receipt({ cost_usd: 0, blocked: true, reason: "tag_budget_exceeded", tag_key: "customer", tag_value: "gamma", scope: "day", spend_usd: 0.5, cap_usd: 5, fleet: true, tags: { customer: "gamma" } });
  await f.receipt({ cost_usd: 0, blocked: true, reason: "budget_exceeded", scope: "org:day" });
  await f.sweep();
  await f.sweep();
  assert.deepEqual(hits().slice(3).sort(), [`cap_hit:org:${org}:day`, `cap_hit:tag:${org}:customer=gamma:day`]);
});
