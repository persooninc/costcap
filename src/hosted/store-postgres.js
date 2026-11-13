// FA-CC-04: Postgres adapter behind the hosted store interface (mode, read, transaction, flush).
//
// Same semantics as the JSON file store for the server: synchronous, all-or-nothing
// transactions over one in-memory state, so it still allows exactly one replica.
// Durability: every transaction schedules a write of the changed records in one
// Postgres transaction. The server awaits flush() before it answers, so a 2xx response
// means the change is in Postgres. If a write fails, the next flush retries the full
// difference between what Postgres holds and memory, and responses return 503 until it lands.
//
// Tenant isolation: each record carries its org id. Writes set app.org_id (or
// app.scope=system for records without an org) per batch, and the row-level security
// policies in db/migrations/003_store.sql reject cross-org reads and writes. The startup
// load runs in a READ ONLY transaction under app.scope=loader, which may only SELECT.
import { EMPTY_STATE, memoryCore } from "./store.js";
import { diffRecords, fromRecords, toRecords } from "./store-records.js";

const TABLE = "store_records";

async function defaultPool(connectionString, max) {
  let pg;
  try { pg = (await import("pg")).default; }
  catch { throw new Error("Postgres store needs the optional 'pg' dependency (npm ci installs it)"); }
  const pool = new pg.Pool({ connectionString, max, application_name: "costcap" });
  // An idle client losing its connection must not crash the process; the next query reconnects.
  pool.on("error", () => console.error("costcap: postgres idle connection lost"));
  return pool;
}

/** Consecutive runs of records with the same tenant scope, in order, so each batch runs
 * under one app.org_id / app.scope and new rows get seq values in the app's key order. */
function byScope(records) {
  const runs = [];
  for (const rec of records) {
    const key = rec.orgId ?? "";
    if (runs.length && runs[runs.length - 1][0] === key) runs[runs.length - 1][1].push(rec);
    else runs.push([key, [rec]]);
  }
  return runs;
}

async function setScope(client, orgId) {
  await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.scope', $2, true)", [orgId || "", orgId ? "tenant" : "system"]);
}

/**
 * @param {{ connectionString?: string, pool?: { connect(): Promise<any>, end?(): Promise<void> }, max?: number, log?: (line: string) => void }} options
 */
export async function openPostgresStore({ connectionString, pool, max = 4, log = (line) => console.error(line) } = {}) {
  if (!pool && !connectionString) throw new Error("Postgres store needs a connection string or pool");
  const db = pool ?? await defaultPool(connectionString, max);
  const rows = [];
  {
    const client = await db.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.scope', 'loader', true)");
      const result = await client.query(`SELECT kind, id, body FROM ${TABLE} ORDER BY seq`);
      rows.push(...result.rows);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally { client.release(); }
  }
  const state = fromRecords(rows, EMPTY_STATE);
  if (state.version !== 1) throw new Error("Unknown store version");
  let records = toRecords(state);
  // Rows already in Postgres. Collections that exist only as empty defaults have no rows.
  let persisted = toRecords(fromRecords(rows, {}));
  let lastError = null;
  let chain = Promise.resolve();

  const persist = async () => {
    const snapshot = records;
    if (snapshot === persisted) return;
    const { upserts, deletes } = diffRecords(persisted, snapshot);
    if (!upserts.length && !deletes.length) { persisted = snapshot; return; }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      for (const [orgId, group] of byScope(deletes)) {
        await setScope(client, orgId);
        await client.query(`DELETE FROM ${TABLE} t USING unnest($1::text[], $2::text[]) AS d(kind, id) WHERE t.kind = d.kind AND t.id = d.id`,
          [group.map((r) => r.kind), group.map((r) => r.id)]);
      }
      for (const [orgId, group] of byScope(upserts)) {
        await setScope(client, orgId);
        await client.query(`INSERT INTO ${TABLE} (kind, id, org_id, body)
          SELECT u.kind, u.id, NULLIF($3, ''), u.body::json FROM unnest($1::text[], $2::text[], $4::text[]) WITH ORDINALITY AS u(kind, id, body, n) ORDER BY u.n
          ON CONFLICT (kind, id) DO UPDATE SET body = EXCLUDED.body, org_id = EXCLUDED.org_id, updated_at = now()`,
          [group.map((r) => r.kind), group.map((r) => r.id), orgId, group.map((r) => r.json)]);
      }
      await client.query("COMMIT");
      persisted = snapshot;
      if (lastError) log("costcap: postgres store recovered");
      lastError = null;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (!lastError) log("costcap: postgres store write failed; responses return 503 until it recovers");
      lastError = err;
      throw err;
    } finally { client.release(); }
  };
  const flush = () => (chain = chain.catch(() => {}).then(persist));
  const core = memoryCore(state, (next) => {
    const nextRecords = toRecords(next);
    if (nextRecords.get("_meta\u0000version")?.body !== 1) throw new Error("Unknown store version");
    records = nextRecords;
    // Start the write now; the server awaits flush() before answering.
    flush().catch(() => {});
  });
  return {
    mode: "postgres",
    ...core,
    /** Resolves when everything committed so far is in Postgres; rejects if the latest write failed. */
    flush,
    healthy() { return lastError === null; },
    async close() { await chain.catch(() => {}); await db.end?.(); },
  };
}
