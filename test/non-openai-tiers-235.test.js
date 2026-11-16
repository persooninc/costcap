// #235: #232 regressions on non-OpenAI providers (Groq on_demand, custom cache writes, OpenRouter usage.cost).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractUsage, startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { premiumTier } from "../src/pricing.js";
import { costForUserPrices, loadUpstreamPrices, userPrice } from "../src/upstreams.js";
import { costWithOverrides } from "../src/price-overrides.js";
import { estimateWorstCase } from "../src/preflight.js";

const prices = (models) => ({ version: "t", sha256: "x", upstreams: { acme: models, groq: models } });
const groqBody = (tier, extra = {}) => JSON.stringify({ model: "llama", service_tier: tier, usage: { prompt_tokens: 10, completion_tokens: 10, ...extra } });

test("#235 AC1: Groq on_demand/default price at standard on a custom upstream; premium stays unpriced", () => {
  const p = prices({ llama: { input: 1, output: 1 } });
  for (const tier of ["on_demand", "default"]) {
    const m = extractUsage("u/groq", groqBody(tier), "llama");
    const r = costForUserPrices(p, "u/groq", m.model, m.usage);
    assert.equal(r.cost_usd, 0.00002, tier);
    assert.equal(r.cost_source, "user_prices");
    assert.equal(r.service_tier, tier);
  }
  for (const tier of ["priority", "fast", "ultrafast", "performance"]) {
    const m = extractUsage("u/groq", groqBody(tier), "llama");
    assert.equal(costForUserPrices(p, "u/groq", m.model, m.usage).reason, "service_tier_unpriced", tier);
  }
  assert.equal(premiumTier({ service_tier: "on_demand" }), null);
  // OpenRouter table pricing with on_demand is standard, not unpriced.
  const m = extractUsage("openrouter", JSON.stringify({ model: "openai/gpt-4o", service_tier: "on_demand", usage: { prompt_tokens: 1000, completion_tokens: 10 } }));
  const r = costWithOverrides(null, "openrouter", m.model, m.usage);
  assert.notEqual(r.cost_usd, null);
  assert.equal(r.pricing_tier, "standard");
});

test("#235 AC2: custom-upstream cache writes are never $0", () => {
  const m = extractUsage("u/acme", JSON.stringify({ model: "my-model", usage: { prompt_tokens: 100000, completion_tokens: 0, prompt_tokens_details: { cache_write_tokens: 100000 } } }), "my-model");
  const none = costForUserPrices(prices({ "my-model": { input: 10, output: 10 } }), "u/acme", m.model, m.usage);
  assert.equal(none.cost_usd, null);
  assert.equal(none.reason, "user_price_unpriced");
  assert.equal(none.cache_write_input_tokens, 100000);
  const priced = costForUserPrices(prices({ "my-model": { input: 10, output: 10, cache_write: 12.5 } }), "u/acme", m.model, m.usage);
  assert.equal(priced.cost_usd, 1.25);
  const m12 = extractUsage("u/acme", JSON.stringify({ model: "my-model", usage: { prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cache_write_tokens: 1000, cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 1000 } } } }), "my-model");
  assert.equal(costForUserPrices(prices({ "my-model": { input: 10, output: 10, cache_write: 12.5 } }), "u/acme", m12.model, m12.usage).reason, "user_price_unpriced");
  assert.equal(costForUserPrices(prices({ "my-model": { input: 10, output: 10, cache_write_1h: 20 } }), "u/acme", m12.model, m12.usage).cost_usd, 0.02);
  // No writes: receipt shape unchanged.
  assert.equal("cache_write_input_tokens" in costForUserPrices(prices({ llama: { input: 1, output: 1 } }), "u/acme", "llama", { input_tokens: 1 }), false);
});

test("#235 AC2: --upstream-prices validates cache_write / cache_write_1h", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-235-"));
  const f = join(dir, "p.json");
  writeFileSync(f, JSON.stringify({ upstreams: { acme: { m: { input: 1, output: 1, cache_write: 1.25, cache_write_1h: 2 } } } }));
  assert.equal(loadUpstreamPrices(f, ["acme"]).upstreams.acme.m.cache_write, 1.25);
  for (const bad of [{ cache_write: -1 }, { cache_write_1h: "x" }]) {
    writeFileSync(f, JSON.stringify({ upstreams: { acme: { m: { input: 1, output: 1, ...bad } } } }));
    assert.throws(() => loadUpstreamPrices(f, ["acme"]), /cache_write/);
  }
});

async function orProxy(t, body) {
  const up = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const file = join(mkdtempSync(join(tmpdir(), "cc-235-")), "receipts.jsonl");
  const { server, port } = await startMeteringProxy({ upstreams: { openrouter: `http://127.0.0.1:${up.address().port}` }, cap: createCapEngine({ caps: { run: 100 } }), receiptsPath: file });
  t.after(() => { server.closeAllConnections(); server.close(); up.closeAllConnections(); up.close(); });
  const call = async () => { const r = await fetch(`http://127.0.0.1:${port}/openrouter/api/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: body.model }) }); await r.text(); return r.status; };
  return { call, receipts: () => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) };
}

for (const model of ["google/gemini-2.5-pro", "openai/gpt-4o"]) {
  test(`#235 AC3: OpenRouter ${model} usage.cost settles a cache write, and the next call runs`, async (t) => {
    const f = await orProxy(t, { model, usage: { prompt_tokens: 2000, completion_tokens: 10, cost: 0.0123, prompt_tokens_details: { cache_write_tokens: 1500 } } });
    assert.equal(await f.call(), 200);
    assert.equal(await f.call(), 200);
    const [r] = f.receipts();
    assert.equal(r.cost_usd, 0.0123);
    assert.equal(r.cost_source, "provider");
    assert.equal(r.reason, undefined);
  });
}

test("#235 AC3: OpenRouter usage.cost settles an unrecognised service tier", async (t) => {
  const f = await orProxy(t, { model: "openai/gpt-4o", service_tier: "performance", usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0123 } });
  assert.equal(await f.call(), 200);
  assert.equal(f.receipts()[0].cost_usd, 0.0123);
});

test("#235 AC4: --preflight prices a Groq on_demand request body at standard", () => {
  const p = prices({ llama: { input: 1, output: 1 } });
  const priceFor = (m) => { const r = userPrice(p, "u/groq", m); return r && { model: m, ...r, fallback: false }; };
  const body = (tier) => JSON.stringify({ model: "llama", service_tier: tier, max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  const ok = estimateWorstCase("u/groq", body("on_demand"), "/v1/chat/completions", priceFor);
  assert.equal(ok.ok, true);
  assert.equal(ok.pricing_tier, "standard");
  assert.equal(estimateWorstCase("u/groq", body("priority"), "/v1/chat/completions", priceFor).reason, "preflight_unpriced");
});
