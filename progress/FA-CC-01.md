# FA-CC-01: ship main to production and alarm on drift (2026-11-13)

- `deploy.yml` now also runs after a green `verify` on a push to main. It deploys that exact `head_sha`, skips stale commits that are no longer main HEAD, and runs one deploy at a time. Repo variable `COSTCAP_AUTO_DEPLOY=off` turns it off.
- `scripts/canary.mjs` checks that `/health.sha` matches the deployed commit, that `/cli` returns 200, and that the persistence mode is the expected one (`COSTCAP_EXPECT_PERSISTENCE`).
- `scripts/drift-check.mjs` and `prod-drift.yml` run daily. The job goes red when production has been behind main HEAD for more than 24h. It is read-only and needs no secrets.
- First local run against app.costcap.dev: prod `85c83a8`, main `6c345da`, state `drift`, about 758h behind (red, as expected).
- Blockers to actually shipping (owner): the `dev-home-01` runner is not picking up jobs, and the host `.env` needs `COSTCAP_STRIPE_MODE` set (live key plus the test default fails the preflight closed).
- Update 2026-11-13 (late): the runner now picks up jobs. The auto-deploy of `be5f992` (after #102) ran and was skipped on purpose: the deploy host's SSH key does not match `infra/ssh/costcap-deploy.known_hosts`, so nothing was sent. Production still serves `85c83a8`, and the daily `prod-drift` run is red, as it should be. Owner: confirm out of band whether the host key changed legitimately, re-pin `known_hosts` if so, set `COSTCAP_STRIPE_MODE` in the host `.env`, then re-run `deploy` with `workflow_dispatch`.
