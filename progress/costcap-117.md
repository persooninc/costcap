# costcap-117: opt-in pre-flight budget estimate (CC-9, #117) (2026-11-15)

- `wrap --preflight` / `COSTCAP_PREFLIGHT=1` / policy `"preflight": true`, off by default.
- `src/preflight.js` estimates worst case per provider shape; proxy refuses with `budget_exceeded` + `reason: "preflight_estimate"` (or `preflight_unpriced`) before any upstream call; blocked receipt has `estimate: true`, `estimate_usd`, `scope`, cost $0.
- `cap.remaining()` added. Tests: `test/preflight.test.js` (unit, integration with counting fake upstream, CLI e2e).
