# costcap-258: alert routes (per-team / per-kind destinations)

- `alertSettings.kinds` filters the default email + Slack; signed webhook unfiltered.
- `alertSettings.routes[]` (max 10; `{ id, name, kinds, teams, emails, slackWebhook }`) via `POST /v1/alert-settings` (session-only, owner/admin); masked in every output.
- Worker passes `routeTeam` (alert team, or the agent's team at send time); route channels `route:<id>:email|slack` reuse the #206 retry/gave_up/lease.
- Dedupe of addresses and Slack URLs per occurrence; team delete leaves `teams: []` (disabled); member removal drops route emails.
- Dashboard: Default kinds checkboxes and Alert routes list/form; viewers read-only.
- Tests: test/delivery.test.js, test/hosted-server.test.js, test/hosted-teams.test.js, test/store-contract.test.js, e2e/alerts.spec.js.
- Not done here: deploy to app.costcap.dev (daily deploy pipeline).
