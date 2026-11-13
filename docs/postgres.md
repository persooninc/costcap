# Postgres datastore (FA-CC-04)

The service uses the JSON file by default. Set `COSTCAP_DATABASE_URL` to switch to Postgres. See [ADR 0012](adr/0012-postgres-store.md).

## Instance (IaC)

The database is defined in persooninc/infra#69 (`homelab/dev-home-02/app-dbs/`):

- Database `costcap` on the existing dev-home-02 Postgres 17, LAN only (`192.168.1.244:5432`, `sslmode=disable`).
- `costcap_migrate` (LOGIN) owns the database and schema `public`. `costcap_app` (LOGIN, NOBYPASSRLS) gets DML only.
- Passwords are kept in `~/.homelab-appdb-secrets/costcap.env` on dev-home-02 (`COSTCAP_MIGRATE_PASSWORD`, `COSTCAP_APP_PASSWORD`). Never commit or print them.
- Backups run nightly to `dev-home-03:/srv/backup/app-dbs/costcap/`, sha256-verified, 14 dumps kept on each side.

Status on 2026-11-13: infra#69 is open and has not been applied. The operator runs its `apply.sh` on dev-home-02. Nothing in this repo creates the database or the roles.

## Cutover (owner)

1. Apply infra#69 on dev-home-02.
2. Run the migrations as the migration role: `COSTCAP_MIGRATE_DATABASE_URL=postgres://costcap_migrate:...@192.168.1.244:5432/costcap?sslmode=disable node scripts/db-apply.mjs`. Each file is applied once and recorded in `schema_migrations`. `000_roles.sql` skips roles that already exist.
3. Stop writes (or take a maintenance window), then copy the JSON store into the empty database as the app role: `COSTCAP_DATABASE_URL=... node scripts/db-import-json.mjs /opt/costcap/data/costcap.json`.
4. Add `COSTCAP_DATABASE_URL` (app role) to the host `/opt/costcap/.env` and deploy. The deploy readback then expects `/health.persistence = postgres`. Set the repo variable `COSTCAP_EXPECT_PERSISTENCE=postgres` so the post-deploy canary expects the same.
5. Keep the JSON file as the rollback copy. To roll back, remove `COSTCAP_DATABASE_URL` and redeploy. Writes made after the cutover stay in Postgres only.

**Reachability:** the production app host has to reach `192.168.1.244:5432`. The IaC keeps the database LAN only. A production host outside the home LAN needs a private link first. That is an owner decision; this repo does not open ports.
