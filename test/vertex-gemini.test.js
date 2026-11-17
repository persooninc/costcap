// #217: Gemini on Vertex AI (generateContent / streamGenerateContent / countTokens). Local stub only: no GCP calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMeteringProxy, baseUrlOverrides } from "../src/proxy.js";
import { classifyCloudRoute, mapCloudModel, mapVertexGemini } from "../src/cloud.js";
import { costForUsage, vertexGeminiModels, vertexGeminiRegionalMultiplier } from "../src/pricing.js";
import pricingTable from "../src/pricing-table.json" with { type: "json" };
import { BUILTIN_ENV_VARS } from "../src/upstreams.js";
import { createCapEngine } from "../src/cap.js";
import "./support/pinned-clock.js"; // #237: prices below are pre-2026-12-01

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = "/v1/projects/p/locations/us-central1/publishers/google/models";
const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 400, thoughtsTokenCount: 100, cachedContentTokenCount: 200, totalTokenCount: 1500 };
const final = { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata, modelVersion: "gemini-2.5-pro-001" };
const chunks = [
  { candidates: [{ content: { parts: [{ text: "h" }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1 } },
  final,
];
const expectedCost = costForUsage("gemini-2.5-pro", { input_tokens: 800, cached_input_tokens: 200, output_tokens: 500 }).cost_usd;

test("route classification: Gemini verbs on publisher google; rejects everything else", () => {
  assert.deepEqual(classifyCloudRoute("vertex", "POST", `${P}/gemini-2.5-pro:generateContent`),
    { modelId: "google/gemini-2.5-pro", publisher: "google", gemini: true, stream: false, countTokens: false, scope: "regional", location: "us-central1" });
  assert.equal(classifyCloudRoute("vertex", "POST", `${P}/gemini-2.5-pro:streamGenerateContent`).stream, true);
  assert.equal(classifyCloudRoute("vertex", "POST", `${P}/gemini-2.5-pro:countTokens`).countTokens, true);
  assert.equal(classifyCloudRoute("vertex", "POST", `${P.replace("us-central1", "global")}/gemini-2.5-flash:generateContent`).scope, "global");
  assert.equal(classifyCloudRoute("vertex", "POST", `${P}/gemini-2.5-pro:predict`), null);
  assert.equal(classifyCloudRoute("vertex", "POST", `${P}/gemini-2.5-pro:batchPredictionJobs`), null);
  assert.equal(classifyCloudRoute("vertex", "POST", `${P.replace("us-central1", "us")}/gemini-2.5-pro:generateContent`), null);
  assert.equal(classifyCloudRoute("vertex", "POST", `${P.replace("google", "anthropic")}/claude-opus-4-5:generateContent`), null);
  assert.equal(classifyCloudRoute("vertex", "GET", `${P}/gemini-2.5-pro:generateContent`), null);
  assert.equal(classifyCloudRoute("vertex", "POST", `${P}/%E0%A4%A:generateContent`), null);
  // Claude rawPredict is unchanged.
  assert.equal(classifyCloudRoute("vertex", "POST", `${P.replace("google", "anthropic")}/claude-opus-4-5:rawPredict`).gemini, undefined);
});

test("model-id normalization and the Vertex rate list", () => {
  assert.deepEqual(vertexGeminiModels(), ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-4-carbon", "gemini-4-argon",
    "gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"]);
  assert.equal(mapCloudModel("vertex", "google/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(mapCloudModel("vertex", "google/gemini-2.5-flash@001"), "gemini-2.5-flash");
  assert.equal(mapCloudModel("vertex", "google/gemini-2.5-flash-lite-001"), "gemini-2.5-flash-lite");
  assert.equal(mapVertexGemini("gemini-2.5-pro@default"), "gemini-2.5-pro");
  for (const bad of ["gemini-2.5-pro-preview-xyz", "gemini-9-ultra", "imagen-3", "", null]) assert.equal(mapVertexGemini(bad), null);
  assert.equal(mapCloudModel("vertex", "google/gemini-3.1-pro-preview@001"), "gemini-3.1-pro-preview"); // #256
  assert.equal(mapCloudModel("vertex", "google/gemini-4-carbon-001"), "gemini-4-carbon");
  for (const out of ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.8-flash-cyber"]) assert.equal(mapVertexGemini(out), null); // #256 Out: no table row
});

test("env: wrap exports GOOGLE_VERTEX_BASE_URL and treats it as a built-in variable", () => {
  assert.ok(baseUrlOverrides(8080).includes("GOOGLE_VERTEX_BASE_URL=http://127.0.0.1:8080/vertex"));
  assert.ok(!baseUrlOverrides(8080, ["gemini"]).some((l) => l.startsWith("GOOGLE_VERTEX_BASE_URL")));
  assert.ok(BUILTIN_ENV_VARS.includes("GOOGLE_VERTEX_BASE_URL"));
});

// ---- proxy against a local stub posing as *-aiplatform.googleapis.com ----

const mode = { cut: false, usage: null };
async function stub() {
  const hits = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push({ url: req.url, auth: req.headers.authorization });
      if (req.url.includes(":countTokens")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ totalTokens: 12 }));
      if (req.url.includes(":streamGenerateContent")) {
        const send = mode.cut ? chunks.slice(0, 1) : mode.usage ? [chunks[0], { ...final, usageMetadata: mode.usage }] : chunks;
        if (req.url.includes("alt=sse")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          let i = 0;
          const next = () => { if (i < send.length) { res.write(`data: ${JSON.stringify(send[i++])}\r\n\r\n`); setTimeout(next, 5); } else res.end(); };
          return next();
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(mode.cut ? `[${JSON.stringify(send[0])}` : JSON.stringify(send));
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mode.usage ? { ...final, usageMetadata: mode.usage } : final));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, url: `http://127.0.0.1:${server.address().port}` };
}
async function proxyFor(t, opts = {}) {
  const up = await stub();
  const receipts = [];
  const dir = mkdtempSync(path.join(tmpdir(), "cc-vg-"));
  const { server, port } = await startMeteringProxy({ receiptsPath: path.join(dir, "r.jsonl"), upstreams: { vertex: up.url },
    onReceipt: (r) => receipts.push(r), onWarning: () => {}, ...opts });
  t.after(() => { server.close(); up.server.close(); });
  const call = (p, body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }) =>
    fetch(`http://127.0.0.1:${port}/vertex${p}`, { method: "POST", headers: { authorization: "Bearer ya29.token", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { up, receipts, call };
}

test("AC1 generateContent: forwarded with Authorization, metered from usageMetadata at the Vertex rate", async (t) => {
  const { up, receipts, call } = await proxyFor(t);
  const r = await call(`/v1${P.slice(3)}/gemini-2.5-pro:generateContent`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), final);
  assert.deepEqual(up.hits[0], { url: `${P}/gemini-2.5-pro:generateContent`, auth: "Bearer ya29.token" });
  const rc = receipts[0];
  assert.deepEqual([rc.provider, rc.model, rc.provider_model, rc.endpoint_scope], ["vertex", "gemini-2.5-pro", "google/gemini-2.5-pro", "regional"]);
  assert.equal(rc.cost_usd, expectedCost);
  assert.ok(rc.cost_usd > 0);
});

test("AC2 streamGenerateContent: SSE and JSON-array streams settle from the last usageMetadata", async (t) => {
  const { receipts, call } = await proxyFor(t);
  const sse = await call(`${P}/gemini-2.5-pro:streamGenerateContent?alt=sse`);
  const text = await sse.text();
  assert.equal(text.split("data: ").length - 1, 2);
  const arr = await call(`${P}/gemini-2.5-pro:streamGenerateContent`);
  assert.deepEqual(await arr.json(), chunks);
  assert.deepEqual(receipts.map((r) => r.cost_usd), [expectedCost, expectedCost]);
});

test("AC2 a stream cut before finishReason is unknown (never $0) and pauses the run", async (t) => {
  mode.cut = true;
  t.after(() => { mode.cut = false; });
  for (const q of ["?alt=sse", ""]) {
    const { up, receipts, call } = await proxyFor(t, { cap: createCapEngine({ caps: { run: 10 } }) });
    await (await call(`${P}/gemini-2.5-pro:streamGenerateContent${q}`)).arrayBuffer();
    assert.equal(receipts[0].cost_usd, null);
    assert.ok(["stream_incomplete", "usage_unavailable"].includes(receipts[0].reason), receipts[0].reason);
    const next = await call(`${P}/gemini-2.5-pro:generateContent`);
    assert.notEqual(next.status, 200);
    assert.equal(up.hits.length, 1);
  }
});

test("AC3 countTokens is forwarded and non-billable", async (t) => {
  const { up, receipts, call } = await proxyFor(t, { cap: createCapEngine({ caps: { run: 0.000001 } }) });
  for (let i = 0; i < 2; i++) assert.equal((await call(`${P}/gemini-2.5-pro:countTokens`)).status, 200);
  assert.equal(up.hits.length, 2);
  assert.deepEqual(receipts.map((r) => [r.cost_usd, r.reason]), [[0, "non_billable_request"], [0, "non_billable_request"]]);
});

test("AC4 unpriced Gemini id: unknown receipt, refused under --unknown-models refuse; cap hard-stops", async (t) => {
  const a = await proxyFor(t);
  assert.equal((await a.call(`${P}/gemini-9-ultra:generateContent`)).status, 200);
  assert.deepEqual([a.receipts[0].cost_usd, a.receipts[0].reason, a.receipts[0].model], [null, "cloud_model_unpriced", "google/gemini-9-ultra"]);
  const b = await proxyFor(t, { unknownModels: "refuse" });
  assert.equal((await b.call(`${P}/gemini-9-ultra@002:generateContent`)).status, 403);
  assert.equal(b.up.hits.length, 0);
  const c = await proxyFor(t, { cap: createCapEngine({ caps: { run: 0.001 } }) });
  assert.equal((await c.call(`${P}/gemini-2.5-pro:generateContent`)).status, 200);
  const stopped = await c.call(`${P}/gemini-2.5-pro:generateContent`);
  assert.equal(stopped.status, 429);
  assert.equal((await stopped.json()).error.type, "budget_exceeded");
  assert.equal(c.up.hits.length, 1);
});

test("preflight reads generationConfig.maxOutputTokens for Vertex Gemini", async (t) => {
  const { up, call } = await proxyFor(t, { preflight: true, cap: createCapEngine({ caps: { run: 0.01 } }) });
  const big = await call(`${P}/gemini-2.5-pro:generateContent`, { contents: [], generationConfig: { maxOutputTokens: 100000 } });
  assert.equal(big.status, 429);
  assert.equal((await big.json()).error.reason, "preflight_estimate");
  assert.equal((await call(`${P}/gemini-2.5-pro:generateContent`, { contents: [], generationConfig: { maxOutputTokens: 10 } })).status, 200);
  assert.equal(up.hits.length, 1);
});

test("AC6 out-of-scope Vertex paths stay 404 cloud_route_unsupported; Claude rawPredict unchanged", async (t) => {
  const { up, receipts, call } = await proxyFor(t);
  for (const p of [`${P}/gemini-2.5-pro:predict`, `${P}/gemini-2.5-pro:batchPredictionJobs`, `${P.replace("us-central1", "us")}/gemini-2.5-pro:generateContent`]) {
    const r = await call(p);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, "cloud_route_unsupported");
  }
  assert.equal(up.hits.length, 0);
  // Regression: Claude on Vertex still meters as Anthropic Messages (the stub's Gemini body has no Anthropic usage).
  await (await call(`${P.replace("google", "anthropic")}/claude-opus-4-5@20251101:rawPredict`)).arrayBuffer();
  assert.equal(up.hits.length, 1);
  assert.equal(receipts.at(-1).model, "claude-opus-4-5");
  assert.equal(receipts.at(-1).cost_usd, null);
});

// ---- e2e: costcap wrap with a genai-style child that only reads GOOGLE_VERTEX_BASE_URL ----

test("e2e wrap: GOOGLE_VERTEX_BASE_URL routes Gemini-on-Vertex through the proxy; pre-set value is not leaked to the parent", async (t) => {
  const up = await stub();
  t.after(() => up.server.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-vg-"));
  const receipts = path.join(dir, "r.jsonl");
  const script = `
    const base = process.env.GOOGLE_VERTEX_BASE_URL;
    const out = [base.endsWith("/vertex")];
    for (let i = 0; i < 2; i++) {
      const r = await fetch(base + ${JSON.stringify(`${P}/gemini-2.5-pro:generateContent`)}, { method: "POST", headers: { authorization: "Bearer ya29.t" }, body: "{}" });
      await r.arrayBuffer(); out.push(r.status);
    }
    console.log(out.join(" "));`;
  const env = { ...process.env, COSTCAP_TEST_VERTEX_UPSTREAM: up.url, GOOGLE_VERTEX_BASE_URL: "http://example.invalid/pre" };
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--cap", "0.001", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script], { cwd: ROOT, env });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", () => resolve({ out: out.replace(/\x1b\[[0-9;]*m/g, "").trim(), err }));
  });
  assert.equal(res.out, "true 200 429", res.err);
  const rows = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse).filter((r) => "cost_usd" in r);
  assert.deepEqual([rows[0].provider, rows[0].model, rows[0].cost_usd], ["vertex", "gemini-2.5-pro", expectedCost]);
  assert.equal(process.env.GOOGLE_VERTEX_BASE_URL, undefined);
});

// ---- #256: Gemini 4 / 3.x on Vertex, dated rates and the non-global +10% ----

const M = 1_000_000;
const ONE_M = { input_tokens: M, output_tokens: M };
const vx = (model, at, regional, usage = ONE_M) => costForUsage(model, usage, { vertex: true, regional, at });
const GLOBAL_P = P.replace("us-central1", "global");

test("#256 AC1 global Vertex: dated rates at the instant, rates_effective_from on a dated entry", () => {
  const c1 = vx("gemini-4-carbon", "2026-11-30T23:59:59Z", false);
  assert.equal(c1.cost_usd, 12);
  assert.equal(c1.rates_effective_from, undefined);
  const c2 = vx("gemini-4-carbon", "2026-12-01T00:00:00Z", false);
  assert.deepEqual([c2.cost_usd, c2.rates_effective_from, c2.regional_multiplier], [24, "2026-12-01", undefined]);
  assert.equal(vx("gemini-4-argon", "2026-12-01T00:00:00Z", false).cost_usd, 24);
  assert.equal(vx("gemini-3.8-flash", "2026-12-31T23:59:59Z", false).cost_usd, 4.5);
  assert.equal(vx("gemini-3.8-flash", "2027-01-01T00:00:00Z", false).cost_usd, 9);
  assert.equal(vx("gemini-3.6-flash", "2027-01-01T00:00:00Z", false).cost_usd, 9);
  assert.equal(vx("gemini-4-hydrogen", "2026-11-20T00:00:00Z", false).cost_usd, 9);
  assert.equal(vx("gemini-3.5-flash-lite", "2026-11-20T00:00:00Z", false).cost_usd, 2.8);
  assert.equal(vx(mapCloudModel("vertex", "google/gemini-3.1-pro-preview@001"), "2026-11-20T00:00:00Z", false).cost_usd, 22);
  // The issue text says $14 for 3.1 Pro Preview, but a 1M prompt is over the 200K threshold, so the $4/$18 long-context rates apply. Under the threshold:
  assert.equal(vx("gemini-3.1-pro-preview", "2026-11-20T00:00:00Z", false, { input_tokens: 100000, output_tokens: M }).cost_usd, 12.2);
});

test("#256 AC2 non-global Vertex: every component x1.1 on GA Gemini 3+, none on 3.1 Pro Preview", () => {
  const cases = [["gemini-4-carbon", "2026-11-30T23:59:59Z", 13.2], ["gemini-4-carbon", "2026-12-01T00:00:00Z", 26.4],
    ["gemini-3.8-flash", "2026-12-31T23:59:59Z", 4.95], ["gemini-3.8-flash", "2027-01-01T00:00:00Z", 9.9],
    ["gemini-4-hydrogen", "2026-11-20T00:00:00Z", 9.9], ["gemini-3.5-flash-lite", "2026-11-20T00:00:00Z", 3.08]];
  for (const [m, at, usd] of cases) {
    const c = vx(m, at, true);
    assert.deepEqual([m, at, c.cost_usd, c.regional_multiplier], [m, at, usd, 1.1]);
  }
  assert.equal(vx("gemini-4-hydrogen", "2026-11-20T00:00:00Z", true, { cached_input_tokens: M }).cost_usd, 0.0825);
  const pre = vx("gemini-3.1-pro-preview", "2026-11-20T00:00:00Z", true);
  assert.deepEqual([pre.cost_usd, pre.regional_multiplier, pre.pricing_tier], [22, undefined, "long_context"]); // long context, see AC1
  // Long-context tier is scaled too (3.1 Pro Preview has no premium, so check against the 2.5 rows: none either).
  const lc = vx("gemini-2.5-pro", "2026-11-20T00:00:00Z", true, { input_tokens: 300000, output_tokens: 0 });
  assert.deepEqual([lc.pricing_tier, lc.regional_multiplier, lc.cost_usd], ["long_context", undefined, 0.75]);
});

test("#256 AC3 Vertex skips billed_as: gemini-2.5-pro keeps its own rate after 2026-12-01; Gemini API still remaps", () => {
  const v = vx("gemini-2.5-pro", "2026-12-02T00:00:00Z", true);
  // 1M prompt > 200K, so 2.5 Pro long-context $2.50/$15 (the issue's $11.25 is the standard tier, checked below).
  assert.deepEqual([v.cost_usd, v.billed_as, v.regional_multiplier], [17.5, undefined, undefined]);
  assert.equal(vx("gemini-2.5-pro", "2026-12-02T00:00:00Z", true, { input_tokens: 100000, output_tokens: M }).cost_usd, 10.125);
  assert.equal(vx("gemini-2.5-flash", "2026-12-02T00:00:00Z", false).billed_as, undefined);
  const api = costForUsage("gemini-2.5-pro", ONE_M, { at: "2026-12-02T00:00:00Z" });
  assert.equal(api.billed_as, "gemini-3.8-flash");
  // Claude-on-Vertex regional is unchanged (Claude list, not the Gemini block).
  assert.equal(costForUsage("claude-opus-4-5", ONE_M, { regional: true, undated: true }).regional_multiplier, 1.1);
  assert.equal(vertexGeminiRegionalMultiplier("claude-opus-4-5"), null);
});

test("#256 AC4 proxy: regional SSE stream settles at the dated regional rate; unknown-models refuse forwards Carbon, refuses 3.7 Flash", async (t) => {
  mode.usage = { promptTokenCount: M, candidatesTokenCount: M, totalTokenCount: 2 * M };
  t.after(() => { mode.usage = null; });
  const at = Date.parse("2026-12-01T00:00:00Z");
  const { receipts, call } = await proxyFor(t, { now: () => at, cap: createCapEngine({ caps: { run: 1000 } }) });
  await (await call(`${P}/gemini-4-hydrogen:streamGenerateContent?alt=sse`)).text();
  await (await call(`${P}/gemini-4-carbon:generateContent`)).arrayBuffer();
  await (await call(`${GLOBAL_P}/gemini-4-carbon:generateContent`)).arrayBuffer();
  assert.deepEqual(receipts.map((r) => [r.model, r.cost_usd, r.regional_multiplier, r.rates_effective_from]),
    [["gemini-4-hydrogen", 9.9, 1.1, undefined], ["gemini-4-carbon", 26.4, 1.1, "2026-12-01"], ["gemini-4-carbon", 24, undefined, "2026-12-01"]]);
  const b = await proxyFor(t, { unknownModels: "refuse" });
  assert.equal((await b.call(`${P}/gemini-4-carbon:generateContent`)).status, 200);
  assert.equal((await b.call(`${P}/gemini-3.7-flash:generateContent`)).status, 403);
  assert.equal(b.up.hits.length, 1);
});

test("#256 AC5 preflight budgets a regional Carbon request at the dated rate x1.1", async (t) => {
  const { up, call } = await proxyFor(t, { now: () => Date.parse("2026-12-01T00:00:00Z"), preflight: true, cap: createCapEngine({ caps: { run: 0.01 } }) });
  // 400 output tokens: $20/M x1.1 = $0.0088 fits; 500 = $0.011 does not (the undated $10 rate would let both through).
  const big = await call(`${P}/gemini-4-carbon:generateContent`, { contents: [], generationConfig: { maxOutputTokens: 500 } });
  assert.equal(big.status, 429);
  assert.equal((await big.json()).error.reason, "preflight_estimate");
  assert.equal(up.hits.length, 0);
  assert.equal((await call(`${P}/gemini-4-carbon:generateContent`, { contents: [], generationConfig: { maxOutputTokens: 400 } })).status, 200);
});

test("#256 AC6 regional list is a subset of the Vertex list and the table", () => {
  const reg = pricingTable.vertex_gemini.regional;
  assert.equal(reg.multiplier, 1.1);
  for (const id of reg.models) {
    assert.ok(vertexGeminiModels().includes(id), id);
    assert.ok(Object.hasOwn(pricingTable.models, id), id);
  }
  assert.ok(!reg.models.includes("gemini-3.1-pro-preview"));
  assert.ok(!reg.models.some((id) => id.startsWith("gemini-2.5")));
});

test("#256 e2e wrap: regional gemini-4-carbon receipt and costcap check spend match AC2", async (t) => {
  const up = await stub();
  mode.usage = { promptTokenCount: M, candidatesTokenCount: M, totalTokenCount: 2 * M };
  t.after(() => { up.server.close(); mode.usage = null; });
  const dir = mkdtempSync(path.join(tmpdir(), "cc-vg-"));
  const receipts = path.join(dir, "r.jsonl");
  const script = `
    const r = await fetch(process.env.GOOGLE_VERTEX_BASE_URL + ${JSON.stringify(`${P}/gemini-4-carbon:generateContent`)}, { method: "POST", headers: { authorization: "Bearer ya29.t" }, body: "{}" });
    await r.arrayBuffer(); console.log(r.status);`;
  const env = { ...process.env, COSTCAP_TEST_VERTEX_UPSTREAM: up.url, COSTCAP_PRICING_CLOCK: "2026-12-01T00:00:00Z" };
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--cap", "100", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script], { cwd: ROOT, env });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", () => resolve({ out: out.replace(/\x1b\[[0-9;]*m/g, "").trim(), err }));
  });
  assert.equal(res.out, "200", res.err);
  const rows = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse).filter((r) => "cost_usd" in r);
  assert.deepEqual([rows[0].model, rows[0].cost_usd, rows[0].regional_multiplier, rows[0].rates_effective_from], ["gemini-4-carbon", 26.4, 1.1, "2026-12-01"]);
  const chk = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", receipts, "--cap", "100"], { cwd: ROOT, env, encoding: "utf8" });
  const cj = JSON.parse(chk.stdout);
  assert.deepEqual([cj.total_usd, cj.cost_complete], [26.4, true], chk.stdout);
});
