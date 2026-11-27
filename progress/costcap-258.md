# costcap-258: alert routes (per-team / per-kind destinations)

- `alertSettings.kinds` filters which kinds reach the default email/Slack; signed webhook unchanged.
- `alertSettings.routes[]` (max 10): `{ id, name, kinds, teams, emails, slackWebhook }`, matched by kind and the alert's team (agent alerts use the team listing the agent at send time).
- Route channels `route:<id>:email|slack` reuse #206 retry/backoff/gave_up; duplicate addresses/URLs sent once per occurrence.
- Team delete disables routes (never widens); member removal drops route emails; route webhooks always masked.
- `POST /v1/alert-settings` is now session-only (API keys get 403).
- Dashboard: Default kinds checkboxes + Alert routes list/editor. Docs: README, docs/hosted-dashboard-design.md.
- Tests: test/alert-routes-258.test.js, test/ui.test.js.
