# ADR 0012: Postgres store adapter behind the hosted store interface

Date: 2026-11-13. Status: accepted (FA-CC-04, absorbs #42). Production still uses the JSON file until the owner sets `COSTCAP_DATABASE_URL`.

## Decision

- `src/hosted/store-postgres.js` implements the same interface as the JSON file store (`mode`, `read`, `transaction`, `flush`). It keeps one in-memory state with synchronous, all-or-nothing transactions, so the service still runs **one replica**.
- Each transaction writes the changed records in one Postgres transaction. The server awaits `flush()` before it answers, so a 2xx response means the change is in Postgres. A failed write returns 503 and is retried on the next flush. `/health` then shows `datastore: "degraded"`.
- Records live in `store_records (seq, kind, id, org_id, body json)` (`db/migrations/003_store.sql`). `body` is `json`, not `jsonb`, so key order round-trips (the receipt conflict check compares JSON text). `seq` keeps creation order.
- Tenant isolation is row-level security on `org_id`. Writes run under `app.org_id`, or under `app.scope = 'system'` for records without an org (sessions, sign-in challenges, billing event ids). The startup load runs `READ ONLY` under `app.scope = 'loader'`, which only has a SELECT policy. `costcap_migrate` owns the table. `costcap_app` gets DML only, no schema CREATE and no BYPASSRLS.
- `/health.persistence` reports `postgres` or `single-process-file`. The deploy readback and canary expect the mode the host selects (`COSTCAP_EXPECT_PERSISTENCE`).
- `test/store-contract.test.js` runs the same contract on both adapters and the RLS denial cases against a disposable Postgres 16 container (CI only; never skipped in CI).

## Consequences

- Supersedes the "run.js does not read DATABASE_URL" part of ADR 0007. The migration URL still never reaches the service.
- Row-level security guards against app bugs. It is not a boundary against a compromised app process, which can set its own scope.
- This is not high availability: one replica, one database. Backups come from the home-lab job in persooninc/infra#69 (nightly dump to dev-home-03, 14 kept, sha256-verified).
