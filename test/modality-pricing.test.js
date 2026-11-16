// #163: audio / image / video tokens priced at their modality rates, or unknown.
import test from "node:test";
import assert from "node:assert/strict";
import { costForUsage, modalityAdjustment, lookupPrice } from "../src/pricing.js";
import { extractUsage, geminiModalitySlice, openaiModalitySlice } from "../src/proxy.js";

const gem = (meta) => extractUsage("gemini", JSON.stringify({ modelVersion: "gemini-2.5-flash", usageMetadata: meta }));
const price = (m) => costForUsage(m.model, m.usage);

test("AC1: gemini-2.5-flash audio input priced at $1.00, not the text rate", () => {
  const m = gem({ promptTokenCount: 101000, candidatesTokenCount: 500, promptTokensDetails: [{ modality: "TEXT", tokenCount: 1000 }, { modality: "AUDIO", tokenCount: 100000 }] });
  assert.deepEqual(m.usage.modality_tokens.input, { text: 1000, image: 0, audio: 100000, video: 0 });
  const r = price(m);
  assert.equal(r.cost_usd, Number(((1000 * 0.30 + 100000 * 1.00 + 500 * 2.50) / 1e6).toFixed(6)));
  assert.notEqual(r.cost_usd, Number(((101000 * 0.30 + 500 * 2.5) / 1e6).toFixed(6)));
  assert.equal(r.cost_source, "table");
  assert.deepEqual(r.modality_tokens, m.usage.modality_tokens);
});

test("AC1: cached audio uses the audio cache rate", () => {
  const m = gem({ promptTokenCount: 3000, cachedContentTokenCount: 2000, candidatesTokenCount: 0,
    promptTokensDetails: [{ modality: "AUDIO", tokenCount: 3000 }], cacheTokensDetails: [{ modality: "AUDIO", tokenCount: 2000 }] });
  assert.equal(price(m).cost_usd, Number(((1000 * 1.00 + 2000 * 0.10) / 1e6).toFixed(6)));
  const lite = costForUsage("gemini-2.5-flash-lite", { ...m.usage });
  assert.equal(lite.cost_usd, Number(((1000 * 0.30 + 2000 * 0.03) / 1e6).toFixed(6)));
});

test("AC2: gpt-image-1 images/generations priced at $5 text, $10 image input, $40 image output", () => {
  const m = extractUsage("openai", JSON.stringify({ usage: { input_tokens: 50, output_tokens: 4160, input_tokens_details: { text_tokens: 50, image_tokens: 0 } } }), "gpt-image-1");
  const r = price(m);
  assert.equal(r.cost_usd, Number(((50 * 5 + 4160 * 40) / 1e6).toFixed(6)));
  assert.equal(r.cost_source, "table");
  const edit = extractUsage("openai", JSON.stringify({ usage: { input_tokens: 1050, output_tokens: 100, input_tokens_details: { text_tokens: 50, image_tokens: 1000 } } }), "gpt-image-1");
  assert.equal(price(edit).cost_usd, Number(((50 * 5 + 1000 * 10 + 100 * 40) / 1e6).toFixed(6)));
});

test("OpenAI cached image tokens split via cached_tokens_details", () => {
  const m = extractUsage("openai", JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 0, input_tokens_details: { cached_tokens: 400, image_tokens: 800, cached_tokens_details: { image_tokens: 400 } } } }), "gpt-image-1");
  assert.deepEqual(m.usage.modality_tokens.input, { text: 200, image: 400, audio: 0, video: 0 });
  assert.equal(price(m).cost_usd, Number(((200 * 5 + 400 * 10 + 400 * 2.5) / 1e6).toFixed(6)));
});

test("AC3: fallback model with audio and priced text model with image/audio are modality_unpriced", () => {
  const unknown = extractUsage("openai", JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { audio_tokens: 40 } } }), "mystery-audio-1");
  const a = price(unknown);
  assert.equal(a.cost_usd, null); assert.equal(a.reason, "modality_unpriced"); assert.equal(a.fallback, true);
  const out = extractUsage("openai", JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 10, completion_tokens_details: { audio_tokens: 5 } } }), "gpt-4o");
  assert.equal(price(out).reason, "modality_unpriced");
  const img = extractUsage("openai", JSON.stringify({ usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { image_tokens: 60 } } }), "gpt-4o-mini");
  assert.equal(price(img).cost_usd, null);
  // Gemini image output on flash has no published modality rate here: unknown, never text.
  const gout = gem({ promptTokenCount: 10, candidatesTokenCount: 1290, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }] });
  assert.equal(price(gout).reason, "modality_unpriced");
});

test("AC4: text-only usage is unchanged for every model in the table", () => {
  const { models } = JSON.parse(require_table());
  for (const model of Object.keys(models)) {
    const base = { input_tokens: 1234, cached_input_tokens: 56, output_tokens: 789 };
    const textOnly = { ...base, modality_tokens: undefined };
    assert.equal(costForUsage(model, textOnly).cost_usd, costForUsage(model, base).cost_usd, model);
  }
  const t = gem({ promptTokenCount: 100, candidatesTokenCount: 10, promptTokensDetails: [{ modality: "TEXT", tokenCount: 100 }], candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 10 }] });
  assert.equal(t.usage.modality_tokens, undefined);
  assert.equal(price(t).cost_usd, Number(((100 * 0.3 + 10 * 2.5) / 1e6).toFixed(6)));
});

test("AC4: uniform_modalities prices audio at the single input rate; flash vision stays at the text rate", () => {
  const usage = { input_tokens: 10000, output_tokens: 0, cached_input_tokens: 0, modality_tokens: { input: { text: 0, image: 0, audio: 10000, video: 0 }, cached_input: null, output: null } };
  assert.equal(costForUsage("gemini-2.5-pro", usage).cost_usd, Number((10000 * 1.25 / 1e6).toFixed(6)));
  assert.equal(costForUsage("gemini-3.8-flash", usage).cost_usd, Number((10000 * 0.75 / 1e6).toFixed(6)));
  const vision = gem({ promptTokenCount: 2000, candidatesTokenCount: 0, promptTokensDetails: [{ modality: "IMAGE", tokenCount: 1500 }, { modality: "VIDEO", tokenCount: 500 }] });
  assert.equal(price(vision).cost_usd, Number((2000 * 0.30 / 1e6).toFixed(6)));
});

test("batch multiplier scales modality rates; 6 dp rounding", () => {
  const usage = { input_tokens: 3, output_tokens: 0, cached_input_tokens: 0, modality_tokens: { input: { text: 0, image: 3, audio: 0, video: 0 }, cached_input: null, output: null } };
  assert.equal(costForUsage("gpt-image-1", usage, { batch: "openai" }).cost_usd, Number((3 * 5 / 1e6).toFixed(6)));
  assert.equal(costForUsage("gpt-image-1", usage).cost_usd, 0.00003);
});

test("helpers: slices, null/garbage inputs", () => {
  assert.equal(geminiModalitySlice(undefined), null);
  assert.equal(geminiModalitySlice([]), null);
  assert.deepEqual(geminiModalitySlice([{ modality: "DOCUMENT", tokenCount: 5 }, { modality: "AUDIO", tokenCount: -1 }, null]), { text: 5, image: 0, audio: 0, video: 0 });
  assert.equal(openaiModalitySlice(null, 1), null);
  assert.equal(openaiModalitySlice({ cached_tokens: 3 }, 10), null);
  assert.deepEqual(modalityAdjustment(lookupPrice("gpt-4o"), {}, null), { delta: 0, unpriced: false });
});

import { readFileSync } from "node:fs";
function require_table() { return readFileSync(new URL("../src/pricing-table.json", import.meta.url), "utf8"); }
