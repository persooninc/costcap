# costcap-stripe-mode-test-default-20261112

- `COSTCAP_STRIPE_MODE` now defaults to `test` (was `live`) in `scripts/deploy-remote.sh`,
  `src/hosted/run.js`, `src/hosted/server.js`, `src/hosted/billing.js` (`stripeHealth`),
  `src/billing/config.js` (`resolveBillingConfig`) and both compose files.
- `run.js` used `??`, so compose's empty `${COSTCAP_STRIPE_MODE:-}` made the launcher throw
  "Unknown Stripe mode" on any build that reads it. Now `||`, and compose defaults to `test`.
- The deploy preflight exports the resolved mode, so the container always gets an explicit value.
- Prod readback (public endpoints only, no values printed): `/health` reports billing enabled at
  sha 85c83a8, which predates `COSTCAP_STRIPE_MODE`. That build is live-only, and
  `/api/health/stripe` is `ready` with a live-shaped key. No repo secret or variable sets the mode.
  No prod env, key or deploy was touched.
- Owner follow-up: the next prod deploy needs the owner to choose a mode in the host `.env`. Either set
  `COSTCAP_STRIPE_MODE=live` explicitly, or swap to test keys. Until then the deploy preflight
  fails closed (exit 2, before build), and the running container is untouched.
