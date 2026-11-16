# costcap-229: PR cost diff vs baseline

- Shipped in 6bd9be0: `costcap summary --json`, `costcap diff`, `check --baseline`, Action baseline inputs/outputs, CI action self-test.
- Unknown cost stays explicit: `accounting_unavailable` (exit 3), never a $0 delta.
- Tests: test/cost-diff.test.js, test/cost-diff-cli.test.js, test/github-output.test.js (23/23 passing on 2026-11-16).
- HANDOFF.md Portable modules: added a `src/cost-diff.js` row.
