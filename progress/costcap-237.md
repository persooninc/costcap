# costcap-237: pin the pricing clock in tests (#237)

- `COSTCAP_PRICING_CLOCK` (ISO instant) pins the pricing clock: `dayOf()` without an instant and every
  proxy pricing instant (request, batch create/settle, realtime) use it. An explicit `at` is never overridden. Unset in production.
- `npm test`, `test:coverage` and `stress` set it to 2026-11-16T12:00:00Z, so gemini-2.5-pro/2.5-flash/3.8-flash
  (and 3.6-flash, 4-carbon/argon) expectations no longer flip on 2026-12-01 or 2027-01-01. Subprocess tests (wrap/cli) inherit it.
- Checked by running the affected files with Date shifted to 2027-02-01. New test: test/pricing-clock-237.test.js.
- To run a single test file by hand, set the env var: `COSTCAP_PRICING_CLOCK=2026-11-16T12:00:00Z node --test test/x.test.js`.
