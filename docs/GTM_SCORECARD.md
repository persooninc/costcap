# CostCap GTM scorecard

Scored 2026-11-07 by Grok Build (grok-4.7 low). Scores are 1 (absent) to 5 (ready to send a stranger). Evidence is from this repo and public URLs fetched that day. Estimates are marked.

Company on customer-facing copy: Persoon.ai Inc. No personal names.

## 2. Time to value — 2/5

A new user can clone the public repo and run `node src/cli.js wrap` (README). They cannot `npx costcap`: `https://registry.npmjs.org/costcap` returned 404. The first screen at `https://costcap.dev/` (301 to `https://app.costcap.dev/`) is an email-code login plus a hidden workspace that offers "$19 USD per month". The structured data on that page says the offer price is 0. Ten minutes gets a local proxy only if they already have Node and a provider SDK that honors base-URL overrides. README states hardcoded endpoints bypass the proxy.

## 3. Offer shape — 4/5

Who pays: an organization that wants the hosted fleet (enroll, caps, alerts, CSV), not a CLI user. CLI stays free (MIT). Packaging in `src/hosted/ui.js`: one hosted workspace plan described as $19 USD per month when billing is enabled, cancel in the portal, viewers cannot buy. `docs/PATH_TO_FIRST_DOLLAR.md` calls $19 a hypothesis, not collected revenue. This audit does not set or change a price. No evidence here of a paid subscriber count.

## 4. Market / demand — 3/5

Demand is inferred from other vendors writing about runaway agent spend, not from CostCap customers (none are documented).

- LiteLLM documents hard budgets that need a database: [FrugalAI, 2026-10-05](https://frugalai.io/blog/litellm-vs-portkey), citing LiteLLM's own docs.
- Helicone and Langfuse are described as showing cost after the fact, with a separate local proxy proposed for the hard stop: [RelayPlane, 2026-09-16](https://relayplane.com/blog/helicone-vs-langfuse-2026).
- Gateway roundups in 2026 still center budgets inside a hosted or self-hosted gateway: [finops.qa, 2026-10-08](https://finops.qa/blog/ai-gateway-cost-control-comparison-2026).

Estimate: the buyer is a developer who will not run LiteLLM plus Postgres for one agent. That is a positioning claim, not a measured market size.

## 5. Competition — 4/5

| Name | What they sell | Cited |
|---|---|---|
| LiteLLM | Self-hosted proxy, budgets per key/team when a database is connected | [docs.litellm.ai virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys), [FrugalAI](https://frugalai.io/blog/litellm-vs-portkey) |
| Portkey (Prisma AIRS AI Gateway since the Palo Alto deal noted by FrugalAI) | Managed gateway; budget limits called out on higher tiers | [FrugalAI](https://frugalai.io/blog/litellm-vs-portkey), [finops.qa](https://finops.qa/blog/ai-gateway-cost-control-comparison-2026) |
| Helicone | Gateway plus observability; rate limits and cost dashboards | [RelayPlane comparison](https://relayplane.com/blog/helicone-vs-langfuse-2026) |
| Langfuse | Trace observability and threshold monitors, not a local kill switch | [itsourcecode comparison, 2026-10-19](https://itsourcecode.com/web-dev/langfuse-vs-langsmith-vs-helicone/) |
| Cloudflare AI Gateway | Managed edge, spend limits | [finops.qa](https://finops.qa/blog/ai-gateway-cost-control-comparison-2026) |
| RelayPlane | Local MIT proxy, daily cap, kill switch, npm install | [RelayPlane](https://relayplane.com/blog/helicone-vs-langfuse-2026) |

Vanta and Drata sell compliance programs. They are not spend-cap products and are not a fit to buy or to integrate for this wedge.

## 6. SEO — 2/5

Indexable: `robots.txt` allows `/` and points at a sitemap. The sitemap has one URL, `lastmod` 2026-10-09 (`src/hosted/seo.js`, confirmed live). Title is "CostCap | Fleet guardrails". Description mentions guardrails, not "cap" or "agent spend". No Open Graph tags. Canonical on the live host is `https://app.costcap.dev` while `PUBLIC_ORIGIN` in source is `https://costcap.dev` (apex 301s to the app host, so the live canonical follows the request host). JSON-LD price 0 conflicts with the $19 card (#89). No docs URL, no comparison URL (#90).

## 7. Integrations — 3/5

Shipped in code: OpenAI, Anthropic, Gemini, OpenRouter base-URL overrides (`README`, `src/pricing-table.json`). Slack webhook and Brevo adapters (`src/hosted/delivery.js`, `src/hosted/email.js`) with unit tests; live send is #45. GitHub Action file `action.yml` exists; Marketplace listing does not (#15). MCP exposes `budget_status` only. No provider-bill API (# reconcile reads a local file).

## 8. Where to sell, first 10 customers — 3/5

Do not buy ads and do not email a list until #89 is fixed. Order:

1. One internal agent (dogfood epic #10) with a real cap and a saved receipt week. That is customer 0 and the only case study source.
2. Publish `npx` (#5, owner) so the README command is one line.
3. Post the existing `docs/launch-drafts.md` Show HN text after #89, with the limits paragraph kept.
4. Answer public threads where people already ask how to stop an agent loop (LiteLLM and Helicone threads). Link the repo, not a cold pitch.
5. GitHub topics and the new `/cli` page (#90) are the search path. Ten teams is an estimate of outreach capacity, not a pipeline.

## 9. Launch assets — 3/5

Present: `docs/deck/index.html`, `docs/launch-drafts.md`, `docs/PATH_TO_FIRST_DOLLAR.md`, README limits. `docs/DESIGN.md` says its notes are not screenshots. No case study. No image of a blocked receipt in `docs/`.

## 10. Trust / compliance — 3/5

The live page says "Guardrails, not guarantees" and that one accepted request can overshoot. Receipts omit bodies and authorization headers (README). Gaps: single-process JSON on the live host, schema/README price contradiction (#89), no published security contact page in the sitemap, no pen-test (owner). Do not buy a compliance suite to unblock the first ten users.

## 11. Moat — 2/5

The wedge is a local proxy plus loop and velocity breakers (`src/spiral.js`, `src/velocity.js`) and a fail-closed unknown cost. RelayPlane already describes the same local-cap shape. The hosted fleet is a convenience layer on a file store, not a data moat. Moat grows only if dogfood receipts and the pricing table stay more honest than gateway dashboards.

## 12. Portfolio call — FINISH THEN SHIP

The local product and the checkout UI exist. Traffic is the stated blocker, and the page is not safe to advertise while JSON-LD says price 0, the README says there is no paid service, and npm 404s. Fix #89 and #90, then use the launch draft. Leave Stripe amounts alone.

## Score summary

| Item | Score |
|---|---|
| 2 Time to value | 2 |
| 3 Offer | 4 |
| 4 Market | 3 |
| 5 Competition | 4 |
| 6 SEO | 2 |
| 7 Integrations | 3 |
| 8 First customers | 3 |
| 9 Launch assets | 3 |
| 10 Trust | 3 |
| 11 Moat | 2 |
| 12 Call | FINISH THEN SHIP |
