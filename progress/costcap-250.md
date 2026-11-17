# costcap-250: Gemini Grounding with Google Search priced (#250)

- Table 2026-11-16.18: `tools.gemini.google_search` (2.0/2.5 $0.035 per prompt, 3/4 $0.014 per query) and `tools.vertex.google_search` (2.5 $0.035 per prompt); #222 note corrected; digest regenerated.
- Detection on Gemini API + Vertex Gemini, non-stream and streamed; receipts get `tool_calls.google_search` and `tool_cost_usd`; never-$0 shapes are `tool_use_unpriced`.
- Batches, `--prices` `tools.google_search`, preflight per-prompt worst case; README documents free allowances not subtracted.
- Tests: test/gemini-grounding-250.test.js.
