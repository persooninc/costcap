# FA-CC-03: test-mode pricing page with Solo $19 and Team $79 (2026-11-13)

- Plan catalog (`src/billing/plans.js`) has three hosted tiers:
  - Free: 3 agents, 3 people, receipts shown for 30 days.
  - Solo ($19, id `workspace` so existing subscriptions keep resolving): 15 agents, 3 people, 90 days.
  - Team ($79): 50 agents, 15 people with admin and viewer roles, 1 year.
- `entitlementsFor({ status, plan })` resolves the paid tier. The upgrade path is free → Solo → Team. `retentionCutoff()` hides older receipts (it never deletes them) only when entitlements are enforced.
- The test-mode Stripe adapter takes an optional owner `teamPriceId` (`COSTCAP_STRIPE_TEAM_PRICE_ID`). Checkout takes `{ plan }`. The subscription price maps back to the plan, and a cancel clears it, which returns the workspace to free. The live adapter sells Solo only (Team gets a 409 before any Stripe call). No code creates a price.
- `/pricing` is on by default (`COSTCAP_PUBLIC_PRICING=disabled` turns it off). It renders both paid tiers at their list price and shows a test-mode banner when not live. CTAs go to the workspace plan card, which has a Team checkout button.
- Tests: `test/plans.test.js` (Team entitlements, ladder, retention, config, adapter) and `e2e/team.spec.js` (pricing → test checkout → Team → portal cancel → free).
- Not built: per-workspace Slack/webhook alert routing (the revenue plan lists it for Team). It is not claimed in the copy. Alert delivery is still the single owner-configured channel.
- Owner: create the Team test price in the Stripe test account and set `COSTCAP_STRIPE_TEAM_PRICE_ID`. Live keys stay parked.
