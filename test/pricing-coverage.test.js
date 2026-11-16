// #157: Anthropic -YYYYMMDD snapshot ids and current OpenAI models price from the table, not the fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupPrice, isPricedModel, costForUsage } from "../src/pricing.js";

const rates = (m) => { const p = lookupPrice(m); return { fallback: p.fallback, input: p.input, cached_input: p.cached_input, output: p.output }; };

test("Anthropic snapshot ids resolve to their base id, one per family", () => {
  for (const [snap, base] of [
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-opus-4-5-20251101", "claude-opus-4-5"],
    ["claude-sonnet-4-6-20260101", "claude-sonnet-4-6"],
    ["claude-opus-4-6-20260101", "claude-opus-4-6"],
    ["claude-sonnet-5-20260601", "claude-sonnet-5"],
    ["claude-opus-5-20260601", "claude-opus-5"],
    ["claude-fable-5-20260601", "claude-fable-5"],
  ]) {
    const p = rates(snap);
    assert.equal(p.fallback, false, snap);
    assert.deepEqual(p, rates(base), snap);
  }
  assert.deepEqual(rates("claude-sonnet-4-5-20250929"), { fallback: false, input: 3, cached_input: 0.3, output: 15 });
});

test("OpenRouter-style anthropic/ and openai/ ids with snapshots resolve", () => {
  assert.deepEqual(rates("anthropic/claude-sonnet-4-5-20250929"), rates("claude-sonnet-4-5"));
  assert.deepEqual(rates("anthropic/claude-sonnet-4.6"), rates("anthropic/claude-sonnet-4.6"));
  assert.equal(lookupPrice("anthropic/claude-sonnet-4.6").fallback, false);
  assert.deepEqual(rates("openai/gpt-5-mini"), rates("gpt-5-mini"));
  assert.equal(lookupPrice("google/unknown-x").fallback, true);
  assert.equal(lookupPrice("mistral/gpt-5").fallback, true);
});

test("current OpenAI models carry published rates", () => {
  const expected = {
    "gpt-5": [1.25, 0.125, 10], "gpt-5-mini": [0.25, 0.025, 2], "gpt-5-nano": [0.05, 0.005, 0.4], "gpt-5-pro": [15, 15, 120],
    "gpt-4.1": [2, 0.5, 8], "gpt-4.1-mini": [0.4, 0.1, 1.6], "gpt-4.1-nano": [0.1, 0.025, 0.4],
    "o1": [15, 7.5, 60], "o1-pro": [150, 150, 600], "o3": [2, 0.5, 8], "o4-mini": [1.1, 0.275, 4.4],
  };
  for (const [m, [input, cached_input, output]] of Object.entries(expected)) {
    assert.deepEqual(rates(m), { fallback: false, input, cached_input, output }, m);
    assert.equal(isPricedModel(m), true, m);
  }
});

test("dated OpenAI ids resolve to the longest exact base, never a shorter family", () => {
  assert.deepEqual(rates("gpt-4.1-2025-04-14"), rates("gpt-4.1"));
  assert.deepEqual(rates("gpt-5-mini-2025-08-07"), rates("gpt-5-mini"));
  assert.notDeepEqual(rates("gpt-5-mini-2025-08-07"), rates("gpt-5"));
  assert.deepEqual(rates("o4-mini-2025-04-16"), rates("o4-mini"));
  assert.deepEqual(rates("o1-pro-2025-03-19"), rates("o1-pro"));
  assert.deepEqual(rates("gpt-4o-mini-2024-07-18"), rates("gpt-4o-mini"));
});

test("isPricedModel accepts snapshot ids; non-date suffixes and prototype keys stay unknown", () => {
  assert.equal(isPricedModel("claude-haiku-4-5-20251001"), true);
  assert.equal(isPricedModel("gpt-4.1-nano-2025-04-14"), true);
  assert.equal(isPricedModel("gpt-5-turbo"), false);
  assert.equal(isPricedModel("claude-sonnet-4-5-2025"), false);
  assert.equal(isPricedModel("constructor"), false);
  assert.equal(isPricedModel("toString"), false);
});

test("o1-pro spend is metered at list price, not the fallback floor", () => {
  const c = costForUsage("o1-pro-2025-03-19", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(c.fallback, false);
  assert.equal(c.cost_usd, 750);
});

// #232: current OpenAI models are priced from the table, not the fallback.
const GPT_232 = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.2"];
test("#232 AC1: GPT-6 / GPT-5.6 / gpt-5.2-5.5 rows and dated snapshots are priced", () => {
  for (const m of [...GPT_232, "gpt-6-astra-2026-04-30"]) {
    assert.equal(lookupPrice(m).fallback, false, m);
    assert.equal(isPricedModel(m), true, m);
    const p = lookupPrice(m);
    assert.equal(p.long_context.threshold_input_tokens, 272000, m);
    assert.equal(p.long_context.input, Number((p.input * 2).toFixed(6)), m);
    assert.equal(p.long_context.output, Number((p.output * 1.5).toFixed(6)), m);
    assert.ok(p.priority, m);
  }
  const a = lookupPrice("gpt-6-astra");
  assert.deepEqual([a.input, a.cached_input, a.output, a.cache_write, a.cache_write_1h], [10, 1, 50, 12.5, 25]);
  assert.equal(costForUsage("gpt-6-astra", { output_tokens: 1_000_000 }).cost_usd, 50);
  assert.equal(costForUsage("gpt-6-astra-2026-04-30", { output_tokens: 1_000_000 }).fallback, false);
  // GPT-6 / GPT-5.6 cache writes are 1.25x (30m) and 2.5x (12h) input; older rows publish none.
  for (const m of GPT_232.filter((m) => /^gpt-(6|5\.6)/.test(m))) {
    const p = lookupPrice(m);
    assert.equal(p.cache_write, Number((p.input * 1.25).toFixed(6)), m);
    assert.equal(p.cache_write_1h, Number((p.input * 2.5).toFixed(6)), m);
  }
  assert.equal(lookupPrice("gpt-5.5").cache_write, undefined);
  assert.equal(costForUsage("gpt-5.5", { cache_write_input_tokens: 10 }).reason, "cache_write_unpriced");
});
