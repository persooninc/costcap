# FA-CC-02: public trust pages (2026-11-13)

- `/privacy`, `/terms` and `/security` are static, indexable pages served by the app. The content is data in `src/hosted/trust.js`; the operator and contact are injectable.
- They are linked from the footer of the landing, `/cli`, `/pricing` and the trust pages, and from the checkout card (`#checkoutTerms`). They are also in `sitemap.xml`.
- The copy follows README "Enforcement limits": receipts carry no bodies and no auth headers, data sits on a single server that is not HA, and there are no SOC 2 or ISO claims.
- The deploy canary now also requires 200 from `/privacy`, `/terms` and `/security`.
- Tests: `test/trust.test.js`, plus `e2e/trust.spec.js` (footer links clicked through, all three routes return 200).
- Owner follow-up: the deletion contact defaults to GitHub issues. Pass `contact` to `uiResponse` (for example a support mailbox) once one exists.
