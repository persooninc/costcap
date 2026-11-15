# costcap-97-revenue-gap (issue #97), 2026-11-12

- package.json: repository, homepage, bugs, keywords, author, publishConfig (public), `release:check` script.
- scripts/release-check.mjs: version/tag/metadata preflight and dist-tag choice.
- .github/workflows/release.yml: tag `vX.Y.Z` or dispatch (dry run by default), NPM_TOKEN fail-closed, provenance on GitHub-hosted runners, registry readback.
- action.yml: Marketplace `author` and `branding`.
- README Install section, docs/RELEASING.md owner runbook, ADR 0011.
- Not done (owner): npm token, NPM_TOKEN secret, first tag/publish, Marketplace listing.
