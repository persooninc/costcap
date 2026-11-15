# Runbook — #11 Hosted guardrails dashboard ($19/mo) (M3)

**Status:** epic, code-complete. Every child is closed or covered: #12 org auth, #13
enrollment sync, #14 alerts (all closed); #72 RLS, #73 pricing (closed); #42 Postgres
cutover and #45 live proof are owner-gated with runbooks in this PR. The remaining epic
work is the **owner deploy + live proof**. Billing stays disabled until a real payment
read-back.

The $19/mo figure is a pricing proposal, not collected revenue. Do not enable Stripe
without the billing story's secret and read-back.

## What is already in place (verified)

- Deploy is IaC: `.github/workflows/deploy.yml` deploys the exact `main` commit after a
  green `verify` run; `scripts/deploy-preflight.mjs` fails closed without production
  secrets; `docker compose config` renders one replica + the documented volume.
- `GET /health` reports the deployed SHA (`test/hosted-server.test.js`).
- Playwright canary: `scripts/canary.mjs` / `test/canary.test.js`.
- Billing core is honesty-safe and disabled by default (`src/hosted/billing.js`,
  `/api/health/stripe` reports `disabled`/`ready`/`misconfigured`).

## Owner steps (exact)

1. **Deploy `main` to the origin.** Coolify deploys on push to `main`; `scripts/deploy-
   preflight.mjs` requires `COSTCAP_ORIGIN`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
   `BREVO_API_KEY`, `COSTCAP_EMAIL_FROM` in the `production` environment:
   ```sh
   gh secret set COSTCAP_ORIGIN -R persooninc/costcap --env production --body 'https://app.costcap.dev'
   # …set the Turnstile/Brevo secrets per #45 runbook…
   gh workflow run deploy.yml -R persooninc/costcap
   ```
2. Confirm the deployed SHA and run the canary against the deployed origin:
   ```sh
   curl -sSf https://app.costcap.dev/health            # SHA must match main HEAD
   COSTCAP_CANARY_ORIGIN=https://app.costcap.dev node scripts/canary.mjs
   ```
3. Live login + alert proof: follow the #45 runbook.
4. Postgres cutover (optional, demand-gated): follow the #42 runbook. JSON store stays
   until `/health` reports Postgres.
5. Keep billing disabled until the separate billing story's live read-back; a test-mode
   checkout+portal loop is already wired (see `docs/PATH_TO_FIRST_DOLLAR.md`).

## Verification (the acceptance criteria)

- Org auth, enrollment, alerts meet their story checklists (#12/#13/#14, closed).
- The service is deployed only by the Actions workflow (no SSH hotfix is the source of truth).
- `GET /health` on the deployed origin matches the deployed commit.
- Billing remains disabled; there is no charge route (`/api/health/stripe` → `disabled`).
- Playwright canary against the deployed origin passes.
- One replica + the documented volume are created by IaC (`docker compose config`).

## Done-when

`main` is deployed by the workflow, `/health` matches the deployed SHA, the canary passes,
billing stays disabled, and one replica + volume come from IaC. All child stories are
closed or covered by this PR.

## Audit read-only verification (2026-11-15)

- Children confirmed **CLOSED**: #12 (org auth), #13 (enrollment sync), #14 (alerts),
  #72 (RLS), #73 (pricing). Remaining: #42 and #45, both owner-gated with runbooks in this PR.
- `curl -sSfI https://app.costcap.dev/health` → **HTTP 403** — the origin is reachable but
  the deployed service with a public `/health` is not live yet; the deploy + canary + live
  proof remain the owner gate (expected).
- Deploy/canary/billing code confirmed present: `.github/workflows/deploy.yml`,
  `scripts/deploy-preflight.mjs`, `scripts/canary.mjs`, `src/hosted/billing.js`.
