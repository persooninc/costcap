// #217: Gemini on Vertex AI (generateContent / streamGenerateContent / countTokens). Local stub only: no GCP calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMeteringProxy, baseUrlOverrides } from "../src/proxy.js";
import { classifyCloudRoute, mapCloudModel, mapVertexGemini } from "../src/cloud.js";
import { costForUsage, vertexGeminiModels } from "../src/pricing.js";
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
  assert.deepEqual(vertexGeminiModels(), ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);
  assert.equal(mapCloudModel("vertex", "google/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(mapCloudModel("vertex", "google/gemini-2.5-flash@001"), "gemini-2.5-flash");
  assert.equal(mapCloudModel("vertex", "google/gemini-2.5-flash-lite-001"), "gemini-2.5-flash-lite");
  assert.equal(mapVertexGemini("gemini-2.5-pro@default"), "gemini-2.5-pro");
  for (const bad of ["gemini-2.5-pro-preview-xyz", "gemini-9-ultra", "imagen-3", "", null]) assert.equal(mapVertexGemini(bad), null);
  assert.equal(mapCloudModel("vertex", "google/gemini-3.1-pro-preview"), null); // no Vertex rate listed: unknown, never $0
});

test("env: wrap exports GOOGLE_VERTEX_BASE_URL and treats it as a built-in variable", () => {
  assert.ok(baseUrlOverrides(8080).includes("GOOGLE_VERTEX_BASE_URL=http://127.0.0.1:8080/vertex"));
  assert.ok(!baseUrlOverrides(8080, ["gemini"]).some((l) => l.startsWith("GOOGLE_VERTEX_BASE_URL")));
  assert.ok(BUILTIN_ENV_VARS.includes("GOOGLE_VERTEX_BASE_URL"));
});

// ---- proxy against a local stub posing as *-aiplatform.googleapis.com ----

const mode = { cut: false };
async function stub() {
  const hits = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push({ url: req.url, auth: req.headers.authorization });
      if (req.url.includes(":countTokens")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ totalTokens: 12 }));
      if (req.url.includes(":streamGenerateContent")) {
        const send = mode.cut ? chunks.slice(0, 1) : chunks;
        if (req.url.includes("alt=sse")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          let i = 0;
          const next = () => { if (i < send.length) { res.write(`data: ${JSON.stringify(send[i++])}\r\n\r\n`); setTimeout(next, 5); } else res.end(); };
          return next();
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(mode.cut ? `[${JSON.stringify(send[0])}` : JSON.stringify(send));
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(final));
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
