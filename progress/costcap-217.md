# costcap-217 — Gemini on Vertex AI metering

Landed in 682ec27: Vertex `publishers/google/models/{id}:generateContent`, `:streamGenerateContent` (SSE and
JSON-array) and `:countTokens` (non-billable) are forwarded to `<loc>-aiplatform.googleapis.com` and metered from
`usageMetadata`; new `vertex_gemini` pricing list; preflight reads `generationConfig.maxOutputTokens`; `wrap`
exports `GOOGLE_VERTEX_BASE_URL`. Other Vertex verbs stay 404 cloud_route_unsupported.
Tests: test/vertex-gemini.test.js, test/cloud-providers.test.js (green, 2026-11-16).
