// #230: Gemini Batch Mode metered at the 50% batch rate; pending until results, settled once.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy, extractUsage } from "../src/proxy.js";
import { costForUsage } from "../src/pricing.js";
import { batchCreateProvider, batchReadPath, foldBatchResults, geminiBatchId, geminiBatchOutput, geminiBatchRequests, isGeminiBatchFreeCall } from "../src/batch.js";
import { GEMINI_EXPECTED, GEMINI_INLINE, GEMINI_OK_1, GEMINI_OK_2, GEMINI_RESULTS, geminiOp, mockUpstream } from "./support/batch.js";
import { checkBudget } from "../src/check.js";

const CREATE = "/gemini/v1beta/models/gemini-2.5-flash:batchGenerateContent";
const REQ = { contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1000 } };
export const geminiBatchBody = (n = 3, model) => JSON.stringify({ batch: { display_name: "evals", input_config: { requests: { requests:
  Array.from({ length: n }, (_, i) => ({ request: { ...REQ, ...(model && { model }) }, metadata: { key: `r${i}` } })) } } } });
const FILE_BODY = JSON.stringify({ batch: { display_name: "f", input_config: { file_name: "files/in-1" } } });
const FILE_GET = geminiOp("BATCH_STATE_SUCCEEDED", { done: true, response: { responsesFile: "files/out-1" } });

async function setup(t, handler, opts = {}) {
  const seen = [];
  const up = http.createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { seen.push({ method: req.method, url: req.url }); handler(req, res); }); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-gbatch-")), "r.jsonl");
  const start = () => startMeteringProxy({ upstreams: { gemini: base }, receiptsPath, ...opts });
  let p = await start();
  t.after(() => { up.closeAllConnections(); up.close(); p.server.closeAllConnections(); p.server.close(); });
  return {
    seen, receiptsPath,
    call: (method, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body }),
    lines: () => readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    restart: async () => { p.server.closeAllConnections(); p.server.close(); p = await start(); },
  };
}

test("matchers: exact Gemini create, get, download, cancel and delete paths; look-alikes rejected", () => {
  for (const v of ["v1", "v1beta", "v1alpha"]) assert.equal(batchCreateProvider("POST", `/gemini/${v}/models/gemini-2.5-flash:batchGenerateContent?key=x`), "gemini");
  for (const [m, u] of [["GET", CREATE], ["POST", `${CREATE}%2F..`], ["POST", "/gemini/v1beta/models/gemini-2.5-flash:batchGenerateContent/x"],
    ["POST", "/gemini/v2/models/m:batchGenerateContent"], ["POST", "/gemini/v1beta/models/a/../b:batchGenerateContent"], ["POST", "/gemini/v1beta/models/m:asyncBatchEmbedContent"]])
    assert.equal(batchCreateProvider(m, u), null, `${m} ${u}`);
  assert.deepEqual(batchReadPath("GET", "/gemini/v1beta/batches/gb_01"), { kind: "gemini_batch", id: "gb_01" });
  assert.deepEqual(batchReadPath("GET", "/gemini/download/v1beta/files/out-1:download?alt=media"), { kind: "gemini_file_download", id: "out-1" });
  for (const u of ["/gemini/v1beta/batches/x/extra", "/gemini/v1beta/batches/x%2F", "/gemini/download/v1beta/files/x:download/y", "/gemini/v1beta/files/x:download"])
    assert.equal(batchReadPath("GET", u), null, u);
  assert.equal(isGeminiBatchFreeCall("POST", "/gemini/v1beta/batches/gb_01:cancel"), true);
  assert.equal(isGeminiBatchFreeCall("DELETE", "/gemini/v1beta/batches/gb_01"), true);
  for (const [m, u] of [["GET", "/gemini/v1beta/batches/gb_01"], ["POST", "/gemini/v1beta/batches/gb_01"], ["DELETE", "/gemini/v1beta/batches/a/b"], ["POST", "/gemini/v1beta/batches/a%2F:cancel"], ["POST", undefined]])
    assert.equal(isGeminiBatchFreeCall(m, u), false, `${m} ${u}`);
  assert.equal(geminiBatchRequests(geminiBatchBody(3)).length, 3);
  assert.equal(geminiBatchRequests(Buffer.from(JSON.stringify({ batch: { inputConfig: { requests: { requests: [{}] } } } })))[0], null);
  assert.deepEqual(geminiBatchRequests(FILE_BODY), []);
  for (const b of ["nope", "{}", JSON.stringify({ batch: { input_config: { requests: { requests: [] } } } }), undefined]) assert.equal(geminiBatchRequests(b), null);
  assert.equal(geminiBatchId({ name: "batches/gb_01" }), "gb_01");
  for (const o of [{ name: "operations/x" }, { name: "batches/a/b" }, null]) assert.equal(geminiBatchId(o), null);
});

test("geminiBatchOutput: inline / file when done; running, failed or expired stay pending", () => {
  const inl = geminiBatchOutput(JSON.stringify(geminiOp("BATCH_STATE_SUCCEEDED", { done: true, response: { inlinedResponses: { inlinedResponses: GEMINI_INLINE } } })));
  assert.equal(inl.inline.split("\n").length, 3);
  assert.deepEqual(geminiBatchOutput(JSON.stringify(FILE_GET)), { file: "out-1" });
  assert.deepEqual(geminiBatchOutput(JSON.stringify(geminiOp("BATCH_STATE_SUCCEEDED", { done: true, metadata: { output: { responsesFile: "files/m-1" } } }))), { file: "m-1" });
  for (const op of [geminiOp("BATCH_STATE_RUNNING"), geminiOp("BATCH_STATE_EXPIRED", { done: true }), geminiOp("BATCH_STATE_FAILED", { done: true, error: { code: 13 } }),
    geminiOp("BATCH_STATE_SUCCEEDED", { done: true, response: { responsesFile: "nope/x" } }), geminiOp("BATCH_STATE_SUCCEEDED", { done: true, response: { inlinedResponses: { inlinedResponses: [] } } })])
    assert.equal(geminiBatchOutput(JSON.stringify(op)), null, JSON.stringify(op));
  assert.equal(geminiBatchOutput("{not json"), null);
});

test("fold gemini: inline and file results at 0.5x the interactive cost; errors $0; model fallback", () => {
  const f = foldBatchResults("gemini", GEMINI_RESULTS, null, { model: "gemini-2.5-flash" });
  assert.deepEqual(f, { ok: true, cost_usd: GEMINI_EXPECTED, succeeded: 2, free: 1, by_model: { "gemini-2.5-flash": GEMINI_EXPECTED } });
  const inline = geminiBatchOutput(JSON.stringify(geminiOp("S", { done: true, response: { inlinedResponses: { inlinedResponses: GEMINI_INLINE } } }))).inline;
  assert.deepEqual(foldBatchResults("gemini", inline, null, { model: "gemini-2.5-flash" }), f);
  // modelVersion wins over the create's path model.
  const pro = foldBatchResults("gemini", JSON.stringify({ response: { ...GEMINI_OK_2, modelVersion: "gemini-2.5-pro" } }), null, { model: "gemini-2.5-flash" });
  assert.deepEqual(Object.keys(pro.by_model), ["gemini-2.5-pro"]);
  const u = extractUsage("gemini", JSON.stringify(GEMINI_OK_1), "gemini-2.5-flash");
  assert.ok(GEMINI_EXPECTED > 0 && GEMINI_EXPECTED < costForUsage(u.model, u.usage).cost_usd);
});

test("AC4 fold gemini: unpriced model, malformed line, audio output without a rate, missing usage stay unknown", () => {
  const audioOut = { ...GEMINI_OK_2, modelVersion: "gemini-2.5-flash", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 50, candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 50 }] } };
  const interactive = extractUsage("gemini", JSON.stringify(audioOut), "gemini-2.5-flash");
  assert.equal(costForUsage(interactive.model, interactive.usage).reason, "modality_unpriced");
  for (const text of [JSON.stringify({ response: { ...GEMINI_OK_2, modelVersion: "gemini-made-up-9" } }), `${JSON.stringify({ response: GEMINI_OK_2 })}\n{not json`,
    JSON.stringify({ response: audioOut }), JSON.stringify({ response: { candidates: [] } }), JSON.stringify({ key: "x" }), "null", ""]) {
    const r = foldBatchResults("gemini", text, null, { model: "gemini-2.5-flash" });
    assert.equal(r.ok, false, text);
    assert.equal(r.reason, "batch_unpriced");
  }
  // No path model and no modelVersion: unknown, never the fallback rate.
  assert.equal(foldBatchResults("gemini", JSON.stringify({ response: GEMINI_OK_2 })).ok, false);
});

test("AC1/AC2: inline create pending, sync continues, GET settles once at 0.5x across reads and restarts", async (t) => {
  const s = await setup(t, mockUpstream());
  const created = await s.call("POST", CREATE, geminiBatchBody(3));
  assert.equal(created.status, 200);
  assert.equal((await created.json()).name, "batches/gb_01");
  let lines = s.lines();
  assert.equal(lines.length, 1);
  const pend = lines[0];
  assert.deepEqual([pend.reason, pend.cost_usd, pend.batch_id, pend.request_count, pend.model], ["batch_pending", null, "gb_01", 3, "gemini-2.5-flash"]);
  assert.equal((await s.call("POST", "/gemini/v1beta/models/gemini-2.5-flash:generateContent", JSON.stringify(REQ))).status, 200);
  assert.equal(checkBudget({ receiptsPath: s.receiptsPath }).cost_complete, false);
  await s.call("GET", "/gemini/v1beta/batches/gb_01");
  await s.call("GET", "/gemini/v1beta/batches/gb_01");
  await s.restart();
  await s.call("GET", "/gemini/v1beta/batches/gb_01");
  lines = s.lines();
  const settles = lines.filter((l) => l.event === "reconciliation");
  assert.equal(settles.length, 1);
  assert.deepEqual([settles[0].receipt_id, settles[0].cost_usd, settles[0].source, settles[0].batch_id, settles[0].succeeded, settles[0].not_billed],
    [pend.id, GEMINI_EXPECTED, "batch_results", "gb_01", 2, 1]);
  assert.deepEqual(settles[0].by_model, { "gemini-2.5-flash": GEMINI_EXPECTED });
  assert.equal(lines.filter((l) => !l.event && l.cost_usd === null && l.reason !== "batch_pending").length, 0);
  assert.equal(checkBudget({ receiptsPath: s.receiptsPath }).ok, true);
});

test("AC3: file-output batch links responsesFile; download settles; an unlinked download stays $0", async (t) => {
  const s = await setup(t, mockUpstream({ geminiGet: FILE_GET }));
  assert.equal((await s.call("POST", CREATE, FILE_BODY)).status, 200);
  const pend = s.lines()[0];
  assert.equal(pend.request_count, undefined);
  await s.call("GET", "/gemini/download/v1beta/files/other-9:download?alt=media");
  assert.deepEqual([s.lines().at(-1).reason, s.lines().at(-1).cost_usd], ["non_billable_request", 0]);
  await s.call("GET", "/gemini/v1beta/batches/gb_01");
  assert.equal(s.lines().some((l) => l.event), false);
  await s.call("GET", "/gemini/download/v1beta/files/out-1:download?alt=media");
  await s.call("GET", "/gemini/download/v1beta/files/out-1:download?alt=media");
  const settles = s.lines().filter((l) => l.event === "reconciliation");
  assert.deepEqual(settles.map((e) => [e.receipt_id, e.cost_usd, e.succeeded, e.not_billed]), [[pend.id, GEMINI_EXPECTED, 2, 1]]);
  assert.equal(s.seen.find((r) => r.url.startsWith("/download/")).url, "/download/v1beta/files/other-9:download?alt=media");
});

test("AC4: unpriced / malformed / unrated-audio results write batch_unpriced, pause the run, no $0 settlement", async (t) => {
  const audio = { ...GEMINI_OK_2, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 50, candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 50 }] } };
  for (const results of [JSON.stringify({ key: "a", response: { ...GEMINI_OK_2, modelVersion: "gemini-made-up-9" } }), "{not json", JSON.stringify({ key: "a", response: audio })]) {
    const s = await setup(t, mockUpstream({ geminiGet: FILE_GET, geminiResults: results }));
    await s.call("POST", CREATE, FILE_BODY);
    await s.call("GET", "/gemini/v1beta/batches/gb_01");
    await s.call("GET", "/gemini/download/v1beta/files/out-1:download");
    const last = s.lines().at(-1);
    assert.deepEqual([last.reason, last.cost_usd, last.batch_id], ["batch_unpriced", null, "gb_01"], results);
    assert.equal(s.lines().some((l) => l.event), false);
    assert.equal((await s.call("POST", "/gemini/v1beta/models/gemini-2.5-flash:generateContent", JSON.stringify(REQ))).status, 429);
  }
});

test("AC5: cancel and delete are $0 non_billable and never pause; an expired batch with no output stays pending", async (t) => {
  const s = await setup(t, mockUpstream({ geminiGet: geminiOp("BATCH_STATE_EXPIRED", { done: true }) }));
  await s.call("POST", CREATE, geminiBatchBody(2));
  assert.equal((await s.call("POST", "/gemini/v1beta/batches/gb_01:cancel", "{}")).status, 200);
  assert.equal((await s.call("DELETE", "/gemini/v1beta/batches/gb_01")).status, 200);
  await s.call("GET", "/gemini/v1beta/batches/gb_01");
  const lines = s.lines();
  assert.deepEqual(lines.slice(1).map((l) => [l.reason, l.cost_usd]), [["non_billable_request", 0], ["non_billable_request", 0], ["non_billable_request", 0]]);
  assert.equal(lines.some((l) => l.event), false);
  assert.equal(checkBudget({ receiptsPath: s.receiptsPath }).hit.reason, "batch_pending");
  assert.equal((await s.call("POST", "/gemini/v1beta/models/gemini-2.5-flash:generateContent", JSON.stringify(REQ))).status, 200);
});

test("allowlist, --unknown-models refuse and downgrade see the path model of a Gemini batch", async (t) => {
  const a = await setup(t, mockUpstream(), { allowedModels: () => ["gemini-2.5-pro"] });
  assert.equal((await a.call("POST", CREATE, geminiBatchBody(1))).status, 403);
  assert.equal(a.seen.length, 0);
  const u = await setup(t, mockUpstream(), { unknownModels: "refuse" });
  assert.equal((await u.call("POST", "/gemini/v1beta/models/gemini-made-up-9:batchGenerateContent", geminiBatchBody(1))).status, 403);
  assert.equal((await u.call("POST", CREATE, geminiBatchBody(1))).status, 200);
  const d = await setup(t, mockUpstream(), { downgrader: { decide: (m) => ({ from: m, to: "gemini-2.5-flash-lite", scope: "run", fraction: 0.9 }) } });
  await d.call("POST", CREATE, geminiBatchBody(1));
  const r = d.lines()[0];
  assert.deepEqual([r.reason, r.downgrade, r.model], ["batch_pending", "unsupported_route", "gemini-2.5-flash"]);
  assert.equal(d.seen[0].url, "/v1beta/models/gemini-2.5-flash:batchGenerateContent");
});
