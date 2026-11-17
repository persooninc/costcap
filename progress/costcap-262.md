# costcap-262: Gemini Priority inference priced at Priority rates (2026-11-16)

- Feature landed on main in `f4dacac` (Gemini `priority` rate rows, `geminiServedTier`, Vertex `trafficType`, downgrade handling, README).
- This follow-up adds the HANDOFF portable-module row and this fragment, and closes #262.
- Tests: test/gemini-priority-tier.test.js (AC1-AC6), pricing-digest, tool-pricing.
- Vertex Priority PayGo stays unpriced until a published rate is verified.
