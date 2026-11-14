# FA-CC-04: durable hosted datastore, Postgres (absorbs #42) (2026-11-13)

- `src/hosted/store-postgres.js` is a Postgres adapter behind the existing store interface (`mode`, `read`, `transaction`, `flush`). The server awaits `flush()` before it answers, so a 2xx means the change is in Postgres. A failed write returns 503 and is retried, and `/health` shows `datastore: degraded` until it lands.
- `db/migrations/003_store.sql` adds `store_records` with row-level security per org (`app.org_id`), a system scope for org-less records, and a read-only loader scope. `costcap_migrate` owns it; `costcap_app` gets DML only.
- `/health.persistence` reports `postgres` when `COSTCAP_DATABASE_URL` is set. The deploy readback and canary expect the selected mode.
- New scripts: `scripts/db-apply.mjs` (ordered, recorded migrations as the migrate role) and `scripts/db-import-json.mjs` (copies the JSON store into an empty database).
- The Dockerfile installs the pinned optional `pg@8.23.1`. The CLI still needs no install.
- Tests: `test/store-contract.test.js` runs the same contract on the file and Postgres adapters, plus the RLS cross-org read/write denial cases, against a disposable PG16 container (CI only).
- Docs: `docs/postgres.md` (instance, backups, cutover runbook) and ADR 0012.
- Blocked (owner): persooninc/infra#69 (home-lab PG for CostCap) was merged on 2026-11-13 with matching role names, but it has not been applied on dev-home-02 (lane hosts have no SSH there). The prod host also has to reach the LAN-only `192.168.1.244:5432`. Production stays on the JSON file until `COSTCAP_DATABASE_URL` is set.
