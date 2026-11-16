// Issue #224: weekly digest — settings routes, scheduler tick with an injected
// clock and fake delivery, per-channel retry, preview parity, memory + Postgres stores.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

const H = 3600_000, DAY = 24 * H;
const C = "owner@digest-c.example";
const SLOT = Date.parse("2026-11-16T09:00:00Z"); // Monday 09:00 UTC: digest for 2026-W46.

async function fixture(t, clock, { failSlackTimes = 0, store } = {}) {
  let code;
  const sent = [];
  let slackFailures = failSlackTimes;
  const service = createHostedServer({ ...(store ? { store } : { storePath: join(mkdtempSync(join(tmpdir(), "cc-digest-")), "store.json") }), origin: "http://localhost", secureCookies: false, stripeEnv: {}, now: () => clock.ms,
    verifyChallenge: async (v) => v === "ok", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {},
    resolveHost: async () => [{ address: "93.184.216.34" }],
    deliverDigest: async (digest, dest, { channels }) => {
      sent.push({ digest, dest, channels });
      return channels.map((channel) => ({ channel, status: channel === "slack" && slackFailures-- > 0 ? "failed" : "accepted" }));
    } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = () => `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, method) => {
    const r = await fetch(`${base()}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const login = async (email) => { const c = await request("/auth/request", { email, turnstileToken: "ok" }); const v = await fetch(`${base()}/auth/verify`, { method: "POST", headers: { origin: "http://localhost", connection: "close", "content-type": "application/json" }, body: JSON.stringify({ challengeId: c.body.challengeId, code }) }); return v.headers.get("set-cookie")?.split(";")[0]; };
  const agent = async (cookie, name, caps = {}) => { const e = await request("/v1/enrollment-tokens", { caps }, cookie); const r = await fetch(`${base()}/v1/enroll`, { method: "POST", headers: { connection: "close", "content-type": "application/json", authorization: `Bearer ${e.body.token}` }, body: JSON.stringify({ name }) }); return r.json(); };
  const upload = (token, rows) => fetch(`${base()}/v1/receipts`, { method: "POST", headers: { connection: "close", "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ receipts: rows }) });
  const audit = async (email, action) => (await request("/v1/evidence.json", undefined, await login(email))).body.audit.filter((e) => e.action === action);
  return { request, login, agent, upload, audit, sent, tick: () => service.runDigests() };
}

test("AC2: digest settings — defaults, validation, roles, audit, org isolation", async (t) => {
  const clock = { ms: SLOT - 6 * DAY };
  const f = await fixture(t, clock);
  const owner = await f.login("owner@digest-a.example");
  const got = await f.request("/v1/digest-settings", undefined, owner);
  assert.equal(got.status, 200);
  // New org: on, email only, Monday 09:00 in the budget-period timezone.
  assert.deepEqual(got.body, { digest: { enabled: true, weekday: 1, hour: 9, channels: ["email"] }, timezone: "UTC", canEdit: true });
  for (const bad of [{ weekday: 7 }, { hour: 24 }, { hour: -1 }, { channels: ["sms"] }, { enabled: "yes" }, { cadence: "daily" }]) {
    assert.equal((await f.request("/v1/digest-settings", bad, owner, "PUT")).status, 400, JSON.stringify(bad));
  }
  const put = await f.request("/v1/digest-settings", { weekday: 5, hour: 17, channels: ["slack", "email"] }, owner, "PUT");
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.digest, { enabled: true, weekday: 5, hour: 17, channels: ["email", "slack"] });
  const rows = await f.audit("owner@digest-a.example", "digest.settings");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].detail.before, { enabled: true, weekday: 1, hour: 9, channels: ["email"] });
  assert.deepEqual(rows[0].detail.after.channels, ["email", "slack"]);
  // A viewer reads but cannot write.
  assert.equal((await f.request("/v1/invitations", { email: "viewer@digest-a.example", role: "viewer" }, owner)).status, 201);
  const viewer = await f.login("viewer@digest-a.example");
  const seen = await f.request("/v1/digest-settings", undefined, viewer);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.digest.weekday, 5);
  assert.equal(seen.body.canEdit, false);
  assert.equal((await f.request("/v1/digest-settings", { enabled: false }, viewer, "PUT")).status, 403);
  assert.equal((await f.request("/v1/digest/preview", undefined, viewer)).status, 200, "any member can preview");
  // Org B sees and changes only its own settings.
  const other = await f.login("owner@digest-b.example");
  assert.equal((await f.request("/v1/digest-settings", undefined, other)).body.digest.weekday, 1);
  assert.equal((await f.request("/v1/digest-settings", { enabled: false }, other, "PUT")).status, 200);
  assert.equal((await f.request("/v1/digest-settings", undefined, owner)).body.digest.enabled, true);
  assert.equal((await f.audit("owner@digest-a.example", "digest.settings")).length, 1);
  assert.equal((await f.request("/v1/digest-settings", undefined, null)).status, 401);
});

async function seeded(t, opts = {}) {
  const clock = { ms: SLOT - 7 * DAY + H }; // Mon Nov 9 10:00Z, inside W46.
  const f = await fixture(t, clock, opts);
  const owner = await f.login("owner@digest-c.example");
  assert.equal((await f.request("/v1/alert-settings", { emails: ["owner@digest-c.example"], slackWebhook: "https://hooks.slack.com/services/T0/B0/fixture" }, owner)).status, 200);
  assert.equal((await f.request("/v1/digest-settings", { channels: ["email", "slack"] }, owner, "PUT")).status, 200);
  const a = await f.agent(owner, "alpha", { month: 100 });
  const b = await f.agent(owner, "beta");
  assert.equal((await f.upload(a.token, [{ id: "w46a", ts: "2026-11-10T10:00:00Z", cost_usd: 12, model: "gpt-4o" }, { id: "w45a", ts: "2026-11-03T10:00:00Z", cost_usd: 4, model: "gpt-4o" }])).status, 200);
  assert.equal((await f.upload(b.token, [{ id: "w46b", ts: "2026-11-11T10:00:00Z", cost_usd: null, model: "claude" }])).status, 200);
  return { f, clock, owner };
}

test("AC3+AC4+AC5: one send per week at the slot, per-channel retry, preview parity", async (t) => {
  const { f, clock, owner } = await seeded(t, { failSlackTimes: 1 });
  // Before the slot: nothing.
  clock.ms = SLOT - 60_000;
  assert.equal(await f.tick(), 0);
  clock.ms = SLOT + 30_000;
  assert.equal(await f.tick(), 1);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].channels, ["email", "slack"]);
  assert.deepEqual(f.sent[0].dest.emails, ["owner@digest-c.example"]);
  const d = f.sent[0].digest;
  assert.equal(d.week, "2026-W46");
  assert.deepEqual(d.total, { usd_known: 12, unknown_count: 1, lower_bound: true, calls: 2 });
  assert.equal(d.previous.usd_known, 4);
  assert.equal(d.headroom[0].name, "alpha");
  let sentRows = await f.audit(C, "digest.sent");
  assert.equal(sentRows.length, 1);
  assert.deepEqual(sentRows[0].detail.outcome, { email: "accepted", slack: "failed" });
  const fresh = await f.login(C);
  // Preview returns the same JSON the scheduler sent, without sending or auditing.
  const preview = await f.request("/v1/digest/preview?week=2026-W46", undefined, fresh);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.digest, d);
  assert.match(preview.body.text, /at least \$12\.00/);
  const dflt = await f.request("/v1/digest/preview", undefined, fresh);
  assert.equal(dflt.body.digest.week, "2026-W46", "default preview is last week");
  assert.equal((await f.request("/v1/digest/preview?week=2026-46", undefined, fresh)).status, 400);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.audit(C, "digest.sent")).length, 1);
  // Same tick time: Slack backoff not due yet; email is never resent.
  assert.equal(await f.tick(), 0);
  clock.ms += 2 * 60_000;
  assert.equal(await f.tick(), 1);
  assert.deepEqual(f.sent[1].channels, ["slack"]);
  sentRows = await f.audit(C, "digest.sent");
  assert.equal(sentRows.length, 2);
  assert.deepEqual(sentRows[1].detail.outcome, { slack: "accepted" });
  assert.equal(sentRows[1].detail.retry, true);
  assert.equal(sentRows[1].actor_label, "system:digest-worker");
  // Later ticks the same week send nothing.
  for (const later of [H, 23 * H, 3 * DAY]) { clock.ms = SLOT + later; assert.equal(await f.tick(), 0); }
  assert.equal(f.sent.length, 2);
  // Next week's slot sends W47 once.
  clock.ms = SLOT + 7 * DAY;
  assert.equal(await f.tick(), 1);
  assert.equal(f.sent[2].digest.week, "2026-W47");
  assert.deepEqual(f.sent[2].digest.previous.week, "2026-W46");
});

test("AC3: a slot missed by more than 24h is skipped and audited, not sent", async (t) => {
  const { f, clock, owner } = await seeded(t);
  clock.ms = SLOT + 25 * H;
  assert.equal(await f.tick(), 0);
  assert.equal(f.sent.length, 0);
  const skipped = await f.audit(C, "digest.skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].detail.week, "2026-W46");
  assert.equal(await f.tick(), 0);
  assert.equal((await f.audit(C, "digest.skipped")).length, 1);
});

test("AC3: a missed slot within 24h (restart) is still sent on the next tick", async (t) => {
  const { f, clock } = await seeded(t);
  clock.ms = SLOT + 20 * H;
  assert.equal(await f.tick(), 1);
  assert.equal(f.sent[0].digest.week, "2026-W46");
});

test("AC4: disabled digest or no destinations sends nothing and does not throw", async (t) => {
  const { f, clock, owner } = await seeded(t);
  assert.equal((await f.request("/v1/digest-settings", { enabled: false }, owner, "PUT")).status, 200);
  clock.ms = SLOT + 60_000;
  assert.equal(await f.tick(), 0);
  // Another org with the default (email on) but no alert destinations.
  const lonely = await f.login("owner@digest-d.example");
  assert.equal((await f.request("/v1/digest-settings", undefined, lonely)).body.digest.enabled, true);
  clock.ms = SLOT + 7 * DAY + 60_000;
  assert.equal(await f.tick(), 0);
  assert.equal(f.sent.length, 0);
  // Re-enabling after the slot does not page for weeks before it was turned on.
  assert.equal((await f.request("/v1/digest-settings", { enabled: true }, await f.login(C), "PUT")).status, 200);
  assert.equal(await f.tick(), 0);
  assert.equal((await f.audit(C, "digest.skipped")).length, 0);
});

// Seeded store state: one org with email + webhook destinations and W46 spend.
const ORG = "00000000-0000-4000-8000-0000000000d1";
function seed(s) {
  s.orgs[ORG] = { id: ORG, name: "seeded", created: SLOT - 30 * DAY, digest: { enabled: true, weekday: 1, hour: 9, channels: ["email", "webhook"] }, alertSettings: { emails: ["fin@seeded.example", "gone@seeded.example"], slackWebhook: null, webhook: { url: "https://hooks.example.com/x", secret: "whsec_fixture" } } };
  s.users.u1 = { id: "u1", orgId: ORG, email: "fin@seeded.example", role: "owner", verified: true };
  s.agents.ag = { id: "ag", orgId: ORG, name: "seed-agent", policy: { version: 1, caps: {} } };
  s.receipts["ag:r1"] = { orgId: ORG, agentId: "ag", receipt: { id: "r1", ts: "2026-11-10T10:00:00.000Z", cost_usd: 3, model: "m" } };
}

test("AC4: an adapter that throws fails every channel; the retry resends them, verified members only", async () => {
  const { memoryCore, EMPTY_STATE } = await import("../src/hosted/store.js");
  const store = { mode: "memory", ...memoryCore(structuredClone(EMPTY_STATE)), async flush() {} };
  store.transaction(seed);
  const clock = { ms: SLOT + 60_000 };
  const calls = [];
  const service = createHostedServer({ store, origin: "http://localhost", now: () => clock.ms, verifyChallenge: async () => true, sendCode: async () => {},
    deliverDigest: async (d, dest, { channels }) => { calls.push({ dest, channels }); if (calls.length === 1) throw new Error("boom"); return channels.map((channel) => ({ channel, status: "accepted" })); } });
  assert.equal(await service.runDigests(), 1);
  assert.deepEqual(calls[0].dest.emails, ["fin@seeded.example"], "unverified/non-member addresses are dropped");
  const rec = store.read((s) => s.digests[`${ORG}:2026-W46`]);
  assert.deepEqual(rec.deliveryChannels, { email: "failed", webhook: "failed" });
  assert.equal(rec.delivery, "failed");
  clock.ms += 2 * 60_000;
  assert.equal(await service.runDigests(), 1);
  assert.deepEqual(calls[1].channels, ["email", "webhook"]);
  assert.equal(store.read((s) => s.digests[`${ORG}:2026-W46`].delivery), "accepted");
  assert.equal(await service.runDigests(), 0);
  // A send cut off by a restart (pending, claim expired) resends the unaccepted channels.
  store.transaction((s) => { s.digests[`${ORG}:2026-W46`] = { orgId: ORG, week: "2026-W46", channels: ["email", "webhook"], delivery: "pending", deliveryChannels: { email: "accepted" } }; });
  assert.equal(await service.runDigests(), 1);
  assert.deepEqual(calls[2].channels, ["webhook"]);
  // No deliverDigest configured: recorded as unconfigured, nothing thrown.
  store.transaction((s) => { delete s.digests[`${ORG}:2026-W46`]; });
  const bare = createHostedServer({ store, origin: "http://localhost", now: () => clock.ms, verifyChallenge: async () => true, sendCode: async () => {} });
  assert.equal(await bare.runDigests(), 1);
  assert.equal(store.read((s) => s.digests[`${ORG}:2026-W46`].delivery), "unconfigured");
});

test("Postgres store: the digest ledger persists as org-scoped digests rows", async () => {
  const { openPostgresStore } = await import("../src/hosted/store-postgres.js");
  const upserts = [];
  const pool = { async connect() { return {
    async query(sql, params) {
      if (/^SELECT kind, id, body/.test(sql)) return { rows: [] };
      if (/^INSERT INTO/.test(sql.trim())) params[0].forEach((k, i) => upserts.push({ kind: k, id: params[1][i], org: params[2] }));
      return { rows: [] };
    },
    release() {},
  }; } };
  const store = await openPostgresStore({ pool, log: () => {} });
  store.transaction(seed);
  await store.flush();
  const sent = [];
  const service = createHostedServer({ store, origin: "http://localhost", now: () => SLOT + 60_000, verifyChallenge: async () => true, sendCode: async () => {},
    deliverDigest: async (d, _dest, { channels }) => { sent.push(d); return channels.map((channel) => ({ channel, status: "accepted" })); } });
  assert.equal(await service.runDigests(), 1);
  await store.flush();
  const row = upserts.find((u) => u.kind === "digests");
  assert.deepEqual(row, { kind: "digests", id: `${ORG}:2026-W46`, org: ORG });
  assert.equal(sent[0].total.usd_known, 3);
  assert.equal(await service.runDigests(), 0);
  assert.equal(store.read((s) => s.audit.filter((e) => e.action === "digest.sent").length), 1);
});
