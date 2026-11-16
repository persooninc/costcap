# costcap-216 — Bedrock Converse / ConverseStream metering

Landed in 16174d8: `/bedrock/model/{id}/converse` and `/converse-stream` are metered (SigV4/Bearer as invoke),
usage from Converse `usage` / ConverseStream `metadata`, priced via the Bedrock id mapping, preflight reads
`inferenceConfig.maxTokens`, `wrap` exports `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`.
Tests: test/bedrock-converse.test.js, test/cloud-providers.test.js (30/30 green, 2026-11-16).
