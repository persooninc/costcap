# costcap-red-base-20261117 — red main fix (2026-11-17)

- Failing check: `verify / test (22)` (run 43983978684): `test/otlp-export.test.js` "exporter failures warn once,
  count drops, honor the final deadline" and "interval timer drains the queue" cancelled with
  "Promise resolution is still pending but the event loop has already resolved".
- Root cause: `createOtlpExporter().finish()` raced in-flight posts against an `unref()`'d deadline timer. With a
  hung post that holds no handle, the event loop drained and `finish()` never settled (Node 20/22; Node 24's test
  runner masked it). In `costcap wrap` this could skip the run summary/exit after a hung exporter.
- Fix: keep the bounded deadline timer ref'd (it is cleared right after the race).
- Test: new subprocess regression test asserts `finish()` resolves at the deadline with nothing else alive; red
  without the fix on Node 24, green on Node 20.20.2 / 22.23.4 / 24.21.0. Targeted OTLP tests: 56/56 on Node 22.
