# costcap-114: hosted per-agent step budgets (maxSteps)
- Fleet policy carries optional `maxSteps`; validated (positive integer), versioned, audited in `policy.change`; `null` clears.
- `resolvePolicy` takes the tighter of fleet and local `--max-steps`; the wrapper applies it via `velocity.setMaxSteps` from the cached policy (offline too).
- Dashboard "Max steps per run" field; `GET /v1/agents/:id/budget?run_id=` reports `max_steps` / `steps`.
- Tests: `test/hosted.test.js`, `test/hosted-server.test.js` (#114 cases incl. real wrapper against the local hosted server, offline, Postgres record mapping), `test/velocity.test.js`, `e2e/hosted.spec.js`.
