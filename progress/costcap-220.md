# costcap-220: Prometheus /v1/metrics scrape endpoint

- `GET /v1/metrics` (src/hosted/metrics.js + route in src/hosted/server.js) serves `text/plain; version=0.0.4` gauges for the current org budget period: spend per agent/team/window, completeness, unknown-cost receipts, agent/team caps and remaining, open alerts per kind and scope, frozen state, last sync time and `costcap_metrics_truncated`.
- Auth: viewer/admin `cck_` key or member session; no key, unknown, revoked or expired -> 401; org-scoped (JSON and Postgres stores tested).
- Spend comes from `spendBreakdown` over `visibleReceipts` with the plan retention cutoff, so it matches `/v1/spend`. `?by=model` swaps agent totals for per-model series; past 5,000 series it falls back to agent totals and drops optional series first.
- Tests: test/hosted-metrics.test.js (builder, escaping, period/retention, truncation, format validator in test/support/prom.js), #220 cases in test/hosted-api-keys.test.js, e2e/metrics.spec.js.
- README: "Prometheus metrics (hosted, #220)" with a prometheus.yml example.
- Follow-up (out of scope): Grafana dashboard JSON; confirm prod 401 after the next deploy.
