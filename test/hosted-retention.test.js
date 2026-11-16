// Issue #211: org receipt retention. GET/POST /v1/retention (roles, validation, audit),
// the purge sweep (cutoff, 32-day/current-month floor, unknown and batch_pending kept,
// org isolation), ingest of already-expired receipts, and unchanged current-period verdicts.
import test from "node:test";
import assert from "node:assert/strict";
import { createHostedServer } from "../src/hosted/server.js";
import { EMPTY_STATE, memoryCore } from "../src/hosted/store.js";
import { periodBounds } from "../src/period.js";
import { expiredReceiptKeys, isExpired, retentionCutoffMs, retentionDaysError, retentionFloorMs, retentionMaxDays } from "../src/hosted/retention.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");

function memoryStore() {
  const core = memoryCore(structuredClone(EMPTY_STATE));
  return { mode: "memory", ...core, async flush() {}, healthy: () => true };
}

async function fixture(t, nowMs = NOW) {
  const codes = {};
  const store = memoryStore();
  const clock = { now: nowMs };
  const service = createHostedServer({ store, origin: "http://localhost", secureCookies: false, now: () => clock.now, stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [{ status: "accepted" }] });
  service.server.keepAliveTimeout = 60_000;
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = () => `http://127.0.0.1:${service.server.address().port}`;
  const raw = (path, body, cookie, auth) => fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const request = async (...args) => { const r = await raw(...args); return { status: r.status, body: await r.json() }; };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    const r = await raw("/auth/verify", { challengeId: c.body.challengeId, code: codes[email] });
    return r.headers.get("set-cookie").split(";")[0];
  };
  const enroll = async (cookie, name, caps) => {
    const token = (await request("/v1/enrollment-tokens", caps ? { caps } : {}, cookie)).body.token;
    return (await request("/v1/enroll", { name }, null, token)).body;
  };
  return { service, store, clock, raw, request, login, enroll };
}

const iso = (ms) => new Date(ms).toISOString();

test("#211 pure: validation, plan max, cutoff, floor and keep rules", () => {
  assert.equal(retentionDaysError(null), null);
  assert.equal(retentionDaysError(7), null);
  assert.equal(retentionDaysError(365), null);
  assert.match(retentionDaysError(6), /between 7 and 365/);
  assert.match(retentionDaysError(366), /between 7 and 365/);
  assert.match(retentionDaysError(30.5), /integer/);
  assert.match(retentionDaysError("30"), /integer/);
  assert.match(retentionDaysError(60, 30), /between 7 and 30/);
  assert.equal(retentionMaxDays({ enforced: false, limits: { receiptRetentionDays: 30 } }), 365);
  assert.equal(retentionMaxDays({ enforced: true, limits: { receiptRetentionDays: 30 } }), 30);
  assert.equal(retentionMaxDays({ enforced: true, limits: { receiptRetentionDays: Infinity } }), 365);
  assert.equal(retentionCutoffMs(null, NOW), null);
  assert.equal(retentionCutoffMs(60, NOW), NOW - 60 * DAY);
  // Floor: last 32 days / current UTC month / org budget month, whichever is earliest.
  assert.equal(retentionFloorMs(NOW), NOW - 32 * DAY);
  for (const bp of [null, { timezone: "Pacific/Kiritimati", monthStartDay: 1 }, { timezone: "America/Los_Angeles", monthStartDay: 28 }]) {
    for (const at of [NOW, Date.parse("2026-12-31T23:00:00Z"), Date.parse("2026-03-01T00:30:00Z")]) {
      const floor = retentionFloorMs(at, bp);
      assert.ok(floor <= periodBounds("month", at, bp).start);
      assert.ok(floor <= at - 32 * DAY);
      assert.ok(floor <= Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), 1));
    }
  }
  // Cutoff boundary: exactly at the cutoff is kept, one ms earlier is expired.
  const cutoff = retentionCutoffMs(60, NOW), floor = retentionFloorMs(NOW);
  assert.equal(isExpired({ receipt: { ts: iso(cutoff), cost_usd: 1 } }, cutoff, floor), false);
  assert.equal(isExpired({ receipt: { ts: iso(cutoff - 1), cost_usd: 1 } }, cutoff, floor), true);
  // A short setting never reaches inside the floor.
  const short = retentionCutoffMs(7, NOW);
  assert.equal(isExpired({ receipt: { ts: iso(floor), cost_usd: 1 } }, short, floor), false);
  assert.equal(isExpired({ receipt: { ts: iso(floor - 1), cost_usd: 1 } }, short, floor), true);
  const old = iso(NOW - 100 * DAY);
  assert.equal(isExpired({ receipt: { ts: old, cost_usd: null } }, cutoff, floor), false, "unsettled unknown kept");
  assert.equal(isExpired({ receipt: { ts: old, cost_usd: null }, settlement: { cost_usd: 2 } }, cutoff, floor), true, "settled unknown purgeable");
  assert.equal(isExpired({ receipt: { ts: old, cost_usd: null, reason: "batch_pending" } }, cutoff, floor), false);
  assert.equal(isExpired({ receipt: { ts: old, cost_usd: null, reason: "batch_pending" }, settlement: { cost_usd: 1 } }, cutoff, floor), false);
  assert.equal(isExpired({ receipt: { ts: "nope", cost_usd: 1 } }, cutoff, floor), false);
  assert.equal(isExpired({ receipt: { ts: old, cost_usd: 1 } }, null, floor), false);
  assert.deepEqual(expiredReceiptKeys({ a: { orgId: "o1", receipt: { ts: old, cost_usd: 1 } }, b: { orgId: "o2", receipt: { ts: old, cost_usd: 1 } } }, "o1", cutoff, floor), ["a"]);
  assert.deepEqual(expiredReceiptKeys({ a: { orgId: "o1", receipt: { ts: old, cost_usd: 1 } } }, "o1", null, floor), []);
});

test("#211 AC1/AC2: /v1/retention roles, validation, default and audit", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("ret-owner@example.invalid");
  assert.equal((await f.request("/v1/retention")).status, 401);
  let r = await f.request("/v1/retention", undefined, owner);
  assert.equal(r.status, 200);
  assert.deepEqual({ days: r.body.days, cutoff: r.body.cutoff, eligible_count: r.body.eligible_count, min: r.body.min, max: r.body.max, canEdit: r.body.canEdit }, { days: null, cutoff: null, eligible_count: 0, min: 7, max: 365, canEdit: true });
  for (const days of [6, 366, 30.5, "30", undefined]) assert.equal((await f.request("/v1/retention", days === undefined ? {} : { days }, owner)).status, 400, String(days));
  r = await f.request("/v1/retention", { days: 30 }, owner);
  assert.equal(r.status, 200);
  assert.equal(r.body.days, 30);
  assert.equal(r.body.cutoff, iso(NOW - 30 * DAY));
  // Viewer: reads, cannot write. API keys (even admin) cannot write.
  assert.equal((await f.request("/v1/invitations", { email: "ret-viewer@example.invalid", role: "viewer" }, owner)).status, 201);
  const viewer = await f.login("ret-viewer@example.invalid");
  assert.equal((await f.request("/v1/retention", undefined, viewer)).body.days, 30);
  assert.equal((await f.request("/v1/retention", undefined, viewer)).body.canEdit, false);
  assert.equal((await f.request("/v1/retention", { days: 60 }, viewer)).status, 403);
  const key = (await f.request("/v1/api-keys", { name: "ci", role: "admin" }, owner)).body.key;
  assert.match(key, /^cck_/);
  assert.equal((await f.request("/v1/retention", undefined, null, key)).status, 200);
  assert.equal((await f.request("/v1/retention", { days: 60 }, null, key)).status, 403);
  // Admin can write; null turns retention off.
  assert.equal((await f.request("/v1/invitations", { email: "ret-admin@example.invalid", role: "admin" }, owner)).status, 201);
  const admin = await f.login("ret-admin@example.invalid");
  assert.equal((await f.request("/v1/retention", { days: null }, admin)).body.days, null);
  const changes = f.store.read((s) => s.audit.filter((e) => e.action === "retention.change"));
  assert.deepEqual(changes.map((e) => e.detail), [{ before: null, after: 30 }, { before: 30, after: null }]);
});

test("#211 AC3-AC6: sweep deletes only expired settled receipts, keeps the floor, unknown and batch_pending, isolates orgs; ingest drops expired", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("sweep-owner@example.invalid");
  const other = await f.login("sweep-other@example.invalid");
  const a = await f.enroll(owner, "alpha", { month: 10, day: 5 });
  const b = await f.enroll(other, "beta");
  const old = (d) => iso(NOW - d * DAY);
  const floor = retentionFloorMs(NOW);
  const receipts = [
    { id: "old1", ts: old(70), cost_usd: 1, model: "m" },
    { id: "old2", ts: iso(floor - 1000), cost_usd: 1, model: "m" },
    { id: "edge", ts: iso(floor), cost_usd: 1, model: "m" },
    { id: "unk", ts: old(71), cost_usd: null, model: "m" },
    { id: "batch", ts: old(72), cost_usd: null, reason: "batch_pending", batch_id: "b1", model: "m" },
    { id: "settled", ts: old(73), cost_usd: null, model: "m", run_id: "r1" },
    { id: "cur", ts: old(2), cost_usd: 4, model: "m", run_id: "r1" },
  ];
  assert.equal((await f.request("/v1/receipts", { receipts }, null, a.token)).status, 200);
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "x1", ts: old(90), cost_usd: 2, model: "m" }] }, null, b.token)).status, 200);
  assert.equal((await f.request("/v1/receipts/settled/settle", { agent_id: a.agentId ?? a.id, cost_usd: 2, source: "manual_evidence", reason: "invoice" }, owner)).status, 200);

  // Null retention: sweep is a no-op.
  assert.deepEqual(f.service.purgeExpiredReceipts(), []);
  const agentId = f.store.read((s) => Object.values(s.agents).find((x) => x.name === "alpha").id);
  const verdictBefore = (await f.request(`/v1/agents/${agentId}/budget`, undefined, owner)).body;
  const csvBefore = await (await f.raw("/v1/receipts.csv", undefined, owner)).text();
  assert.match(csvBefore, /old1/);
  const evIds = async () => (await f.request("/v1/evidence.json", undefined, owner)).body.receipts.map((x) => x.receipt_id);
  const runIds = async () => (await f.request(`/v1/agents/${agentId}/runs/r1`, undefined, owner)).body.receipts.map((x) => x.receipt_id);
  const spendTotal = async () => (await f.request("/v1/spend?since=2026-01-01", undefined, owner)).body;
  assert.ok((await evIds()).includes("old1"));
  assert.deepEqual((await runIds()).sort(), ["cur", "settled"]);
  const spendBefore = await spendTotal();

  assert.equal((await f.request("/v1/retention", { days: 30 }, owner)).status, 200);
  assert.equal((await f.request("/v1/retention", undefined, owner)).body.eligible_count, 3);
  const swept = f.service.purgeExpiredReceipts();
  assert.deepEqual(swept, [{ orgId: f.store.read((s) => Object.values(s.agents).find((x) => x.name === "alpha").orgId), count: 3 }]);
  const left = f.store.read((s) => Object.values(s.receipts).map((r) => r.receipt.id).sort());
  assert.deepEqual(left, ["batch", "cur", "edge", "unk", "x1"]);
  const purges = f.store.read((s) => s.audit.filter((e) => e.action === "receipts.purge"));
  assert.equal(purges.length, 1);
  assert.deepEqual(purges[0].detail, { count: 3, cutoff: iso(NOW - 30 * DAY) });
  assert.equal(purges[0].actor, "retention-sweep");
  assert.equal((await f.request("/v1/retention", undefined, owner)).body.eligible_count, 0);
  assert.deepEqual(f.service.purgeExpiredReceipts(), [], "idempotent");

  // AC6: reads no longer return deleted receipts; the current-period verdict is unchanged.
  const csv = await (await f.raw("/v1/receipts.csv", undefined, owner)).text();
  for (const id of ["old1", "old2", "settled"]) assert.doesNotMatch(csv, new RegExp(`\\b${id}\\b`));
  assert.match(csv, /\bcur\b/);
  assert.notDeepEqual(await spendTotal(), spendBefore);
  assert.deepEqual((await runIds()), ["cur"]);
  assert.deepEqual((await evIds()).sort(), ["batch", "cur", "edge", "unk"]);
  assert.deepEqual((await f.request(`/v1/agents/${agentId}/budget`, undefined, owner)).body, verdictBefore);

  // AC5: ingest of an expired receipt is acknowledged, not stored; floor/unknown still stored.
  const r = await f.request("/v1/receipts", { receipts: [{ id: "late", ts: old(80), cost_usd: 1, model: "m" }, { id: "late-unk", ts: old(80), cost_usd: null, model: "m" }, { id: "fresh", ts: old(1), cost_usd: 1, model: "m" }] }, null, a.token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { acceptedIds: ["late", "late-unk", "fresh"], expired: 1 });
  const ids = f.store.read((s) => Object.values(s.receipts).map((x) => x.receipt.id));
  assert.equal(ids.includes("late"), false);
  assert.ok(ids.includes("late-unk") && ids.includes("fresh"));
  const sync = f.store.read((s) => s.audit.filter((e) => e.action === "receipts.sync").at(-1));
  assert.deepEqual(sync.detail, { count: 3, expired: 1 });
  // The other org (retention null) never lost anything.
  assert.ok(ids.includes("x1"));
});

test("#211 Postgres: purged receipt keys become DELETE rows", async () => {
  const { openPostgresStore } = await import("../src/hosted/store-postgres.js");
  const deleted = [];
  const pool = { async connect() { return {
    async query(sql, params) {
      if (/^SELECT kind, id, body/.test(sql)) return { rows: [] };
      if (/^DELETE FROM store_records/.test(sql.trim())) deleted.push(...params[0].map((k, i) => `${k}/${params[1][i]}`));
      return { rows: [] };
    },
    release() {},
  }; } };
  const store = await openPostgresStore({ pool, log: () => {} });
  const ORG = "00000000-0000-4000-8000-0000000000a1";
  const old = iso(NOW - 90 * DAY);
  store.transaction((s) => {
    s.orgs[ORG] = { id: ORG, receiptRetentionDays: 30 };
    s.receipts["ag:r1"] = { orgId: ORG, agentId: "ag", receipt: { id: "r1", ts: old, cost_usd: 1 } };
    s.receipts["ag:r2"] = { orgId: ORG, agentId: "ag", receipt: { id: "r2", ts: iso(NOW - DAY), cost_usd: 1 } };
  });
  await store.flush();
  const service = createHostedServer({ store, origin: "http://localhost", secureCookies: false, now: () => NOW, verifyChallenge: async () => true, sendCode: async () => {} });
  assert.deepEqual(service.purgeExpiredReceipts(), [{ orgId: ORG, count: 1 }]);
  await store.flush();
  assert.deepEqual(deleted, ["receipts/ag:r1"]);
});
