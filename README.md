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
| OpenAI | `OPENAI_BASE_URL=http://127.0.0.1:<port>/openai/v1` and `COSTCAP_OPENAI_REALTIME_URL=ws://127.0.0.1:<port>/openai/v1/realtime` |
| Anthropic | `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/anthropic` |
| OpenRouter | `OPENROUTER_BASE_URL=http://127.0.0.1:<port>/openrouter` |
| Gemini | `GOOGLE_GEMINI_BASE_URL` (read by go-genai, `@google/genai` and Gemini CLI) and `GEMINI_BASE_URL` (legacy), both `http://127.0.0.1:<port>/gemini` |
| Claude on Amazon Bedrock | `ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:<port>/bedrock` |
| Claude on Google Vertex AI | `ANTHROPIC_VERTEX_BASE_URL=http://127.0.0.1:<port>/vertex/v1` |

The Python `google-genai` SDK has no base-URL environment variable; set
`http_options={"base_url": os.environ["GOOGLE_GEMINI_BASE_URL"]}` in code or its
traffic bypasses CostCap.

### Realtime API

The OpenAI Realtime API (`/v1/realtime` WebSocket) is proxied and metered. CostCap
writes one receipt per `response.done` (`transport: "websocket"`, `session_id`,
`response_id`), pricing text, audio and image tokens at the `gpt-realtime*` rates with
the cached split. Admission (kill, allowlist, `--unknown-models refuse`, agent/team,
tag and spend caps) runs before the `101`; a refusal is a plain HTTP error and nothing
reaches OpenAI. After each response the caps are re-checked: on a hit the client gets
that `response.done`, then `{"type":"error","error":{"type":"costcap","code":"budget_exceeded"}}`,
then close `1008`. `costcap kill` closes open sessions within a second.

- **Python SDK:** works as is. `client.realtime.connect()` derives `ws://…/realtime` from `OPENAI_BASE_URL`.
- **Raw WebSocket apps:** connect to `COSTCAP_OPENAI_REALTIME_URL` (add `?model=…`).
- **Node SDK:** unsupported. It forces `wss:`, and the loopback proxy is plain HTTP.
- **Hardcoded `wss://api.openai.com`:** bypasses CostCap.

A response cut before `response.done`, audio on a model with no audio rate
(`gpt-realtime-mini` is text only here) and a billed input transcription are recorded as
unknown cost (`stream_incomplete`, `modality_unpriced`, `transcription_unpriced`) and
pause the run until reconciled. Upgrades on any other path get `501 websocket_unsupported`.

### Other OpenAI-compatible providers

Groq, DeepSeek, Together, Mistral, a self-hosted vLLM/Ollama server or an Azure
OpenAI deployment can be metered and capped with `--upstream NAME=URL[,env=VAR][,insecure]`
(repeatable). `URL` is the base your SDK would use *without* costcap (the same
value you would put in `base_url`). The proxy forwards `/u/<NAME>/<rest>` to `URL/<rest>` (query and
headers, including Azure's `api-key`, pass through; redirects are refused) and
sets `COSTCAP_UPSTREAM_<NAME>_BASE_URL=http://127.0.0.1:<port>/u/<NAME>` for the
child, plus `VAR` when `env=VAR` is given. `URL` must be `https`; plain `http` is
allowed for loopback hosts, or any host with `,insecure` (warned on stderr).
Receipts record `provider: "u/<NAME>"`. If a custom upstream's first response in a
wrap is a 404, costcap prints one stderr hint per name:
`costcap: upstream "<NAME>" returned 404 for /<path>; does --upstream URL need a /v1 suffix?`

```bash
# Groq with the OpenAI SDK (base_url https://api.groq.com/openai/v1)
costcap wrap --upstream groq=https://api.groq.com/openai/v1,env=OPENAI_BASE_URL --upstream-prices prices.json --cap 1 -- node agent.js
# Groq with the Groq SDK (it appends /openai/v1/... to GROQ_BASE_URL itself)
costcap wrap --upstream groq=https://api.groq.com,env=GROQ_BASE_URL --upstream-prices prices.json --cap 1 -- node agent.js
# Point an OpenAI SDK at a local vLLM box (vLLM serves the OpenAI API under /v1)
costcap wrap --upstream vllm=http://127.0.0.1:8000/v1,env=OPENAI_BASE_URL --upstream-prices prices.json -- python agent.py
# Azure OpenAI with the openai SDK's AzureOpenAI client: it appends /openai/deployments/<dep>/...
# to AZURE_OPENAI_ENDPOINT, so URL is the bare resource endpoint (no /openai suffix)
costcap wrap --upstream azure=https://my-resource.openai.azure.com,env=AZURE_OPENAI_ENDPOINT --upstream-prices prices.json -- node agent.js
```

**Fail-safe pricing.** Custom upstreams never price from the shipped table and
never use the fallback rate. Rates come only from `--upstream-prices FILE` (USD
per 1M tokens; snapshot date suffixes are stripped):

```json
{ "version": "2026-11", "upstreams": { "groq": { "llama-3.3-70b-versatile": { "input": 0.59, "output": 0.79 } } } }
```

A priced receipt carries `cost_source: "user_prices"`, `prices_version` and
`prices_sha256`. A model missing from the file (or cached tokens with no
`cached_input` rate) records `cost_usd: null, reason: "upstream_model_unpriced"`
and pauses the run until `costcap reconcile --apply` settles it.
`--unknown-models refuse`, `--models` and `--preflight` use the same prices; a
request with no body `model` (Azure deployments) is model-less and refused when
an allowlist is set. Native non-OpenAI wire formats on custom upstreams (Cohere v2)
and embeddings/batch/files billing on custom upstreams stay unknown. Claude on
Bedrock and Vertex has its own built-in routes (next section).

## Negotiated rates and new models

The same `--upstream-prices FILE` can override the shipped table for the built-in
providers `openai`, `anthropic`, `gemini` and `openrouter`. These keys need no `--upstream`:

```json
{ "version": "acme-2026-11", "upstreams": {
  "anthropic": { "claude-sonnet-4-5": { "discount": 0.2 } },
  "openai": { "gpt-6-preview": { "input": 3, "output": 12 }, "*": { "discount": 0.1 } } } }
```

- `{discount: d}` (0 < d < 1) scales every table component of the model (standard,
  long context, fast/priority, modalities, batch) by `1-d`. `"*"` applies a discount to
  every model in the table for that provider; a model-specific entry wins over it.
- Absolute rates (`input`, `output`, optional `cached_input`, `cache_write`, `cache_write_1h`,
  USD per 1M tokens) can price a model that isn't in the table. They price only the
  standard text components they list.
- **Never $0, never silently lower.** Rates must be > 0. `wrap` exits 2 before spawning on
  a discount outside (0,1), rates mixed with a discount, an unknown key, or `"*"` with rates.
  A discount never applies to a fallback-priced model: a `{discount}` entry for a model not in the
  pricing table is ignored (`wrap` warns "discount ignored: …"), so `--unknown-models refuse` still refuses it and
  `pricing show`/`--preflight` quote the full fallback rate. If a call needs a component that an
  absolute entry doesn't list (a cache write with no rate, long context over the table
  threshold, fast/priority, non-text tokens or a batch line), the receipt is
  `cost_usd: null, reason: "user_price_unpriced"` and the run pauses. The table rate is never used instead.
- Receipts record `cost_source: "user_prices"`, `prices_version`, `prices_sha256` and the
  table pin. `--unknown-models refuse`, `--preflight` and `--models` use the same rates.
  OpenRouter's reported `usage.cost` still wins.
- `costcap pricing show MODEL --prices FILE` prints the effective row. `costcap pricing verify
  --receipts R --prices FILE` counts `user_prices` receipts and exits 1 when their
  `prices_sha256` doesn't match the file. The hosted Spend card shows "$X at your prices".

## Claude on Bedrock / Vertex, Gemini on Vertex

`costcap wrap` sets `ANTHROPIC_BEDROCK_BASE_URL`, `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` and
`ANTHROPIC_VERTEX_BASE_URL`, so boto3 / AWS SDK v3 Bedrock callers, Claude Code (`CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1`) and the Anthropic
Bedrock/Vertex SDKs are metered, capped and killable like `api.anthropic.com`.

- **Routes.** Bedrock `POST /model/{id}/invoke`, `invoke-with-response-stream` and
  `count-tokens`, plus Converse `POST /model/{id}/converse` and `converse-stream`
  (boto3 `converse`/`converse_stream`, LangChain `ChatBedrockConverse`, Strands), go to `bedrock-runtime.<region>.amazonaws.com`. Vertex
  `…/locations/<loc>/publishers/anthropic/models/{id}:rawPredict` and `:streamRawPredict`
  go to `<loc>-aiplatform.googleapis.com` (`global` goes to `aiplatform.googleapis.com`).
  Converse is metered from `usage` (`inputTokens`, `outputTokens`, `cacheReadInputTokens`,
  `cacheWriteInputTokens`) and ConverseStream from the final `metadata` event; a stream cut
  before `metadata` is `stream_incomplete` (unknown cost, never $0). Preflight reads
  `inferenceConfig.maxTokens`. If `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` is already set, wrap leaves
  it alone and warns once. Non-Anthropic Converse models (Nova, Llama, …) are unpriced.
  Any other path (`GET /inference-profiles`, multi-region Vertex hosts such as
  `locations/us`) is answered locally with `404 cloud_route_unsupported` and never forwarded.
- **Gemini on Vertex.** wrap also sets `GOOGLE_VERTEX_BASE_URL=http://127.0.0.1:<port>/vertex`
  (read by Google's genai SDKs with `vertexai=True`; for SDKs that don't read it, pass
  `http_options.base_url` with that value). `…/publishers/google/models/{id}:generateContent`,
  `:streamGenerateContent` (`?alt=sse` or the default JSON-array stream) and `:countTokens`
  (free) are metered from `usageMetadata` exactly like `/gemini` calls, with caps, kill switch,
  allowlist and preflight (`generationConfig.maxOutputTokens`). Receipts have provider `vertex`.
  `@version` / `-NNN` suffixes price as the base id; only Gemini models listed under
  `vertex_gemini` in the pricing table are priced, any other id is unknown (never $0).
  Batch prediction, `cachedContents`, tuning, Imagen, Veo, embeddings and Live stay
  `404 cloud_route_unsupported`.
- **Bedrock credentials.** A `Bearer` Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) passes
  through unchanged; the region comes from `AWS_REGION`, then `AWS_DEFAULT_REGION`. A SigV4
  request is signed by the child for the local proxy, so CostCap verifies it with the static
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` in wrap's environment
  (bad signature: `403 bedrock_signature_invalid`) and re-signs it for the real host. Without
  static credentials a signed call gets `502 bedrock_credentials_unavailable` and nothing is
  forwarded. Profiles, SSO and IMDS are not resolved inside the proxy; export them first:
  `eval "$(aws configure export-credentials --format env)"`. Keys never reach receipts.
- **Vertex credentials.** The OAuth `Authorization` header passes through unchanged.
- **Metering.** JSON, Vertex SSE and Bedrock's binary `application/vnd.amazon.eventstream`
  are metered in real time (frames forwarded byte-for-byte, CRC-checked). A cut stream or a
  bad CRC is `stream_incomplete`. `count-tokens` is free.
- **Models.** The model comes from the path: Bedrock geo prefixes (`global.`, `us.`, `eu.`,
  `apac.`, `jp.`, `au.`), `anthropic.` and `-vN[:M]` are stripped; Vertex `@YYYYMMDD` is
  stripped. Receipts carry `provider`, `model` (table id), `provider_model` (raw id) and
  `endpoint_scope`. A non-Anthropic id, an ARN or an unlisted id records
  `cost_usd: null, reason: "cloud_model_unpriced"` and pauses; it never uses the fallback rate.
- **Regional premium.** Claude 4.5+ on regional endpoints costs 10% over global (Bedrock
  `global.` ids and Vertex `locations/global` are global). The table's `regional_endpoint`
  multiplier stacks with long context and batch; receipts record `regional_multiplier`.
- Cloud routes always bypass the response cache (`x-costcap-cache: bypass`).

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
  It also covers `--policy` agent and team budgets (the tighter remainder) and
  every matching `--tag-cap` (`tag_budget_exceeded`). With `--enrollment` it also
  covers the enrolled fleet agent day/month caps and the hosted team budget,
  against fleet-wide synced spend plus this host's unsynced receipts
  (`fleet: true`, and `team` for a team budget).
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
  Which endpoints are estimated (#205): chat, responses, messages, embeddings
  and other generating POSTs use the maths above. An Anthropic Message Batches
  create is estimated as the **sum** of every `requests[].params` worst case
  times the batch rate (0.5x); the batch preflight discounts tokens only, and
  each entry's tool worst case (`max_uses` x rate) is added at 100%
  (`tool_calls_max` / `tool_usd_max` are summed across entries, #218); any unpriced entry refuses with
  `preflight_unpriced` naming it. These pass through preflight unestimated
  (still subject to caps, allowlists and rpm; the receipt has
  `preflight_estimate: false`): `GET`/`HEAD` (background polls, batch and file
  retrieves, `/v1/models`), `/v1/files` and `/v1/uploads`, and OpenAI batch
  creates (their models live in the uploaded file; results are metered at
  settle). Audio (`/v1/audio/*`) is checked against the extracted `model`
  only: a priced model (e.g. `whisper-1`) passes, an unpriced one refuses with
  `preflight_unpriced` naming it.
- Local `wrap`/`check` daily and monthly periods use UTC; hosted caps follow the org budget period (below). Pricing is a versioned estimate, not the
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
  estimates embeddings as input only. Gemini `:embedContent` and
  `:batchEmbedContents` are metered input-only from
  `usageMetadata.promptTokenCount` (`gemini-embedding-001` $0.15/M;
  `gemini-embedding-2` text $0.20, image $0.45, audio $6.50, video $12.00 per
  M via `promptTokenDetails`). OpenRouter embeddings
  (`POST /openrouter/v1/embeddings`, exact path) are metered input-only from
  `usage.prompt_tokens`: a valid `usage.cost` wins (`cost_source: "provider"`),
  otherwise `openai/` ids use the table rate and other ids the fallback input
  rate (`fallback: true`).
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
  An enrolled wrapper that is still running resumes without a restart once every
  unknown receipt it produced is settled from the dashboard (picked up on the next
  fleet poll). A local `costcap reconcile --apply` while a wrap runs is not tailed:
  restart the wrap after reconciling. An uncertain upstream outcome or an
  unavailable ledger always needs a restart.
- A provider 4xx rejection (400, 401, 403, 404, 409, 413, 422, 429) whose body is a
  provider error object is recorded at `cost_usd: 0` with `reason: "upstream_rejected"`
  and does not pause the run; GET/HEAD metadata calls such as `GET /v1/models` are
  `reason: "non_billable_request"`. Files API upload/delete (`POST /v1/files`,
  `DELETE /v1/files/{id}` on Anthropic and OpenAI) 2xx replies are also
  `non_billable_request`: Anthropic documents "Files API operations are free"; file
  content is billed as input tokens when used in a Messages call. 5xx, 2xx without usage and cut streams stay unknown
  and still pause. Repeated identical 429s still trip the retry-spiral breaker.
- Retrieves never create spend: any GET/HEAD (for example `GET /v1/responses/{id}` or a
  stored `GET /v1/chat/completions/{id}`) is `cost_usd: 0, reason: "non_billable_request"`
  even when the body carries usage, unless it settles a pending background response.
- OpenAI Responses background mode (`POST /openai/v1/responses` with
  `background: true`): a 2xx `queued`/`in_progress` reply writes a
  `reason: "background_pending"` receipt with `response_id` at `cost_usd: null`. Like a
  pending batch it does not pause the run, spend is a lower bound and `costcap check`
  fails until it settles. A cut `background: true, stream: true` stream that already
  sent `response.created` is also `background_pending`. Polling `queued`/`in_progress`
  costs $0. The first terminal (`completed`, `incomplete`, `failed`, `cancelled`) read
  through the proxy (`GET /v1/responses/{id}`, a resumed `?stream=true` stream, or
  `POST /v1/responses/{id}/cancel`) appends one
  `{"event":"reconciliation","source":"background_result","response_id"}` at the
  create's `ts` (once, including across restarts). A terminal reply with null or
  unpriceable usage appends `{"event":"background_unpriced"}`: the receipt becomes an
  unknown `background_unpriced` and the run pauses.
  Another run's background settle counts toward day/month and `--policy`/`--tag-cap`
  budgets, never toward this run's velocity breaker (matching batches).
- Batch APIs (`POST /v1/messages/batches` on Anthropic, `POST /v1/batches` on
  OpenAI): a 2xx create writes a `reason: "batch_pending"` receipt with `batch_id`
  (and `request_count` for Anthropic) at `cost_usd: null`. It does not pause the
  run, but the run total stays unknown and `costcap check` fails until the batch
  settles. Enrolled fleet day/month caps and hosted team caps (`costcap wrap
  --enrollment`) follow the same rule: a pending batch is shown as pending, not as an
  unreconciled unknown, and its settled cost counts toward the fleet/team total.
  Reading the results through the proxy settles it: Anthropic
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
  Gemini Batch Mode (#230): a 2xx `POST /gemini/v1beta/models/{m}:batchGenerateContent`
  writes the same `batch_pending` receipt (`batch_id` from `name: "batches/{id}"`,
  `request_count` for inline requests, the path model checked against `--models`
  and `--unknown-models refuse`). A `GET /gemini/v1beta/batches/{id}` that is
  `done` with inlined responses settles it; one that names a `responsesFile`
  links the file, and `GET /gemini/download/v1beta/files/{f}:download` settles it.
  Lines are priced like interactive Gemini calls (cache, thoughts, modality and
  long-context rules) at `batch.gemini` 0.5; error lines are $0. Cancel
  (`POST …/batches/{id}:cancel`) and `DELETE …/batches/{id}` are $0 and never pause;
  a failed, cancelled or expired batch with no output stays pending (unknown).
  With `--preflight`, an inline Gemini create is estimated as the sum of each
  request's worst case x 0.5; a file-input create passes unestimated.
  Not covered: Gemini batch embeddings (`:asyncBatchEmbedContent`), Vertex batch
  prediction, OpenRouter batches, and polling the provider (costcap only sees
  results you fetch through it).
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
  calls. A stream also counts as cut if it ends without its provider's final
  event, even when early usage was seen: Anthropic without `message_stop` (or
  with a mid-stream `event: error`), Gemini without a `finishReason`, OpenAI
  Responses without `response.completed`/`incomplete`/`failed`. Timeouts match the official SDKs: the proxy waits up to 600s for the
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

### Check metered spend against the provider bill

`reconcile` needs per-receipt charges, which no provider export has. `bill-check`
compares daily aggregates instead: CostCap's metered spend (receipts plus
`reconcile --apply` settlements) against the OpenAI Costs API
(`/v1/organization/costs?group_by=line_item`) or the Anthropic Cost Report
(`/v1/organizations/cost_report`), per UTC day and model:

```sh
costcap bill-check --receipts .costcap/receipts.jsonl --provider openai \
  --provider-export costs.json --since 2026-11-01 --until 2026-11-15 --tolerance-pct 5 [--json]
# or fetch it (admin key from env only, never argv; redirects are never followed):
COSTCAP_OPENAI_ADMIN_KEY=... costcap bill-check --receipts ... --provider openai --fetch --since 2026-11-01
```

Each day/model row has `metered_usd`, `billed_usd`, `delta_usd`, `delta_pct` and a
status (`match`, `over_metered`, `unmetered_spend`, `metered_only`, `billed_only`,
`incomplete`). Line items that don't map to a model are listed under `unmapped`
with their USD, never dropped. Unknown-cost receipts are counted as
`unknown_count` and make the verdict `incomplete`; they are never $0. Verdicts:
`match` (exit 0), `over_metered` (pricing drift), `unmetered_spend` (possible
bypass traffic) and `incomplete` (exit 1); usage errors exit 2. A settled batch is
attributed per model from its results (#226): the `batch_results` settlement (and a
`reconcile --apply` charge with a `by_model` object) records `by_model` with each
succeeded line's model, so a mixed-model batch splits across model rows; the day is
the batch create day, as with budgets. Older settlements without `by_model` stay
under model `unknown`. `--project` /
`--workspace` filter the export; filtering needs the export grouped by project
(`group_by=project_id`) or workspace (`group_by[]=workspace_id`), because the
providers report the id as `null` otherwise. `--fetch` adds that grouping
automatically; a `--provider-export` file with no project/workspace ids exits 2
and asks you to re-export grouped. If the filter matches no billed rows while the
export has rows in the period (a mistyped id, or Anthropic's default workspace,
reported as `null`), the output says `filter matched no billed rows` and the
verdict is `incomplete` (exit 1), not `over_metered`. Samples: `docs/fixtures/openai-costs.sample.json`,
`docs/fixtures/anthropic-cost-report.sample.json`.

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

**Per-agent caps on `POST /v1/agents/:id/policy` (#175):** `caps` (`run`, `hour`, `day`, `month`) replaces the whole caps object, so a key you leave out is removed; omitting `caps` keeps the saved caps. The dashboard agent card shows Per run / Per hour / Per day / Per month and its "Save caps" always sends every key, so an API-set `caps.hour` survives a save that only changes models or steps; clearing a field removes that cap.

Enrolled agents can also get a fleet step budget: an admin sets "Max steps per run" in the dashboard (`maxSteps` on `POST /v1/agents/:id/policy`). The wrapper enforces it per run from its cached policy, even offline. A local `--max-steps` can tighten it, never loosen it.

### Model allowlist

Pin an agent to the models it may call: `costcap wrap --models gpt-4o-mini,claude-haiku-4-5 -- node agent.js` (exact ids, comma separated). The model is read from the request before it is forwarded (JSON `model` for OpenAI, OpenRouter and Anthropic; `models/<id>:generateContent` in the Gemini path). A disallowed model, or a request whose model can't be determined, gets `403 {"error":"model_not_allowed","model":...}` and is never sent upstream, streaming included. A zero-cost receipt with `outcome: "blocked_model"` is written and the run is not frozen, so the next allowed call still works.

On OpenRouter, every entry of a `models` fallback array is checked too (OpenRouter may route to any of them): the first disallowed entry is named in the 403, and a `models` value that is not an array of model id strings gets `400 invalid_models`. `openrouter/auto` is refused whenever an allowlist is set, unless `openrouter/auto` itself is listed. `--preflight` budgets at the priciest candidate.

`--unknown-models refuse` refuses any model that is not in the pricing table (`403 model_unpriced`), even without `--models`. The default (`fallback`) keeps pricing unknown models at the declared fallback rate.

The same `models: [...]` limit works in a `--policy` file (`default`, `agents.<id>`, `teams.<id>`) and on the hosted per-agent policy (`models` on `POST /v1/agents/:id/policy`, or "Allowed models" in the dashboard; `null` clears it). Enrolled wrappers enforce the synced list offline. All lists combine as an intersection, so the most restrictive wins; an empty intersection refuses every call. `costcap check --models ...`, `agent-status` and the MCP budget tools report `allowed_models`; `check` also reports `blocked_model_count`. Receipts CSV exports and `/v1/evidence.json` carry an `outcome` column.

An agent entry replaces the default. An agent with no entry and no default is
refused (`no_budget_policy`).

Usage is known only when the provider's required token counters are present as
finite numbers: prompt/input **and** completion/output for OpenAI and OpenRouter,
`promptTokenCount` **and** `candidatesTokenCount` for Gemini. An empty usage
object, or a duration-shaped one outside the OpenAI audio routes below, is recorded as
`cost_usd: null`, `reason: "usage_unavailable"`, and pauses the run. It is never
zero-filled to $0.

**OpenAI audio (#198).** `POST /v1/audio/transcriptions` and `/translations` send
`multipart/form-data`; CostCap reads only the `model`, `response_format` and `stream`
text parts (256 bytes each) and forwards the upload byte-for-byte, so `--models` and
`--unknown-models refuse` work on them. Two `model` parts get `400 invalid_model`
with no upstream call. Pricing, from the verified table:

| Model | Billed | Receipt |
|---|---|---|
| `whisper-1` ($0.006/min), `gpt-transcribe` ($0.0045/min) | `usage.seconds`, else verbose_json `duration` rounded up to a whole second | `cost_basis: "duration"`, `billed_seconds` |
| `tts-1` ($15/1M chars), `tts-1-hd` ($30/1M chars) | request `input`, counted in Unicode code points | `cost_basis: "characters"`, `billed_characters` |
| `gpt-4o-transcribe`, `-diarize`, `gpt-4o-mini-transcribe`, `gpt-4o-mini-tts` | token usage (JSON, or SSE `transcript.text.done` / `speech.audio.done`) | token receipt |

Unknown stays unknown and pauses the run: a `text`/`srt`/`vtt` reply with no
duration, a binary `gpt-4o-mini-tts` reply, an unpriced model (audio tokens on an
unknown `*-transcribe` model are `modality_unpriced`), or a per-minute model that
returns only token usage (`unit_unpriced`). Audio has no preflight estimate, and
`--prices` / `--upstream-prices` cannot override the per-minute or per-character units. Real explicit zeros still record a known $0. The proxy never
follows a provider redirect, so your API key is not sent to another host. A 3xx
returns 502 `upstream_redirect` to the client, with a $0 receipt because nothing
was generated. A missing, negative, non-finite or non-numeric OpenRouter
`usage.cost` falls back to table/fallback pricing, never $0, and `usage.cost`
without the token counters is still `usage_unavailable`.

Provider-side tools are priced per call, never silently free (#214). The
pricing table's `tools` section carries the published rates: Anthropic
`server_tool_use.web_search_requests` at $10 per 1,000 searches (also Claude on
Vertex AI, regional and global, without the 1.1× regional token multiplier;
Claude on Bedrock stays unpriced until a rate is published, #222), OpenAI
Responses `web_search_call` at $10 per 1,000 (`web_search` tool, and
`web_search_preview` on gpt-5 / o-series) or $25 per 1,000
(`web_search_preview` on gpt-4o / gpt-4.1), and `file_search_call` at $2.50 per
1,000. The receipt adds `tool_calls` (for example `{"web_search": 3}`) and
`tool_cost_usd`, and `cost_usd` is tokens plus tools, so search spend counts
toward every cap. In batches the 50% discount applies to tokens only; tool
calls bill at the full rate. The OpenAI web search type comes from the
request's `tools`; background receipts (settled on the terminal GET) use the type
recorded at create time or the Response object's echoed `tools`, and batch
receipts use each result line's Response `tools`. Only when none names a type
does the higher rate apply (#219). With `--preflight`, an Anthropic or Vertex Claude web search tool
that sets `max_uses` adds `max_uses × rate` to the worst case. Override a rate
with a top-level `tools` map in the `--prices` / `--upstream-prices` file, for
example `{"tools": {"web_search": 0.008}}` (keys `web_search`,
`web_search_preview`, `file_search`; USD per call, > 0); such receipts are
marked `cost_source: "user_prices"`. Any other per-call counter (for example
`web_fetch_requests`), a model family the table does not list, or a tool on a
route without a rate (OpenRouter, Bedrock, Vertex, custom upstreams) is still
recorded as `cost_usd: null`, `reason: "tool_use_unpriced"`, and the run pauses
until you reconcile it. Gemini
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

**Team alerts:** each alert sweep checks every team against its own day and month caps. At 80% of a cap (default 80%, configurable per agent/team) it raises `cap_approaching`, and at 100% it raises `cap_hit` (keys `cap_approaching:team:<orgId>:<name>:<scope>` and `cap_hit:team:<orgId>:<name>:<scope>`). A member receipt blocked with `scope: "team:<name>:<scope>"` in the last hour also raises that team's `cap_hit`, even when synced totals lag. A team with unknown cost raises no cap alert. Team alerts fire once, re-arm after the condition clears, go to the org's alert destinations, and carry `team`, `scope`, `cap` and `spent`. Deleting the team deactivates them.

**Warning fractions (hosted):** `cap_approaching` defaults to 80%, configurable per agent/team. Set `warnFractions` on `POST /v1/agents/:id/policy` or `POST /v1/teams` (or "Warn at (%)" in the dashboard), e.g. `[0.5, 0.8, 0.95]`: 1-5 unique fractions between 0 and 1, stored sorted. Omitted keeps the saved value, `null` resets to the default, and `[]` turns `cap_approaching` off (`cap_hit` still fires). Each sweep fires the highest crossed fraction, at most once per UTC day/month cap period; a jump past lower fractions covers them. The 0.8 key stays `cap_approaching:<id>:<scope>`; others append `:p<pct>` (e.g. `:p95`), and the alert carries `fraction`. Raising a cap re-arms only fractions whose threshold moves above current spend. Wrappers ignore `warnFractions`.

**Run alerts (hosted):** set a per-run cap (`caps.run`, "Per run" on the agent card) and each alert sweep checks every run synced in the last hour by `run_id`. At the warning fraction (default 80%) it raises `cap_approaching` keyed `cap_approaching:<id>:run:<runId>`, and at the cap `cap_hit:<id>:run:<runId>`, each at most once per run. Unknown cost is never $0: an all-unknown run raises nothing, a partial one alerts on known spend with `lower_bound: true`. A blocked run receipt with the same `run_id` does not page twice. Alerts carry `run_id` in the dashboard and `/v1/evidence.json`.

## Model downgrade

Degrade, don't die: past a fraction of a cap, a wrapped agent's expensive model calls go upstream on a cheaper model instead of stopping at 100%.

```sh
costcap wrap --day-cap 10 --downgrade gpt-4o=gpt-4o-mini,claude-opus-4-1=claude-sonnet-4-5 --downgrade-at 0.8 -- node agent.js
```

- **Trigger:** the first run/hour/day/month scope whose spend is at or above `F` (default `0.8`, 0 < F ≤ 1) of its cap. That can be a local cap, a `--policy` agent or team budget, or an enrolled fleet agent or team cap. Unknown cost is never counted as $0: known spend is a lower bound and still triggers.
- **Rewrite:** only the JSON `model` field changes, on the openai, anthropic, openrouter and custom `--upstream` routes (streamed requests included). Under `F`, requests are byte-identical. The allowlist, `--unknown-models refuse`, preflight, tag caps and the cache key all see the new model. A disallowed or unpriced target is refused as usual, never sent as the original. An unpriced `--downgrade` target exits `2` at wrap start.
- **Not rewritten:** Gemini (model in the path), Bedrock/Vertex, batches, multipart audio and OpenRouter `models[]`. These pass through unchanged, with receipt `downgrade: "unsupported_route"`.
- **Records:** the receipt has `model: TO`, `requested_model: FROM` and `downgrade: {scope, fraction}`, and the response carries `x-costcap-model-downgraded: FROM->TO`. One `{"event":"model_downgrade"}` ledger line and one stderr line are written per scope and period, never counted as spend. The run summary and `costcap runs` show `downgraded_calls`.
- **Hard stop:** at 100% the cap still refuses. A downgrade never raises or bypasses any cap.
- **Fleet:** `downgrade: {at, map}` on `POST /v1/agents/:id/policy` ("Downgrade models" / "Downgrade at (%)" on the agent card; `null` clears it). A bad fraction, an empty map or FROM equal to TO returns `400`. Enrolled wrappers use the cached map offline. Local `--downgrade` can only add models the fleet does not map, and local `--downgrade-at` can only lower `at`.

## Rate limits

Cap how fast a wrapped agent may call the model, independent of dollars:

```sh
node src/cli.js wrap --rpm 60 --tpm 200000 -- node your-agent.js
```

- **Where:** `--rpm N` / `--tpm N` (positive integers), `rpm`/`tpm` on `default` or an agent in a `--policy` file, or "Requests/min" / "Tokens/min" on the dashboard agent card (`rpm`/`tpm` on `POST /v1/agents/:id/policy`, audited as `policy.change`). The minimum of all three applies, so a local value can tighten a fleet value but never loosen it. The cached fleet value is enforced offline.
- **Window:** rolling 60 s, per wrapper process (not shared across `--shared-ledger` wrappers or the fleet).
- **RPM** counts requests admitted to the upstream; the slot is reserved before forwarding, so a concurrent burst cannot overshoot. GET/HEAD, cache hits and calls CostCap refuses do not count. A call the provider rejects (including its own 429) does count.
- **TPM** adds the metered tokens (input + cached input + cache writes + output) when a call completes. It is checked before each call, so one in-flight call can overshoot it. Unknown usage adds 0 tokens.
- **Refusal:** CostCap never queues. It returns `429` with `Retry-After` (seconds, at least 1) and `{error:{type:"rate_limited", source:"costcap", limit:"rpm"|"tpm", limit_value, observed, window_s:60, retry_after_s, message}}`, which the OpenAI and Anthropic SDKs retry. Each refusal writes a $0 `blocked:true, reason:"rate_limited"` receipt. It never latches and never counts toward `maxSteps`, velocity, spiral, caps or alerts.

## Soft warnings

`wrap` and `check` warn before the hard stop. By default, a warning fires when run, day or month spend reaches 80% of its cap:

```sh
costcap wrap --day-cap 10 --warn-at 0.5,0.8 -- node agent.js
# costcap: warning: day spend $8.0123 is 80% of $10 cap (2026-11-16 UTC)
```

- `--warn-at F[,F...]` takes fractions with 0 < F < 1. The default is `0.8`, and `--warn-at off` disables warnings. A bad value exits `2`.
- The first time a capped scope crosses a fraction, `wrap` prints one stderr line and appends one ledger event: `{"event":"cap_warning","scope","fraction","cap","spent_usd","period","run_id","agent_id","lower_bound"}`. Warnings are deduped per scope, fraction and period (`run_id` for run, the UTC `YYYY-MM-DD` for day, `YYYY-MM` for month), so a second wrap on the same day does not warn again. The run summary lists them under `warnings`.
- Warnings never block a call and are never spend. Receipts, runs and check totals ignore `cap_warning` lines.
- `wrap` also checks once at startup: a fraction already reached (including from a cached fleet cap) warns once if this period has no matching `cap_warning` yet.
- When a scope has an unknown-cost receipt (a pending batch included), its spend is a lower bound: `lower_bound: true`, and the stderr line says "(lower bound)". Unknown cost is never counted as $0.
- `costcap check` adds `warnings: [{scope, fraction, cap, spent_usd, lower_bound}]` without changing `ok`. With `--github-output`, it also writes a `warnings` output (for example `day:0.8,month:0.5`) and a warnings row in the job summary.

## Response cache

`costcap wrap --cache TTL` (off by default; `30s`, `10m`, `24h`, `7d`, at most `7d`) answers repeated identical deterministic requests from a local disk cache. A hit makes no upstream call, costs $0, and still writes a receipt: `{cost_usd: 0, reason: "cache_hit", cache: "hit", saved_usd, cache_source_receipt}`.

- **Cached:** `POST` non-streaming generation requests whose JSON body sets `temperature` (Gemini: `generationConfig.temperature`) to exactly `0`, and embeddings requests. Only a `2xx` response with a known, numeric `cost_usd` is stored.
- **Never cached** (`x-costcap-cache: bypass`): streams (`stream: true`, `:streamGenerateContent`, `alt=sse`, any `text/event-stream` response), batches, Files, count-tokens, GET/HEAD and `n > 1`. Provider errors, unknown or unpriced cost `batch_pending` and `background_pending` responses are never stored.
- **Key:** SHA-256 of provider, upstream, method, path and query, the exact body bytes, `anthropic-version`, `anthropic-beta`, `openai-organization`, `openai-project`, and a hash of the API key headers and any `key=` query value. Different keys never share entries.
- **Order:** the lookup runs after every check (kill file, caps, allowlist, preflight, breaker, spiral). A hit never bypasses a refusal. Hits count toward `--max-steps` and policy `maxSteps`, never toward velocity spend, caps, alerts or billing.
- **Storage:** `--cache-dir DIR` (default `<ledger-dir>/cache`, mode `0700`, entries `0600`). `--cache-max-mb N` (default 256) evicts least recently used entries; a response over 1/10 of the cap is not stored. Entries hold status, content-type, response body, model, original cost, source receipt id and a timestamp. They never hold request bodies, headers or keys. Delete the directory to purge.
- **Per call:** send `x-costcap-cache: bypass` to skip lookup and store. CostCap always strips the header before forwarding. Responses carry `x-costcap-cache: hit|miss|bypass`.
- **Reporting:** the run summary gains `cache: {hits, misses, saved_usd}`, the roll-up line adds ` · cache: N hits, saved $X`, and hosted `/v1/spend` reports `cache_hits` and `saved_usd` per bucket and in the total.

Cached answers can be stale for up to the TTL. Use a short TTL, or the bypass header, where freshness matters.

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
receipt file, not one reconstructed run. `--day-cap` and `--month-cap` use UTC. `--hour-cap USD` is a rolling 60-minute window (spend with `now - 60min < ts <= now`): it never latches, a refusal is a 429 `budget_exceeded` with `scope: "hour"`, `retry_after_s` and a `Retry-After` header, and policy files (`hour` on `default`, agents, teams) and fleet `caps.hour` accept it too (a policy `hour` refusal also carries `retry_after_s` and `Retry-After`, from the agent's or the team's pooled spend; #177); the tighter of local and fleet wins.
### Cost attribution tags

Label spend for chargeback with `costcap wrap --tag feature=search --tag env=prod -- <command>`
(repeatable), or per request with the header `x-costcap-tag: customer=acme[,k=v]`. Keys match
`[a-z0-9_.-]{1,32}`, values are 1-64 printable characters, at most 10 tags. Wrapper tags win
on a key clash, so the agent cannot relabel what the operator set. The header is always removed
before the request reaches the provider. A malformed header gets `400 invalid_tags` and a $0
receipt; the call is not forwarded and later calls are not blocked. Every receipt for a tagged
request carries `tags`. Filter with `costcap receipts --tag customer=acme`; both CSV exports have
a `tags` column (`k=v;k=v`, sorted). Hosted: `GET /v1/spend?group_by=tag&tag_key=customer`
returns one bucket per value plus `(untagged)`, and the dashboard Spend card has a "By tag" field.

#### Per-tag spend caps

`--tag-cap KEY:SCOPE=USD` (repeatable; `SCOPE` is `hour` (rolling 60 min), `day` or `month`, UTC)
gives every value of `KEY` its own cap. One runaway end customer is stopped while the rest keep working:

```bash
# SaaS: each customer (x-costcap-tag: customer=acme) gets $5 a UTC day and $50 a month.
costcap wrap --tag-cap customer:day=5 --tag-cap customer:month=50 -- node server.js
```

Requests without `KEY` share the `(untagged)` bucket, which has the same cap, so a missing header
never bypasses it. Caps use the merged tags (wrapper `--tag` wins). Once a value's spend (ledger
history, live receipts, settlements and `--shared-ledger` siblings) reaches its cap, the call is not
forwarded: `429 {"error":"tag_budget_exceeded", tag_key, tag_value, scope, spend_usd, cap_usd}`
(plus `retry_after_s` and `Retry-After` for `hour`) and a $0 blocked receipt with the tags. The
refusal never latches: other values, and this value once its window rolls over, keep going. An
invalid key, the `run` scope, a cap that is not `> 0` or a duplicate `KEY:SCOPE` exits 2 before
anything is spawned. `costcap check --tag-cap customer:day=5` exits 1 when any value is at or over
its cap and lists them in `tag_caps: [{key, value, scope, spend_usd, cap_usd, verdict}]` (Action
input `tag-caps`, output `tag-caps`).

#### Fleet tag caps (hosted)

An org owner or admin can set up to 10 fleet-wide tag caps in the dashboard's
**Tag caps** card, or with `PUT /v1/tag-caps` and a body like
`{"tagCaps":[{"key":"customer","scope":"day","usd":5}]}`. The scope is `day` or
`month` (UTC). Viewers can read the rules but can't change them. Each change is
audited as `tag_caps.change`, with the rules before and after.

Every enrolled `costcap wrap` gets the rules in `GET /v1/policy` (`tag_caps`), together with the
org's synced, settled-aware spend per tag value for the current UTC month. It
enforces each rule against that spend plus its own unsynced receipts. A value at
or over its cap gets `429 tag_budget_exceeded` with `"fleet": true`. A value with
an unknown-cost receipt gets `accounting_unavailable`, and only that value is
refused. A local `--tag-cap` on the same `KEY:SCOPE` can tighten a fleet rule but
never loosen it. Offline, the wrapper keeps enforcing the last rules and spend it
received. Removing a rule takes effect at the next successful poll. The payload
lists at most 1000 values per key. When the list is truncated, an unlisted value
counts at the lowest listed month spend, an upper bound, so the cap is never
under-counted. Not covered yet: the `hour` scope, per-tag alerts, per-team or
per-agent tag caps, and `--preflight` against fleet tag remainders.
With `--preflight`, a call whose estimated worst case exceeds a matching value's remaining budget
(including `(untagged)`) is refused the same way, with `reason: "preflight_estimate"`, `estimate: true`,
`estimate_usd` and `remaining_usd`, before any upstream call.

With `--run-id ID` (Action input `run-id`), `--cap` counts only receipts whose
`run_id` is `ID`; output adds `run_id`, `scope: "run"` and separate
`run`/`day`/`month` totals, while day/month caps still cover the whole ledger.
Unknown cost inside the run exits 1 (`accounting_unavailable`); unknown cost in
another run only affects day/month caps. A pending batch (`batch_pending`) in
any run makes hour/day/month caps fail with `batch_pending` until it settles
(`ledger_pending_batch_count` reports it); a run-only `--cap` gate is
unaffected by another run's batch. A run id with no receipts exits 2.
List run ids with `costcap runs`.
List and export local receipts with `costcap receipts [--since 14d|24h|ISO] [--until ISO] [--agent ID] [--run-id ID] [--tag KEY=VALUE] [--json] [--export csv] [--receipts FILE]`
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

## PR cost diff vs main

`costcap summary --json` writes a stable, versioned summary of a receipt ledger (total, calls, tokens, per model, per tag). `costcap diff --baseline base.json --current head.json [--max-increase-pct N] [--max-increase-usd N] [--markdown]` shows the $ and % change and exits 0 (ok), 1 (`cost_regression`) or 3 (`accounting_unavailable`: the current run has unknown cost, so the deltas are lower bounds, shown as "≥"). If only the baseline has unknown cost, the verdict carries a `baseline_incomplete` warning and the % gate is skipped. A $0 baseline reports `+∞%`.

The Action does the same with `baseline`, `max-increase-pct`, `max-increase-usd` and `summary-out` inputs, and adds the `delta-usd`, `delta-pct`, `baseline-usd` and `diff-markdown` outputs. Without `baseline`, its outputs are unchanged. Two-job workflow (also at `docs/examples/cost-diff.yml`, checked by `actionlint`):

```yaml
name: agent cost diff
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
  actions: read
  pull-requests: write
jobs:
  baseline:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./run-agent-evals.sh # your agent, wrapped with: costcap wrap --receipts .costcap/receipts.jsonl -- ...
      - uses: persooninc/costcap@<sha>
        with:
          receipts: .costcap/receipts.jsonl
          cap: '20'
          summary-out: costcap-summary.json
      - uses: actions/upload-artifact@v4
        with:
          name: costcap-baseline
          path: costcap-summary.json
  diff:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./run-agent-evals.sh
      - uses: dawidd6/action-download-artifact@v6
        with:
          workflow: cost-diff.yml
          branch: main
          name: costcap-baseline
          path: baseline
      - id: costcap
        uses: persooninc/costcap@<sha>
        with:
          receipts: .costcap/receipts.jsonl
          cap: '20'
          baseline: baseline/costcap-summary.json
          max-increase-pct: '25'
          max-increase-usd: '1'
      # Optional: post the table yourself (CostCap never calls the GitHub API).
      - if: always() && steps.costcap.outputs.diff-markdown != ''
        env:
          GH_TOKEN: ${{ github.token }}
          BODY: ${{ steps.costcap.outputs.diff-markdown }}
          PR: ${{ github.event.pull_request.number }}
        run: gh pr comment "$PR" --body "$BODY"
```

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

**Run outcomes and wasted spend (#225).** When an enrolled `costcap wrap` ends, it syncs one run-end record (`run_id`, `started_at`, `ended_at`, `exit_code`, `stop_reason`, `calls`, `usd_known`, `unknown_count`) to `POST /v1/runs/end`, idempotent by agent and run. `stop_reason` is `exited`, `cap_hit`, `kill_switch`, `spiral`, `velocity`, `step_budget` or `signal:<NAME>`. The outcome is `success` (exit 0, `exited`), `failure` (non-zero exit, `exited`), `killed` (any guardrail or kill stop) or `unknown` (no record). An older server without the route is skipped and the record is retried on the next sync. `POST /v1/agents/:id/runs/:run_id/outcome {outcome: success|failure, note?}` overrides it (the agent's own token, a member or an admin/member API key; viewers get 403) and is audited as `run.outcome`. Runs gain `ended_at`, `exit_code`, `stop_reason`, `outcome` and `outcome_override`. `GET /v1/spend?group_by=outcome` (and `/v1/spend.csv?group_by=outcome`) splits spend into the four outcomes, each with `runs` and `lower_bound` (unknown cost is never $0); the CSV appends `runs,lower_bound` columns for `group_by=outcome` only. Spiral-breaker blocks count as `spiral` and tag-cap blocks as `cap_hit`, so those runs are `killed` even if the child exits 0. A run-end that arrives after an early override is still recorded, and the override stays in effect. Each agent card shows "Failed/killed runs (30d)" with its share of spend and "Cost per successful run" (`≥` when a successful run has unknown cost, `—` with no successes). `costcap runs` prints `outcome=` per run. The outcome is only the exit code, stop reason or override; it never grades task quality.

`GET /v1/evidence.json` (signed-in session, scoped to your org) returns a `costcap.evidence/v1` document for ShipReady Metrics. It holds per-agent caps, day/month known spend, unknown-cost counts, active alerts, receipts (with `blocked`, `reason` and `scope`), and an `audit` trail: every org audit entry oldest first with `ts`, `actor`, `action`, `target` and `detail`. A `policy.change` entry carries `detail.previous` (caps, `killed`, `maxSteps`, `models` before the change) and `detail.policy` (after); fleet freeze/resume entries carry `reason` and `agent_ids`. A receipt with unknown cost keeps `cost_usd: null`. It is never counted as $0, and `cost_complete` is false whenever any cost is unknown. Sample: `docs/fixtures/srm-evidence.sample.json`.

**Settling an unknown cost (hosted, #125).** An owner or admin can settle an unknown-cost receipt with an audited value from provider evidence: the dashboard's *Unknown-cost receipts* card, or `POST /v1/receipts/:id/settle` with `{cost_usd, source, reason}` (`source` is `provider_invoice`, `provider_usage_export` or `manual_evidence`; pass `agent_id` if two agents share a receipt id). The receipt keeps `cost_usd: null` and gains `settled_cost_usd`, `settled_at`, `settled_by`, `settle_source` and `settle_reason`. Fleet spend, agent and team verdicts, alerts and evidence then use the settled cost in the receipt's original window; `unknown_cost_receipts` counts only unsettled receipts. A known or already-settled receipt returns 409 (`already_known` / `already_settled`). Each settlement writes one `receipt.settle` audit entry (`event: "reconciliation"`, before `null`, after the value). No provider billing API is called.

**Alert lifecycle (#143).** Each firing is its own alert occurrence with `id`, `key`, `fired_at`, `resolved_at` (null while active), `acknowledged_at` and `acknowledged_by`. When the condition clears, `resolved_at` is set and the record is kept; a later firing of the same key is a new occurrence. `GET /v1/alerts?status=active|acknowledged|resolved|all&since=&until=` (any member, org-scoped; `since`/`until` filter on `fired_at`) lists them, active first. `POST /v1/alerts/:id/ack` (owner or admin; viewer 403, other org 404) sets `acknowledged_at`/`acknowledged_by` once and writes one `alert.ack` audit row; acknowledging never resolves an alert or re-delivers it. `/v1/evidence.json` alerts carry the same lifecycle fields for all occurrences. Records stored before #143 keep `fired_at: null` (unknown, never invented).

**Alert destinations.** `GET /v1/alert-settings` (any member) returns the org's alert emails and the Slack webhook masked (`https://hooks.slack.com/services/…` + last 4). `POST /v1/alert-settings` (owner or admin) takes `{ "emails": [...verified member emails], "slackWebhook": "https://hooks.slack.com/services/..." | null }`; an omitted field keeps its value. Each org's alerts go only to its own destinations; changes are audited as `alert_settings.change` with masked values.

**Signed webhook.** Owners and admins can also set one generic HTTPS endpoint per org: `POST /v1/alert-settings` with `{ "webhook": "https://alerts.example.com/costcap" }` (or `null` to remove), and `{ "rotateWebhookSecret": true }` to issue a new signing secret. CostCap generates the secret and returns it in full only in that create or rotate response, as `webhookSecret`. Everywhere else it is masked (`whsec_…` + last 4), and the URL shows only its origin. The URL must be `https` on port 443, with no credentials and no IP literal or `localhost`/`.local`/`.internal` host. It must also resolve to a public address, and it is checked again at every send. Redirects are refused, and each send times out after 5s. Every hosted alert is POSTed once as JSON with `id` (the alert occurrence, use it for idempotency), `kind`, `org_id`, `agent_id`, `agent_name`, `team`, `run_id`, `scope`, `period`, `fraction`, `spent_usd`, `cap_usd`, `unknown_count` (null when not known, never 0), `fired_at` and `dashboard_url`. Retries are per channel (email, Slack, webhook): a non-2xx response, a timeout or a send error retries **only that channel** for that alert occurrence, with backoff of 1, 2, 4, 8, 16, then 30 minutes between attempts and at most 10 attempts per channel. After that the channel is marked `gave_up` and one `alert.delivery_gave_up` audit row is written. A channel that answered 2xx (or accepted the email) is never resent for that occurrence, even while another channel is still retrying; it fires again only when the alert clears and re-arms as a new occurrence. A channel configured after the alert fired is not back-filled for that occurrence. Each queued send holds a 2-minute claim (`delivery_claimed_at`), so overlapping sweeps never page twice. An alert interrupted by a restart (deploy, SIGTERM, crash) mid-send stays `pending`; the first sweep after the claim expires re-sends every channel (counted toward the 10-attempt cap) and writes an `alert.delivery` audit row with `recovered: true`, so webhook consumers should dedupe on `id`. The alert's `delivery` field is `accepted` when every configured channel accepted, otherwise `failed`; per-channel state is in `deliveryChannels`. Verify the `x-costcap-signature: t=<unix>,v1=<hex>` header:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verifyCostCap(secret, rawBody, header, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

### Org API keys

Scripts, CI, incident tooling and BI can call the hosted API with a revocable org key instead of a browser session. An owner or admin creates one in the dashboard's "API keys" card or with `POST /v1/api-keys` (session only, body `{ "name": "...", "role": "viewer" | "admin", "expires_at"?: "<ISO date>" }`). The response carries the full `cck_…` value once; CostCap stores only its SHA-256 hash. `GET /v1/api-keys` lists keys masked (`cck_…` + last 4) with status and `last_used_at`, and `POST /v1/api-keys/:id/revoke` revokes one. Create and revoke write `api_key.create` / `api_key.revoke` audit entries.

Send it as `Authorization: Bearer cck_…` (no `Origin` header is needed):

- **viewer**: `GET /v1/spend`, `/v1/receipts.csv`, `/v1/audit.csv`, `/v1/evidence.json`, `/v1/fleet`, `/v1/alerts`, `/v1/agents/:id/budget` and `/v1/agents/:id/runs`.
- **admin**: also `POST /v1/fleet/freeze|resume`, `/v1/agents/:id/policy|revoke`, `/v1/alerts/:id/ack` and `/v1/receipts/:id/settle`. Actions are audited with the key id as actor and `api_key:<name>` as its label.

A key can't create or revoke keys, issue enrollment tokens, or reach billing, members, invitations, roles or alert settings. A revoked, expired or unknown key gets `401`, a key only ever sees its own org, and a `cck_` key is never accepted as an agent token. Example, freezing the fleet from a CostCap alert webhook handler:

```sh
curl -X POST https://app.costcap.dev/v1/fleet/freeze -H "Authorization: Bearer $COSTCAP_API_KEY" \
  -H 'content-type: application/json' -d '{"reason":"cap_hit webhook"}'
```

### Fleet freeze (kill switch)

`POST /v1/fleet/freeze` and `POST /v1/fleet/resume` (owner or admin session, or an admin [API key](#org-api-keys), body `{ "reason": "..." }`, 1-500 characters) kill or revive the whole org's fleet. Freeze bumps the policy version of every non-revoked agent that is not already killed and sets `killed: true`. Repeating it while frozen is a no-op (`alreadyFrozen: true`). Resume only revives the agents that freeze killed, so an agent killed on its own stays killed. Each action writes one `fleet.freeze` / `fleet.resume` audit entry with actor, reason and agent ids; `POST /v1/agents/:id/policy` also accepts an optional `reason`. Wrappers apply the freeze at their next policy poll. It is not instant and does not undo requests already accepted. The dashboard has a "Freeze all agents" card with a required reason and a confirm step.

### Time-boxed cap raise requests

When an agent hits its cap mid-job, it (or a member) can ask for more budget for a while instead of someone editing the policy and forgetting to undo it:

```sh
costcap request-raise --scope day --amount 20 --hours 4 --reason "finish nightly batch" --enrollment .costcap/enrollment.json
```

That calls `POST /v1/agents/:id/cap-requests` with `{scope: run|hour|day|month, amount_usd, duration_hours 1-168, reason}`. The agent's own token, a member session or an org API key may file it; an agent token can only file for itself (any other id is `404`). The agent must already have a base cap for that scope. One request per agent per scope can be pending (`409` otherwise). `GET /v1/cap-requests?status=pending|approved|denied|expired|all` lists them for any member. An owner or admin approves or denies with `POST /v1/cap-requests/:id/approve|deny` (viewer `403`); approve may lower `amount_usd` or `duration_hours`. Approval appends an entry to the policy overlay `raise: { <scope>: [{ amount_usd, expires_at, request_id }, ...] }` and bumps the policy version. Raises on one scope **stack**: a second approved request while one is active adds its own entry, both apply together, and each expires on its own `expires_at`. The effective cap is computed at evaluation time as the **current** base cap plus the sum of active raise amounts, so lowering the base during a raise lowers the effective cap at once (verdict, alerts, evidence and wrappers). Base `caps` are never changed by a raise, and a later "Save caps" keeps active raises. Older overlays in the `{ cap }` form are migrated to `amount_usd` from the approved amount, so no in-flight raise grows. Every approved request whose `expires_at` has passed is marked `expired` and audited exactly once, and the card never shows it as active.

The raise applies only while `now < expires_at`: in the hosted verdict, `cap_hit`/`cap_approaching` alerts, and in wrappers, which revert to the base cap at expiry from their cached policy without contacting the service. A raise never lifts `killed`, a fleet freeze, a local `--cap` (the lowest value still wins), or team and tag caps. Unknown cost is still never counted as $0. Audit events `cap_request.create`, `.approve`, `.deny` and `.expire` carry the actor, before/after caps and the reason, and appear in `/v1/audit.csv` and `/v1/evidence.json` (which also lists `effective_caps` and active `raises` per agent). The dashboard's "Cap raise requests" card shows pending requests with Approve/Deny and active raises with their expiry.

### Budget period (hosted, #209)

By default hosted day and month caps reset at UTC midnight on the 1st. An owner or
admin can set the org budget period in the dashboard's **Budget period** card or with
`POST /v1/budget-period {"timezone":"America/Los_Angeles","monthStartDay":15}`
(`GET` for any member). `timezone` is an IANA zone and `monthStartDay` is 1-28; a bad
value returns `400`, a viewer gets `403`, and every change is audited as
`budget_period.change` with `before`/`after`. The period drives hosted agent, team and
tag caps, `cap_approaching`/`cap_hit` periods, `cap_projected` (elapsed share of the
configured month), `/v1/spend` day buckets and the agent cards. Enrolled wrappers get
it as `budget_period` in `/v1/policy`, so offline enforcement rolls synced spend over
on the same clock. Days follow local midnight across DST (a fall-back day has 25
hours). Out of scope: local `--day-cap`/`--month-cap` (still UTC), per-agent zones,
non-midnight resets.

`GET /v1/spend?since=&until=&group_by=day|model|agent` (any session role, including viewer) returns the org's synced receipt spend in buckets. Each bucket has `usd_known`, `calls`, `unknown_count`, `blocked_count` and `cost_complete`, plus a `total`. Days follow the org budget period (UTC unless set, see below) and the response reports `budget_period`. `since`/`until` take an ISO instant or `YYYY-MM-DD`; a date-only value is local midnight in the org budget-period timezone (UTC unless set), and a date-only `until` covers that whole local day (#215). Instead of `since`, `range=current_month|7d|30d` starts at the current budget-month start or at local midnight 6/29 days back; the response echoes `range`, the resolved `since` and `since_local` (the local start date). `/v1/spend.csv` accepts the same `range`. A `cost_usd: null` receipt adds to `unknown_count` and marks the bucket incomplete; it never adds $0. Once settled it counts at the settled value in its original bucket. With entitlements enforced, the period is clamped to the plan's receipt retention, and the response reports the clamped `since` with `retention_clamped: true`. An invalid `group_by`, `since` or `until` returns `400`. The dashboard's Spend card reads it with a 7-day, 30-day or this-month period.

**Team chargeback (#213).** `GET /v1/spend?group_by=team` returns one bucket per org team plus `(no team)`, each with a `label`, and `team_membership: "current"`: spend is allocated by today's team membership, not membership history. `GET /v1/spend.csv?group_by=team&period=month|day&since=&until=` (any member or viewer API key) downloads a finance summary with columns `period,group_by,key,label,usd_known,calls,unknown_count,cost_complete,blocked_count`, one row per budget period and group. It takes every `/v1/spend` `group_by`. In-band `# retention_clamped`, `# cost_incomplete` and `# team_membership` lines precede the header when they apply. The Spend card shows a By team section and a Download CSV link that follows the selected period.

**Prometheus scrape (#220).** `GET /v1/metrics` returns `text/plain; version=0.0.4` (Prometheus exposition format) for the caller's org. It takes an org API key (`Authorization: Bearer cck_…`, viewer or admin) or a member session; no key, or a revoked or expired key, gives `401`. Series: `costcap_spend_usd{agent,team,window}`, `costcap_spend_complete{agent,window}` (0 when the window has unsettled unknown-cost receipts, so spend is a lower bound), `costcap_unknown_cost_receipts{agent}`, `costcap_cap_usd` and `costcap_cap_remaining_usd{scope="agent|team",name,window}` (omitted when there is no cap), `costcap_alerts_open{kind,scope_name}` (active, unacknowledged; every alert kind), `costcap_agent_frozen{agent}`, `costcap_agent_last_sync_timestamp_seconds{agent}` and `costcap_metrics_truncated`. `window` is `day` or `month` of the org budget period, and receipts past the retention cutoff are excluded as in `/v1/spend`. `?by=model` adds a `model` label to `costcap_spend_usd`; past 5,000 series the per-model series are dropped, `costcap_metrics_truncated` is 1 and the agent totals stay complete. Every value is a **gauge for the current period, not a monotonic counter** (retention deletes old receipts), so use it directly rather than with `rate()`.

**Spend anomaly alerts (#223).** The alert worker raises `spend_anomaly` when an agent's (or a team's summed) spend today is at least `max(min_usd, multiplier × baseline)`, where the baseline is the median known daily spend over the previous 14 complete days in the org budget-period timezone. No cap is needed. Defaults: `multiplier` 3, `min_usd` 5; with fewer than 7 days of history it stays silent. It fires once per agent or team per local day (key `spend_anomaly:<agent_id>:<date>` or `spend_anomaly:team:<org>:<team>:<date>`) and resolves at the next local day boundary; it can be acknowledged like other alerts. Unknown-cost receipts are never $0: the alert fires on the known part with `lower_bound: true`, and baseline days with unknown cost set `baseline_lower_bound: true`. Settings: org default via `GET/PUT /v1/anomaly-settings` (`{enabled, multiplier 1.5-20, min_usd >= 0}`, owner/admin), per-agent `anomaly` on `POST /v1/agents/:id/policy` (omit keeps, `null` clears; also the dashboard's "Anomaly multiplier" fields, where `off` disables) and per-team `anomaly` on `POST /v1/teams`. Every change is audited as `anomaly.change` with before/after. Delivery uses the org destinations; the webhook payload adds `today_usd`, `baseline_usd`, `multiplier`, `top_models` (top 3 by spend today) and `lower_bound`. It pages only; it never freezes an agent.

**Weekly spend digest (#224).** Once a week the hosted service sends each org a digest to its own alert destinations: last ISO week's spend vs the week before (absolute and %), the top 5 agents, teams and models, cap headroom for the current budget period per capped agent/team, unsettled unknown-cost receipts and alerts fired by kind, plus a dashboard link. Unknown cost is never shown as $0: totals carry `lower_bound: true` and read "at least $X". Settings: `GET/PUT /v1/digest-settings` (`{enabled, weekday 0-6 (0 = Sunday, default 1), hour 0-23 (default 9), channels: email|slack|webhook}`, owner/admin write, any member reads, audited as `digest.settings`), in the org budget-period timezone. New orgs start on (email only); existing orgs start off. The send is at most once per org and week (ledger key `org:YYYY-Www`). A slot missed by a restart is sent within 24 h and otherwise skipped (`digest.skipped`). A failed channel is retried alone with the alert backoff; each send writes `digest.sent` with the outcome per channel. Email is plain text + HTML, Slack gets Block Kit, and the signed webhook receives `type: "costcap.digest"` with the same `x-costcap-signature` scheme as alerts. `GET /v1/digest/preview?week=YYYY-Www` (default: last week) returns the same JSON and text without sending; the dashboard's "Weekly spend digest" card edits the settings and previews it.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: costcap
    scheme: https
    metrics_path: /v1/metrics
    scrape_interval: 60s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/costcap.key   # a viewer cck_ key
    static_configs:
      - targets: [app.costcap.dev]
```

### Receipt retention (hosted, #211)

By default synced receipts are kept. An owner or admin can turn on deletion in the
dashboard's **Receipt retention** card or with `POST /v1/retention {"days":30}` (a
session is required; a viewer or an API key gets `403`). `days` is an integer from 7 to
the plan's `receiptRetentionDays` (365 when entitlements are not enforced), or `null`
to keep everything; anything else returns `400`. Each change is audited as
`retention.change` with `before`/`after`. Any member can `GET /v1/retention` for `days`,
`cutoff` and `eligible_count` (what the next sweep would delete).

A sweep runs at startup and then nightly. It permanently deletes that org's receipts (and
their settlements) with `ts` before the cutoff, and writes one `receipts.purge` audit
entry per org with `count` and `cutoff`. It never deletes receipts from the last 32 days,
the current UTC month or the org's current budget-period month, so cap, team and
projection totals do not change. It also never deletes unsettled unknown-cost receipts or
`batch_pending`/`background_pending` receipts. When a wrapper syncs a receipt that is
already past the cutoff, the receipt is listed in `acceptedIds` so the backlog drains, but
it is not stored, and the response reports `expired: n`. The audit log, alerts and the
local CLI ledger are not trimmed.
