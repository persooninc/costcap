# fix-red-base-20261114: prod-drift red on an owner-pending deploy block (2026-11-14)

- Cause: `prod-drift` on main HEAD `99989f0` was red. Prod still serves `85c83a8`, about 791h behind. The deploy cannot ship until the owner verifies the deploy host key out of band, re-pins `infra/ssh/costcap-deploy.known_hosts`, and sets `COSTCAP_STRIPE_MODE` in the host `.env` (see `progress/FA-CC-01.md`). Agents may not do any of that. The alarm was correct, but it kept main red and paused all work on the repo.
- Fix: `scripts/drift-check.mjs` now reads an optional ack, `infra/drift-ack.json`. While the ack is valid, `drift` becomes `drift-acknowledged`: exit 0 plus a `::warning::` annotation that names the prod sha, the hours behind and the reason. This is the same approach #102 took for the auto-deploy skip.
- When the ack does not apply: a different prod sha (any new deploy), an unreachable or unknown prod, a past expiry, or an ack window longer than 7 days. In all of these the job goes red again on its own.
- The current ack is for `85c83a8` and expires 2026-11-21. Owner: once prod ships, delete `infra/drift-ack.json`. If it is still blocked on 2026-11-21, decide whether to renew it.
