# costcap-232: price current OpenAI models (2026-11-16)

- Added 12 OpenAI rows (gpt-6-astra, gpt-6.1-sol/terra, gpt-6-sol/luna, gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.2) with standard, Fast (`priority`), Ultrafast (astra / 6.1-sol), cache writes (GPT-6 / 5.6) and >272K long-context rates. Table version 2026-11-16.14, digest regenerated.
- `service_tier` `fast` prices at priority; `ultrafast` uses its own set; unrecognised values are `service_tier_unpriced`. Fast over 272K = 2x long-context rates where published.
- OpenAI cache writes are parsed (30m / 12h, no breakdown = 30m, inconsistent = unknown).
- `gpt-6` web_search / web_search_preview family at $0.01.
- Rates were checked against developers.openai.com/api/docs/pricing on 2026-11-16.
