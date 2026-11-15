// FA-CC-04: one store contract, run on the JSON file adapter and the Postgres adapter.
// Postgres runs in a disposable container (CI-only DB); it skips locally without Docker, never in CI.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/hosted/store.js";
import { openPostgresStore } from "../src/hosted/store-postgres.js";
import { diffRecords, fromRecords, toRecords } from "../src/hosted/store-records.js";
import { createHostedServer } from "../src/hosted/server.js";
import { applyMigrations } from "../scripts/db-apply.mjs";
import { psql } from "../scripts/db-migrate.mjs";
import { skipUnlessDocker } from "./support/docker.js";
import { startPostgres } from "./support/postgres.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

async function healthOf(store) {
  const service = createHostedServer({ store, origin: "http://localhost", secureCookies: false, verifyChallenge: async () => false, sendCode: async () => {} });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  try { return await (await fetch(`http://127.0.0.1:${service.server.address().port}/health`)).json(); }
  finally { service.server.closeAllConnections(); service.server.close(); }
}

async function contract(open, mode) {
  const store = await open();
  assert.equal(store.mode, mode);
  store.transaction((s) => {
    s.orgs[ORG_A] = { id: ORG_A, name: "a.example", created: 1 };
    s.orgs[ORG_B] = { id: ORG_B, name: "b.example", created: 2 };
    s.users.u1 = { id: "u1", email: "a@a.example", orgId: ORG_A, role: "owner", verified: true };
    s.users.u2 = { id: "u2", email: "b@b.example", orgId: ORG_B, role: "owner", verified: true };
    s.sessions.h1 = { userId: "u1", expires: 9 };
    s.receipts["ag1:r1"] = { orgId: ORG_A, agentId: "ag1", receipt: { id: "r1", ts: "2026-11-13T00:00:00Z", model: "m", cost_usd: 0.25, z: 1, a: 2 } };
    s.receipts["ag2:r1"] = { orgId: ORG_B, agentId: "ag2", receipt: { id: "r1", ts: "2026-11-13T00:00:00Z", model: "m", cost_usd: null } };
    for (let i = 0; i < 12; i += 1) s.audit.push({ ts: `t${i}`, org_id: i % 2 ? ORG_B : ORG_A, actor: "u", action: `a${i}`, target: null, detail: {} });
  });
  await store.flush();
  assert.throws(() => store.transaction((s) => { s.orgs.gone = { id: "gone" }; throw new Error("rollback"); }), /rollback/);
  assert.equal(store.read((s) => s.orgs.gone), undefined);
  assert.throws(() => store.transaction(() => store.transaction(() => {})), /Nested/);
  assert.throws(() => store.transaction(async () => {}), /synchronous/);
  store.transaction((s) => { delete s.receipts["ag2:r1"]; s.users.u1.role = "admin"; });
  await store.flush();
  const reopened = await open();
  // Same state, same key order (the receipt conflict check compares JSON text).
  assert.equal(JSON.stringify(reopened.read((s) => s)), JSON.stringify(store.read((s) => s)));
  assert.equal(reopened.read((s) => s.audit.map((e) => e.action).join()), Array.from({ length: 12 }, (_, i) => `a${i}`).join());
  assert.equal(reopened.read((s) => s.receipts["ag2:r1"]), undefined);
  assert.equal(reopened.read((s) => s.users.u1.role), "admin");
  assert.equal((await healthOf(reopened)).persistence, mode);
  return { store, reopened };
}

test("store contract: JSON file adapter", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "cc-contract-")), "store.json");
  await contract(async () => openStore(path), "single-process-file");
});

test("records: round trip keeps order, org scope moves are delete-then-insert", () => {
  const state = { version: 1, orgs: { [ORG_A]: { id: ORG_A } }, users: { u: { orgId: ORG_A } }, sessions: { h: { userId: "u" } }, audit: [{ a: 1 }, { a: 2 }] };
  const recs = toRecords(state);
  assert.equal(recs.get(`orgs\u0000${ORG_A}`).orgId, ORG_A);
  assert.equal(recs.get("sessions\u0000h").orgId, null);
  assert.deepEqual(fromRecords([...recs.values()].reverse(), { version: 1, alerts: {} }), { ...state, alerts: {} });
  const moved = toRecords({ ...state, users: { u: { orgId: ORG_B } } });
  const { upserts, deletes } = diffRecords(recs, moved);
  assert.deepEqual(deletes, [{ kind: "users", id: "u", orgId: ORG_A }]);
  assert.deepEqual(upserts.map((r) => [r.kind, r.orgId]), [["users", ORG_B]]);
});

test("postgres write failure answers 503 until the retry lands", async () => {
  // Fails the write started by the transaction and the retry the response awaits.
  let failInserts = 2;
  const written = [];
  const pool = { async connect() { return {
    async query(sql, params) {
      if (/^SELECT kind, id, body/.test(sql)) return { rows: [] };
      if (/^INSERT INTO store_records/.test(sql.trim())) {
        if (failInserts > 0) { failInserts -= 1; throw new Error("connection reset"); }
        written.push(...params[1]);
      }
      return { rows: [] };
    },
    release() {},
  }; } };
  const store = await openPostgresStore({ pool, log: () => {} });
  const service = createHostedServer({ store, origin: "http://localhost", secureCookies: false, verifyChallenge: async () => true, sendCode: async () => {} });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const request = () => fetch(`${base}/auth/request`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ email: "a@a.example", turnstileToken: "x" }) });
    const first = await request();
    assert.equal(first.status, 503);
    assert.equal(store.healthy(), false);
    assert.equal((await (await fetch(`${base}/health`)).json()).datastore, "degraded");
    const second = await request();
    assert.equal(second.status, 200);
    assert.equal(store.healthy(), true);
    assert.ok(written.includes("version"));
  } finally { service.server.closeAllConnections(); service.server.close(); }
});

test("store contract: Postgres adapter, roles, and row-level security", { skip: skipUnlessDocker() }, async (t) => {
  const { container, port, stop } = await startPostgres(t, { publish: true, autoStop: false });
  const clients = [];
  t.after(async () => { for (const c of clients.reverse()) await c.end().catch(() => {}); stop(); });
  const pg = (await import("pg")).default;
  const admin = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres` });
  admin.on("error", () => {});
  await admin.connect();
  clients.push(admin);
  const applied = await applyMigrations(admin, { log: () => {} });
  assert.deepEqual(applied, ["000_roles.sql", "001_init.sql", "002_grants.sql", "003_store.sql"]);
  assert.deepEqual(await applyMigrations(admin, { log: () => {} }), []);
  psql(container, "ALTER ROLE costcap_app LOGIN;");
  assert.equal(psql(container, "SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.relname = 'store_records';").trim(), "costcap_migrate");
  assert.equal(psql(container, "SELECT has_schema_privilege('costcap_app', 'public', 'CREATE');").trim(), "f");
  const appUrl = `postgres://costcap_app@127.0.0.1:${port}/postgres`;
  const opened = [];
  clients.push({ end: () => Promise.all(opened.map((s) => s.close())) });
  await contract(async () => { const s = await openPostgresStore({ connectionString: appUrl, max: 2 }); opened.push(s); return s; }, "postgres");

  const app = new pg.Client({ connectionString: appUrl });
  app.on("error", () => {});
  await app.connect();
  clients.push(app);
  const scoped = async (settings, fn) => {
    await app.query("BEGIN");
    try {
      for (const [key, value] of Object.entries(settings)) await app.query("SELECT set_config($1, $2, true)", [key, value]);
      return await fn();
    } finally { await app.query("ROLLBACK"); }
  };
  const count = async (where = "true") => Number((await app.query(`SELECT count(*) FROM store_records WHERE ${where}`)).rows[0].count);
  // Org A sees only its own rows and cannot read, change or plant org B rows.
  await scoped({ "app.org_id": ORG_A }, async () => {
    assert.equal(await count(`org_id = '${ORG_B}'`), 0);
    assert.ok(await count() > 0);
    assert.equal(await count("org_id IS NULL"), 0);
    assert.equal((await app.query(`UPDATE store_records SET body = '{}' WHERE org_id = '${ORG_B}'`)).rowCount, 0);
    assert.equal((await app.query(`DELETE FROM store_records WHERE org_id = '${ORG_B}'`)).rowCount, 0);
  });
  await assert.rejects(scoped({ "app.org_id": ORG_A }, () => app.query(`INSERT INTO store_records (kind, id, org_id, body) VALUES ('receipts', 'x', '${ORG_B}', '{}')`)), /row-level security/);
  await assert.rejects(scoped({ "app.org_id": ORG_A }, () => app.query(`UPDATE store_records SET org_id = '${ORG_B}' WHERE org_id = '${ORG_A}'`)), /row-level security/);
  // No scope: nothing visible. Loader: read-only. System: no tenant rows.
  assert.equal(await count(), 0);
  await scoped({ "app.scope": "loader" }, async () => assert.ok(await count(`org_id = '${ORG_B}'`) > 0));
  await assert.rejects(scoped({ "app.scope": "loader" }, () => app.query("INSERT INTO store_records (kind, id, org_id, body) VALUES ('sessions', 'x', NULL, '{}')")), /row-level security/);
  await scoped({ "app.scope": "system" }, async () => assert.equal(await count("org_id IS NOT NULL"), 0));
  assert.equal(psql(container, "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'costcap_app';").trim(), "f");
});

test("JSON import copies into an empty store only", async () => {
  const { importJsonStore } = await import("../scripts/db-import-json.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cc-import-"));
  const target = openStore(join(dir, "target.json"));
  const counts = await importJsonStore(target, { version: 1, orgs: { [ORG_A]: { id: ORG_A } }, users: {}, sessions: {}, challenges: {}, enrollments: {}, agents: {}, receipts: {}, audit: [{ a: 1 }], alerts: {} });
  assert.equal(counts.orgs, 1);
  assert.equal(counts.audit, 1);
  await assert.rejects(importJsonStore(target, { version: 1, orgs: {} }), /not empty/);
  await assert.rejects(importJsonStore(openStore(join(dir, "other.json")), { version: 2 }), /version/);
});
