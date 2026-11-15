# fix/red-base-20261113

- main went red on the automatic `deploy` run (job `gate`, run 43403208214) after #101 merged.
- Cause: the deploy host at the pinned address presents new ED25519 and RSA host keys. Neither matches
  `infra/ssh/costcap-deploy.known_hosts`, so ssh refused (StrictHostKeyChecking). Not a code regression.
- Fix: `scripts/deploy-apply.mjs` now scans and compares the host key before sending anything (exit 3),
  and maps the host preflight refusal (deploy-remote.sh exit 2) to exit 4. The automatic run after
  `verify` warns and skips on 3 or 4; manual dispatch still fails. The pin was NOT updated.
- Owner action: verify the new host key out of band (or point COSTCAP_DEPLOY_HOST at the current
  host), then update the pin. The Stripe mode decision for the host .env is still open too.
