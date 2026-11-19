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
