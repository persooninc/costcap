# costcap-112: hosted per-agent budget verdict
- `GET /v1/agents/:id/budget` (member session or the agent's own token), via pure `src/hosted/agent-verdict.js` reusing the local agent-budget engine.
- Tests: `test/hosted-server.test.js` (#112 cases, parity with agent-status, null-cost regression), `e2e/hosted.spec.js` (#112).
- Note: ok verdict is `"ok"` per the issue; local `agent-status` says `"allow"`. Keys match.
