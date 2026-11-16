# costcap-196: OpenAI Responses background mode settles once (2026-11-16)

- Landed on main in 76e01a9 (issue #196 closed). `src/background.js` matches the paths and classifies terminal statuses. A queued/in_progress `POST /openai/v1/responses` writes `background_pending` and does not freeze the run. A cut `background:true` stream does the same.
- A terminal retrieve, cancel or resumed stream appends one `background_result` reconciliation at the create's `ts`. A terminal response with no usage, or one that can't be priced, becomes `background_unpriced` and pauses the run. A GET/HEAD with no matching pending receipt is always `non_billable_request` at $0 (this covers Responses and stored chat completions).
- Caps, `check`, the settler and agent/tag/team budgets treat `background_pending` the same way as `batch_pending`.
- Tests: `test/responses-background.test.js` plus extensions to the stream, regression, check, agent-budget and fleet tests. On 2026-11-16 the targeted set, including the batch regressions, passed 119/119.
