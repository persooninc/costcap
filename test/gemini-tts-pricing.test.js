// #270: Gemini text-to-speech priced at the published text-in / audio-out rates, dated 2027-01-01
// change on the 3.8 rows, Priority on the 3.8 rows only, batch at 0.5x, no cache rate. Local stubs only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy, extractUsage } from "../src/proxy.js";
import { costForUsage, lookupPrice, isPricedModel, loadPricingTable } from "../src/pricing.js";
import { estimateWorstCase, preflightCheck } from "../src/preflight.js";
import { pricingCommand } from "../src/pricing-cli.js";
import { foldBatchResults } from "../src/batch.js";
import { createCapEngine } from "../src/cap.js";
import "./support/pinned-clock.js";

const M = 1_000_000;
const MID = "2026-11-16T12:00:00Z";
const NEXT = "2027-01-02T00:00:00Z";
const TTS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"];
const um = (p, c, extra = {}) => ({ promptTokenCount: p, candidatesTokenCount: c, totalTokenCount: p + c,
  promptTokensDetails: [{ modality: "TEXT", tokenCount: p }], candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: c }], ...extra });
const body = (model, p = M, c = M, extra) => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAAA" } }] }, finishReason: "STOP" }],
  usageMetadata: um(p, c, extra), modelVersion: model });
const REQ = { contents: [{ parts: [{ text: "Say cheerfully: have a wonderful day!" }] }],
  generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } };
const cost = (model, json, at = MID, opts = {}) => { const u = extractUsage("gemini", JSON.stringify(json), model); return costForUsage(u.model, u.usage, { at, ...opts }); };

function withClock(t, at) {
  const prev = process.env.COSTCAP_PRICING_CLOCK;
  process.env.COSTCAP_PRICING_CLOCK = at;
  t.after(() => { if (prev === undefined) delete process.env.COSTCAP_PRICING_CLOCK; else process.env.COSTCAP_PRICING_CLOCK = prev; });
}

async function setup(t, respond, opts = {}) {
  const hits = [];
  const up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push(req.url);
      const { json, sse, headers = {} } = respond(req.url);
      if (sse) {
        res.writeHead(200, { "content-type": "text/event-stream", ...headers });
        for (const c of sse) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json", ...headers }).end(JSON.stringify(json));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receipts = [];
  const { server, port } = await startMeteringProxy({ receiptsPath: join(mkdtempSync(join(tmpdir(), "cc-tts-")), "r.jsonl"),
    upstreams: { gemini: base }, onReceipt: (r) => receipts.push(r), onWarning: () => {}, ...opts });
  t.after(() => { up.closeAllConnections(); up.close(); server.closeAllConnections(); server.close(); });
  const call = (p, b = REQ) => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": "k" }, body: JSON.stringify(b) });
  return { hits, receipts, call };
}

const gen = (m) => `/gemini/v1beta/models/${m}:generateContent`;
const stream = (m) => `/gemini/v1beta/models/${m}:streamGenerateContent?alt=sse`;

test("table: five TTS rows priced, dated 3.8 rows, digest verifies", () => {
  assert.equal(loadPricingTable().verification.ok, true);
  for (const m of TTS) assert.equal(isPricedModel(m), true, m);
  assert.equal(lookupPrice("gemini-3.8-flash-tts", NEXT).rates_effective_from, "2027-01-01");
  assert.equal(lookupPrice("gemini-3.8-flash-tts", MID).cached_input, undefined);
  assert.equal(lookupPrice("gemini-2.5-flash-preview-tts", MID).priority, undefined);
});

test("AC1/AC3: 1M text in + 1M audio out per row, today and from 2027-01-01", () => {
  const today = { "gemini-3.8-flash-tts": 9.5, "gemini-3.8-flash-lite-tts": 6.5, "gemini-3.1-flash-tts-preview": 21, "gemini-2.5-flash-preview-tts": 10.5, "gemini-2.5-pro-preview-tts": 21 };
  for (const [m, v] of Object.entries(today)) {
    const r = cost(m, body(m));
    assert.deepEqual([r.cost_usd, r.fallback], [v, false], m);
  }
  const later = cost("gemini-3.8-flash-tts", body("gemini-3.8-flash-tts"), NEXT);
  assert.deepEqual([later.cost_usd, later.rates_effective_from], [19, "2027-01-01"]);
  assert.equal(cost("gemini-3.8-flash-lite-tts", body("gemini-3.8-flash-lite-tts"), NEXT).cost_usd, 13);
  assert.equal(cost("gemini-3.8-flash-tts", body("gemini-3.8-flash-tts", 20, 250)).cost_usd, 0.00226);
});

test("AC4: Priority on 3.8 rows, preview Priority unpriced, batch 0.5x", () => {
  const u = extractUsage("gemini", JSON.stringify(body("gemini-3.8-flash-tts")), "gemini-3.8-flash-tts").usage;
  assert.equal(costForUsage("gemini-3.8-flash-tts", { ...u, service_tier: "priority" }, { at: MID }).cost_usd, 17.1);
  assert.equal(costForUsage("gemini-3.8-flash-tts", { ...u, service_tier: "priority" }, { at: NEXT }).cost_usd, 34.2);
  const pre = costForUsage("gemini-2.5-flash-preview-tts", { ...u, service_tier: "priority" }, { at: MID });
  assert.deepEqual([pre.cost_usd, pre.reason], [null, "service_tier_unpriced"]);
  assert.equal(costForUsage("gemini-3.8-flash-tts", u, { at: MID, batch: "gemini" }).cost_usd, 4.75);
  const f = foldBatchResults("gemini", JSON.stringify({ response: body("gemini-3.8-flash-tts") }), null, { model: "gemini-3.8-flash-tts" });
  assert.deepEqual([f.ok, f.cost_usd], [true, 4.75]);
});

test("AC5 edges: audio input unpriced, cache read unknown (never $0), no details array prices as audio", () => {
  const audioIn = body("gemini-3.8-flash-tts", M, M, { promptTokensDetails: [{ modality: "AUDIO", tokenCount: M }] });
  assert.equal(cost("gemini-3.8-flash-tts", audioIn).reason, "modality_unpriced");
  const cached = cost("gemini-3.8-flash-tts", body("gemini-3.8-flash-tts", M, M, { cachedContentTokenCount: 1000 }));
  assert.deepEqual([cached.cost_usd, cached.reason], [null, "cache_read_unpriced"]);
  const bare = { promptTokenCount: M, candidatesTokenCount: M, totalTokenCount: 2 * M };
  assert.equal(cost("gemini-3.8-flash-tts", { ...body("gemini-3.8-flash-tts"), usageMetadata: bare }).cost_usd, 9.5);
});

test("AC6 preflight: maxOutputTokens 8192 at the $9 audio rate; passes $1, refused at $0.05", () => {
  const req = JSON.stringify({ ...REQ, generationConfig: { ...REQ.generationConfig, maxOutputTokens: 8192 } });
  const path = "/v1beta/models/gemini-3.8-flash-tts:generateContent";
  const e = estimateWorstCase("gemini", req, path, undefined, undefined, MID);
  assert.equal(e.ok, true);
  assert.ok(e.estimate_usd >= 8192 * 9 / M && e.estimate_usd < 0.08, String(e.estimate_usd));
  assert.equal(preflightCheck(createCapEngine({ caps: { run: 1 } }), "gemini", req, path, undefined, undefined, undefined, MID), null);
  assert.ok(preflightCheck(createCapEngine({ caps: { run: 0.05 } }), "gemini", req, path, undefined, undefined, undefined, MID));
});

test("AC6 pricing verify passes and show prints the 2027-01-01 row", () => {
  assert.equal(pricingCommand(["verify"]).code ?? 0, 0);
  const out = pricingCommand(["show", "gemini-3.8-flash-tts"]).out;
  assert.match(out, /from 2027-01-01: input \$1(\.00)?, .*output \$18/);
  assert.match(out, /\(audio\).*output \$9/);
});

test("proxy e2e AC1/AC2: JSON + SSE priced, run not latched, --cap 10 trips on the third call", async (t) => {
  withClock(t, MID);
  const m = "gemini-3.8-flash-tts";
  const cap = createCapEngine({ caps: { run: 10 } });
  const { hits, receipts, call } = await setup(t, (url) => url.includes("stream") ? { sse: [body(m)] } : { json: body(m) }, { cap });
  assert.equal((await call(gen(m))).status, 200);
  assert.equal((await call(stream(m))).status, 200);
  assert.deepEqual(receipts.map((r) => [r.cost_usd, r.fallback]), [[9.5, false], [9.5, false]]);
  const third = await call(gen(m));
  assert.equal(third.status, 429);
  assert.match(await third.text(), /budget_exceeded/);
  assert.equal(hits.length, 2);
});

test("proxy e2e AC1: 2027-01-02 is 19.00; a plain call after TTS is forwarded; priority header 17.10", async (t) => {
  withClock(t, NEXT);
  const m = "gemini-3.8-flash-tts";
  let headers = {};
  const { hits, receipts, call } = await setup(t, (url) => ({ json: url.includes("tts") ? body(m) : { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }, headers }));
  await call(gen(m));
  assert.deepEqual([receipts[0].cost_usd, receipts[0].rates_effective_from], [19, "2027-01-01"]);
  assert.equal((await call(gen("gemini-3.8-flash"), { contents: [] })).status, 200);
  assert.equal(hits.length, 2);
  withClock(t, MID);
  headers = { "x-gemini-service-tier": "priority" };
  await call(gen(m), { ...REQ, service_tier: "priority" });
  assert.equal(receipts.at(-1).cost_usd, 17.1);
});

test("proxy e2e: --unknown-models refuse forwards TTS", async (t) => {
  withClock(t, MID);
  const m = "gemini-2.5-pro-preview-tts";
  const { hits, call } = await setup(t, () => ({ json: body(m) }), { unknownModels: "refuse" });
  assert.equal((await call(gen(m))).status, 200);
  assert.equal(hits.length, 1);
});
