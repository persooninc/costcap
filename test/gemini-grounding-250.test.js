// #250: Grounding with Google Search on Gemini (API + Vertex) priced per query (3+) or per prompt (2.x).
// Local stubs only: no Google calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy, extractUsage, geminiGroundingCalls } from "../src/proxy.js";
import { costForUsage, googleSearchBilling, toolRate, loadPricingTable } from "../src/pricing.js";
import { validateToolPrices, withToolCost, TOOL_OVERRIDE_KEYS } from "../src/price-overrides.js";
import { foldBatchResults } from "../src/batch.js";
import { estimateWorstCase, preflightCheck, toolWorstCase } from "../src/preflight.js";
import { createCapEngine } from "../src/cap.js";
import "./support/pinned-clock.js";

const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 };
const tokenCost = (model) => costForUsage(model, { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 }).cost_usd;
const web = (uri) => ({ web: { uri, title: "t" } });
const grounded = (model, gm, extra = {}) => ({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP", groundingMetadata: gm, ...extra }], usageMetadata, modelVersion: model });

test("table: gemini and vertex google_search rows, billing unit per family", () => {
  const { table, verification } = loadPricingTable();
  assert.equal(verification.ok, true);
  assert.ok(table.sources.some((s) => s.includes("#250")));
  assert.ok(!table.sources.some((s) => s.includes("Gemini grounding stays unpriced")));
  assert.equal(toolRate("gemini", "google_search", "gemini-3.8-flash"), 0.014);
  assert.equal(toolRate("gemini", "google_search", "gemini-4-carbon"), 0.014);
  assert.equal(toolRate("gemini", "google_search", "gemini-2.5-pro"), 0.035);
  assert.equal(toolRate("gemini", "google_search", "gemini-2.0-flash"), 0.035);
  assert.equal(toolRate("vertex", "google_search", "gemini-2.5-flash"), 0.035);
  assert.equal(toolRate("vertex", "google_search", "gemini-3.8-flash"), 0.014);
  assert.equal(googleSearchBilling("gemini-3.8-flash"), "query");
  assert.equal(googleSearchBilling("gemini-2.5-pro"), "prompt");
  assert.equal(googleSearchBilling("gemini-1.5-pro"), null);
  assert.equal(googleSearchBilling("gemini-2.5-pro", "openai"), null);
});

test("geminiGroundingCalls: unique non-empty queries, per-prompt once, never-$0 shapes", () => {
  assert.deepEqual(geminiGroundingCalls([{ webSearchQueries: ["a", "b", "a", ""] }], "gemini-3.8-flash"), { unpriced: false, calls: 2 });
  assert.deepEqual(geminiGroundingCalls([{ webSearchQueries: ["a"] }, { webSearchQueries: ["b", "a"] }], "gemini-3.8-flash"), { unpriced: false, calls: 2 });
  assert.deepEqual(geminiGroundingCalls([{ webSearchQueries: ["a", "b", "c"], groundingChunks: [web("u")] }], "gemini-2.5-pro"), { unpriced: false, calls: 1 });
  assert.deepEqual(geminiGroundingCalls([{ webSearchQueries: [] }], "gemini-2.5-pro"), { unpriced: false, calls: 0 });
  assert.deepEqual(geminiGroundingCalls([{ groundingChunks: [web("u")] }], "gemini-2.5-pro"), { unpriced: true });
  assert.deepEqual(geminiGroundingCalls([{ webSearchQueries: ["a"], groundingChunks: [{ maps: { uri: "m" } }] }], "gemini-2.5-pro"), { unpriced: true });
  assert.deepEqual(geminiGroundingCalls([{ groundingChunks: [{ retrievedContext: { uri: "r" } }] }], "gemini-2.5-pro"), { unpriced: true });
  assert.deepEqual(geminiGroundingCalls([{ googleMapsWidgetContextToken: "w" }], "gemini-2.5-pro"), { unpriced: true });
  assert.deepEqual(geminiGroundingCalls([{ retrievalQueries: ["q"] }], "gemini-2.5-pro"), { unpriced: true });
  assert.deepEqual(geminiGroundingCalls([{ webSearchQueries: ["a"] }], "gemini-1.5-pro"), { unpriced: true });
  assert.deepEqual(geminiGroundingCalls([null, { groundingChunks: [null] }], "gemini-2.5-pro"), { unpriced: false, calls: 0 });
});

test("extractUsage: grounded body and streams (last metadata per candidate wins)", () => {
  const m = extractUsage("gemini", JSON.stringify(grounded("gemini-3.8-flash", { webSearchQueries: ["a", "b", "a", ""] })), "gemini-3.8-flash");
  assert.deepEqual(m.toolCalls, { google_search: 2 });
  const plain = extractUsage("gemini", JSON.stringify({ ...grounded("gemini-2.5-pro", {}), candidates: [{ finishReason: "STOP" }] }), "gemini-2.5-pro");
  assert.equal(plain.toolCalls, undefined);
  const stream = [
    { candidates: [{ index: 0, content: { parts: [{ text: "x" }] }, groundingMetadata: { webSearchQueries: ["a", "b", "c", "d"] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1 } },
    { candidates: [{ index: 0, finishReason: "STOP", groundingMetadata: { webSearchQueries: ["a"] } }], usageMetadata, modelVersion: "gemini-3.8-flash" },
  ];
  assert.deepEqual(extractUsage("gemini", JSON.stringify(stream), "gemini-3.8-flash").toolCalls, { google_search: 1 });
  assert.equal(extractUsage("gemini", JSON.stringify(grounded("gemini-2.5-pro", { groundingChunks: [web("u")] })), "gemini-2.5-pro").toolUseUnpriced, true);
});

async function setup(t, respond, opts = {}) {
  const hits = [];
  const up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push(req.url);
      const { body, sse } = respond(req.url);
      if (sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const c of body) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receipts = [];
  const { server, port } = await startMeteringProxy({ receiptsPath: join(mkdtempSync(join(tmpdir(), "cc-gg-")), "r.jsonl"),
    upstreams: { gemini: base, vertex: base }, onReceipt: (r) => receipts.push(r), onWarning: () => {}, ...opts });
  t.after(() => { up.closeAllConnections(); up.close(); server.closeAllConnections(); server.close(); });
  const call = (p, body = { contents: [{ parts: [{ text: "hi" }] }], tools: [{ googleSearch: {} }] }) =>
    fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ya29.t" }, body: JSON.stringify(body) });
  return { hits, receipts, call };
}

test("AC1 gemini-3.8-flash: 2 unique queries -> $0.028 tool cost, counts toward run and day caps", async (t) => {
  const cap = createCapEngine({ caps: { run: 10, day: 10 } });
  const { hits, receipts, call } = await setup(t, () => ({ body: grounded("gemini-3.8-flash", { webSearchQueries: ["a", "b", "a", ""], groundingChunks: [web("u")] }) }), { cap });
  const r = await call("/gemini/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(r.status, 200);
  await r.arrayBuffer();
  const rc = receipts[0];
  assert.deepEqual(rc.tool_calls, { google_search: 2 });
  assert.equal(rc.tool_cost_usd, 0.028);
  assert.equal(rc.cost_usd, Number((tokenCost("gemini-3.8-flash") + 0.028).toFixed(6)));
  assert.equal(rc.reason, undefined);
  assert.equal((await call("/gemini/v1beta/models/gemini-3.8-flash:generateContent")).status, 200);
  assert.equal(hits.length, 2);
  const s = cap.spend();
  assert.ok(Math.abs(s.run - 2 * rc.cost_usd) < 1e-9 && Math.abs(s.day - 2 * rc.cost_usd) < 1e-9);
});

test("AC2 gemini-2.5-pro per prompt: non-stream and SSE (metadata on the final chunk); zero queries adds $0", async (t) => {
  const gm = { webSearchQueries: ["a", "b", "c"], groundingChunks: [web("u")] };
  const { receipts, call } = await setup(t, (url) => {
    if (url.includes("zero")) return { body: grounded("gemini-2.5-pro", { webSearchQueries: [] }) };
    if (url.includes("alt=sse")) return { sse: true, body: [
      { candidates: [{ content: { parts: [{ text: "x" }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1 } },
      grounded("gemini-2.5-pro", gm)] };
    return { body: grounded("gemini-2.5-pro", gm) };
  });
  await (await call("/gemini/v1beta/models/gemini-2.5-pro:generateContent")).arrayBuffer();
  await (await call("/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse")).arrayBuffer();
  await (await call("/gemini/v1beta/models/gemini-2.5-pro:generateContent?zero=1")).arrayBuffer();
  for (const rc of receipts.slice(0, 2)) {
    assert.deepEqual(rc.tool_calls, { google_search: 1 });
    assert.equal(rc.tool_cost_usd, 0.035);
    assert.equal(rc.cost_usd, Number((tokenCost("gemini-2.5-pro") + 0.035).toFixed(6)));
  }
  assert.equal(receipts[2].tool_calls, undefined);
  assert.equal(receipts[2].tool_cost_usd, undefined);
  assert.equal(receipts[2].cost_usd, tokenCost("gemini-2.5-pro"));
});

test("AC3 Vertex gemini-2.5-flash grounding priced at $0.035 per prompt", async (t) => {
  const { receipts, call } = await setup(t, () => ({ body: grounded("gemini-2.5-flash", { webSearchQueries: ["a", "b"], groundingChunks: [web("u")] }) }));
  const r = await call("/vertex/v1/projects/p/locations/global/publishers/google/models/gemini-2.5-flash:generateContent");
  assert.equal(r.status, 200);
  await r.arrayBuffer();
  const rc = receipts[0];
  assert.equal(rc.provider, "vertex");
  assert.deepEqual(rc.tool_calls, { google_search: 1 });
  assert.equal(rc.tool_cost_usd, 0.035);
  assert.equal(rc.cost_usd, Number((costForUsage("gemini-2.5-flash", { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 }).cost_usd + 0.035).toFixed(6)));
});

test("AC4 never $0: web chunks without queries and Maps grounding are tool_use_unpriced and pause; plain calls unchanged", async (t) => {
  for (const [gm, tools] of [[{ groundingChunks: [web("u")] }, [{ googleSearch: {} }]], [{ groundingChunks: [{ maps: { uri: "m" } }] }, [{ googleMaps: {} }]]]) {
    const { hits, receipts, call } = await setup(t, () => ({ body: grounded("gemini-2.5-pro", gm) }), { cap: createCapEngine({ caps: { run: 10 } }) });
    const body = { contents: [{ parts: [{ text: "hi" }] }], tools };
    await (await call("/gemini/v1beta/models/gemini-2.5-pro:generateContent", body)).arrayBuffer();
    assert.equal(receipts[0].cost_usd, null);
    assert.equal(receipts[0].reason, "tool_use_unpriced");
    assert.notEqual((await call("/gemini/v1beta/models/gemini-2.5-pro:generateContent", body)).status, 200);
    assert.equal(hits.length, 1);
  }
  const plain = { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }], usageMetadata, modelVersion: "gemini-2.5-pro" };
  const { receipts, call } = await setup(t, () => ({ body: plain }));
  await (await call("/gemini/v1beta/models/gemini-2.5-pro:generateContent", { contents: [] })).arrayBuffer();
  assert.equal(receipts[0].cost_usd, tokenCost("gemini-2.5-pro"));
  assert.equal(receipts[0].tool_calls, undefined);
});

test("AC5 batch line: tokens at 0.5x plus the full tool rate; --prices google_search override pins user_prices", () => {
  const line = JSON.stringify({ response: grounded("gemini-2.5-pro", { webSearchQueries: ["a"], groundingChunks: [web("u")] }) });
  const f = foldBatchResults("gemini", line, null, { model: "gemini-2.5-pro" });
  assert.equal(f.ok, true);
  assert.equal(f.cost_usd, Number((tokenCost("gemini-2.5-pro") * 0.5 + 0.035).toFixed(6)));
  assert.ok(TOOL_OVERRIDE_KEYS.includes("google_search"));
  validateToolPrices("p.json", { google_search: 0.01 });
  assert.throws(() => validateToolPrices("p.json", { google_search: 0 }), /never \$0/);
  const base = costForUsage("gemini-3.8-flash", { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 });
  const r = withToolCost(base, { tools: { google_search: 0.01 } }, "gemini", { model: "gemini-3.8-flash", toolCalls: { google_search: 2 } }, {});
  assert.equal(r.tool_cost_usd, 0.02);
  assert.equal(r.cost_source, "user_prices");
  // An unpriced batch line (web chunks, no queries) makes the batch unknown, never $0.
  assert.equal(foldBatchResults("gemini", JSON.stringify({ response: grounded("gemini-2.5-pro", { groundingChunks: [web("u")] }) }), null, { model: "gemini-2.5-pro" }).ok, false);
});

test("AC6 preflight: per-prompt Google Search adds 1x rate; per-query adds nothing; refuses past the cap", () => {
  const path = "/v1beta/models/gemini-2.5-pro:generateContent";
  const req = { contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 100 } };
  const without = estimateWorstCase("gemini", JSON.stringify(req), path);
  const withSearch = estimateWorstCase("gemini", JSON.stringify({ ...req, tools: [{ googleSearch: {} }] }), path);
  // The tools JSON also adds a few input bytes to the estimate; the tool allowance is exactly 1 x $0.035.
  assert.equal(withSearch.tool_usd_max, 0.035);
  assert.ok(withSearch.estimate_usd - without.estimate_usd >= 0.035 && withSearch.estimate_usd - without.estimate_usd < 0.0351);
  assert.equal(withSearch.tool_calls_max, 1);
  assert.deepEqual(toolWorstCase("gemini", { tools: [{ google_search: {} }] }, "gemini-3.8-flash"), { ok: true, usd: 0, calls: 0 });
  assert.deepEqual(toolWorstCase("gemini", { tools: [{ functionDeclarations: [] }] }, "gemini-2.5-pro"), { ok: true, usd: 0, calls: 0 });
  assert.equal(toolWorstCase("gemini", { tools: [{ googleSearchRetrieval: {} }] }, "gemini-2.0-flash").usd, 0.035);
  const cap = createCapEngine({ caps: { run: Number((without.estimate_usd + 0.01).toFixed(6)) } });
  assert.equal(preflightCheck(cap, "gemini", JSON.stringify(req), path), null);
  assert.equal(preflightCheck(cap, "gemini", JSON.stringify({ ...req, tools: [{ googleSearch: {} }] }), path).reason, "preflight_estimate");
});
