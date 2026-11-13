# ADR 0011: Tag-triggered npm release workflow

Date: 2026-11-12. Status: accepted. Supersedes the "never publishes" scope of ADR 0005 for `release.yml` only.

## Decision

`.github/workflows/release.yml` publishes the CLI to npm when an owner pushes a `vX.Y.Z` tag that equals `package.json` `version`, or dispatches it with `publish=true`. Manual dispatch defaults to `npm publish --dry-run`. A real publish fails closed without the `NPM_TOKEN` secret and ends with a registry readback of version, dist-tag and integrity. `publish.yml` and `scripts/publish-preflight.mjs` stay as the no-publish gate from ADR 0005.

The job runs on the self-hosted runner by default (owner rule). npm provenance needs a GitHub-hosted runner, so `--provenance` is added only when `RUNNER_ENVIRONMENT=github-hosted`; the owner opts in with the `COSTCAP_RELEASE_RUNS_ON` repository variable.

## Consequences

Merging this workflow publishes nothing. The first release, the token, and the Marketplace listing are owner actions ([docs/RELEASING.md](../RELEASING.md)).
