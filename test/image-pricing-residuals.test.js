// #275: gpt-image-2.5-* never fallback-priced on the images endpoints, gemini-nano-banana-2.1 row,
// detail-less Gemini image output priced at the image rate (never text).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costForUsage, lookupPrice, loadPricingTable } from "../src/pricing.js";
import { extractUsage, isImagesPath, startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import "./support/pinned-clock.js";

const IMG = (details) => ({ created: 1, data: [{ b64_json: "x" }], usage: { input_tokens: 50, output_tokens: 4160, input_tokens_details: { text_tokens: 50, image_tokens: 0 }, ...(details && { output_tokens_details: { image_tokens: 4160, text_tokens: 0 } }) } });
const gem = (model, meta) => JSON.stringify({ modelVersion: model, candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: meta });
const price = (m) => costForUsage(m.model, m.usage);

test("isImagesPath matches only exact generations/edits paths", () => {
  for (const p of ["/openai/v1/images/generations", "/openai/v1/images/edits", "/openrouter/v1/images/generations?x=1"]) assert.equal(isImagesPath(p), true, p);
  for (const p of ["/openai/v1/images/variations", "/openai/v1/images/../chat/completions", "/openai/v1/images%2Fedits", "/gemini/v1/images/generations", null]) assert.equal(isImagesPath(p), false, String(p));
});

test("AC1: gpt-image-2.5-* on images endpoints is modality_unpriced with or without output details", () => {
  for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]) for (const details of [false, true]) {
    const r = price(extractUsage("openai", JSON.stringify(IMG(details)), model, { images: true }));
    assert.equal(r.cost_usd, null, `${model} ${details}`);
    assert.equal(r.reason, "modality_unpriced");
  }
  assert.equal(lookupPrice("gpt-image-2.5-sunburst").fallback, true);
});

test("AC1: table-priced gpt-image-2.6 unchanged by the images flag", () => {
  assert.equal(price(extractUsage("openai", JSON.stringify(IMG(false)), "gpt-image-2.6-sunburst", { images: true })).cost_usd, 0.12505);
});

test("non-images text endpoints still text-price undetailed output", () => {
  const body = JSON.stringify({ model: "gpt-5.5", usage: { prompt_tokens: 10, completion_tokens: 10 } });
  assert.ok(price(extractUsage("openai", body, "gpt-5.5")).cost_usd > 0);
});

test("AC2: gemini-nano-banana-2.1 priced from its row: 10 text in + 1120 image out", () => {
  const meta = { promptTokenCount: 10, candidatesTokenCount: 1120, promptTokensDetails: [{ modality: "TEXT", tokenCount: 10 }], candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }] };
  const r = price(extractUsage("gemini", gem("gemini-nano-banana-2.1", meta)));
  assert.equal(r.cost_source, "table");
  assert.equal(r.cost_usd, Number(((10 * 1.5 + 1120 * 30) / 1e6).toFixed(6)));
  const m = extractUsage("gemini", gem("gemini-nano-banana-2.1", meta));
  assert.equal(costForUsage(m.model, m.usage, { batch: "gemini" }).cost_usd, Number((((10 * 1.5 + 1120 * 30) / 1e6) * 0.5).toFixed(6)));
  assert.equal(costForUsage("gemini-nano-banana-2.1", { input_tokens: 10, output_tokens: 100 }).cost_usd, Number(((10 * 1.5 + 100 * 7.5) / 1e6).toFixed(6)));
  const t = loadPricingTable();
  assert.equal(t.verification.ok, true);
  assert.ok(t.table.sources.some((s) => s.includes("gemini-nano-banana-2.1") && s.includes("retrieved 2026-11-17")));
});

test("AC3: detail-less Gemini output on image rows prices candidates at the image rate", () => {
  const rows = ["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image", "gemini-nano-banana-2.1"];
  for (const id of rows) {
    const row = lookupPrice(id);
    const r = price(extractUsage("gemini", gem(id, { promptTokenCount: 10, candidatesTokenCount: 1120, thoughtsTokenCount: 20 })));
    assert.equal(r.cost_usd, Number(((10 * row.input + 1120 * row.modalities.image.output + 20 * row.output) / 1e6).toFixed(6)), id);
  }
  assert.equal(price(extractUsage("gemini", gem("gemini-3.1-flash-image", { promptTokenCount: 10, candidatesTokenCount: 1120 }))).cost_usd, 0.067205);
  // A text-only Gemini row keeps text pricing when details are absent.
  const txt = price(extractUsage("gemini", gem("gemini-2.5-flash", { promptTokenCount: 10, candidatesTokenCount: 100 })));
  assert.equal(txt.cost_usd, Number(((10 * 0.3 + 100 * 2.5) / 1e6).toFixed(6)));
});

test("e2e AC1: 2 gpt-image-2.5 images never pass a $1 run cap; second call 429 accounting_unavailable", async (t) => {
  let hits = 0;
  const up = http.createServer((req, res) => { req.resume(); req.on("end", () => { hits++; res.end(JSON.stringify(IMG(false))); }); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = join(mkdtempSync(join(tmpdir(), "cc-275-")), "r.jsonl");
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, receiptsPath: receipts, cap: createCapEngine({ caps: { run: 1 } }) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const post = (path) => fetch(`http://127.0.0.1:${p.port}/openai${path}`, { method: "POST", body: JSON.stringify({ model: "gpt-image-2.5-sunburst", prompt: "cat" }) });
  const first = await post("/v1/images/generations"); await first.text(); assert.equal(first.status, 200);
  const second = await post("/v1/images/edits");
  assert.equal(second.status, 429);
  assert.match(await second.text(), /accounting_unavailable/);
  assert.equal(hits, 1);
  const [rec] = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.event);
  assert.equal(rec.cost_usd, null);
  assert.equal(rec.reason, "modality_unpriced");
});
