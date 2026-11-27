# Free-beta hosted workspace

The same-origin root page serves email-code login with the configured production Turnstile site key, then fleet view, enrollment-token creation, caps, freeze/resume, revoke, alerts and audit log. Billing is disabled. The CLI stays free.

Set TURNSTILE_SITE_KEY as well as TURNSTILE_SECRET_KEY. The public key is returned from /ui/config; the secret never reaches the browser. CSP allows only this site's scripts and Cloudflare's challenge script/frame. API session cookies remain HttpOnly, Secure and SameSite=Strict. No enrollment token or session data is stored in browser storage. Fleet fields render with textContent, not HTML.

New emails create separate organizations. Shared email domains are not membership proof. Owners and admins can invite an email address; that person joins only after verifying the invited address. Viewers can read the fleet and cannot change it. Deployment remains exactly one process with a persistent JSON store, not Postgres or a high-availability service. Alerts need a separately configured owner-approved destination. Provider-bill reconciliation, streaming UX and two weeks of fleet dogfood remain separate acceptance work.

Per-model caps (#244): an agent's `modelCaps` (set by API) are enforced fleet-wide for `day` and `month` from the per-model spend that `GET /v1/policy` ships in `agent_spend.models`, in the org budget period. The agent card's "Model caps" line shows fleet spend against each cap (`claude-opus-4-8 day $4.10 / $5`), and the Alerts list shows per-model `cap_approaching`/`cap_hit` entries (`<agent> · model <id> <scope>`). `hour` rules stay local to each host.

Spend forecast (#294): with "This month" selected, the Spend card total adds "Projected by <budget-month end>: $X at the current pace" (`≥` when unknown-cost receipts are unsettled; "Projection available after the first 24 h of the budget month" before then), and agent, team, model and tag rows add "→ $P projected". The figure is a linear estimate from `/v1/spend` `forecast` (the same projection as `cap_projected` alerts), not a bill. "Last 7 days" and "Last 30 days" show no projection.

Receipt-based caps may overshoot by one accepted request. Freeze/resume is policy sync: offline agents retain the last-known policy and cannot receive a new remote freeze until reconnecting. Only proxy-routed traffic is enforced. The dashboard shows synced reported costs and separately counts unknown-cost receipts; it is not a provider bill.

Deployment: retain /opt/costcap/data, apply the completed private env, build/recreate the Docker container, then check /health, /, /ui/config and a real challenge + email-code login. Local test challenges are fixture-only and never enabled by the production launcher.

Local verification command: `npm test`. On a machine with Google Chrome, `node scripts/ui-browser-smoke.mjs` exercises the UI against a local-only challenge fixture and fake email transport: login, enrollment, XSS-safe agent name, caps, freeze/resume, revoke, logout. It sends no external email and does not alter production Turnstile behavior.

Per-model caps (#238, #244): an agent's hosted `modelCaps` are set by API only (`POST /v1/agents/:id/policy`); the agent card's "Model caps" line shows fleet-wide spend against each day/month cap once it has spend (`claude-opus-4-8 day $3.20 / $5`, `unknown` while a receipt for that model has no cost). The Alerts list shows per-model `cap_approaching` / `cap_hit` as `<agent> · model <id> <scope>`.
