# #265 Lifetime "total" caps that never reset (hosted agents and teams)

- `total` scope: `periodKey("total")` is one never-ending period; engine `SCOPES`, hosted `CAP_KEYS` (not a raise scope), `TEAM_SCOPES`.
- Verdicts/snapshots count every receipt when a total cap is set (otherwise unchanged windows); `budget_remaining.total_usd`, `spend.total_usd`, `spent.total`.
- Refusals: `scope: "total"` / `team:<name>:total`, no Retry-After, "does not reset" message.
- Alerts: cap_approaching/cap_hit per agent and team total (period `total`). Retention never deletes receipts that count toward a total cap.
- Dashboard: "Total (never resets)" on the agent card and team form. README documents it.
- Tests: `test/total-cap.test.js` (AC1–AC6 + hosted integration), `wrap-policy`, `store-contract`, `dashboard-hour-cap`; e2e `hosted.spec.js` #265.
