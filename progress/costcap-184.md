# costcap-184: opt-in local response cache (2026-11-16)

- `costcap wrap --cache TTL [--cache-dir DIR] [--cache-max-mb N]`: temperature-0 / embeddings requests are served from disk after the full verdict, with $0 `cache_hit` receipts carrying `saved_usd` and `cache_source_receipt`.
- Run summary `cache` block and roll-up saving; hosted ingest validates `saved_usd`; `/v1/spend` reports `cache_hits`/`saved_usd`; dashboard Spend total shows "Saved $X on N cached calls".
- Tests: test/response-cache.test.js (new), plus extensions to the proxy-streaming, proxy-regression, cli, run-summary, velocity, hosted-spend and hosted-server tests and e2e/spend.spec.js.
- Not done in this lane: deploying the hosted change (it ships with the daily production deploy).
