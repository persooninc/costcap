// #260: Vertex Gemini 3/4 grounding per query, and the Gemini API Dec 1 billed_as remap covers grounding.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy, billedAsGrounding } from "../src/proxy.js";
import { costForUsage, toolRate, googleSearchBilling, loadPricingTable } from "../src/pricing.js";
import "./support/pinned-clock.js";

const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 };
const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 };
const web = (uri) => ({ web: { uri, title: "t" } });
const grounded = (model, gm) => ({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP", groundingMetadata: gm }], usageMetadata, modelVersion: model });

function withClock(t, at) {
  const prev = process.env.COSTCAP_PRICING_CLOCK;
  process.env.COSTCAP_PRICING_CLOCK = at;
  t.after(() => { if (prev === undefined) delete process.env.COSTCAP_PRICING_CLOCK; else process.env.COSTCAP_PRICING_CLOCK = prev; });
}

async function setup(t, respond) {
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
  const { server, port } = await startMeteringProxy({ receiptsPath: join(mkdtempSync(join(tmpdir(), "cc-gg260-")), "r.jsonl"),
    upstreams: { gemini: base, vertex: base }, onReceipt: (r) => receipts.push(r), onWarning: () => {} });
  t.after(() => { up.closeAllConnections(); up.close(); server.closeAllConnections(); server.close(); });
  const call = async (p) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ya29.t" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], tools: [{ googleSearch: {} }] }) });
    await r.arrayBuffer();
    return r.status;
  };
  return { hits, receipts, call };
}

const vertexPath = (loc, model, verb = "generateContent") => `/vertex/v1/projects/p/locations/${loc}/publishers/google/models/${model}:${verb}`;

test("table: Vertex gemini-3/gemini-4 grounding at $0.014 per query; sources cite #260", () => {
  const { table, verification } = loadPricingTable();
  assert.equal(verification.ok, true);
  assert.ok(table.sources.filter((s) => s.includes("#260")).length >= 2);
  for (const m of ["gemini-4-hydrogen", "gemini-4-carbon", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"]) assert.equal(toolRate("vertex", "google_search", m), 0.014, m);
  assert.equal(toolRate("vertex", "google_search", "gemini-2.5-pro"), 0.035);
  assert.equal(table.tools.vertex.google_search.billing["gemini-4"], "query");
  assert.equal(googleSearchBilling("gemini-4-hydrogen", "vertex"), "query");
});

test("AC1 Vertex global gemini-4-hydrogen, gemini-3.8-flash and a stream: 2 queries -> $0.028, run not paused", async (t) => {
  for (const [model, verb] of [["gemini-4-hydrogen", "generateContent"], ["gemini-3.8-flash", "generateContent"], ["gemini-4-hydrogen", "streamGenerateContent?alt=sse"]]) {
    const gm = { webSearchQueries: ["a", "b"], groundingChunks: [web("u")] };
    const { hits, receipts, call } = await setup(t, (url) => url.includes("alt=sse")
      ? { sse: true, body: [{ candidates: [{ content: { parts: [{ text: "x" }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1 } }, grounded(model, gm)] }
      : { body: grounded(model, gm) });
    assert.equal(await call(vertexPath("global", model, verb)), 200);
    const rc = receipts[0];
    assert.equal(rc.provider, "vertex");
    assert.equal(rc.reason, undefined, `${model} ${verb}`);
    assert.deepEqual(rc.tool_calls, { google_search: 2 });
    assert.equal(rc.tool_cost_usd, 0.028);
    assert.equal(rc.cost_usd, Number((costForUsage(model, usage, { vertex: true }).cost_usd + 0.028).toFixed(6)));
    assert.equal(await call(vertexPath("global", model, verb)), 200);
    assert.equal(hits.length, 2);
  }
});

test("AC2 regional us-central1: x1.1 on tokens only, grounding stays $0.028", async (t) => {
  const { receipts, call } = await setup(t, () => ({ body: grounded("gemini-4-hydrogen", { webSearchQueries: ["a", "b"] }) }));
  assert.equal(await call(vertexPath("us-central1", "gemini-4-hydrogen")), 200);
  const rc = receipts[0];
  assert.equal(rc.tool_cost_usd, 0.028);
  const tokens = costForUsage("gemini-4-hydrogen", usage, { vertex: true, regional: true }).cost_usd;
  assert.ok(tokens > costForUsage("gemini-4-hydrogen", usage, { vertex: true }).cost_usd);
  assert.equal(rc.cost_usd, Number((tokens + 0.028).toFixed(6)));
});

test("AC3 Gemini API after 2026-12-01: gemini-2.5-pro/flash grounding bills per query as the billed_as model", async (t) => {
  withClock(t, "2026-12-02T00:00:00Z");
  for (const [model, billed] of [["gemini-2.5-pro", "gemini-3.8-flash"], ["gemini-2.5-flash", "gemini-3.5-flash-lite"]]) {
    const { receipts, call } = await setup(t, () => ({ body: grounded(model, { webSearchQueries: ["a", "b", "c", "a"], groundingChunks: [web("u")] }) }));
    assert.equal(await call(`/gemini/v1beta/models/${model}:generateContent`), 200);
    const rc = receipts[0];
    assert.equal(rc.billed_as, billed);
    assert.deepEqual(rc.tool_calls, { google_search: 3 });
    assert.equal(rc.tool_cost_usd, 0.042);
    assert.equal(rc.cost_usd, Number((costForUsage(model, usage, { at: "2026-12-02T00:00:00Z" }).cost_usd + 0.042).toFixed(6)));
  }
});

test("AC3 Gemini API on 2026-11-30: gemini-2.5-pro is still 1 prompt at $0.035", async (t) => {
  withClock(t, "2026-11-30T12:00:00Z");
  const { receipts, call } = await setup(t, () => ({ body: grounded("gemini-2.5-pro", { webSearchQueries: ["a", "b", "c"] }) }));
  assert.equal(await call("/gemini/v1beta/models/gemini-2.5-pro:generateContent"), 200);
  assert.equal(receipts[0].billed_as, undefined);
  assert.deepEqual(receipts[0].tool_calls, { google_search: 1 });
  assert.equal(receipts[0].tool_cost_usd, 0.035);
});

test("AC4 Vertex gemini-2.5-pro after 2026-12-01 keeps per-prompt $0.035", async (t) => {
  withClock(t, "2026-12-02T00:00:00Z");
  const { receipts, call } = await setup(t, () => ({ body: grounded("gemini-2.5-pro", { webSearchQueries: ["a", "b", "c"] }) }));
  assert.equal(await call(vertexPath("global", "gemini-2.5-pro")), 200);
  assert.equal(receipts[0].billed_as, undefined);
  assert.deepEqual(receipts[0].tool_calls, { google_search: 1 });
  assert.equal(receipts[0].tool_cost_usd, 0.035);
});

test("billedAsGrounding: unchanged for cloud, other providers, no billed_as, no queries", () => {
  const m = { model: "gemini-2.5-pro", toolCalls: { google_search: 1 }, groundingQueries: 3 };
  assert.equal(billedAsGrounding("gemini", true, { billed_as: "gemini-3.8-flash" }, m), m);
  assert.equal(billedAsGrounding("openai", false, { billed_as: "gemini-3.8-flash" }, m), m);
  assert.equal(billedAsGrounding("gemini", false, {}, m), m);
  assert.equal(billedAsGrounding("gemini", false, { billed_as: "x" }, { ...m, groundingQueries: 0 }).groundingQueries, 0);
  assert.equal(billedAsGrounding("gemini", false, { billed_as: "gemini-1.0-nope" }, m), m);
  assert.deepEqual(billedAsGrounding("gemini", false, { billed_as: "gemini-3.8-flash" }, m), { ...m, model: "gemini-3.8-flash", toolCalls: { google_search: 3 } });
});
