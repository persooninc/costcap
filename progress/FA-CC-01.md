# FA-CC-01: ship main to production and alarm on drift (2026-11-13)

- `deploy.yml` now also runs after a green `verify` on a push to main. It deploys that exact `head_sha`, skips stale commits that are no longer main HEAD, and runs one deploy at a time. Repo variable `COSTCAP_AUTO_DEPLOY=off` turns it off.
- `scripts/canary.mjs` checks that `/health.sha` matches the deployed commit, that `/cli` returns 200, and that the persistence mode is the expected one (`COSTCAP_EXPECT_PERSISTENCE`).
- `scripts/drift-check.mjs` and `prod-drift.yml` run daily. The job goes red when production has been behind main HEAD for more than 24h. It is read-only and needs no secrets.
- First local run against app.costcap.dev: prod `85c83a8`, main `6c345da`, state `drift`, about 758h behind (red, as expected).
- Blockers to actually shipping (owner): the `dev-home-01` runner is not picking up jobs, and the host `.env` needs `COSTCAP_STRIPE_MODE` set (live key plus the test default fails the preflight closed).
- Update 2026-11-13 (late): the runner now picks up jobs. The auto-deploy of `be5f992` (after #102) ran and was skipped on purpose: the deploy host's SSH key does not match `infra/ssh/costcap-deploy.known_hosts`, so nothing was sent. Production still serves `85c83a8`, and the daily `prod-drift` run is red, as it should be. Owner: confirm out of band whether the host key changed legitimately, re-pin `known_hosts` if so, set `COSTCAP_STRIPE_MODE` in the host `.env`, then re-run `deploy` with `workflow_dispatch`.
- Update 2026-11-14: the auto-deploy of `4909c40` (after #103) was skipped for the same reason, and production still serves `85c83a8`. A read-only `ssh-keyscan` from a lane host shows why the pin fails:
  - The pin in `infra/ssh/costcap-deploy.known_hosts` is ED25519 `SHA256:uBzulk1S2g+8IyZhok6P8MPFJXOFJIY2++REiJ1mSSw` and RSA `SHA256:lu4mP/BK3GJ0nhF0l8yjGWlVhHH1CZJ7gUzDZqhFj9w`.
  - `app.costcap.dev` now resolves to `157.180.14.21` (it was `2.29.29.67`). That host presents ED25519 `SHA256:Nj2XofgiejKZUgdCUQjEp0iUeklduK34XnoDepJX5Aw`. The CLAUDE-INBOX entry of 2026-11-14 00:14 EDT records that fingerprint as matching an existing trusted host record.
  - `2.29.29.67` presents ED25519 `SHA256:HcyuVGIPx9fZXfuovbsAK5uM8kjbnZfsDmffMFuYdG8` and no longer serves the app over HTTPS.
  - The pin matches neither host. The pin was left unchanged: a scan from a lane host is not out-of-band verification.
  - Owner: confirm which host `COSTCAP_DEPLOY_HOST` should point to, and verify that host's key out of band. Then re-pin `known_hosts` for that host, set `COSTCAP_STRIPE_MODE` in its `.env`, and re-run `deploy` with `workflow_dispatch`.
