# CostCap

Local spend guardrails for proxy-routed AI requests. Development beta.
The CLI meters token usage, stops subsequent calls once a budget is reached,
detects normalized retry patterns, enforces step budgets, and supports a local
kill file. MIT, no warranty.

**What is free and what is paid.** The CLI is free and stays free. This repo
also contains the hosted workspace (`src/hosted/`). When the deployment has
billing enabled, the workspace offers an optional $19 USD/month plan; without
billing it is a free beta with no card and no charges. Neither tier is a
provider-bill guarantee: these are guardrails, not guarantees.

The free hosted workspace covers up to 3 enrolled agents and 3 people. Solo
($19/month list price) raises that to 15 agents, and Team ($79/month list price,
Stripe test mode only for now) to 50 agents and 15 people, with receipts shown
for 1 year. Limits apply only where checkout is
configured, so a limited workspace always has an upgrade path: by default in
Stripe test mode, and in live mode only with `COSTCAP_ENTITLEMENTS=enforced`.
Existing agents keep running over a limit; only new enrollments and invitations
are refused. The public `/pricing` page is on by default and shows a test-mode
banner until live billing is approved; `COSTCAP_PUBLIC_PRICING=disabled` turns it off.
`/privacy`, `/terms` and `/security` are public. The hosted datastore is the JSON
file unless `COSTCAP_DATABASE_URL` selects Postgres ([docs/postgres.md](docs/postgres.md)).
Variables: [env.example](env.example) and [docs/billing-readiness.md](docs/billing-readiness.md).

## Install

Node 20 or newer; no runtime dependencies. **Not yet on npm or the GitHub
Marketplace:** the package and the Action are release-ready, and the owner
publishes them (see [docs/RELEASING.md](docs/RELEASING.md)). Until then, use
[Run from source](#run-from-source) or pin the Action to a commit SHA.

Once the first release is out:

```sh
npx costcap wrap --cap 5 -- node your-agent.js   # one-off, no install
npm install --save-dev costcap                   # per project
npm install --global costcap                     # costcap on your PATH
costcap --version
```

GitHub Action (fails the job when the receipt ledger reaches the cap, or when
any receipt has unknown cost):

```yaml
- uses: persooninc/costcap@v0.0.1 # or a full commit SHA
  with:
    receipts: .costcap/receipts.jsonl
    cap: "5"
    day-cap: "10"   # optional, UTC day
    month-cap: "50" # optional, UTC month
```

The CLI and the Action are free. The optional hosted workspace plans are
described above.

## Run from source

Node 20 or newer; no runtime dependencies.

```sh
npm test
node src/cli.js wrap --cap 5 --day-cap 10 --max-steps 40 -- node your-agent.js
node src/cli.js kill "pause local wrapped agents"
node src/cli.js resume
```

The wrapper sets provider base URL environment variables. Your SDK must honor
them. Hardcoded endpoints and subprocesses that ignore these variables bypass
CostCap. The local proxy binds to 127.0.0.1.

## Enforcement limits

- Metering uses provider-reported usage after each response. A call can exceed
  the remaining budget; this is **not** a prepaid reservation or bill guarantee.
- Requests are serialized inside a proxy. A receipt ledger is exclusively locked
  for each wrapper. Separate ledgers do not share day/month caps. A crashed
  wrapper leaves a lock that you must remove only after checking it stopped.
- `--shared-ledger` lets several wrappers on **one host** share one ledger, so
  their combined day/month spend (and `--policy` agent/team budgets) is capped
  together. Every decision and every receipt append runs in a short
  cross-process critical section (`<ledger>.cs`) that first reads what the other
  wrappers appended. **Documented overshoot: at most one in-flight call per
  wrapper**, so recorded spend stays within `cap + wrappers × max single-call
  cost`. `--cap` (run) stays per wrapper. An unknown-cost receipt from any
  wrapper blocks every wrapper on the ledger. Stale critical sections are
  fail-closed: a holder is reclaimed only when it is on this host and its PID
  is provably gone; any other holder (another host, unreadable owner) is waited
  on for 5s and then the wrapper refuses calls with `receipt_ledger_unavailable`.
  Shared and exclusive (default) wrappers refuse to run on the same ledger.
  Sharing across hosts is the hosted fleet's job.
- `--preflight` (or `COSTCAP_PREFLIGHT=1`, or `"preflight": true` in a
  `--policy` file) is **off by default**. Before forwarding, it estimates the
  call's **worst case** and refuses it with `budget_exceeded`,
  `reason: "preflight_estimate"` when that can't fit the remaining run, day or
  month budget. **It is an estimate, not a tokenizer:** input tokens are
  bounded by `ceil(request bytes / 4)` (images, tool schemas and unusual
  tokenization can exceed this), output tokens are `max_tokens` /
  `max_completion_tokens` / `generationConfig.maxOutputTokens`, or a
  conservative per-provider default maximum when absent (OpenAI/OpenRouter
  32,768; Anthropic 64,000; Gemini 65,536). Cache discounts and reasoning
  tokens beyond the max are not modelled. A model with no rate in the table is
  refused with `preflight_unpriced`, never forwarded as free. Blocked receipts
  carry `estimate: true`, `estimate_usd` and `scope`, and cost $0 in totals.
  Post-call metering is unchanged.
- Daily and monthly periods use UTC. Pricing is a versioned estimate, not the
  provider bill. The table prices common OpenAI, Anthropic, Gemini, and
  OpenRouter model ids. Unknown models use the declared fallback. Rates are the
  standard text price in force on the table version date (the lower tier when a
  model publishes a prompt-length split). Check `src/pricing-table.json` before
  relying on rates.
- Missing/invalid usage or an uncertain network outcome pauses further calls.
  Such receipts have `cost_usd: null`. Reconcile them before starting again;
  existing unknown-cost receipts block restart. Never replace unknown cost with
  zero without evidence from the provider.
- SSE (`text/event-stream`) responses are passed through in real time, chunk by
  chunk with backpressure, and usage is metered from the stream as it passes.
  The receipt is written when the stream ends, so a cap hit by a streamed call
  blocks the **next** call; a call already in flight can overshoot the cap. A
  stream cut (upstream error, client abort or timeout) before usage arrives
  records `cost_usd: null` with `reason: "stream_incomplete"` and blocks further
  calls. The proxy timeout covers the whole stream. OpenAI chat/Responses,
  Anthropic start/delta usage, Gemini usageMetadata, and OpenRouter (OpenAI-shape)
  usage have local fixture tests. Provider billing reconciliation and live SDK
  compatibility remain unverified.
- Anthropic cache writes use per-model 5-minute and 1-hour rates. A response without
  the 5m/1h breakdown is priced at the 5-minute rate. A cache write on a model with no
  published rate records `cost_usd: null` and blocks further calls. Other billable
  features and dynamic pricing may differ.
- The default kill file is relative to the working directory. Only agents sharing
  that file are affected. Polling defaults to 500ms, with SIGKILL after 5 seconds.
  It does not undo a request already accepted by the provider or stop remote agents.
- This proxy is for a trusted local machine, not an exposed multi-tenant service.
  It does not establish an authentication boundary against other local processes.

Receipts include unique IDs, timestamp, model, usage, versioned estimated cost,
and blocked reasons. No request bodies or authorization headers are written.

The local CLI is covered by `npm test`. The hosted beta at the configured
origin serves the fleet UI; when billing is enabled it shows the optional $19/month
plan described above. Live checkout, live email login, live alert
delivery, npm publication, marketplace distribution, and two-week dogfood are
not certified by this repository's tests. `costcap reconcile` compares a local
receipt file with a provider charge file and does not call a provider.

## Enrollment client (service not yet deployed)

```sh
# Set COSTCAP_ENROLL_TOKEN through your local secret manager, not CLI arguments.
node src/cli.js enroll --url https://your-fleet-service.example --name worker-1
node src/cli.js wrap --enrollment .costcap/enrollment.json --cap 1 -- node your-agent.js
```

The client expects `/v1/enroll`, `/v1/policy` and `/v1/receipts` from a trusted,
authenticated fleet service. It caches the policy and enforces it while offline.
Only newer versions replace cached caps or kill state; local caps may tighten,
not loosen, the policy. Polling is once per minute, not instant remote kill.
Receipt IDs are acknowledged before marking them synced. Credentials are stored
mode 0600. A 401/403 response freezes the wrapper. Redirects are refused to avoid
forwarding agent credentials to another host. These paths have local test-server
coverage, not production verification or a finished org dashboard.

## Per-agent budgets

```sh
cat > .costcap/policy.json <<'JSON'
{ "default": { "run": 5, "day": 20, "maxSteps": 40 },
  "agents": { "release-bot": { "run": 1, "maxSteps": 10 } } }
JSON
node src/cli.js wrap --agent release-bot --policy .costcap/policy.json -- node your-agent.js
node src/cli.js agent-status --agent release-bot --policy .costcap/policy.json
```

Enrolled agents can also get a fleet step budget: an admin sets "Max steps per run" in the dashboard (`maxSteps` on `POST /v1/agents/:id/policy`). The wrapper enforces it per run from its cached policy, even offline. A local `--max-steps` can tighten it, never loosen it.

An agent entry replaces the default. An agent with no entry and no default is
refused (`no_budget_policy`).

Team budgets share one cap across a group of agents:
`"teams": { "ops": { "agents": ["release-bot", "triage-bot"], "day": 30, "month": 400 } }`.
Each agent's own cap applies first, then the team's summed spend. A team cap
blocks with `budget_exceeded` plus `team`. An unknown cost from any teammate
returns `accounting_unavailable` instead of being counted as $0. An agent can be
in only one team, and team membership on its own counts as a budget policy.
`budget_remaining` shows the tighter of the agent and team remainders.

Blocks return HTTP 429 with `verdict`, `reason`,
`agent_id` and `run_id`, and `agent-status` and the MCP tool `agent_budget_status`
return the same verdict with `budget_remaining`. Run and step budgets are per
`run_id`, which the wrapper assigns. Figures are estimates, the same limits above
apply, and the policy file must be protected from the agent it limits.

## CI check and local MCP

```sh
node src/cli.js check --receipts .costcap/receipts.jsonl --cap 5
node src/cli.js mcp --receipts .costcap/receipts.jsonl --day-cap 10
```

`check` returns JSON and exits 0 below the budget, 1 at/above it or with unknown
cost, and 2 for missing/malformed evidence. `--cap` sums the entire selected
receipt file, not one reconstructed run. `--day-cap` and `--month-cap` use UTC.
`action.yml` exposes this check as a composite GitHub Action (Marketplace
branding included); no Marketplace listing or public release has been made yet. MCP exposes only `budget_status` via
JSON-RPC stdio. It cannot kill, resume, change caps or spend money. Local MCP
protocol tests do not substitute for verification in every MCP client.

<!-- generated-by: workspace-admin/iac-independence -->

## Setup

```bash
bash scripts/setup.sh
```

Requires: Node 20+, and access to `gitdhillonai/dotenv` for `.env.local`.

## Environment

See `env.example`. Pull real values with `bash scripts/pull-secrets.sh`.

## Docs

- [TECHSTACK.md](TECHSTACK.md) — runtime, store, and deploy contract
- [ACCOUNTS.md](ACCOUNTS.md) — service names only, no secrets
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — as-built architecture and trust boundaries
- [docs/PATH_TO_FIRST_DOLLAR.md](docs/PATH_TO_FIRST_DOLLAR.md) — the free→paid path and its owner gates
- [docs/RELEASING.md](docs/RELEASING.md) — npm release workflow and Marketplace listing (owner steps)
- [docs/VISION.md](docs/VISION.md)
- [docs/deck/index.html](docs/deck/index.html) — short pitch

## Deploy / Rollback

The `deploy` workflow (`.github/workflows/deploy.yml`) runs after a green
`verify` run on a push to `main`, for that exact commit (only while it is still
main HEAD), or by manual dispatch. The repo variable `COSTCAP_AUTO_DEPLOY=off`
stops the automatic run. It checks production secrets, renders one replica with
`docker compose config`, and applies that one replica with
`scripts/deploy-apply.mjs` only when `COSTCAP_DEPLOY_HOST` and
`COSTCAP_DEPLOY_SSH_KEY` are present; otherwise the apply step exits without
applying. A canary then checks the origin serves that commit
(`COSTCAP_EXPECT_SHA`), the expected datastore, and `/cli` plus the trust pages.
The daily `prod-drift` workflow fails when production has been behind `main`
HEAD for more than 24 hours.
Rollback: `git revert` on `main`, then dispatch `deploy` again.

<!-- iac-gaps -->

## Testing

```bash
npm test
```

## SRM evidence export

`GET /v1/agents/:id/budget` returns one agent's spend verdict. Any signed-in member of the agent's org may call it (viewers included); the agent's own enrolled bearer token may call it for that agent only. Another org's agent and an unknown id both return the same 404; no credential returns 401. Keys match `costcap agent-status`: `ok`, `verdict`, `reason`, `hit`, `agent_id`, `run_id`, `budget_remaining` (`day_usd`, `month_usd`, `null` where there is no cap) and `estimate_only`, plus `scope`, `cap_usd`, `spent_usd` or `unknown_receipts` when they apply. Verdicts: `ok`, `budget_exceeded`, `accounting_unavailable` (any `cost_usd: null` receipt this month, reason `unreconciled_receipt`; never `ok`), `killed`, `revoked`, `no_budget_policy`.

`GET /v1/evidence.json` (signed-in session, scoped to your org) returns a `costcap.evidence/v1` document for ShipReady Metrics. It holds per-agent caps, day/month known spend, unknown-cost counts, active alerts, and receipts. A receipt with unknown cost keeps `cost_usd: null`. It is never counted as $0, and `cost_complete` is false whenever any cost is unknown. Sample: `docs/fixtures/srm-evidence.sample.json`.

### Fleet freeze (kill switch)

`POST /v1/fleet/freeze` and `POST /v1/fleet/resume` (owner or admin session, body `{ "reason": "..." }`, 1-500 characters) kill or revive the whole org's fleet. Freeze bumps the policy version of every non-revoked agent that is not already killed and sets `killed: true`. Repeating it while frozen is a no-op (`alreadyFrozen: true`). Resume only revives the agents that freeze killed, so an agent killed on its own stays killed. Each action writes one `fleet.freeze` / `fleet.resume` audit entry with actor, reason and agent ids; `POST /v1/agents/:id/policy` also accepts an optional `reason`. Wrappers apply the freeze at their next policy poll. It is not instant and does not undo requests already accepted. The dashboard has a "Freeze all agents" card with a required reason and a confirm step.
