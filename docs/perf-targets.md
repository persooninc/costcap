# Performance and capacity targets

The stress suite is `npm run stress` (`test/stress/`). It runs in CI after `npm test`.

| Target | Load | Budget |
|---|---|---|
| Cap engine check+record | 10k-receipt history, 2k cycles | < 2000 ms |
| Hard-stop overshoot | 100k attempted calls at $0.0003 against a $1 run cap | at most one call over the cap |
| Ledger load | 100k JSONL lines, 0.1% event lines | < 4000 ms, events excluded |
| Ledger lock | 1000 acquire/contend/release cycles | < 5000 ms, always exclusive |

History: on 2026-11-15 the first stress run took 168 s on the cap-engine target, because `check()` rescanned
and re-formatted every receipt. Spend is now bucketed by UTC day and month at record time.

Budgets were calibrated before first ship on the shared self-hosted runner at load average ~60, where the
measurements were: cap cycles 430-610 ms, ledger load 1.5-2.4 s, lock 1.5-2.4 s.

## IaC validation

- `actionlint` (runner labels in `.github/actionlint.yaml`): 0 findings
- `hadolint Dockerfile`: 0 findings
- `gitleaks detect`: 0 findings. `.gitleaksignore` holds one fingerprint, the IndexNow key in `src/hosted/ui.js`, which the protocol requires to be public.
- `test/iac.test.js`: SHA-pinned actions, explicit permissions, no untrusted event text in `run:`, non-root Dockerfile.
