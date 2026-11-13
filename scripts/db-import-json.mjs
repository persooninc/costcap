// FA-CC-04 cutover helper: copies a JSON store file into an EMPTY Postgres store through the
// same row-level-security-scoped writes the service uses. Refuses a non-empty database.
// Usage: COSTCAP_DATABASE_URL=postgres://costcap_app:...@host/costcap node scripts/db-import-json.mjs /opt/costcap/data/costcap.json
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openPostgresStore } from "../src/hosted/store-postgres.js";

export async function importJsonStore(store, data) {
  if (data?.version !== 1) throw new Error("import: unknown JSON store version");
  const existing = store.read((s) => Object.entries(s).filter(([k, v]) => k !== "version" && (Array.isArray(v) ? v.length : Object.keys(v ?? {}).length)).length);
  if (existing) throw new Error("import: target datastore is not empty");
  store.transaction((s) => { for (const [key, value] of Object.entries(data)) s[key] = value; });
  await store.flush();
  return store.read((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v === "object" && v ? Object.keys(v).length : v])));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  const url = process.env.COSTCAP_DATABASE_URL;
  if (!file || !url) { console.error("import: COSTCAP_DATABASE_URL and a JSON store path are required"); process.exit(2); }
  const store = await openPostgresStore({ connectionString: url, max: 1 });
  try { console.error(`import: counts ${JSON.stringify(await importJsonStore(store, JSON.parse(readFileSync(file, "utf8"))))}`); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
  finally { await store.close(); }
}
