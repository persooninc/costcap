import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lookupPrice, costForUsage, TABLE_VERSION } from "../src/pricing.js";
import "./support/pinned-clock.js"; // #237: prices below are pre-2026-12-01

const table = JSON.parse(readFileSync(new URL("../src/pricing-table.json", import.meta.url), "utf8"));

test("known model returns its table entry with version pinned", () => {
  const p = lookupPrice("gpt-4o-mini");
  assert.equal(p.input, 0.15);
  assert.equal(p.output, 0.6);
  assert.equal(p.fallback, false);
  assert.equal(p.table_version, TABLE_VERSION);
});

test("unknown model bills at declared fallback, flagged, never free", () => {
  const p = lookupPrice("gpt-99-ultra");
  assert.equal(p.fallback, true);
  assert.ok(p.input > 0 && p.output > 0);
  assert.equal(p.table_version, TABLE_VERSION);
});

test("cost arithmetic matches table rates", () => {
  const r = costForUsage("gpt-4o-mini", { input_tokens: 1_000_000, output_tokens: 500_000 });
  assert.equal(r.cost_usd, 0.45);
});

test("cached tokens bill at the cached rate", () => {
  const r = costForUsage("gpt-4o", { cached_input_tokens: 1_000_000 });
  assert.equal(r.cost_usd, 1.25);
});

test("zero usage costs zero but still pins the table version", () => {
  const r = costForUsage("unknown-model");
  assert.equal(r.cost_usd, 0);
  assert.equal(r.fallback, true);
  assert.equal(r.table_version, TABLE_VERSION);
});

test("Claude and Gemini models the proxy routes use table rates, not the fallback", () => {
  for (const model of ["claude-sonnet-4-6", "gemini-2.5-flash", "anthropic/claude-sonnet-4.6"]) {
    const p = lookupPrice(model);
    assert.equal(p.fallback, false, model);
    assert.equal(p.table_version, TABLE_VERSION);
    assert.notEqual(p.output, table.fallback.output);
  }
  assert.equal(lookupPrice("claude-sonnet-4-6").output, 15);
  assert.equal(lookupPrice("gemini-2.5-flash").input, 0.3);
});

test("every table rate is finite and positive and each provider has a source URL", () => {
  assert.equal(table.version, TABLE_VERSION);
  for (const host of ["openai.com", "claude.com", "google.dev", "openrouter.ai"]) {
    assert.ok(table.sources.some((url) => url.includes(host)), host);
  }
  for (const [model, rates] of Object.entries(table.models)) {
    // #198: audio models billed per minute / per character carry one positive unit rate and no token rates.
    if (rates.per_minute !== undefined || rates.per_million_characters !== undefined) {
      const unit = rates.per_minute ?? rates.per_million_characters;
      assert.equal(Number.isFinite(unit) && unit > 0, true, `${model} unit rate`);
      assert.equal(rates.input, undefined, model);
      continue;
    }
    for (const field of ["input", "cached_input", "output"]) {
      // Documented exception (#145): input-only models (embeddings) bill no output, so output is exactly 0.
      if (rates.input_only && field === "output") { assert.equal(rates.output, 0, model); continue; }
      // #269: Gemini image models publish no cached rate; the key is absent (cache reads are unpriced), never 0.
      if (field === "cached_input" && !Object.hasOwn(rates, "cached_input") && (/-image$/.test(model) || model === "gemini-nano-banana-2.1")) continue;
      // Documented exception (#270): Gemini TTS publishes no context-caching rate; a cache read is unpriced.
      if (rates.no_cache_rate && field === "cached_input") { assert.equal(rates.cached_input, undefined, model); continue; }
      assert.equal(Number.isFinite(rates[field]) && rates[field] > 0, true, `${model}.${field}`);
    }
  }
});

test("every Claude model has cache-write rates at the published multiples, and the fallback declares them", () => {
  for (const [model, rates] of Object.entries(table.models)) {
    if (!model.startsWith("claude-")) continue;
    assert.equal(rates.cache_write, rates.input * 1.25, model);
    assert.equal(rates.cache_write_1h, rates.input * 2, model);
  }
  assert.equal(table.fallback.cache_write, table.fallback.input * 1.25);
  assert.equal(table.fallback.cache_write_1h, table.fallback.input * 2);
});

test("current Claude models use published rates, not the fallback", () => {
  for (const [model, output] of [["claude-fable-5-1", 50], ["claude-fable-5", 50], ["claude-opus-5-5", 20], ["claude-sonnet-5-5", 10]]) {
    const p = lookupPrice(model);
    assert.equal(p.fallback, false, model);
    assert.equal(p.output, output, model);
  }
});

test("dated snapshot ids price as their base model, not the fallback", () => {
  const p = lookupPrice("gpt-4o-mini-2024-07-18");
  assert.equal(p.fallback, false);
  assert.equal(p.input, 0.15);
  assert.equal(lookupPrice("gpt-99-ultra-2026-01-01").fallback, true);
});

test("#145 embeddings rates are input-only at published prices", () => {
  for (const [m, rate] of [["text-embedding-3-small", 0.02], ["text-embedding-3-large", 0.13], ["text-embedding-ada-002", 0.1]]) {
    const p = lookupPrice(m);
    assert.deepEqual([p.input, p.output, p.input_only, p.fallback], [rate, 0, true, false], m);
  }
  assert.equal(costForUsage("text-embedding-3-small", { input_tokens: 1_000_000 }).cost_usd, 0.02);
  assert.ok(table.sources.some((u) => u.includes("openai.com/api/pricing")));
});

test("#160 batch multiplier is 0.5 per provider and stacks with caching and long_context", async () => {
  const { batchMultiplier } = await import("../src/pricing.js");
  assert.equal(batchMultiplier("openai"), 0.5);
  assert.equal(batchMultiplier("anthropic"), 0.5);
  assert.equal(batchMultiplier("gemini"), 0.5); // #230
  assert.equal(batchMultiplier("openrouter"), null);
  const usage = { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 4000, cache_write_input_tokens: 300, cache_write_1h_input_tokens: 200 };
  const std = costForUsage("claude-sonnet-4-6", usage);
  const b = costForUsage("claude-sonnet-4-6", usage, { batch: "anthropic" });
  assert.equal(b.batch_multiplier, 0.5);
  assert.ok(Math.abs(b.cost_usd - std.cost_usd * 0.5) < 1e-6);
  const big = { ...usage, input_tokens: 250000 };
  const lc = costForUsage("claude-sonnet-4-6", big, { batch: "anthropic" });
  assert.equal(lc.pricing_tier, "long_context");
  assert.ok(Math.abs(lc.cost_usd - costForUsage("claude-sonnet-4-6", big).cost_usd * 0.5) < 1e-6);
  assert.equal(costForUsage("gpt-4o", { input_tokens: 10 }).batch_multiplier, undefined);
  assert.throws(() => costForUsage("gemini-2.5-pro", { input_tokens: 1 }, { batch: "openrouter" }), /no batch rate/);
  // #230: Gemini batch stacks with long_context like the other providers.
  const g = { input_tokens: 250000, output_tokens: 1000, cached_input_tokens: 1000 };
  const gb = costForUsage("gemini-2.5-pro", g, { batch: "gemini" });
  assert.deepEqual([gb.batch_multiplier, gb.pricing_tier], [0.5, "long_context"]);
  assert.ok(Math.abs(gb.cost_usd - costForUsage("gemini-2.5-pro", g).cost_usd * 0.5) < 1e-6);
});

test("#163: text-only costs are unchanged by the modality breakdown", () => {
  for (const model of ["gpt-4o", "gemini-2.5-flash", "claude-sonnet-4-6", "gpt-image-1", "unknown-xyz"]) {
    const u = { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200 };
    const text = { input: { text: 1000, image: 0, audio: 0, video: 0 }, cached_input: null, output: null };
    assert.equal(costForUsage(model, { ...u, modality_tokens: text }).cost_usd, costForUsage(model, u).cost_usd, model);
  }
});

test("#200 gemini-embedding rows are in the table", () => {
  assert.equal(lookupPrice("gemini-embedding-001").input, 0.15);
  assert.equal(lookupPrice("gemini-embedding-2").modalities.video.input, 12);
});
