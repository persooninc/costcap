# costcap-red-base-20261119: auto-deploy crashed on a rejected deploy key (2026-11-19)

- Failing check on main HEAD `74f6bba`: `deploy / gate` (run 44403604661), step "apply one replica".
- Cause: once the stale production `COSTCAP_DEPLOY_HOST` override was removed (21e7af3), the host key verifies, but
  the host refuses `COSTCAP_DEPLOY_SSH_KEY` (`Permission denied (publickey)`). `deploy-apply.mjs` streamed the tar
  into an ssh that had already exited, crashed with `spawnSync ssh EPIPE` (exit 1), and the auto run went red.
  Exits 3/4 already warn and skip for owner-blocked conditions; an auth rejection had no exit code.
- Fix: `deploy-apply.mjs` runs an `ssh … true` probe before sending the tree. A `Permission denied (` on exit 255 is
  exit 5 (nothing sent). The automatic run after `verify` warns and skips on 5, like 3 and 4. Manual dispatch,
  `deploy-billing`, and network failures still fail.
- Tests: `test/compose.test.js` covers exit 5 with no upload, the network failure still throwing, `isAuthRejected`,
  and runs the workflow's apply-step shell for exits 0/1/3/4/5 on both events. Targeted tests 66/66.
- Owner action (unchanged): authorize the deploy key on the app host (`deploy-key-info` prints the
  authorized_keys line) or fix the secret. `infra/drift-ack.json` expires 2026-11-21.

## Follow-up: `verify / test (22)` hung on main `ccd5b30` (run 44462415327)

- `test/proxy-concurrency.test.js` "#255 AC1" hit its 120 s timeout. The job then sat silent until the 30 min
  job limit cancelled it; `test (20)`, `e2e` and `action-self-test` were green.
- Cause (test-only): AC1 polled `while (up.inFlight < 4)` with a 60 ms upstream. Admission is serialized, so on a
  loaded runner (load ~65) the first call answered before the 4th was admitted, `inFlight` never reached 4,
  and the loop spun forever. A timed-out node:test test cannot stop its own loop, and the live timers kept
  the file, and so `npm test`, from exiting. AC2 had the same unbounded `inFlight` poll.
- Fix: the test upstream takes `hold(i)` (request i stays in flight until a latch opens). AC1 holds the first 4,
  so "4 in flight" is guaranteed, and now also asserts no queued call starts while the lowered ceiling of 1
  is exceeded. AC2 holds all 6, so the 4 queued calls can only start because n was raised. Every poll goes
  through `waitFor(cond, what, 10 s)`, which throws instead of spinning. No product change.
- Checked: with the #255 bug put back in `src/proxy.js` (no wait while `inFlight > 0`), AC1 fails in 0.2 s
  instead of hanging. `test/proxy-concurrency.test.js` 18/18, 3 runs in a row at load ~63.
