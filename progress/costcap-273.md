# costcap-273: GPT-Live sessions (2026-11-17)
- `/openai/v1/live/sessions` WebSocket proxied (was 501); `gpt-live-1` $0.05/min row (table 2026-11-16.26).
- Per-snapshot delta receipts, backend response.completed pricing, mid-session caps + 1 s estimate ticker, kill, `session_usage_unconfirmed` latch.
- Tests: test/proxy-live.test.js (AC1-AC7). Envelope field for backend events assumed `event` (falls back to `data`); not verified against live docs.
