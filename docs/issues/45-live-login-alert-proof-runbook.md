# Runbook — #45 Live login and alert proof in CI

**Status:** code-complete; owner-gated on production Turnstile + Brevo secrets in the
GitHub `production` environment and a deployed origin. No code change remains.

Do not send probe mail to arbitrary addresses. Only `COSTCAP_ALERT_ORG_ID`'s authorized
test inbox is used.

## What is already in place (verified)

- `scripts/live-proof.mjs` is the live-proof shell; it fails closed without the production
  secrets. The fixture verifier covers CI without secrets today.
- `.github/workflows/live-proof.yml` (`workflow_dispatch`, `production` environment) reads
  `TURNSTILE_SECRET_KEY`, `BREVO_API_KEY`, `COSTCAP_ALERT_ORG_ID` and runs the proof.
- `test/live-proof.test.js` and `docs/adr/0010-live-proof-gate.md` document the contract:
  the workflow never prints the code, API key, or inbox password.

## Owner steps (exact)

1. Deploy `main` to the origin first (see #11 runbook) — the proof needs a live origin.
2. Add the production secrets to the GitHub `production` environment (never commit them):
   ```sh
   gh secret set TURNSTILE_SECRET_KEY   -R persooninc/costcap --env production --body '<cf-turnstile-secret>'
   gh secret set BREVO_API_KEY          -R persooninc/costcap --env production --body '<brevo-api-key>'
   gh secret set COSTCAP_ALERT_ORG_ID   -R persooninc/costcap --env production --body '<authorized-test-org-id>'
   ```
   The `COSTCAP_ALERT_ORG_ID` org must map to an inbox you control and authorize for probes.
3. Run the live-proof workflow from CI:
   ```sh
   gh workflow run live-proof.yml -R persooninc/costcap
   gh run watch -R persooninc/costcap "$(gh run list -R persooninc/costcap -w live-proof.yml -L1 --json databaseId -q '.[0].databaseId')"
   ```

## Verification (the acceptance criteria)

- The run requests a real Turnstile challenge path only with the production secret; the
  fixture verifier is absent from the production command (assert in the run log).
- The run proves one sign-in code accepted by Brevo for the authorized test inbox, then
  logs out.
- The run proves one alert delivery response for `COSTCAP_ALERT_ORG_ID` only.
- The run log contains no code, API key, or inbox password — scan the log:
  ```sh
  gh run view -R persooninc/costcap "$RUN_ID" --log | grep -iE 'sk_|whsec|password|brevo.*key' && echo 'LEAK — fail' || echo 'no secret printed'
  ```

## Done-when

CI proves one Brevo-accepted sign-in (then logout) and one alert delivery for
`COSTCAP_ALERT_ORG_ID` only, with the fixture verifier absent and no secret printed.
