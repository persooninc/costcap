# Runbook — #15 Distribution (M4)

**Status:** epic, code-complete. The first AC (the GitHub Action running `costcap check`
with day/month caps) is shipped and tested. The remaining ACs are owner-gated: npm publish
(#5), the public-repo decision, and Marketplace publisher access. `costcap.dev` DNS/TLS is
covered by #44. Child stories #5 and #44 are covered by runbooks in this PR.

## What is already in place (verified)

- `action.yml` runs `costcap check` and passes day and month caps (shipped + tested).
- The npm-publishable CLI + Marketplace-ready Action exist (no publish performed) — see
  commits `#99`, `#97`.

## Owner steps (exact)

1. **npm publish** so `npx costcap` resolves — follow the #5 runbook (add `NPM_TOKEN`, run
   `publish.yml`, read back version/dist-tag/integrity from the registry).
2. **Public-repo decision.** If the repo is made public, do it via a recorded GitHub API
   step (not a console click) so the change is in the workflow/audit log:
   ```sh
   gh api -X PATCH repos/persooninc/costcap -f visibility=public   # owner decision only
   ```
3. **Marketplace listing.** With publisher access, list the Action. Listing text must
   contain only claims this repo has verified — no customer counts, no revenue claims.
   Draft copy: guardrails for AI-agent spend (meter, cap, hard-stop); free MIT CLI;
   `costcap check` for CI with day/month caps. Omit any user/customer numbers.
4. **DNS/TLS** for `costcap.dev` — follow the #44 runbook.

## Verification (the acceptance criteria)

- `action.yml` runs `costcap check` with day/month caps — **done** (tested).
- The npm package is published by CI (verify via `npm view costcap version`; #5).
- Any repo-visibility change is done by an IaC/GitHub API step recorded in a log.
- Marketplace listing text contains only verified claims — no customer counts.

## Done-when

The Action is published to the Marketplace with honest copy, the npm package is CI-published
(#5), and any visibility change is recorded in a log. Child stories #5 and #44 are covered
by this PR.

## Audit read-only verification (2026-11-15)

- `action.yml` confirmed present (first AC shipped). `npm view costcap version` → **E404**:
  package not yet CI-published (#5 gate). Child stories #5 and #44 are covered by runbooks in
  this PR. Remaining ACs are owner-gated: npm token, public-repo decision, Marketplace access.
