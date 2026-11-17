// #269: gpt-image-2.6 and Gemini native image models priced from the table; Responses
// image_generation_call is never priced from text tokens alone.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costForUsage, lookupPrice, loadPricingTable } from "../src/pricing.js";
import { extractUsage, startMeteringProxy } from "../src/proxy.js";
import { createModelCaps } from "../src/model-cap.js";
import { pricingCommand } from "../src/pricing-cli.js";
import "./support/pinned-clock.js";

const IMG_USAGE = (details) => ({ created: 1, data: [{ b64_json: "x" }], usage: { input_tokens: 50, output_tokens: 4160, total_tokens: 4210, input_tokens_details: { text_tokens: 50, image_tokens: 0 }, ...(details && { output_tokens_details: { image_tokens: 4160, text_tokens: 0 } }) } });
const EDIT_USAGE = { created: 1, data: [{ b64_json: "x" }], usage: { input_tokens: 350, output_tokens: 4160, input_tokens_details: { text_tokens: 50, image_tokens: 300 } } };
const GEM_META = { promptTokenCount: 570, candidatesTokenCount: 1160, promptTokensDetails: [{ modality: "TEXT", tokenCount: 10 }, { modality: "IMAGE", tokenCount: 560 }], candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }, { modality: "TEXT", tokenCount: 40 }] };
const GEM_25_META = { promptTokenCount: 10, candidatesTokenCount: 1290, promptTokensDetails: [{ modality: "TEXT", tokenCount: 10 }], candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }] };
const gemBody = (model, meta) => ({ modelVersion: model, candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] }, finishReason: "STOP" }], usageMetadata: meta });
const price = (m) => costForUsage(m.model, m.usage);
const NEW_IDS = ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image"];

test("AC1: gpt-image-2.6-sunburst costs 0.12505 with and without output image details", () => {
  for (const details of [false, true]) {
    const r = price(extractUsage("openai", JSON.stringify(IMG_USAGE(details)), "gpt-image-2.6-sunburst"));
    assert.equal(r.cost_usd, 0.12505);
    assert.equal(r.cost_source, "table");
    assert.equal(r.reason, undefined);
  }
});

test("AC2: gpt-image-2.6-flare edit with image input costs 0.12745", () => {
  assert.equal(price(extractUsage("openai", JSON.stringify(EDIT_USAGE), "gpt-image-2.6-flare")).cost_usd, 0.12745);
});

test("AC3: Gemini image models price IMAGE output at the image rate, input at the listed rate", () => {
  const g = (model, meta) => price(extractUsage("gemini", JSON.stringify(gemBody(model, meta))));
  assert.equal(g("gemini-3.1-flash-image", GEM_META).cost_usd, 0.067605);
  assert.equal(g("gemini-3-pro-image", GEM_META).cost_usd, 0.13602);
  assert.equal(g("gemini-2.5-flash-image", GEM_25_META).cost_usd, 0.038703);
  assert.equal(g("gemini-3.1-flash-lite-image", GEM_META).cost_usd, Number(((570 * 0.25 + 1120 * 30 + 40 * 1.5) / 1e6).toFixed(6)));
  const m = extractUsage("gemini", JSON.stringify(gemBody("gemini-3.1-flash-image", GEM_META)));
  assert.equal(costForUsage(m.model, m.usage, { batch: "gemini" }).cost_usd, Number((0.067605 * 0.5).toFixed(6)));
});

test("Gemini image models have no cached rate: cache reads stay unknown, never NaN or $0", () => {
  const r = costForUsage("gemini-3-pro-image", { input_tokens: 10, cached_input_tokens: 100, output_tokens: 5 });
  assert.equal(r.cost_usd, null);
  assert.equal(r.reason, "cache_read_unpriced");
});

test("AC6 guards: unlisted gpt-image-9 stays modality_unpriced; new ids are table priced; gpt-image-2.5 stays unknown", () => {
  const r = price(extractUsage("openai", JSON.stringify(IMG_USAGE(true)), "gpt-image-9"));
  assert.equal(r.cost_usd, null);
  assert.equal(r.reason, "modality_unpriced");
  for (const id of NEW_IDS) assert.equal(lookupPrice(id).fallback, false, id);
  assert.equal(lookupPrice("gpt-image-2.5-sunburst").fallback, true);
  assert.equal(loadPricingTable().verification.ok, true);
});

test("AC6: pricing show gemini-3-pro-image prints the image output rate", async () => {
  const r = pricingCommand(["show", "gemini-3-pro-image"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /120/);
});

test("AC4: Responses image_generation_call is tool_use_unpriced; a failed item is priced on tokens", () => {
  const body = (status) => JSON.stringify({ model: "gpt-5.5", output: [{ id: "ig_1", type: "image_generation_call", status }, { type: "message", content: [] }], usage: { input_tokens: 100, output_tokens: 50 } });
  const done = extractUsage("openai", body("completed"), "gpt-5.5");
  assert.equal(done.toolUseUnpriced, true);
  assert.equal(done.unpricedTool, "Responses image_generation");
  const failed = extractUsage("openai", body("failed"), "gpt-5.5");
  assert.equal(failed.toolUseUnpriced, undefined);
  assert.ok(price(failed).cost_usd > 0);
});

async function proxy(t, provider, handler, opts = {}) {
  let hits = 0;
  const up = http.createServer((req, res) => { req.resume(); req.on("end", () => { hits++; handler(req, res); }); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = join(mkdtempSync(join(tmpdir(), "cc-269-")), "r.jsonl");
  const p = await startMeteringProxy({ upstreams: { [provider]: `http://127.0.0.1:${up.address().port}` }, receiptsPath: receipts, ...opts });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  return { base: `http://127.0.0.1:${p.port}/${provider}`, receipts, hits: () => hits };
}
const readReceipts = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.event);
const post = (url, body) => fetch(url, { method: "POST", body: JSON.stringify(body) });

test("e2e AC1/AC2: image generations and edits are table priced and the next call is forwarded", async (t) => {
  let n = 0;
  const f = await proxy(t, "openai", (req, res) => res.end(JSON.stringify(n++ % 2 ? EDIT_USAGE : IMG_USAGE(true))));
  assert.equal((await post(`${f.base}/v1/images/generations`, { model: "gpt-image-2.6-sunburst", prompt: "cat" })).status, 200);
  assert.equal((await post(`${f.base}/v1/images/edits`, { model: "gpt-image-2.6-flare", prompt: "cat" })).status, 200);
  const third = await post(`${f.base}/v1/images/generations`, { model: "gpt-image-2.6-sunburst", prompt: "cat" });
  await third.text();
  assert.equal(third.status, 200);
  const recs = readReceipts(f.receipts);
  assert.deepEqual(recs.slice(0, 2).map((r) => r.cost_usd), [0.12505, 0.12745]);
  assert.ok(recs.every((r) => r.cost_source === "table" && !r.reason));
});

for (const sse of [false, true]) {
  test(`e2e AC3: Gemini image model generateContent (${sse ? "SSE" : "JSON"})`, async (t) => {
    const body = gemBody("gemini-3.1-flash-image", GEM_META);
    const f = await proxy(t, "gemini", (req, res) => res.end(sse ? `data: ${JSON.stringify(body)}\r\n\r\n` : JSON.stringify(body)));
    const path = `${f.base}/v1beta/models/gemini-3.1-flash-image:${sse ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    await (await post(path, { contents: [] })).text();
    const second = await post(path, { contents: [] });
    await second.text();
    assert.equal(second.status, 200);
    assert.equal(readReceipts(f.receipts)[0].cost_usd, 0.067605);
  });
}

test("e2e AC4: streamed image_generation_call freezes the run with tool_use_unpriced", async (t) => {
  const events = [
    { type: "response.output_item.added", item: { id: "ig_1", type: "image_generation_call", status: "in_progress" } },
    { type: "response.output_item.done", item: { id: "ig_1", type: "image_generation_call", status: "completed" } },
    { type: "response.completed", response: { model: "gpt-5.5", output: [{ id: "ig_1", type: "image_generation_call", status: "completed" }], usage: { input_tokens: 100, output_tokens: 50 } } },
  ];
  const f = await proxy(t, "openai", (req, res) => res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")));
  await (await post(`${f.base}/v1/responses`, { model: "gpt-5.5", stream: true, tools: [{ type: "image_generation" }] })).text();
  const second = await post(`${f.base}/v1/responses`, { model: "gpt-5.5" });
  assert.equal(second.status, 429);
  assert.match(await second.text(), /accounting_unavailable/);
  assert.equal(f.hits(), 1);
  const [rec] = readReceipts(f.receipts);
  assert.equal(rec.cost_usd, null);
  assert.equal(rec.reason, "tool_use_unpriced");
});

test("e2e AC5: --model-cap gpt-image-2.6-sunburst:day=1 forwards 8 images and refuses the 9th", async (t) => {
  const modelCaps = createModelCaps({ rules: [{ model: "gpt-image-2.6-sunburst", scope: "day", cap: 1 }] });
  const f = await proxy(t, "openai", (req, res) => res.end(JSON.stringify(IMG_USAGE(false))), { modelCaps });
  for (let i = 0; i < 8; i++) {
    const r = await post(`${f.base}/v1/images/generations`, { model: "gpt-image-2.6-sunburst", prompt: `cat ${i}` });
    await r.text();
    assert.equal(r.status, 200, `image ${i + 1}`);
  }
  const ninth = await post(`${f.base}/v1/images/generations`, { model: "gpt-image-2.6-sunburst", prompt: "cat" });
  assert.equal(ninth.status, 429);
  assert.equal((await ninth.json()).error, "model_budget_exceeded");
  assert.equal(f.hits(), 8);
});

test("#276: gpt-audio rows have no cached rate: cache reads stay cache_read_unpriced", () => {
  for (const id of ["gpt-audio-1.5", "gpt-audio", "gpt-audio-mini"]) {
    const r = costForUsage(id, { input_tokens: 10, cached_input_tokens: 100, output_tokens: 5 });
    assert.equal(r.cost_usd, null, id);
    assert.equal(r.reason, "cache_read_unpriced", id);
  }
});
