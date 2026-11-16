// #235: #232 regressions on non-OpenAI providers (Groq on_demand, custom-upstream cache writes,
// OpenRouter usage.cost on unpriced cache writes / tiers).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractUsage, applyProviderCost } from "../src/proxy.js";
import { costForUserPrices, loadUpstreamPrices } from "../src/upstreams.js";
import { costWithOverrides } from "../src/price-overrides.js";
import { estimateWorstCase } from "../src/preflight.js";

const prices = (upstreams) => ({ version: "t", sha256: "x", upstreams });

test("u/groq service_tier on_demand and default price at standard user rates", () => {
  for (const tier of ["on_demand", "default"]) {
    const body = JSON.stringify({ model: "llama", service_tier: tier, usage: { prompt_tokens: 10, completion_tokens: 10 } });
    const m = extractUsage("u/acme", body, "llama");
    const r = costForUserPrices(prices({ acme: { llama: { input: 1, output: 1 } } }), "u/acme", m.model, m.usage);
    assert.equal(r.cost_usd, 0.00002);
    assert.equal(r.cost_source, "user_prices");
    assert.equal(r.service_tier, tier);
  }
});

test("known premium tiers on a custom upstream stay unpriced", () => {
  for (const tier of ["priority", "fast", "ultrafast"]) {
    const r = costForUserPrices(prices({ acme: { llama: { input: 1, output: 1 } } }), "u/acme", "llama", { input_tokens: 10, output_tokens: 10, service_tier: tier });
    assert.equal(r.cost_usd, null);
    assert.equal(r.reason, "service_tier_unpriced");
  }
});

test("OpenRouter on_demand prices from the table", () => {
  const r = costWithOverrides(null, "openrouter", "openai/gpt-4o", { input_tokens: 100, output_tokens: 10, service_tier: "on_demand" });
  assert.notEqual(r.cost_usd, null);
  assert.notEqual(r.reason, "service_tier_unpriced");
});

test("custom-upstream cache writes without a rate are unknown, never $0", () => {
  const body = JSON.stringify({ model: "my-model", usage: { prompt_tokens: 100000, completion_tokens: 0, prompt_tokens_details: { cache_write_tokens: 100000 } } });
  const m = extractUsage("u/acme", body, "my-model");
  const r = costForUserPrices(prices({ acme: { "my-model": { input: 10, output: 10 } } }), "u/acme", m.model, m.usage);
  assert.equal(r.cost_usd, null);
  assert.equal(r.reason, "user_price_unpriced");
  assert.equal(r.cache_write_input_tokens, 100000);
});

test("custom-upstream cache_write / cache_write_1h rates price the writes", () => {
  const p = prices({ acme: { m: { input: 10, output: 10, cache_write: 12.5, cache_write_1h: 20 } } });
  const r = costForUserPrices(p, "u/acme", "m", { input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 100000, cache_write_1h_input_tokens: 100000 });
  assert.equal(r.cost_usd, 3.25);
  // a 1h write with only a cache_write rate is unpriced
  const r2 = costForUserPrices(prices({ acme: { m: { input: 10, output: 10, cache_write: 12.5 } } }), "u/acme", "m", { cache_write_1h_input_tokens: 5 });
  assert.equal(r2.reason, "user_price_unpriced");
});

test("--upstream-prices validates cache_write rates", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc235-"));
  const f = path.join(dir, "p.json");
  writeFileSync(f, JSON.stringify({ upstreams: { acme: { m: { input: 1, output: 1, cache_write: 2, cache_write_1h: 3 } } } }));
  assert.equal(loadUpstreamPrices(f, ["acme"]).upstreams.acme.m.cache_write, 2);
  writeFileSync(f, JSON.stringify({ upstreams: { acme: { m: { input: 1, output: 1, cache_write: -1 } } } }));
  assert.throws(() => loadUpstreamPrices(f, ["acme"]), /cache_write/);
});

test("OpenRouter usage.cost is used when the table cannot price a cache write", () => {
  for (const model of ["google/gemini-2.5-pro", "openai/gpt-4o"]) {
    const body = JSON.stringify({ model, usage: { prompt_tokens: 2000, completion_tokens: 100, cost: 0.0123, prompt_tokens_details: { cache_write_tokens: 1500 } } });
    const m = extractUsage("openrouter", body, model);
    const receipt = costWithOverrides(null, "openrouter", m.model, m.usage);
    applyProviderCost(receipt, m.providerCost);
    assert.equal(receipt.cost_usd, 0.0123);
    assert.equal(receipt.cost_source, "provider");
    assert.equal(receipt.reason, undefined);
  }
});

test("applyProviderCost rescues service_tier_unpriced but not other unknowns", () => {
  assert.equal(applyProviderCost({ cost_usd: null, reason: "service_tier_unpriced" }, 0.5).cost_usd, 0.5);
  assert.equal(applyProviderCost({ cost_usd: null, reason: "modality_unpriced" }, 0.5).cost_usd, null);
  assert.equal(applyProviderCost({ cost_usd: null, reason: "cache_write_unpriced" }, undefined).cost_usd, null);
});

test("--preflight: a Groq on_demand request body is not preflight_unpriced", () => {
  const body = JSON.stringify({ model: "llama", service_tier: "on_demand", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  const est = estimateWorstCase("u/acme", body, "/v1/chat/completions", () => ({ input: 1, output: 1, user_prices: true }));
  assert.equal(est.ok, true);
  assert.equal(est.pricing_tier, "standard");
});
