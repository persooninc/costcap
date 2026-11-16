# costcap-159: hosted per-run drill-down

Landed on main in 0d3d397: `GET /v1/agents/:id/runs` (`src/hosted/runs.js`), Recent runs on each dashboard agent card, and a `run_id` column in receipts.csv. Unknown cost marks a run incomplete, never $0. Tests: test/hosted-runs.test.js, test/ui.test.js, test/receipts-csv.test.js, e2e/runs.spec.js (17/17 targeted unit tests green). Follow-up commit adds the HANDOFF portable-modules row and closes #159.
