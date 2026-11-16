# costcap-220: Prometheus /v1/metrics scrape endpoint (2026-11-16)

- New `src/hosted/metrics.js` (pure builder + exposition validator) and `GET /v1/metrics` in `src/hosted/server.js` (cck_ key or member session, org-scoped, `text/plain; version=0.0.4`).
- Gauges: spend (agent/team/window, optional `?by=model`), spend_complete, unknown_cost_receipts, cap/cap_remaining (agent+team), alerts_open per ALERT_KINDS, agent_frozen, last_sync; 5,000-series cap with `costcap_metrics_truncated`.
- Spend reuses `spendBreakdown` with the org budget period and retention cutoff, so it matches `/v1/spend`.
- Tests: `test/hosted-metrics.test.js` (unit + HTTP on JSON and Postgres stores), `/v1/metrics` added to the viewer-key route matrix in `test/hosted-api-keys.test.js`, `e2e/metrics.spec.js`.
- README Hosted API: scrape example with `credentials_file`, gauge-not-counter note.
- Prod check after deploy: `/v1/metrics` unauthenticated should return 401.
