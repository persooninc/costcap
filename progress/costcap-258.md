# costcap-258: alert routes (per-team / per-kind destinations)

- Feature landed in ca06630 (kinds filter, routes, retry, lifecycle, dashboard, docs, tests).
- Follow-up: `POST /v1/alert-settings` is session-only, so any API key (viewer included) gets 403 per AC1 (it was 401). Test added in test/alert-routes-258.test.js.
