# costcap-183 (2026-11-16)

Enrolled fleet/team cached caps no longer freeze the agent after a batch create.
`src/hosted/teams.js` skips `batch_pending` receipts when counting unknown (cached
verdicts and server-side `agentSpendPolicy`/`teamVerdict`); `hostedAgentVerdict`
passes `reason` through. Fleet view reports pending batches separately.
Tests: `test/fleet-batch-pending.test.js` (unit + proxy-wired enrolled agent and team flows).
