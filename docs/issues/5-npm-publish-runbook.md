# Runbook — #5 Publish `costcap` to npm so `npx costcap` resolves

**Status:** code-complete; owner-gated on the `NPM_TOKEN` secret. No code change remains.
The publish is CI/IaC only — never run `npm publish` from a laptop.

## What is already in place (verified)

- `package.json` declares `bin: { costcap: "src/cli.js" }` and a `files` allowlist of
  `src`, `README.md`, `LICENSE` only (no `.env`).
- `src/cli.js` is shebanged (`#!/usr/bin/env node`).
- `scripts/pack-check.mjs` + `test/pack.test.js` assert the tarball contains only the
  allowlisted paths and no `.env`.
- `scripts/publish-preflight.mjs` fails closed when `NPM_TOKEN` is absent.
- `.github/workflows/publish.yml` (`workflow_dispatch`) runs `npm ci`, `pack-check`, then
  the publish-preflight gate.

## Owner steps (exact)

1. Create an npm **automation** token for the `costcap` package owner account at
   <https://www.npmjs.com/settings/~/tokens> (type: *Automation*, so 2FA does not block CI).
2. Add it as a repo secret (never commit it):
   ```sh
   gh secret set NPM_TOKEN -R persooninc/costcap --body '<npm-automation-token>'
   ```
3. Trigger the publish workflow from CI (not a laptop):
   ```sh
   gh workflow run publish.yml -R persooninc/costcap
   gh run watch -R persooninc/costcap "$(gh run list -R persooninc/costcap -w publish.yml -L1 --json databaseId -q '.[0].databaseId')"
   ```

## Verification (the acceptance criteria)

- `npx costcap` resolves the published package and prints usage with no hosted account:
  ```sh
  npx -y costcap@latest --help
  ```
- Registry read-back of version, dist-tag, and integrity (run after publish):
  ```sh
  npm view costcap version dist-tags dist.integrity
  ```
  Confirm the version matches `package.json` and the dist-tag is `latest`.
- Confirm the published tarball contains only `src/`, `README.md`, `LICENSE`:
  ```sh
  npm pack costcap --dry-run
  ```
  The file list must show no `.env` and nothing outside the allowlist.

## Done-when

`npx costcap` resolves the published package and prints usage; the registry read-back
matches `package.json`; no person ran `npm publish` (the GitHub Actions run log is the
source of truth).

## Audit read-only verification (2026-11-15)

- `npm view costcap version` → **E404, not found** — the package is not yet published,
  confirming the owner-gated state (publish is what creates the registry record).
- All referenced code is present on `main`: `package.json` (`bin.costcap`, `files`
  allowlist), `src/cli.js` (shebanged), `scripts/pack-check.mjs`, `test/pack.test.js`,
  `scripts/publish-preflight.mjs`, `.github/workflows/publish.yml` — all confirmed to exist.
