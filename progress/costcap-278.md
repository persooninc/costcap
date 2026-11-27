# costcap-278: price non-Anthropic Bedrock models; bedrock/vertex overrides

- `bedrock_models` table section (version 2026-11-17.3): 24 Nova/Llama/Mistral/DeepSeek/gpt-oss/Qwen ids,
  on-demand standard input/output/cache-read per region (us-east-1, us-west-2, eu-west-1 where listed),
  from AWS Price List publication 20261111013037 (retrieved 2026-11-17). Cache writes left unknown.
- `mapCloudModel("bedrock", id)` resolves listed ids (geo prefix stripped; `global.`, ARN, unlisted stay null).
  Region with no row → `cloud_model_unpriced`; Converse `serviceTier` != default → `service_tier_unpriced`.
- `--upstream-prices` accepts `bedrock` / `vertex` keys (#189 semantics); `pricing show` prints per-region rows.
- Tests: bedrock-converse (AC1-AC4 via signed stub), cloud-providers, price-overrides, upstreams, pricing-coverage, pricing-digest.
