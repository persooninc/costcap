# costcap-119: per-run JSON summary + `costcap runs`

- `src/run-summary.js`: builder, roll-up line, atomic writer, lister (corrupt files skipped and reported).
- `wrap` collects this run's receipts via the proxy `onReceipt` hook and writes `<ledger-dir>/runs/<run_id>.json` on every exit path that reaches the end of the run (normal, non-zero, cap, breaker, `costcap kill`).
- `costcap runs [--json] [--receipts FILE]`.
- Tests: `test/run-summary.test.js` (unit, CLI integration for criteria 1-4 and 6, e2e for `runs --json`).
