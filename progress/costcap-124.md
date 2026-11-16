# costcap-124: costcap reconcile --apply

- Shipped in 4bbec0c / 9098a77: append-only settlement events from provider evidence; never $0; idempotent.
- This commit: HANDOFF portable-module row for `src/reconcile.js`, progress fragment, closes #124.
- Tests: test/reconcile.test.js (10/10 green), cap.test.js, cli.test.js e2e.
