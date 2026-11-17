// #262: Gemini Priority inference priced at the Priority column, downgrades at standard,
// Vertex Priority PayGo unpriced (never standard). Local stubs only: no Google calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy, extractUsage, geminiServedTier } from "../src/proxy.js";
import { costForUsage, lookupPrice, loadPricingTable } from "../src/pricing.js";
import { estimateWorstCase, preflightCheck } from "../src/preflight.js";
import { pricingCommand } from "../src/pricing-cli.js";
import { createCapEngine } from "../src/cap.js";
import "./support/pinned-clock.js";

const M = 1_000_000;
const MID = "2026-11-16T12:00:00Z";
const usageMetadata = (extra = {}) => ({ promptTokenCount: M, candidatesTokenCount: M, totalTokenCount: 2 * M, ...extra });
const body = (model, extra) => ({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }], usageMetadata: usageMetadata(extra), modelVersion: model });
const P = { input_tokens: M, output_tokens: M, cached_input_tokens: 0 };

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
  const { server, port } = await startMeteringProxy({ receiptsPath: join(mkdtempSync(join(tmpdir(), "cc-gp-")), "r.jsonl"),
    upstreams: { gemini: base, vertex: base }, onReceipt: (r) => receipts.push(r), onWarning: () => {}, ...opts });
  t.after(() => { up.closeAllConnections(); up.close(); server.closeAllConnections(); server.close(); });
  const call = (p, b = { contents: [{ parts: [{ text: "hi" }] }], service_tier: "priority" }) =>
    fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ya29.t" }, body: JSON.stringify(b) });
  return { hits, receipts, call };
}

const GEN = "/gemini/v1beta/models/gemini-3.8-flash:generateContent";
const STREAM = "/gemini/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse";

test("table: Gemini priority sets, dated sets, digest verifies", () => {
  const { verification } = loadPricingTable();
  assert.equal(verification.ok, true);
  assert.deepEqual(lookupPrice("gemini-3.8-flash", MID).priority, { input: 1.35, cached_input: 0.135, output: 6.75 });
  assert.deepEqual(lookupPrice("gemini-3.8-flash", "2027-01-02T00:00:00Z").priority, { input: 2.70, cached_input: 0.27, output: 13.50 });
  assert.equal(lookupPrice("gemini-4-carbon", MID).priority.input, 3.60);
  assert.equal(lookupPrice("gemini-4-argon", "2026-12-02T00:00:00Z").priority.output, 36);
  assert.equal(lookupPrice("gemini-4-hydrogen", MID).priority.output, 13.5);
  assert.equal(lookupPrice("gemini-3.1-pro-preview", MID).priority.output, 21.6);
  // No published Priority column: stays unpriced, never standard.
  for (const m of ["gemini-3.6-flash", "gemini-3.5-flash-lite"]) assert.equal(lookupPrice(m, MID).priority, undefined);
});

test("AC1 costForUsage: gemini-3.8-flash priority 8.10 today, 16.20 from 2027-01-01", () => {
  const r = costForUsage("gemini-3.8-flash", { ...P, service_tier: "priority" }, { at: MID });
  assert.deepEqual([r.cost_usd, r.pricing_tier, r.service_tier], [8.1, "priority", "priority"]);
  assert.equal(costForUsage("gemini-3.8-flash", { ...P, service_tier: "priority" }, { at: "2027-01-02T00:00:00Z" }).cost_usd, 16.2);
  assert.equal(costForUsage("gemini-3.8-flash", P, { at: MID }).cost_usd, 4.5);
});

test("AC4 edges: long context x1.8, Priority audio rate, unpriced model, billed_as", () => {
  const lc = costForUsage("gemini-2.5-pro", { input_tokens: 250_000, output_tokens: M, cached_input_tokens: 0, service_tier: "priority" }, { at: MID });
  assert.equal(lc.long_context, true);
  assert.equal(lc.cost_usd, Number((250_000 * 4.5 / M + 27).toFixed(6)));
  const audio = costForUsage("gemini-2.5-flash", { input_tokens: M, output_tokens: 0, cached_input_tokens: 0, service_tier: "priority",
    modality_tokens: { input: { text: 0, audio: M } } }, { at: MID });
  assert.equal(audio.cost_usd, 1.8);
  const lite = costForUsage("gemini-2.5-flash-lite", { input_tokens: M, output_tokens: 0, cached_input_tokens: 0, service_tier: "priority",
    modality_tokens: { input: { text: 0, audio: M } } }, { at: MID });
  assert.equal(lite.cost_usd, 0.54);
  const none = costForUsage("gemini-3.6-flash", { ...P, service_tier: "priority" }, { at: MID });
  assert.deepEqual([none.cost_usd, none.reason], [null, "service_tier_unpriced"]);
  const remap = costForUsage("gemini-2.5-pro", { ...P, service_tier: "priority" }, { at: "2026-12-02T00:00:00Z" });
  assert.deepEqual([remap.billed_as, remap.cost_usd], ["gemini-3.8-flash", 8.1]);
});

test("geminiServedTier: header, request tier, downgrade, Vertex trafficType", () => {
  const u = { input_tokens: 1 };
  assert.equal(geminiServedTier(u, { service_tier: "Priority" }, null).service_tier, "priority");
  assert.equal(geminiServedTier(u, { serviceTier: "PRIORITY" }, "priority").service_tier, "priority");
  assert.equal(geminiServedTier(u, {}, "priority").service_tier, "priority");
  const dg = geminiServedTier(u, { service_tier: "priority" }, "Standard");
  assert.deepEqual([dg.service_tier, dg.requested_service_tier], [undefined, "priority"]);
  assert.deepEqual(geminiServedTier(u, {}, null), u);
  assert.deepEqual(geminiServedTier(u, null, "standard"), u);
  assert.equal(geminiServedTier(u, { service_tier: "flex" }, null).service_tier, undefined);
  assert.equal(geminiServedTier({ ...u, traffic_type: "ON_DEMAND_PRIORITY" }, null, null, { vertex: true }).service_tier, "priority");
  assert.equal(geminiServedTier({ ...u, traffic_type: "ON_DEMAND" }, { service_tier: "priority" }, "priority", { vertex: true }).service_tier, undefined);
  assert.equal(geminiServedTier(undefined, {}, null), undefined);
  assert.equal(extractUsage("gemini", JSON.stringify(body("gemini-3.8-flash", { trafficType: "ON_DEMAND_FLEX" })), "gemini-3.8-flash").usage.traffic_type, "ON_DEMAND_FLEX");
});

test("AC5 Vertex: ON_DEMAND_PRIORITY unpriced, never standard; ON_DEMAND/FLEX at standard", () => {
  const v = costForUsage("gemini-3.8-flash", { ...P, service_tier: "priority" }, { vertex: true, at: MID });
  assert.deepEqual([v.cost_usd, v.reason, v.pricing_tier], [null, "service_tier_unpriced", "priority"]);
  assert.equal(costForUsage("gemini-3.8-flash", P, { vertex: true, at: MID }).cost_usd, 4.5);
});

test("proxy e2e AC1/AC2: JSON + SSE priority, downgrade, missing header, no tier", async (t) => {
  withClock(t, MID);
  let headers = { "x-gemini-service-tier": "priority" };
  const { receipts, call } = await setup(t, (url) => url.includes("stream") ? { sse: [body("gemini-3.8-flash")], headers } : { json: body("gemini-3.8-flash"), headers });
  assert.equal((await call(GEN)).status, 200);
  assert.equal((await call(STREAM)).status, 200);
  headers = { "x-gemini-service-tier": "standard" };
  await call(GEN);
  headers = {};
  await call(GEN);
  await call(GEN, { contents: [] });
  const got = receipts.map((r) => [r.cost_usd, r.pricing_tier, r.requested_service_tier]);
  assert.deepEqual(got, [[8.1, "priority", undefined], [8.1, "priority", undefined], [4.5, "standard", "priority"], [8.1, "priority", undefined], [4.5, "standard", undefined]]);
  assert.equal(receipts[0].service_tier, "priority");
});

test("proxy e2e AC1: priority at 2027-01-02 is 16.20", async (t) => {
  withClock(t, "2027-01-02T00:00:00Z");
  const { receipts, call } = await setup(t, () => ({ json: body("gemini-3.8-flash"), headers: { "x-gemini-service-tier": "priority" } }));
  await call(GEN);
  assert.equal(receipts[0].cost_usd, 16.2);
});

test("proxy e2e AC3: --cap 10 trips on the second priority call, third refused upstream-free", async (t) => {
  withClock(t, MID);
  const cap = createCapEngine({ caps: { run: 10 } });
  const { hits, receipts, call } = await setup(t, () => ({ json: body("gemini-3.8-flash"), headers: { "x-gemini-service-tier": "priority" } }), { cap });
  assert.equal((await call(GEN)).status, 200);
  assert.equal((await call(GEN)).status, 200);
  assert.equal(Number(receipts.reduce((s, r) => s + (r.cost_usd ?? 0), 0).toFixed(6)), 16.2);
  const third = await call(GEN);
  assert.equal(third.status, 429);
  assert.match(await third.text(), /budget_exceeded/);
  assert.equal(hits.length, 2);
});

test("proxy e2e AC4: model with no Priority rate latches accounting_unavailable", async (t) => {
  withClock(t, MID);
  const { receipts, call } = await setup(t, () => ({ json: body("gemini-3.6-flash"), headers: { "x-gemini-service-tier": "priority" } }));
  await call("/gemini/v1beta/models/gemini-3.6-flash:generateContent");
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "service_tier_unpriced"]);
  const next = await call("/gemini/v1beta/models/gemini-3.6-flash:generateContent");
  assert.equal(next.status, 429);
  assert.match(await next.text(), /accounting_unavailable/);
});

test("proxy e2e AC5: Vertex trafficType recorded; ON_DEMAND_PRIORITY unpriced", async (t) => {
  withClock(t, MID);
  let tt = "ON_DEMAND";
  const { receipts, call } = await setup(t, () => ({ json: body("gemini-3.8-flash", { trafficType: tt }) }));
  const V = "/vertex/v1/projects/p/locations/global/publishers/google/models/gemini-3.8-flash:generateContent";
  await call(V, { contents: [] });
  tt = "ON_DEMAND_FLEX";
  await call(V, { contents: [] });
  assert.deepEqual(receipts.map((r) => [r.cost_usd, r.traffic_type]), [[4.5, "ON_DEMAND"], [4.5, "ON_DEMAND_FLEX"]]);
  tt = "ON_DEMAND_PRIORITY";
  await call(V, { contents: [] });
  assert.deepEqual([receipts[2].cost_usd, receipts[2].reason, receipts[2].traffic_type], [null, "service_tier_unpriced", "ON_DEMAND_PRIORITY"]);
});

test("AC6 preflight: Gemini priority body estimates at Priority rates and refuses over cap", () => {
  const req = { contents: [{ parts: [{ text: "x".repeat(4000) }] }], generationConfig: { maxOutputTokens: 100_000 } };
  const path = "/v1beta/models/gemini-3.8-flash:generateContent";
  const std = estimateWorstCase("gemini", JSON.stringify(req), path, undefined, undefined, MID);
  const pri = estimateWorstCase("gemini", JSON.stringify({ ...req, serviceTier: "PRIORITY" }), path, undefined, undefined, MID);
  assert.equal(pri.ok, true);
  assert.equal(pri.pricing_tier, "priority");
  assert.ok(pri.estimate_usd > std.estimate_usd * 1.7);
  const limit = (std.estimate_usd + pri.estimate_usd) / 2;
  const cap = createCapEngine({ caps: { run: limit } });
  assert.equal(preflightCheck(cap, "gemini", JSON.stringify(req), path, undefined, undefined, undefined, MID), null);
  assert.ok(preflightCheck(cap, "gemini", JSON.stringify({ ...req, service_tier: "priority" }), path, undefined, undefined, undefined, MID));
  const none = estimateWorstCase("gemini", JSON.stringify({ ...req, service_tier: "priority" }), "/v1beta/models/gemini-3.6-flash:generateContent", undefined, undefined, MID);
  assert.deepEqual([none.ok, none.reason], [false, "preflight_unpriced"]);
});

test("AC6 pricing show lists a (priority) row for gemini-3.8-flash", () => {
  assert.match(pricingCommand(["show", "gemini-3.8-flash"]).out, /gemini-3\.8-flash \(priority\): input \$1\.35/);
});
