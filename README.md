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
($19/month list price) raises that to 15 agents, and Team ($79/month: the Agent Guardrails Team
bundle, Stripe lookup key `guardrails_team_month`) to 50 agents and 15 people, with receipts shown
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
    run-id: ${{ env.RUN_ID }} # optional: cap only this run's receipts
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
node src/cli.js kill --host "runaway"   # freeze every wrapped agent on this machine
node src/cli.js resume --host
node src/cli.js kill --status           # {"host":{...},"project":{...}}
```

The wrapper sets provider base URL environment variables. Your SDK must honor
them. Hardcoded endpoints and subprocesses that ignore these variables bypass
CostCap. The local proxy binds to 127.0.0.1.

| Provider | Variables set for the child |
| --- | --- |
| OpenAI | `OPENAI_BASE_URL=http://127.0.0.1:<port>/openai/v1` |
| Anthropic | `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/anthropic` |
| OpenRouter | `OPENROUTER_BASE_URL=http://127.0.0.1:<port>/openrouter` |
| Gemini | `GOOGLE_GEMINI_BASE_URL` (read by go-genai, `@google/genai` and Gemini CLI) and `GEMINI_BASE_URL` (legacy), both `http://127.0.0.1:<port>/gemini` |

The Python `google-genai` SDK has no base-URL environment variable; set
`http_options={"base_url": os.environ["GOOGLE_GEMINI_BASE_URL"]}` in code or its
traffic bypasses CostCap.

## Enforcement limits

- Metering uses provider-reported usage after each response. A call can exceed
  the remaining budget; this is **not** a prepaid reservation or bill guarantee.
- Receipts never store credentials passed in the URL. Every receipt (success,
  blocked, unknown outcome) records the request path with credential-like query
  parameters (`key`, `api_key`, `apikey`, `access_token`, `token`, `sig`,
  `signature`, case-insensitive) replaced by `REDACTED`, so Gemini's `?key=` is
  never written to the ledger or the hosted store. The upstream still receives
  the full query. The hosted ingest redacts older clients' uploads too, and
  stored receipts are scrubbed once at server startup.
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
  Sharing across hosts is the hosted fleet's job (fleet-wide agent caps, #127).
- `--preflight` (or `COSTCAP_PREFLIGHT=1`, off by default) refuses a call whose
  **estimated** worst case cannot fit the remaining run/day/month budget, before
  any upstream call, with `budget_exceeded` / `reason: "preflight_estimate"`.
  It is an estimate, not a tokenizer: input tokens = request bytes / 4, output
  tokens = `max_tokens` (or `max_completion_tokens`, Gemini
  `generationConfig.maxOutputTokens`), else a conservative provider default,
  times the completion count: OpenAI-compatible `n` / `best_of` (the larger,
  since `best_of` bills every candidate) or Gemini `candidateCount`
  (`candidate_count`). An invalid count is treated as 1 and flagged
  `output_multiplier_defaulted`; a count above the provider maximum (128 for
  OpenAI/OpenRouter, 8 for Gemini) is clamped to it and flagged
  `output_multiplier_clamped`. Allowed calls record `output_tokens_est` and
  `output_multiplier` on their receipt.
  Text that tokenizes denser than 4 bytes/token can still overshoot. Models
  with no published rate are refused with `preflight_unpriced`, never priced at
  the fallback. The blocked receipt has `estimate: true`, `estimate_usd` and
  `scope`, and costs $0 toward spend.
- Daily and monthly periods use UTC. Pricing is a versioned estimate, not the
  provider bill. The table prices common OpenAI, Anthropic, Gemini, and
  OpenRouter model ids. Unknown models use the declared fallback. On the
  `/openrouter` route only, a finite, non-negative `usage.cost` in the response
  (or the last SSE usage chunk) is OpenRouter's exact USD charge and replaces
  the table/fallback price for any routed model. Every priced receipt carries
  `cost_source`: `provider`, `table` or `fallback`. A `usage.cost` on any other
  route is ignored. `costcap runs` shows each model's `cost_source`, and
  `costcap receipts --export csv`, `/v1/receipts.csv` and `/v1/evidence.json`
  include the column. Rates are the
  standard text price in force on the table version date. Audio, image and
  video tokens (Gemini `promptTokensDetails` / `cacheTokensDetails` /
  `candidatesTokensDetails`, OpenAI `*_tokens_details.audio_tokens` /
  `image_tokens`) are recorded on the receipt as `modality_tokens` and priced
  at the model's published modality rate (Gemini 2.5 Flash / Flash-Lite audio,
  `gpt-image-1` image input and output). Models with one price for all inputs
  declare `uniform_modalities`; image/video input listed at the text rate is
  declared `text_rate_modalities`. Any other non-text token (including every
  unknown/fallback model) gives `cost_usd: null`, `reason: "modality_unpriced"`
  and the next call returns `accounting_unavailable`: never priced as text.
  `costcap pricing show` prints the modality rates. When a model
  publishes a prompt-length split (Gemini 2.5 Pro / 3.1 Pro, Claude Sonnet
  4.5 / 4.6 above 200K prompt tokens), a call whose whole prompt (input +
  cache read + cache writes) exceeds the threshold is priced entirely at the
  `long_context` rates, and the receipt says `pricing_tier: "long_context"`
  (otherwise `"standard"`). Preflight and `costcap pricing show` use the same
  tier. Check `src/pricing-table.json` before
  relying on rates.
- Premium speed tiers: Anthropic fast mode (response `usage.speed: "fast"`,
  Claude Opus 5.5 at $8/$40 per M, Claude Opus 5 at $10/$50) and OpenAI priority processing
  (`service_tier: "priority"`, gpt-4o at $4.25/$17, gpt-4o-mini at $0.25/$1) are
  priced at the table's `fast` / `priority` rates. The receipt records
  `pricing_tier: "fast" | "priority"` plus the raw `speed` / `service_tier`.
  These rates count toward caps and the velocity breaker. `default` and `flex` tiers are priced at
  standard (flex over-counts, which is the safe direction), and the value is recorded. A premium
  tier on a model with no published premium rate, including fallback models and cache
  components with no premium rate, is never priced at standard: the receipt has
  `cost_usd: null` and `reason: "service_tier_unpriced"`, and the next call gets
  `accounting_unavailable`. `--preflight` reads `speed` / `service_tier` from
  the request body and estimates at premium rates (`preflight_unpriced` when
  no premium rate exists). `costcap pricing show` prints `(fast)` and `(priority)` rows.
- OpenAI embeddings (`POST /openai/v1/embeddings`, exact path) are metered
  input-only: `text-embedding-3-small` ($0.02/M), `text-embedding-3-large`
  ($0.13/M) and `text-embedding-ada-002` ($0.10/M), with `output_tokens: 0`.
  They count toward run, day and month caps. Unknown embedding models bill at
  the fallback input rate (`fallback: true`). An embeddings response with no
  usable `usage.prompt_tokens` is still `usage_unavailable`. `--preflight`
  estimates embeddings as input only. Gemini `embedContent` and OpenRouter
  embeddings are not metered (no usage in the response).
- The pricing table is offline-verifiable. `src/pricing-table.sha256.json`
  holds the committed SHA-256 of the canonical table (keys sorted, no
  whitespace). Every receipt records `table_version` and `table_sha256`.
  `costcap pricing verify` exits 0 when the installed table matches its digest
  and 1 otherwise; `--receipts FILE` also lists receipts priced under a
  different digest, and older receipts with no digest as "unknown" (never as
  matching). `costcap pricing show [model]` prints a model's rates, or the
  fallback rate for an unknown model. `costcap wrap` refuses to start on a table
  that fails verification. To change rates: edit the table, bump `version`,
  run `node scripts/pricing-digest.mjs`; CI runs it with `--check`.
- Missing/invalid usage or an uncertain network outcome pauses further calls.
  Such receipts have `cost_usd: null`. Reconcile them before starting again;
  existing unknown-cost receipts block restart. Never replace unknown cost with
  zero without evidence from the provider.
- A provider 4xx rejection (400, 401, 403, 404, 409, 413, 422, 429) whose body is a
  provider error object is recorded at `cost_usd: 0` with `reason: "upstream_rejected"`
  and does not pause the run; GET/HEAD metadata calls such as `GET /v1/models` are
  `reason: "non_billable_request"`. Files API upload/delete (`POST /v1/files`,
  `DELETE /v1/files/{id}` on Anthropic and OpenAI) 2xx replies are also
  `non_billable_request`: Anthropic documents "Files API operations are free"; file
  content is billed as input tokens when used in a Messages call. 5xx, 2xx without usage and cut streams stay unknown
  and still pause. Repeated identical 429s still trip the retry-spiral breaker.
- Batch APIs (`POST /v1/messages/batches` on Anthropic, `POST /v1/batches` on
  OpenAI): a 2xx create writes a `reason: "batch_pending"` receipt with `batch_id`
  (and `request_count` for Anthropic) at `cost_usd: null`. It does not pause the
  run, but the run total stays unknown and `costcap check` fails until the batch
  settles. Reading the results through the proxy settles it: Anthropic
  `GET /v1/messages/batches/{id}/results`, or OpenAI `GET /v1/batches/{id}` (which
  links its `output_file_id`) then `GET /v1/files/{output_file_id}/content`.
  Succeeded lines are priced at the published 50% batch rate (pricing table
  `batch`, applied to every component including cache reads/writes and on top of
  long_context); errored, canceled, expired and non-2xx lines cost $0. One
  `{"event":"reconciliation","source":"batch_results"}` line is appended (once,
  however often results are read) and counts at the batch's original `ts`. An
  unpriced model, a `speed: "fast"` line or a malformed line settles nothing: the
  read is recorded as `reason: "batch_unpriced"` and the run pauses. Every
  Anthropic `requests[].params.model` is checked against `--models` and
  `--unknown-models refuse`; an OpenAI batch names its models only inside the
  input file, so an OpenAI batch create is refused whenever an allowlist is set.
  Not covered: pre-flight reservation for batches, Gemini batch mode and
  OpenRouter batches, and polling the provider (costcap only sees results you
  fetch through it).
- SSE (`text/event-stream`) responses are passed through in real time, chunk by
  chunk with backpressure, and usage is metered from the stream as it passes.
  OpenAI and OpenRouter chat completions only send usage in a stream when
  `stream_options.include_usage` is set, so for `"stream": true` chat calls
  costcap sets it in the forwarded request (other `stream_options` keys are kept).
  When costcap injected it, the extra usage-only chunk (`choices: []`) is metered
  and not forwarded, so your client sees the same events as without costcap. If you
  set `include_usage: true` yourself, the chunk is forwarded unchanged. Other
  requests are forwarded byte-identical.
  The receipt is written when the stream ends, so a cap hit by a streamed call
  blocks the **next** call; a call already in flight can overshoot the cap. A
  stream cut (upstream error, client abort or timeout) before usage arrives
  records `cost_usd: null` with `reason: "stream_incomplete"` and blocks further
  calls. Timeouts match the official SDKs: the proxy waits up to 600s for the
  first response byte (`wrap --timeout <seconds>` or `COSTCAP_UPSTREAM_TIMEOUT_S`),
  then a stream is cut only after it goes silent for 300s
  (`COSTCAP_STREAM_IDLE_TIMEOUT_S`), so long streams that keep sending chunks are
  never cut. Request bodies up to 32 MB are forwarded (`COSTCAP_MAX_REQUEST_MB`);
  a larger body gets a 413 naming the limit and a zero-cost
  `reason: "request_too_large"` receipt with `bytes_limit`, and does not block
  later calls. OpenAI Responses API streams
  are metered from the terminal `response.completed` / `response.incomplete` /
  `response.failed` event (cached input priced as cached); a Responses stream that
  ends without a terminal event records `stream_incomplete`. OpenAI chat/Responses,
  Anthropic start/delta usage, Gemini usageMetadata, and OpenRouter (OpenAI-shape)
  usage have local fixture tests. Provider billing reconciliation and live SDK
  compatibility remain unverified.
- Anthropic cache writes use per-model 5-minute and 1-hour rates. A response without
  the 5m/1h breakdown is priced at the 5-minute rate. A cache write on a model with no
  published rate records `cost_usd: null` and blocks further calls. Other billable
  features and dynamic pricing may differ.
- The default kill file is relative to the working directory. Only agents sharing
  that file are affected. The host kill file `$COSTCAP_HOME/KILL` (`COSTCAP_HOME`
  defaults to `~/.costcap`) is checked in addition, by `wrap`, `mcp`, `agent-status`
  and `check`: either file present means killed (`kill_scope: "host"|"project"` and
  `kill_file` in the verdict, blocked receipt and run summary). `costcap kill --host` /
  `costcap resume --host` change only the host file; plain `resume` never lifts a host
  kill. A host-file stat error other than not-found counts as killed. Polling defaults to 500ms, with SIGKILL after 5 seconds.
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

To settle unknown-cost receipts from that provider evidence, add `--apply`:

```sh
costcap reconcile --receipts .costcap/receipts.jsonl --provider charges.jsonl --apply
```

For each `cost_usd: null` receipt with a matching charge whose `cost_usd` is a
finite number >= 0, one `{"event":"reconciliation","receipt_id",...,"provider_sha256"}`
line is appended; the original receipt line is never edited. The settled cost
counts toward the original receipt's run/day/month. A missing, null or negative
charge never settles (it is not $0): the command exits 1 and lists the ids still
unknown. Re-running is idempotent. See `docs/fixtures/provider-charges.sample.json`.

Settlements also flow the other way (#162): `GET /v1/policy` returns `settlements` (`receipt_id`, `settled_cost_usd`, `settle_source`, `audit_id` of the `receipt.settle` audit entry) for this agent's settled unknown-cost receipts. On the next poll the wrapper appends one `{"event":"reconciliation","source":"hosted_settle",...}` line per settlement to its local ledger (never editing the original line; repeat polls add nothing), so a dashboard settle unblocks a running or freshly started `costcap wrap` and `costcap agent-status` agrees with `/v1/agents/:id/budget`. Settlements for other agents' receipts, known-cost receipts or receipts already settled locally are ignored.

On an enrolled wrapper, the fleet team and agent checks use the settled cost too.
The next sync uploads each settlement once to `POST /v1/receipts/settlements`
(agent token; only the agent's own synced `cost_usd: null` receipt; duplicate =
idempotent 200, already known or settled = 409). The hosted receipt keeps
`cost_usd: null`, gains `settled_cost_usd`, and is audited as `receipt.settle`
with `source: "agent_reconcile"` and the agent as actor. An older server without
the route is skipped without failing receipt sync.

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

**Fleet-wide agent caps (#127):** `/v1/policy` also returns
`agent_spend: { spent: { day, month }, unknown, as_of }`, the agent's synced
spend across every host and runner using that identity (settled costs
included). The wrapper refuses before calling upstream once synced spend plus
its own unsynced receipts reach the fleet day/month cap (`429 budget_exceeded`,
`scope: "day"|"month"`), and refuses with `accounting_unavailable` while any
unknown cost is unsettled. Spend cached from an earlier UTC day/month counts 0
for that window. A fresh runner or wiped `.costcap/` no longer starts from $0.
Overshoot is still bounded by unsynced spend on other hosts (one poll interval).

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

### Model allowlist

Pin an agent to the models it may call: `costcap wrap --models gpt-4o-mini,claude-haiku-4-5 -- node agent.js` (exact ids, comma separated). The model is read from the request before it is forwarded (JSON `model` for OpenAI, OpenRouter and Anthropic; `models/<id>:generateContent` in the Gemini path). A disallowed model, or a request whose model can't be determined, gets `403 {"error":"model_not_allowed","model":...}` and is never sent upstream, streaming included. A zero-cost receipt with `outcome: "blocked_model"` is written and the run is not frozen, so the next allowed call still works.

`--unknown-models refuse` refuses any model that is not in the pricing table (`403 model_unpriced`), even without `--models`. The default (`fallback`) keeps pricing unknown models at the declared fallback rate.

The same `models: [...]` limit works in a `--policy` file (`default`, `agents.<id>`, `teams.<id>`) and on the hosted per-agent policy (`models` on `POST /v1/agents/:id/policy`, or "Allowed models" in the dashboard; `null` clears it). Enrolled wrappers enforce the synced list offline. All lists combine as an intersection, so the most restrictive wins; an empty intersection refuses every call. `costcap check --models ...`, `agent-status` and the MCP budget tools report `allowed_models`; `check` also reports `blocked_model_count`. Receipts CSV exports and `/v1/evidence.json` carry an `outcome` column.

An agent entry replaces the default. An agent with no entry and no default is
refused (`no_budget_policy`).

Usage is known only when the provider's required token counters are present as
finite numbers: prompt/input **and** completion/output for OpenAI and OpenRouter,
`promptTokenCount` **and** `candidatesTokenCount` for Gemini. An empty or
duration-shaped usage object (for example `{"seconds": 42}`) is recorded as
`cost_usd: null`, `reason: "usage_unavailable"`, and pauses the run. It is never
zero-filled to $0. Real explicit zeros still record a known $0. The proxy never
follows a provider redirect, so your API key is not sent to another host. A 3xx
returns 502 `upstream_redirect` to the client, with a $0 receipt because nothing
was generated. A missing, negative, non-finite or non-numeric OpenRouter
`usage.cost` falls back to table/fallback pricing, never $0, and `usage.cost`
without the token counters is still `usage_unavailable`.

Provider-side tools are never silently free. Anthropic `server_tool_use`
requests (for example `web_search_requests`) and OpenAI Responses
`web_search_call` / `file_search_call` items are billed per call at rates the
pricing table does not carry, so the call is recorded as `cost_usd: null`,
`reason: "tool_use_unpriced"`, and the run pauses until you reconcile it. Gemini
`toolUsePromptTokenCount` is counted as input tokens. The free token-count
endpoints (`POST /anthropic/v1/messages/count_tokens`, Gemini
`models/<model>:countTokens`, `POST /openai/v1/responses/input_tokens`) record a
$0 `non_billable_request` on 2xx and do not pause. Only these exact paths are
exempt; dot segments or percent-encoded paths are not.

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

### Hosted team budgets

In the hosted workspace an owner or admin defines teams with `POST /v1/teams` (`{"name": "ops", "agents": [agentId, ...], "day": 30, "month": 500}`; `{"name": "ops", "remove": true}` deletes). Any member can read `GET /v1/teams`. Viewers get 403 on writes, and an agent from another org gets 400. An agent belongs to at most one team. Every change is audited as `team.change`, with the previous and new values.

Each enrolled wrapper gets its team's caps and the team's synced spend with every `/v1/policy` poll. It enforces them offline from that cache, adding its own unsynced spend on top. Its own caps apply first, then the team's. A refusal reads `budget_exceeded` with `scope: "team:ops:day"`. An unknown cost (`cost_usd: null`) from any member makes the team verdict `accounting_unavailable`. It is never counted as $0.

**Overshoot:** team spend comes from synced receipts. Spend another member has not synced yet (up to one poll interval, 60s) is not seen, so the team can go over its cap by that amount. Removing an agent from a team stops its team enforcement at its next poll. `GET /v1/agents/:id/budget`, `/v1/evidence.json` (`teams[]`, `agents[].team`) and the dashboard's Team budgets card show each team's cap, spend and verdict.

**Team alerts:** each alert sweep checks every team against its own day and month caps. At 80% of a cap it raises `cap_approaching`, and at 100% it raises `cap_hit` (keys `cap_approaching:team:<orgId>:<name>:<scope>` and `cap_hit:team:<orgId>:<name>:<scope>`). A member receipt blocked with `scope: "team:<name>:<scope>"` in the last hour also raises that team's `cap_hit`, even when synced totals lag. A team with unknown cost raises no cap alert. Team alerts fire once, re-arm after the condition clears, go to the org's alert destinations, and carry `team`, `scope`, `cap` and `spent`. Deleting the team deactivates them.

## Soft warnings

`wrap` and `check` warn before the hard stop. By default, a warning fires when run, day or month spend reaches 80% of its cap:

```sh
costcap wrap --day-cap 10 --warn-at 0.5,0.8 -- node agent.js
# costcap: warning: day spend $8.0123 is 80% of $10 cap (2026-11-16 UTC)
```

- `--warn-at F[,F...]` takes fractions with 0 < F < 1. The default is `0.8`, and `--warn-at off` disables warnings. A bad value exits `2`.
- The first time a capped scope crosses a fraction, `wrap` prints one stderr line and appends one ledger event: `{"event":"cap_warning","scope","fraction","cap","spent_usd","period","run_id","agent_id","lower_bound"}`. Warnings are deduped per scope, fraction and period (`run_id` for run, the UTC `YYYY-MM-DD` for day, `YYYY-MM` for month), so a second wrap on the same day does not warn again. The run summary lists them under `warnings`.
- Warnings never block a call and are never spend. Receipts, runs and check totals ignore `cap_warning` lines.
- When a scope has an unknown-cost receipt, its spend is a lower bound: `lower_bound: true`, and the stderr line says "(lower bound)". Unknown cost is never counted as $0.
- `costcap check` adds `warnings: [{scope, fraction, cap, spent_usd, lower_bound}]` without changing `ok`. With `--github-output`, it also writes a `warnings` output (for example `day:0.8,month:0.5`) and a warnings row in the job summary.

## Run summaries

Every `costcap wrap` run writes `<ledger-dir>/runs/<run_id>.json` (`costcap.run-summary/v1`) when it ends, including after a cap stop, breaker stop or `costcap kill`. It holds `calls`, `blocked_calls`, `by_model` (calls, input/output/cache-read/cache-write tokens, `cost_usd`), `total_cost_usd`, `unknown_cost_calls`, `caps` (limit and spent per scope) and `stopped_by` (`null`, `budget_exceeded`, `breaker_open` or `killed`, plus `stopped_scope`). If any call has unknown cost, `total_cost_usd` is `null`, never a silent $0. A one-line roll-up is printed to stderr.

```sh
node src/cli.js runs                 # newest first
node src/cli.js runs --json --receipts .costcap/receipts.jsonl
```

Corrupt summary files are reported and skipped. No account is needed.

## CI check and local MCP

```sh
node src/cli.js check --receipts .costcap/receipts.jsonl --cap 5
node src/cli.js mcp --receipts .costcap/receipts.jsonl --day-cap 10
```

`check` returns JSON and exits 0 below the budget, 1 at/above it or with unknown
cost, and 2 for missing/malformed evidence. `--cap` sums the entire selected
receipt file, not one reconstructed run. `--day-cap` and `--month-cap` use UTC.
With `--run-id ID` (Action input `run-id`), `--cap` counts only receipts whose
`run_id` is `ID`; output adds `run_id`, `scope: "run"` and separate
`run`/`day`/`month` totals, while day/month caps still cover the whole ledger.
Unknown cost inside the run exits 1 (`accounting_unavailable`); unknown cost in
another run only affects day/month caps. A run id with no receipts exits 2.
List run ids with `costcap runs`.
List and export local receipts with `costcap receipts [--since 14d|24h|ISO] [--until ISO] [--agent ID] [--run-id ID] [--json] [--export csv] [--receipts FILE]`
(oldest first; kill/resume/reconciliation lines skipped; unknown cost prints `unknown`, settled receipts show `settled_cost_usd`;
CSV uses the hosted export columns and formula-injection escaping; exit 2 on a bad time or unreadable ledger).
`action.yml` exposes this check as a composite GitHub Action (Marketplace
branding included); no Marketplace listing or public release has been made yet. MCP exposes only `budget_status` via
JSON-RPC stdio. It cannot kill, resume, change caps or spend money. Local MCP
protocol tests do not substitute for verification in every MCP client.

`mcp` and `agent-status` give the same answer the wrapper will enforce on the
next call. `--kill-file PATH` (default `.costcap/KILL`, the wrapper's default)
and `--enrollment PATH` (the cached hosted policy that `wrap --enrollment`
reads) are honoured in the wrapper's order: a kill file, a cached fleet
`killed: true` or revoked credentials return `ok: false`, `verdict: "killed"`
and the kill metadata, ahead of any budget verdict. Then the cached fleet
per-agent caps and team caps apply (`scope` reads e.g. `team:ops:day`), then
min(local, fleet) day/month caps. Unsettled fleet or team spend returns
`accounting_unavailable`, never ok. Both commands only read the enrollment
cache; they never sync or write it. With no kill file and no enrollment the
output is unchanged.

With `--github-output`, `check` also appends step outputs to `$GITHUB_OUTPUT`
(delimiter syntax, so values cannot break the file) and a Markdown table to
`$GITHUB_STEP_SUMMARY`, before it exits. The Action does this automatically and
exposes the outputs `verdict` (`ok`, `budget_exceeded`, `accounting_unavailable`),
`spent-usd` (empty, never `0`, when any cost is unknown), `cap-usd`,
`day-spent-usd`, `month-spent-usd`, `unknown-receipts` and `receipts-count`:

```yaml
- id: budget
  uses: persooninc/costcap@<sha>
  with: { receipts: .costcap/receipts.jsonl, cap: '5' }
- if: always()
  run: echo "verdict=${{ steps.budget.outputs.verdict }} spent=${{ steps.budget.outputs.spent-usd }}"
```

The job summary says that totals are estimates and whether any cost is unknown.

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

`GET /v1/agents/:id/runs?since=&limit=&cursor=` lists that agent's recent runs (same access rules as `/budget`), newest first by last receipt, keyset-paginated (`limit` 1-100, default 20; pass `next_cursor` back as `cursor`) and clamped to plan retention. Each run has `run_id`, `first_ts`, `last_ts`, `calls`, `usd_known` (6 dp, settlements applied), `unknown_count`, `blocked_count`, `models[]` (`model`, `calls`, `usd_known`) and `cost_complete`. An unknown cost is never counted as $0: it raises `unknown_count` and sets `cost_complete: false`. Receipts without a `run_id` group under `(none)`. `GET /v1/agents/:id/runs/:run_id` returns that run's summary and receipts. `/v1/receipts.csv` has a `run_id` column (after `receipt_id`) and accepts `run_id=` to filter. The dashboard shows "Recent runs" on each agent card; click a run to see its receipts.

`GET /v1/evidence.json` (signed-in session, scoped to your org) returns a `costcap.evidence/v1` document for ShipReady Metrics. It holds per-agent caps, day/month known spend, unknown-cost counts, active alerts, receipts (with `blocked`, `reason` and `scope`), and an `audit` trail: every org audit entry oldest first with `ts`, `actor`, `action`, `target` and `detail`. A `policy.change` entry carries `detail.previous` (caps, `killed`, `maxSteps`, `models` before the change) and `detail.policy` (after); fleet freeze/resume entries carry `reason` and `agent_ids`. A receipt with unknown cost keeps `cost_usd: null`. It is never counted as $0, and `cost_complete` is false whenever any cost is unknown. Sample: `docs/fixtures/srm-evidence.sample.json`.

**Settling an unknown cost (hosted, #125).** An owner or admin can settle an unknown-cost receipt with an audited value from provider evidence: the dashboard's *Unknown-cost receipts* card, or `POST /v1/receipts/:id/settle` with `{cost_usd, source, reason}` (`source` is `provider_invoice`, `provider_usage_export` or `manual_evidence`; pass `agent_id` if two agents share a receipt id). The receipt keeps `cost_usd: null` and gains `settled_cost_usd`, `settled_at`, `settled_by`, `settle_source` and `settle_reason`. Fleet spend, agent and team verdicts, alerts and evidence then use the settled cost in the receipt's original window; `unknown_cost_receipts` counts only unsettled receipts. A known or already-settled receipt returns 409 (`already_known` / `already_settled`). Each settlement writes one `receipt.settle` audit entry (`event: "reconciliation"`, before `null`, after the value). No provider billing API is called.

**Alert lifecycle (#143).** Each firing is its own alert occurrence with `id`, `key`, `fired_at`, `resolved_at` (null while active), `acknowledged_at` and `acknowledged_by`. When the condition clears, `resolved_at` is set and the record is kept; a later firing of the same key is a new occurrence. `GET /v1/alerts?status=active|acknowledged|resolved|all&since=&until=` (any member, org-scoped; `since`/`until` filter on `fired_at`) lists them, active first. `POST /v1/alerts/:id/ack` (owner or admin; viewer 403, other org 404) sets `acknowledged_at`/`acknowledged_by` once and writes one `alert.ack` audit row; acknowledging never resolves an alert or re-delivers it. `/v1/evidence.json` alerts carry the same lifecycle fields for all occurrences. Records stored before #143 keep `fired_at: null` (unknown, never invented).

**Alert destinations.** `GET /v1/alert-settings` (any member) returns the org's alert emails and the Slack webhook masked (`https://hooks.slack.com/services/…` + last 4). `POST /v1/alert-settings` (owner or admin) takes `{ "emails": [...verified member emails], "slackWebhook": "https://hooks.slack.com/services/..." | null }`; an omitted field keeps its value. Each org's alerts go only to its own destinations; changes are audited as `alert_settings.change` with masked values.

### Fleet freeze (kill switch)

`POST /v1/fleet/freeze` and `POST /v1/fleet/resume` (owner or admin session, body `{ "reason": "..." }`, 1-500 characters) kill or revive the whole org's fleet. Freeze bumps the policy version of every non-revoked agent that is not already killed and sets `killed: true`. Repeating it while frozen is a no-op (`alreadyFrozen: true`). Resume only revives the agents that freeze killed, so an agent killed on its own stays killed. Each action writes one `fleet.freeze` / `fleet.resume` audit entry with actor, reason and agent ids; `POST /v1/agents/:id/policy` also accepts an optional `reason`. Wrappers apply the freeze at their next policy poll. It is not instant and does not undo requests already accepted. The dashboard has a "Freeze all agents" card with a required reason and a confirm step.

`GET /v1/spend?since=&until=&group_by=day|model|agent` (any session role, including viewer) returns the org's synced receipt spend in buckets. Each bucket has `usd_known`, `calls`, `unknown_count`, `blocked_count` and `cost_complete`, plus a `total`. Days are UTC. `since`/`until` take an ISO instant or `YYYY-MM-DD`; a date-only `until` covers that whole day. A `cost_usd: null` receipt adds to `unknown_count` and marks the bucket incomplete; it never adds $0. Once settled it counts at the settled value in its original bucket. With entitlements enforced, the period is clamped to the plan's receipt retention, and the response reports the clamped `since` with `retention_clamped: true`. An invalid `group_by`, `since` or `until` returns `400`. The dashboard's Spend card reads it with a 7-day, 30-day or this-month period.
