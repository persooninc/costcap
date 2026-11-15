# Releasing costcap (npm + GitHub Marketplace)

Status (2026-11-12): release-ready, **not published**. `npm view costcap` returns
404 and the Action has no Marketplace listing. Every step below that publishes,
creates a credential, or changes repository settings is an owner step.

## What the repo provides

| Piece | Where |
|---|---|
| npm metadata (`bin`, `files`, `license`, `repository`, `homepage`, `bugs`, `keywords`, `publishConfig.access=public`) | `package.json` |
| Tarball allowlist (manifest, README, LICENSE, `src/` only) | `scripts/pack-check.mjs` (also run by `verify` CI) |
| Version/tag/metadata preflight, dist-tag choice (`latest`, or `next` for prereleases) | `scripts/release-check.mjs` (`npm run release:check`) |
| Release workflow (tag `vX.Y.Z` or manual dispatch) | `.github/workflows/release.yml` |
| No-publish gate kept from ADR 0005 | `.github/workflows/publish.yml` |
| Marketplace metadata (`name`, `description`, `author`, `branding`) | `action.yml` |

`release.yml` never runs on push to `main`. A tag push publishes; a manual
dispatch is `npm publish --dry-run` unless `publish` is ticked. A real publish
without the `NPM_TOKEN` secret fails before `npm publish` runs. After publishing
it reads the version, dist-tag and integrity back from the registry.

## Owner steps: first npm release

1. On npmjs.com, confirm the `costcap` name is still free and create a granular
   access token with read/write on that package (or an automation token).
2. Store it as the repository secret `NPM_TOKEN` (Settings, Secrets and
   variables, Actions). Never paste it into an issue, PR or log.
3. Optional provenance: npm only signs provenance on GitHub-hosted runners, while
   the default runner rule is self-hosted. To opt in, set the repository
   variable `COSTCAP_RELEASE_RUNS_ON` to `["ubuntu-latest"]`. Without it, the
   release publishes from `[self-hosted, dev-home-01]` without provenance.
4. Dry run: Actions, `release`, Run workflow on `main` with `publish` unticked.
5. Bump `version` in `package.json` through a PR if needed, merge, then:
   `git tag v0.0.1 && git push origin v0.0.1` (the tag must equal the version).
6. Check the run's readback step, then `npm view costcap`.

## Owner steps: Marketplace listing

The repo is public and has one `action.yml` at the root with branding, which is
what the Marketplace requires.

1. Draft a GitHub release from the same `vX.Y.Z` tag.
2. Tick "Publish this Action to the GitHub Marketplace", accept the developer
   agreement if prompted, pick categories (Continuous integration, Utilities).
3. Publish the release. Consider also moving a major tag (`v0`) to the same
   commit so users can pin `persooninc/costcap@v0`.

## Not covered

No token is created here, nothing was published, and repository visibility was
not changed. The registry readback is the first evidence of a real release.
