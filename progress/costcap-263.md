# #263 Gemini batch grounding follows billed_as (per query after Dec 1)

- `src/batch.js` `priceLine` now runs `billedAsGrounding` (shared with the live path, #260) per priced instant and keeps the higher total of tokens + grounding (#236).
- Tests: `test/gemini-batch-grounding-263.test.js` (AC2–AC4).
