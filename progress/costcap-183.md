# costcap-183 follow-up (2026-11-16)

a8211a2 fixed the cached verdicts and agentSpendPolicy. The server-side
`teamVerdict` and `hostedAgentVerdict` still dropped `reason`, so after a sync a
member's pending batch came back as team `unknown` and the cached team cap
refused again. Both now keep `reason`; team spend reports `pending_batch_count`.
Tests: test/hosted-team-pending-batch.test.js.
