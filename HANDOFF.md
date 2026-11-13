# Handoff: costcap (root)

The long-form history lives in [docs/HANDOFF.md](docs/HANDOFF.md). This file tracks
modules meant to be ported into ShipReadyMetrics.

**Last item (2026-11-12): path to paid, Stripe test mode only.** Plan catalog and
entitlement checks (`src/billing/`), free-vs-paid limits on agent enrollment and
teammate seats (402 + upgrade hint), an onboarding checklist that ends at the first
synced receipt, and a `/pricing` page behind the `COSTCAP_PUBLIC_PRICING` owner gate
(off by default). Stripe Checkout, webhook and portal already existed in
`src/hosted/billing.js` (live and test-mode adapters).

**Item 2026-11-12 (#97): npm and Marketplace readiness, no publish.** Package metadata,
`scripts/release-check.mjs`, a tag/dispatch `release.yml`, `action.yml` branding, README
Install section and [docs/RELEASING.md](docs/RELEASING.md). Owner still has to create the
npm token, add `NPM_TOKEN`, push the first tag and list the Action.

**Batch 2026-11-13 (FA-CC-01..04, branch `integration/costcap-2026-11-12`):**
- FA-CC-01: verify-green deploys, SHA-match canary (plus `/cli` and trust pages), daily `prod-drift` alarm. Prod is ~758h behind and stays there until the runner `dev-home-01` picks up jobs and the owner sets `COSTCAP_STRIPE_MODE` in the host `.env`.
- FA-CC-02: `/privacy`, `/terms`, `/security`.
- FA-CC-03: Team $79 tier and plan-aware test-mode checkout. `/pricing` is on by default with a test-mode banner. The owner adds `COSTCAP_STRIPE_TEAM_PRICE_ID` (a test price).
- FA-CC-04: Postgres store adapter with RLS (absorbs #42). Cutover waits on persooninc/infra#69 being applied and the prod host reaching the LAN database ([docs/postgres.md](docs/postgres.md)).

**Remaining blocker:** live Stripe keys stay parked until Rajvir approves them. Live
enforcement of plan limits (`COSTCAP_ENTITLEMENTS=enforced`) and public pricing
(`COSTCAP_PUBLIC_PRICING=enabled`) are owner switches and stay off.

## Portable modules

| Module | Purpose | Public API | Deps |
|---|---|---|---|
| `src/billing/` (`index.js`, types in `index.d.ts`) | Plan catalog, free vs paid entitlement checks, billing env switches. Pure: no store, no request, no `process.env`, no Stripe calls. | `DEFAULT_PLANS`, `PAID_STATUSES`, `listPlans(catalog?)`, `isPaidStatus(status)`, `planForStatus(status, catalog?)`, `upgradePlan(catalog?)`, `entitlementsFor({ status, enforced, catalog })`, `checkLimit(ent, feature, used, adding?)`, `requireLimit(...)` (throws `EntitlementError`, status 402, JSON `body`), `resolveBillingConfig(env, { prefix })`, `priceLabel({ billing, stripeMode })` | None (Node 20+, ESM) |
| `src/hosted/billing.js` | Stripe Checkout adapters. `createStripeBilling` (live, account and $19 price readback) and `createTestModeStripeBilling` (refuses anything but `sk_test_`, grants only `livemode: false` objects). Both expose `status(orgId)`, `checkout(user)`, `portal(orgId)`, `webhook(raw, signature)`; `stripeHealth()` and `verifyStripeEvent()` are standalone. | as listed | `fetch` (injectable `fetchImpl`), a store with `read(fn)` / synchronous `transaction(fn)` over `{ orgs: { [id]: { billing } }, billingEvents }` |
| `src/billing/` Team tier (FA-CC-03) | Three hosted tiers (free, Solo `workspace` $19, Team $79) with `agents`, `seats`, `receiptRetentionDays` limits; plan-aware resolution and upgrade ladder. | `paidPlans(catalog?)`, `planForStatus(status, catalog?, planId?)`, `upgradePlan(catalog?, fromPlanId?)`, `entitlementsFor({ status, plan, enforced, catalog })`, `retentionCutoff(ent, nowMs)`; `resolveBillingConfig` adds `teamPrice` and `<P>PUBLIC_PRICING=disabled` | None |
| `src/hosted/billing.js` test mode (FA-CC-03) | `createTestModeStripeBilling({ ..., priceId, teamPriceId })` sells Solo and optional Team; `checkout(user, { plan })`; status returns `plan` and `plans`; a canceled subscription clears the plan. Live adapter sells Solo only. | as listed | as above |
| `src/hosted/trust.js` (FA-CC-02) | Privacy, terms and security pages as data (sections of plain text). The host renders and escapes them. | `TRUST_ROUTES`, `TRUST_UPDATED`, `DEFAULT_CONTACT`, `SECURITY_REPORT_URL`, `trustDocument(path, { operator?, contact?, product? })` returns `{ path, title, heading, description, lede, sections }` or `null` | None |
| `src/hosted/store.js` | Store interface plus the JSON file adapter. `memoryCore(initial, commit)` gives synchronous all-or-nothing transactions over in-memory state for any backend. | `openStore(path)`, `memoryCore(initial, commit)`, `EMPTY_STATE`; a store is `{ mode, read(fn), transaction(fn), flush(), healthy() }` | `node:fs` |
| `src/hosted/store-records.js` (FA-CC-04) | Pure state ⇄ row mapping with an org id on every record, and a diff for incremental writes. | `toRecords(state)`, `fromRecords(rows, empty)`, `diffRecords(prev, next)`, `recordOrg(kind, id, body)`, `META_KIND` | None |
| `src/hosted/store-postgres.js` (FA-CC-04) | Postgres adapter behind the store interface. Writes are RLS-scoped (`app.org_id` / `app.scope`), the read-only loader runs at startup, and flush-before-reply with retry. One replica. | `openPostgresStore({ connectionString? , pool?, max?, log? })` returns `{ mode: "postgres", read, transaction, flush, healthy, close }` | optional `pg` (or an injected pool with `connect()`) |
| `db/migrations/003_store.sql` + `scripts/db-apply.mjs` + `scripts/db-import-json.mjs` | `store_records` table with RLS policies, an ordered and recorded migration runner, and a one-time JSON-to-Postgres import into an empty DB. | `applyMigrations(client, { dir?, log? })`, `pendingMigrations(dir?, applied?)`, `importJsonStore(store, data)` | `pg` |
| `scripts/drift-check.mjs` + `.github/workflows/drift.yml` (FA-CC-01) | Prod-vs-main drift alarm, red after a grace window. Read-only, no secrets. | `driftDecision({ prodSha, mainSha, behindSinceMs, nowMs, graceHours })`, `behindSince(prodSha, mainSha, git?)`, `readProdSha(origin, fetchImpl?)` | `git` on PATH (CLI) |
| `scripts/canary.mjs` | Post-deploy canary: health (billing, persistence, sha), UI, config, the fleet auth wall, and public pages. | `canary(base, fetchImpl?, expectedSha?, expectedBilling?, { persistence?, pages? })`, `PUBLIC_PAGES` | `fetch` |
| `src/hosted/onboarding.js` | First-run checklist state (token, enroll, first receipt). | `ONBOARDING_STEPS`, `onboardingState({ tokensIssued, agents, receipts })` | None |
| `scripts/release-check.mjs` | npm release preflight: required metadata, public access, github repository, bin shebang, tag equals `v<version>`, dist-tag (`latest` / `next` for prereleases). Pure core, CLI prints `version=` / `dist_tag=` for `$GITHUB_OUTPUT`. | `checkRelease({ pkg, ref?, fileExists?, readText? })` returns `{ ok, problems, version, distTag }` | None (Node 20+, ESM) |
| `scripts/pack-check.mjs` | Tarball allowlist (manifest, README, LICENSE, `src/`). | `reviewPack(paths)`, `readPackPaths()` | `npm` on PATH |
| `.github/workflows/release.yml` | Tag/dispatch npm release: dry run by default on dispatch, `NPM_TOKEN` fail-closed, provenance on GitHub-hosted runners, registry readback. Copy with the two scripts above; change the package name in the readback step. | Inputs: `publish` (dispatch). Secret `NPM_TOKEN`, variable `COSTCAP_RELEASE_RUNS_ON` | actions/checkout, actions/setup-node |

Porting notes: pass your own catalog to every `src/billing` call to change tiers
(store the paid plan id next to the subscription status and pass it as `plan`);
`resolveBillingConfig(env, { prefix: "SRM_" })` reads `SRM_BILLING`, `SRM_STRIPE_MODE`,
`SRM_ENTITLEMENTS`, `SRM_PUBLIC_PRICING`. An unset `<P>STRIPE_MODE` resolves to `test`
(as do `stripeHealth()` and `createHostedServer()`); live is always an explicit switch. The host app counts usage
(see `planUsage` in `src/hosted/server.js`) and maps `EntitlementError.body` into its
error response.
