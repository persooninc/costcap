# costcap-225 residual gaps (2026-11-16)
- spiral_detected / tag_budget_exceeded blocks now map to stop_reason spiral / cap_hit (outcome killed); local stopped_by too.
- Run-end arriving after a pre-end outcome override fills the placeholder instead of 409-and-drop.
- /v1/spend.csv?group_by=outcome adds runs,lower_bound columns.
- Tests: test/run-outcome.test.js, test/run-summary.test.js.
