// FA-CC-04: applies db/migrations/*.sql (not *.down.sql) in order, each once, as the
// migration role. Reads COSTCAP_MIGRATE_DATABASE_URL; prints file names, never the URL.
// Usage: COSTCAP_MIGRATE_DATABASE_URL=postgres://costcap_migrate:...@host:5432/costcap node scripts/db-apply.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));

/** Up migrations in apply order. */
export function pendingMigrations(dir = MIGRATIONS_DIR, applied = new Set()) {
  return readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f) && !f.endsWith(".down.sql")).sort().filter((f) => !applied.has(f));
}

/** @param {{ query(sql: string, params?: any[]): Promise<{ rows: any[] }> }} client */
export async function applyMigrations(client, { dir = MIGRATIONS_DIR, log = (line) => console.error(line) } = {}) {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const todo = pendingMigrations(dir, applied);
  for (const name of todo) {
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(join(dir, name), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      log(`db: applied ${name}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`db: ${name} failed: ${err.message}`);
    }
  }
  if (!todo.length) log("db: up to date");
  return todo;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = process.env.COSTCAP_MIGRATE_DATABASE_URL;
  if (!url) { console.error("db: COSTCAP_MIGRATE_DATABASE_URL required"); process.exit(2); }
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: url, application_name: "costcap-migrate" });
  await client.connect();
  try { await applyMigrations(client); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
  finally { await client.end(); }
}
