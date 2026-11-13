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

**Remaining blocker:** live Stripe keys stay parked until Rajvir approves them. Live
enforcement of plan limits (`COSTCAP_ENTITLEMENTS=enforced`) and public pricing
(`COSTCAP_PUBLIC_PRICING=enabled`) are owner switches and stay off.

## Portable modules

| Module | Purpose | Public API | Deps |
|---|---|---|---|
| `src/billing/` (`index.js`, types in `index.d.ts`) | Plan catalog, free vs paid entitlement checks, billing env switches. Pure: no store, no request, no `process.env`, no Stripe calls. | `DEFAULT_PLANS`, `PAID_STATUSES`, `listPlans(catalog?)`, `isPaidStatus(status)`, `planForStatus(status, catalog?)`, `upgradePlan(catalog?)`, `entitlementsFor({ status, enforced, catalog })`, `checkLimit(ent, feature, used, adding?)`, `requireLimit(...)` (throws `EntitlementError`, status 402, JSON `body`), `resolveBillingConfig(env, { prefix })`, `priceLabel({ billing, stripeMode })` | None (Node 20+, ESM) |
| `src/hosted/billing.js` | Stripe Checkout adapters. `createStripeBilling` (live, account and $19 price readback) and `createTestModeStripeBilling` (refuses anything but `sk_test_`, grants only `livemode: false` objects). Both expose `status(orgId)`, `checkout(user)`, `portal(orgId)`, `webhook(raw, signature)`; `stripeHealth()` and `verifyStripeEvent()` are standalone. | as listed | `fetch` (injectable `fetchImpl`), a store with `read(fn)` / synchronous `transaction(fn)` over `{ orgs: { [id]: { billing } }, billingEvents }` |
| `src/hosted/onboarding.js` | First-run checklist state (token, enroll, first receipt). | `ONBOARDING_STEPS`, `onboardingState({ tokensIssued, agents, receipts })` | None |
| `scripts/release-check.mjs` | npm release preflight: required metadata, public access, github repository, bin shebang, tag equals `v<version>`, dist-tag (`latest` / `next` for prereleases). Pure core, CLI prints `version=` / `dist_tag=` for `$GITHUB_OUTPUT`. | `checkRelease({ pkg, ref?, fileExists?, readText? })` returns `{ ok, problems, version, distTag }` | None (Node 20+, ESM) |
| `scripts/pack-check.mjs` | Tarball allowlist (manifest, README, LICENSE, `src/`). | `reviewPack(paths)`, `readPackPaths()` | `npm` on PATH |
| `.github/workflows/release.yml` | Tag/dispatch npm release: dry run by default on dispatch, `NPM_TOKEN` fail-closed, provenance on GitHub-hosted runners, registry readback. Copy with the two scripts above; change the package name in the readback step. | Inputs: `publish` (dispatch). Secret `NPM_TOKEN`, variable `COSTCAP_RELEASE_RUNS_ON` | actions/checkout, actions/setup-node |

Porting notes: pass your own catalog to every `src/billing` call to change tiers;
`resolveBillingConfig(env, { prefix: "SRM_" })` reads `SRM_BILLING`, `SRM_STRIPE_MODE`,
`SRM_ENTITLEMENTS`, `SRM_PUBLIC_PRICING`. The host app counts usage
(see `planUsage` in `src/hosted/server.js`) and maps `EntitlementError.body` into its
error response.
