// #160: Batch APIs metered at the provider batch rate; pending until results, never $0.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { anthropicBatchModels, batchCreateProvider, batchReadPath, foldBatchResults } from "../src/batch.js";
import { ANTHROPIC_EXPECTED, ANTHROPIC_RESULTS, OPENAI_EXPECTED, OPENAI_RESULTS, mockUpstream } from "./support/batch.js";
import { createCapEngine, isPendingBatch, loadSettledReceipts } from "../src/cap.js";
import { checkBudget } from "../src/check.js";

const SONNET = { model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
const ABATCH = JSON.stringify({ requests: ["a", "b", "c"].map((custom_id) => ({ custom_id, params: SONNET })) });

async function setup(t, handler, opts = {}) {
  const seen = [];
  const up = http.createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { seen.push({ method: req.method, url: req.url, body: Buffer.concat(c).toString() }); handler(req, res); }); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-batch-")), "r.jsonl");
  const start = () => startMeteringProxy({ upstreams: { openai: base, anthropic: base }, receiptsPath, ...opts });
  let p = await start();
  const closers = [() => { up.closeAllConnections(); up.close(); }];
  t.after(() => { for (const c of closers) c(); p.server.closeAllConnections(); p.server.close(); });
  return {
    seen, receiptsPath,
    call: (method, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body }),
    lines: () => readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    restart: async () => { p.server.closeAllConnections(); p.server.close(); p = await start(); },
  };
}

test("path matchers are exact and hardened like count_tokens", () => {
  assert.equal(batchCreateProvider("POST", "/anthropic/v1/messages/batches"), "anthropic");
  assert.equal(batchCreateProvider("POST", "/openai/v1/batches?x=1"), "openai");
  for (const [m, u] of [["POST", "/anthropic/v1/messages/batches%2F.."], ["POST", "/openai/v1/batches/x/extra"], ["GET", "/openai/v1/batches"],
    ["POST", "/anthropic//v1/messages/batches"], ["POST", "/anthropic/v1/messages/batches/../batches"], ["POST", "/openai/v1/batches\\x"], ["POST", undefined]])
    assert.equal(batchCreateProvider(m, u), null, `${m} ${u}`);
  assert.deepEqual(batchReadPath("GET", "/anthropic/v1/messages/batches/msgbatch_01/results"), { kind: "anthropic_results", id: "msgbatch_01" });
  assert.deepEqual(batchReadPath("GET", "/openai/v1/batches/batch_01"), { kind: "openai_batch", id: "batch_01" });
  assert.deepEqual(batchReadPath("GET", "/openai/v1/files/file-out/content"), { kind: "openai_file_content", id: "file-out" });
  for (const u of ["/openai/v1/files/a%2F/content", "/openai/v1/files/a/content/x", "/anthropic/v1/messages/batches/a/b/results", "/openai/v1/batches/a/cancel"])
    assert.equal(batchReadPath("GET", u), null, u);
  assert.equal(batchReadPath("POST", "/openai/v1/batches/batch_01"), null);
  assert.deepEqual(anthropicBatchModels(ABATCH), ["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-sonnet-4-6"]);
  assert.deepEqual(anthropicBatchModels('{"requests":[{"params":{}}]}'), [null]);
  for (const b of ["nope", "{}", '{"requests":[]}']) assert.equal(anthropicBatchModels(b), null);
});

test("fold: succeeded lines at 0.5x, errored/canceled/expired and non-2xx at $0", () => {
  const a = foldBatchResults("anthropic", ANTHROPIC_RESULTS);
  assert.deepEqual(a, { ok: true, cost_usd: ANTHROPIC_EXPECTED, succeeded: 2, free: 1, by_model: { "claude-sonnet-4-6": ANTHROPIC_EXPECTED } });
  const free = ["canceled", "expired", "errored"].map((type) => JSON.stringify({ custom_id: type, result: { type } })).join("\n");
  assert.deepEqual(foldBatchResults("anthropic", free), { ok: true, cost_usd: 0, succeeded: 0, free: 3, by_model: {} });
  const o = foldBatchResults("openai", OPENAI_RESULTS);
  assert.deepEqual({ ...o, by_model: undefined }, { ok: true, cost_usd: OPENAI_EXPECTED, succeeded: 2, free: 1, by_model: undefined });
  assert.equal(Object.values(o.by_model).reduce((x, y) => x + y, 0).toFixed(6), OPENAI_EXPECTED.toFixed(6));
  assert.equal(foldBatchResults("openai", '{"id":"x","response":null,"error":{"code":"batch_expired"}}').free, 1);
});

test("fold: unpriced model, fast speed, malformed lines and empty bodies stay unknown, never $0", () => {
  const line = (model, extra = {}) => JSON.stringify({ custom_id: "x", result: { type: "succeeded", message: { model, usage: { input_tokens: 1, output_tokens: 1, ...extra } } } });
  for (const text of [line("claude-made-up-9"), line("claude-sonnet-4-6", { speed: "fast" }), `${line("claude-sonnet-4-6")}\n{not json`, "", "null",
    '{"result":{"type":"weird"}}', JSON.stringify({ result: { type: "succeeded", message: { model: "claude-sonnet-4-6" } } })]) {
    const r = foldBatchResults("anthropic", text);
    assert.equal(r.ok, false, text);
    assert.equal(r.reason, "batch_unpriced");
  }
  const oa = (body, status_code = 200) => JSON.stringify({ response: { status_code, body } });
  for (const text of [oa({ model: "gpt-made-up", usage: { prompt_tokens: 1, completion_tokens: 1 } }), oa({ model: "gpt-4o", service_tier: "priority", usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    '{"response":{}}', oa({ model: "gpt-4o" })])
    assert.equal(foldBatchResults("openai", text).ok, false, text);
});

test("pending batches do not stop the cap engine but are never counted as spend", () => {
  const pending = { ts: new Date().toISOString(), cost_usd: null, reason: "batch_pending", batch_id: "b" };
  assert.equal(isPendingBatch(pending), true);
  assert.equal(isPendingBatch({ ...pending, cost_usd: 1 }), false);
  const cap = createCapEngine({ caps: { run: 1 }, history: [pending] });
  assert.equal(cap.check(), null);
  cap.record(pending);
  assert.equal(cap.check(), null);
  cap.record({ cost_usd: null, ts: pending.ts });
  assert.equal(cap.check().reason, "unreconciled_receipt");
});

test("Anthropic: create pending, sync calls continue, results settle once at 0.5x", async (t) => {
  const s = await setup(t, mockUpstream());
  const created = await s.call("POST", "/anthropic/v1/messages/batches", ABATCH);
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { id: "msgbatch_01", type: "message_batch", processing_status: "in_progress" });
  assert.equal((await s.call("POST", "/anthropic/v1/messages", JSON.stringify(SONNET))).status, 200);
  const pend = s.lines()[0];
  assert.deepEqual([pend.reason, pend.cost_usd, pend.batch_id, pend.request_count, pend.model], ["batch_pending", null, "msgbatch_01", 3, "claude-sonnet-4-6"]);
  for (let i = 0; i < 2; i++) assert.equal((await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results")).status, 200);
  const settles = s.lines().filter((l) => l.event === "reconciliation");
  assert.equal(settles.length, 1);
  assert.deepEqual([settles[0].receipt_id, settles[0].cost_usd, settles[0].source, settles[0].batch_id], [pend.id, ANTHROPIC_EXPECTED, "batch_results", "msgbatch_01"]);
  const settled = loadSettledReceipts(s.receiptsPath).find((r) => r.id === pend.id);
  assert.deepEqual([settled.cost_usd, settled.ts], [ANTHROPIC_EXPECTED, pend.ts]);
  assert.equal(checkBudget({ receiptsPath: s.receiptsPath }).ok, true);
  // Results of a batch costcap never saw stay a free metadata read.
  await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_other/results");
  assert.equal(s.lines().at(-1).reason, "non_billable_request");
});

test("pending survives a restart and settles from the ledger exactly once", async (t) => {
  const s = await setup(t, mockUpstream());
  await s.call("POST", "/anthropic/v1/messages/batches", ABATCH);
  assert.equal(checkBudget({ receiptsPath: s.receiptsPath }).hit.reason, "batch_pending");
  await s.restart();
  await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results");
  await s.restart();
  await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results");
  assert.equal(s.lines().filter((l) => l.event === "reconciliation").length, 1);
});

test("OpenAI: batch retrieve links output_file_id; file content settles; unrelated file stays $0", async (t) => {
  const s = await setup(t, mockUpstream());
  assert.equal((await s.call("POST", "/openai/v1/batches", JSON.stringify({ input_file_id: "file-in", endpoint: "/v1/chat/completions", completion_window: "24h" }))).status, 200);
  assert.equal((await s.call("POST", "/openai/v1/chat/completions", JSON.stringify({ model: "gpt-4o-mini" }))).status, 200);
  await s.call("GET", "/openai/v1/files/file-unrelated/content");
  await s.call("GET", "/openai/v1/batches/batch_01");
  await s.call("GET", "/openai/v1/files/file-out/content");
  await s.call("GET", "/openai/v1/files/file-out/content");
  const lines = s.lines();
  const pend = lines.find((l) => l.reason === "batch_pending");
  assert.equal(pend.batch_id, "batch_01");
  assert.equal(lines.filter((l) => l.path === "/v1/files/file-unrelated/content")[0].cost_usd, 0);
  const settles = lines.filter((l) => l.event === "reconciliation");
  assert.deepEqual(settles.map((e) => [e.receipt_id, e.cost_usd]), [[pend.id, OPENAI_EXPECTED]]);
});

test("unpriced results keep the batch unknown, pause the run and never write a $0 settlement", async (t) => {
  const bad = JSON.stringify({ custom_id: "x", result: { type: "succeeded", message: { model: "claude-made-up-9", usage: { input_tokens: 1, output_tokens: 1 } } } });
  const s = await setup(t, mockUpstream({ anthropicResults: bad }));
  await s.call("POST", "/anthropic/v1/messages/batches", ABATCH);
  await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results");
  const last = s.lines().at(-1);
  assert.deepEqual([last.reason, last.cost_usd, last.batch_id], ["batch_unpriced", null, "msgbatch_01"]);
  assert.equal(s.lines().some((l) => l.event), false);
  assert.equal((await s.call("POST", "/anthropic/v1/messages", JSON.stringify(SONNET))).status, 429);
  assert.equal(checkBudget({ receiptsPath: s.receiptsPath }).ok, false);
});

test("allowlist and --unknown-models refuse check every batch request model before sending", async (t) => {
  const mixed = JSON.stringify({ requests: [{ custom_id: "a", params: { ...SONNET, model: "claude-haiku-4-5" } }, { custom_id: "b", params: { ...SONNET, model: "claude-opus-4-6" } }] });
  const s = await setup(t, mockUpstream(), { allowedModels: () => ["claude-haiku-4-5"] });
  const r = await s.call("POST", "/anthropic/v1/messages/batches", mixed);
  assert.equal(r.status, 403);
  assert.deepEqual([(await r.json()).error, s.seen.length], ["model_not_allowed", 0]);
  assert.equal(s.lines()[0].model, "claude-opus-4-6");
  assert.equal((await s.call("POST", "/anthropic/v1/messages", JSON.stringify({ ...SONNET, model: "claude-haiku-4-5" }))).status, 200);
  // OpenAI batches name models only inside the input file: refused under an allowlist (documented).
  assert.equal((await s.call("POST", "/openai/v1/batches", "{}")).status, 403);
  const u = await setup(t, mockUpstream(), { unknownModels: "refuse" });
  const unk = JSON.stringify({ requests: [{ custom_id: "a", params: SONNET }, { custom_id: "b", params: { ...SONNET, model: "claude-made-up-9" } }] });
  assert.equal((await u.call("POST", "/anthropic/v1/messages/batches", unk)).status, 403);
  assert.equal(u.seen.length, 0);
  assert.equal((await u.call("POST", "/anthropic/v1/messages/batches", ABATCH)).status, 200);
});

test("hardened look-alike paths are not batch creates and still pause", async (t) => {
  for (const path of ["/anthropic/v1/messages/batches%2F..", "/openai/v1/batches/x/extra"]) {
    const s = await setup(t, (req, res) => { req.resume(); res.end('{"id":"b"}'); });
    await s.call("POST", path, "{}");
    assert.equal(s.lines()[0].reason, "usage_unavailable", path);
  }
});

test("#230 Gemini look-alike batch paths are not batch creates and still pause", async (t) => {
  for (const path of ["/gemini/v1beta/models/gemini-2.5-flash:batchGenerateContent%2F..", "/gemini/v1beta/batches/x/extra"]) {
    const up = http.createServer((req, res) => { req.resume(); res.end('{"name":"batches/b"}'); });
    await new Promise((r) => up.listen(0, "127.0.0.1", r));
    const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-gla-")), "r.jsonl");
    const p = await startMeteringProxy({ upstreams: { gemini: `http://127.0.0.1:${up.address().port}` }, receiptsPath });
    t.after(() => { up.closeAllConnections(); up.close(); p.server.closeAllConnections(); p.server.close(); });
    await fetch(`http://127.0.0.1:${p.port}${path}`, { method: "POST", body: "{}" });
    assert.equal(JSON.parse(readFileSync(receiptsPath, "utf8").trim().split("\n")[0]).reason, "usage_unavailable", path);
  }
});

test("#232 AC1: a gpt-6-astra batch line settles at 0.5x standard; ultrafast stays unknown", () => {
  const line = (extra = {}) => JSON.stringify({ response: { status_code: 200, body: { model: "gpt-6-astra-2026-04-30", ...extra, usage: { prompt_tokens: 1000, completion_tokens: 1000 } } } });
  const r = foldBatchResults("openai", line());
  assert.deepEqual([r.ok, r.cost_usd, r.succeeded], [true, 0.03, 1]); // (1000*10 + 1000*50)/1e6 * 0.5
  for (const t of ["fast", "ultrafast", "turbo"]) assert.equal(foldBatchResults("openai", line({ service_tier: t })).ok, false, t);
});

test("#234 AC3: a claude-haiku-5-5 >100K batch line settles at 0.5x the long-context rate", () => {
  const line = JSON.stringify({ custom_id: "h", result: { type: "succeeded", message: { model: "claude-haiku-5-5", usage: { input_tokens: 90_000, cache_read_input_tokens: 20_000, output_tokens: 1000 } } } });
  const r = foldBatchResults("anthropic", line);
  assert.deepEqual([r.ok, r.cost_usd, r.succeeded], [true, 0.02425, 1]);
});
