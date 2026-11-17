# Hosted dashboard design (stories #12, #13, #14)

Draft. Nothing here is deployed. The hosted stack depends on epic #16 (adopt OpenClaw Enterprise / engrams): if that substrate is chosen, `src/hosted/*` stays as stack-agnostic logic and the tables below map onto it.

## #12 Org-first auth
- Company email signs up -> company org created or joined by verified domain. No orphan users. Personal-domain emails (gmail.com etc.) get their own single-member org.
- Email verification required before an org can enroll agents or change caps. Turnstile on signup, login and password reset.
- Roles: owner, admin, viewer. Only owner/admin raise caps or kill.
- Tables: orgs(id, name, domain, created_at), users(id, email, email_verified_at, org_id, role), sessions.
- Not in this patch set: UI and framework auth wiring (no hosted app in the repo yet).

## #13 Enrollment + policy sync
- Org admin creates an enrollment token (shown once, stored as SHA-256 hash). `costcap enroll <token>` stores an agent credential locally.
- CLI fetches the policy on start and every 60s. Policy = {version, caps{run,day,month}, killed}.
- Offline = last-known policy keeps being enforced. Only a newer valid version replaces it. Local flags can tighten, never loosen (src/hosted/policy.js).
- Receipts sync on reconnect, append-only, deduped by receipt id.
- Tables: agents(id, org_id, name, token_hash, last_seen_at), policies(org_id, agent_id nullable, version, caps jsonb, killed, updated_by), receipts(org_id, agent_id, id, ts, cost_usd, model, blocked, reason).
- Endpoints: POST /v1/enroll, GET /v1/policy, POST /v1/receipts.

## #14 Alerts + audit log
- Rules: cap_approaching (default 80%, configurable per agent/team via `warnFractions`: 1-5 fractions between 0 and 1, null = default, [] = off; the highest crossed fraction fires once per UTC cap period), cap_hit, loop_detected, agent_silent (default 6h, per-agent override via policy `silentAfterHours`: null = default, 0 = off, up to 720; set in the agent card or `POST /v1/agents/:id/policy`, recorded in the `policy.change` audit). Fire once, re-arm after clearing (src/hosted/alerts.js). `loop_detected` names one guardrail: `spiral_detected`, then `cost_velocity`, then `step_budget`. Non-finite spend does not page.
- Run-scope alerts (#168): for an agent whose policy has a numeric `caps.run`, each sweep groups synced receipts by `run_id` (`summarizeRuns`), keeps runs whose last receipt is within the last hour (every such run, no per-agent bound; #180) and raises `cap_approaching:<id>:run:<runId>` (`:p<pct>` for non-0.8 fractions) and `cap_hit:<id>:run:<runId>`, carrying `scope: "run"`, `run_id`, `cap`, `spent`, `fraction`, `unknown_count` and `lower_bound`. Each fraction fires at most once per run; a new run re-arms. Unknown cost is never $0: a run with only unknown-cost receipts raises nothing, a partial one alerts on known spend with `lower_bound: true`. A blocked `budget_exceeded` run receipt with a `run_id` uses the same per-run `cap_hit` key (one page per run); without a `run_id` it keeps `cap_hit:<id>:run`. Run alerts resolve when the run leaves the active window or the agent is revoked. The dashboard shows `cap_approaching 80% · run <runId>`, and `/v1/evidence.json` alerts carry `run_id`.
- Channels: Brevo email to the configured alert recipients, Slack webhook per configured org. Missing delivery is logged, never silent. Billing stays disabled.
- Alert destinations (#121): an owner or admin sets the org's own recipients with `GET`/`POST /v1/alert-settings` or the dashboard "Alert destinations" card. Emails must be verified members of the org; the Slack webhook must be `https://hooks.slack.com/services/…`, is stored on the org record and is only ever returned masked (`…` + last 4). Every change writes an `alert_settings.change` audit entry with masked before/after. The alert worker routes each org's alerts to that org's settings; `COSTCAP_ALERT_ORG_ID` (+ `COSTCAP_ALERT_EMAILS`, `COSTCAP_SLACK_WEBHOOK`) remains a fallback for that one org only while it has no saved settings. An org with no settings stays `unconfigured` and is not retried. A "Send test alert" button (#259, owner/admin) calls `POST /v1/alert-settings/test` and lists one accepted/failed/not configured line per channel.
- Signed webhook (#199): an optional `webhook` `{url, secret}` on the org alert settings. The secret is server-generated (`whsec_…`) and returned in full only on create or rotate. It is masked in GET, audit, fleet, evidence and CSV. Delivery is a JSON POST signed `x-costcap-signature: t=<unix>,v1=HMAC-SHA256(secret, "<t>.<body>")`. An SSRF guard (https, port 443 only, no userinfo, no IP literal or local host, resolved address not private, loopback, link-local, CGNAT or metadata, `redirect: "error"`, 5s timeout) runs on save and on every send. Results are recorded as a `webhook` channel row in the existing retry rule.
- Audit log is append-only: who raised a cap, who killed an agent, when (auditEntry).
- Copy everywhere: guardrails, not guarantees.

## Open questions for Roger
- Trial and pricing ($19/mo, 14 days no card) are from the spec as pitch-level; confirm before any public pricing.
- Silent threshold default (6h) is a guess; scheduled agents (nightly CI) should set a per-agent `silentAfterHours` (e.g. 26) or 0.
