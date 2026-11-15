# Runbook — #42 Postgres with separate migration and application roles

**Status:** migration layer built and CI-proven; owner-gated on an IaC-managed Postgres
instance and the production cutover. The CI-only code sub-slice (#72, RLS write-harden)
is closed. No further code change remains for this story.

The single-process JSON store stays the only backend until `/health` reports the Postgres
backend. Do not point production at an unproven database.

## What is already in place (verified)

- Migrations, not console changes: `db/migrations/000_roles.sql`, `001_init.sql`,
  `002_grants.sql`, `003_store.sql`, plus down-migrations `001_init.down.sql`,
  `003_store.down.sql`.
- `test/migrate.test.js` proves apply/rollback, that the `costcap_migrate` role owns
  tables, and that `costcap_app` has no `CREATE` but can `INSERT`.
- RLS tenant isolation hardened under #72 (`WITH CHECK`, fail-closed when `app.org_id`
  is unset), proven in CI Docker-Postgres.
- Apply/import helpers: `scripts/db-apply.mjs`, `scripts/db-migrate.mjs`,
  `scripts/db-import-json.mjs`.

## Owner steps (exact)

1. Provision an IaC-managed Postgres (same IaC as the deploy) with **two roles**:
   - `costcap_migrate` — owns the schema, runs migrations.
   - `costcap_app` — the application role; does **not** own tables, has no `CREATE`.
   Do not create schema or grants by hand — they are the migration files above.
2. Put the connection strings in the GitHub `production` environment (never commit them):
   ```sh
   gh secret set COSTCAP_PG_MIGRATE_URL -R persooninc/costcap --env production --body 'postgres://costcap_migrate:…@host/costcap'
   gh secret set COSTCAP_PG_APP_URL     -R persooninc/costcap --env production --body 'postgres://costcap_app:…@host/costcap'
   ```
3. Apply migrations with the migrate role, then import the current JSON store:
   ```sh
   COSTCAP_PG_MIGRATE_URL=… node scripts/db-migrate.mjs up
   COSTCAP_PG_MIGRATE_URL=… node scripts/db-import-json.mjs    # one-time backfill
   ```
4. Flip the backend to Postgres in the deploy env (app role only) and redeploy (#11):
   `COSTCAP_STORE=postgres`, `COSTCAP_PG_APP_URL=…`.

## Verification (the acceptance criteria)

- Schema + grants came from migrations (run log of `db-migrate.mjs`, not a console).
- Tenant isolation enforced in the DB (proven by #72's CI test; re-run against the live
  instance as the app role to confirm cross-tenant read/write is blocked).
- Rollback tested: `node scripts/db-migrate.mjs down` restores the prior schema.
- `/health` reports the Postgres backend:
  ```sh
  curl -sSf https://app.costcap.dev/health | grep -i postgres
  ```

## Rollback

Set `COSTCAP_STORE` back to the JSON store and redeploy; the JSON file remains intact
until the Postgres read-back is confirmed. `db-migrate.mjs down` reverses the schema.

## Done-when

Schema+grants are migrations (done), tenant isolation is enforced in the DB (done, #72),
rollback is tested (done), `/health` reports the Postgres backend, and the JSON store
stays the only backend until that read-back exists.

## Audit read-only verification (2026-11-15)

- `curl -sSfI https://app.costcap.dev/health` → **HTTP 403**: no deployed origin reporting a
  DB backend yet, so the JSON store correctly remains the only backend (per the AC).
- #72 (RLS write-harden) confirmed **CLOSED**. Migration + helper files all present:
  `db/migrations/000_roles.sql`/`001_init.sql`/`002_grants.sql`/`003_store.sql` plus
  `001_init.down.sql`/`003_store.down.sql`, `test/migrate.test.js`, `scripts/db-migrate.mjs`,
  `scripts/db-import-json.mjs`.
