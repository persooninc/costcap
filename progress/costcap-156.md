# costcap-156: hosted spend breakdown

Landed on main in 5b7650b: `GET /v1/spend` by day/model/agent (`src/hosted/spend.js`) and the dashboard Spend card. Unknown cost is counted and marks the bucket incomplete, never $0. Tests: test/hosted-spend.test.js, test/ui.test.js, e2e/spend.spec.js. Follow-up commit adds the HANDOFF portable-modules row.
