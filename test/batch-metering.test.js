// #160: OpenAI Batch API and Anthropic Message Batches metered at the batch rate.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy, extractUsage } from "../src/proxy.js";
import { costForUsage, isPricedModel, premiumTier, batchMultiplier } from "../src/pricing.js";
import { createCapEngine, loadSettledReceipts } from "../src/cap.js";
import { checkBudget } from "../src/check.js";
import { anthropicBatchModels, anthropicResultsBatchId, batchCreateProvider, createBatchIndex, foldBatchResults,
  openaiBatchGetId, openaiFileContentId, pendingFromCreate } from "../src/batch.js";

const SONNET = "claude-sonnet-4-6";
const A_USAGE = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000 };
const B_USAGE = { input_tokens: 2000, output_tokens: 1000 };
const STD_ANTHROPIC = 0.0111 + 0.021; // standard cost of A + B
const okLine = (id, usage, model = SONNET, extra = {}) => JSON.stringify({ custom_id: id, result: { type: "succeeded", message: { id: `msg_${id}`, model, usage: { ...usage, ...extra } } } });
const ANTHROPIC_JSONL = [okLine("a", A_USAGE), okLine("b", B_USAGE), JSON.stringify({ custom_id: "c", result: { type: "errored", error: { type: "invalid_request" } } })].join("\n") + "\n";
const OPENAI_JSONL = [
  JSON.stringify({ id: "r1", custom_id: "1", response: { status_code: 200, body: { model: "gpt-4o-mini", usage: { prompt_tokens: 1000, completion_tokens: 1000 } } }, error: null }),
  JSON.stringify({ id: "r2", custom_id: "2", response: { status_code: 200, body: { object: "response", model: "gpt-4o-mini", usage: { input_tokens: 2000, output_tokens: 500, input_tokens_details: { cached_tokens: 1000 } } } }, error: null }),
  JSON.stringify({ id: "r3", custom_id: "3", response: { status_code: 400, body: { error: { message: "bad" } } }, error: null }),
].join("\n");
const STD_OPENAI = 0.00075 + 0.000525;
const deps = (provider) => ({ extractUsage, costForUsage, isPricedModel, premiumTier, multiplier: batchMultiplier(provider) });
const batchBody = (models) => JSON.stringify({ requests: models.map((model, i) => ({ custom_id: String(i), params: { model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] } })) });

test("#160 path matchers are exact and hardened like isCountTokensPath", () => {
  assert.equal(batchCreateProvider("POST", "/anthropic/v1/messages/batches"), "anthropic");
  assert.equal(batchCreateProvider("POST", "/openai/v1/batches?x=1"), "openai");
  for (const u of ["/anthropic/v1/messages/batches%2F..", "/openai/v1/batches/x/extra", "/anthropic//v1/messages/batches", "/anthropic/v1/messages/batches/", "/openai/v1/batches/../batches", undefined])
    assert.equal(batchCreateProvider("POST", u), null, String(u));
  assert.equal(batchCreateProvider("GET", "/openai/v1/batches"), null);
  assert.equal(anthropicResultsBatchId("GET", "/anthropic/v1/messages/batches/msgbatch_1/results"), "msgbatch_1");
  assert.equal(anthropicResultsBatchId("GET", "/anthropic/v1/messages/batches/a%2F/results"), null);
  assert.equal(anthropicResultsBatchId("POST", "/anthropic/v1/messages/batches/x/results"), null);
  assert.equal(openaiBatchGetId("GET", "/openai/v1/batches/batch_1"), "batch_1");
  assert.equal(openaiBatchGetId("GET", "/openai/v1/batches/batch_1/cancel"), null);
  assert.equal(openaiFileContentId("GET", "/openai/v1/files/file-1/content"), "file-1");
  assert.equal(openaiFileContentId("GET", "/openai/v1/files/../content"), null);
});

test("#160 anthropicBatchModels and pendingFromCreate", () => {
  assert.deepEqual(anthropicBatchModels(batchBody([SONNET, "claude-haiku-4-5"])), [SONNET, "claude-haiku-4-5"]);
  for (const b of ["nope", "{}", '{"requests":[]}', '{"requests":[{"params":{}}]}']) assert.equal(anthropicBatchModels(b), null, b);
  assert.deepEqual(pendingFromCreate("anthropic", batchBody([SONNET, SONNET, SONNET]), '{"id":"msgbatch_1"}'), { batch_id: "msgbatch_1", request_count: 3, model: SONNET });
  assert.equal(pendingFromCreate("anthropic", batchBody([SONNET, "claude-haiku-4-5"]), '{"id":"m"}').model, "mixed");
  assert.deepEqual(pendingFromCreate("openai", '{"input_file_id":"f"}', '{"id":"batch_1","request_counts":{"total":2}}'), { batch_id: "batch_1", request_count: 2, model: "unknown" });
  assert.equal(pendingFromCreate("openai", "{}", '{"error":{}}'), null);
  assert.equal(pendingFromCreate("openai", "{}", "not json"), null);
});

test("#160 fold: succeeded at 0.5x, errored/canceled/expired and non-2xx lines at $0", () => {
  const a = foldBatchResults("anthropic", ANTHROPIC_JSONL, deps("anthropic"));
  assert.equal(a.cost_usd, Number((STD_ANTHROPIC * 0.5).toFixed(6)));
  assert.deepEqual([a.succeeded, a.free], [2, 1]);
  assert.equal(a.by_model[SONNET].cached_input_tokens, 2000);
  const free = ["canceled", "expired", "errored"].map((type) => JSON.stringify({ custom_id: type, result: { type } })).join("\n");
  assert.equal(foldBatchResults("anthropic", free, deps("anthropic")).cost_usd, 0);
  const o = foldBatchResults("openai", OPENAI_JSONL, deps("openai"));
  assert.equal(o.cost_usd, Number((STD_OPENAI * 0.5).toFixed(6)));
  assert.deepEqual([o.succeeded, o.free], [2, 1]);
  assert.equal(foldBatchResults("openai", JSON.stringify({ id: "x", response: null, error: { code: "batch_expired" } }), deps("openai")).cost_usd, 0);
});

test("#160 fold: unpriced, fast, malformed and empty never produce $0", () => {
  const cases = [
    ["anthropic", okLine("u", B_USAGE, "claude-imaginary-9"), "batch_unpriced"],
    ["anthropic", okLine("f", B_USAGE, SONNET, { speed: "fast" }), "batch_unpriced"],
    ["anthropic", okLine("a", A_USAGE) + "\n{not json", "batch_results_malformed"],
    ["anthropic", JSON.stringify({ result: { type: "weird" } }), "batch_results_malformed"],
    ["anthropic", "", "batch_results_malformed"],
    ["openai", JSON.stringify({ response: { status_code: 200, body: { model: "gpt-4o-mini" } } }), "batch_results_malformed"],
    ["openai", JSON.stringify({ response: {} }), "batch_results_malformed"],
    ["openai", JSON.stringify({ response: { status_code: 200, body: { model: "mystery-1", usage: { prompt_tokens: 1, completion_tokens: 1 } } } }), "batch_unpriced"],
  ];
  for (const [p, text, reason] of cases) assert.deepEqual([foldBatchResults(p, text, deps(p)).cost_usd, foldBatchResults(p, text, deps(p)).reason], [null, reason], text);
  assert.equal(foldBatchResults("anthropic", ANTHROPIC_JSONL, { ...deps("anthropic"), multiplier: null }).reason, "batch_unpriced");
});

test("#160 batch index: pending lookup, file link, settled once", () => {
  const idx = createBatchIndex([{ id: "r1", provider: "openai", reason: "batch_pending", batch_id: "b1", cost_usd: null },
    { id: "r2", provider: "openai", batch_id: "b1", output_file_id: "f1", cost_usd: 0 }]);
  assert.equal(idx.pendingFor("openai", "b1").id, "r1");
  assert.equal(idx.batchForFile("f1"), "b1");
  assert.equal(idx.pendingFor("anthropic", "b1"), null);
  idx.observe({ event: "reconciliation", receipt_id: "r1", cost_usd: 1 });
  assert.equal(idx.pendingFor("openai", "b1"), null);
  assert.equal(idx.isTracked("openai", "b1"), true);
});

test("#160 cap engine: a pending batch does not block wrap but does block a read-only check", () => {
  const pending = { ts: new Date().toISOString(), cost_usd: null, reason: "batch_pending" };
  assert.equal(createCapEngine({ history: [pending], pendingBatchesBlock: false }).check(), null);
  assert.equal(createCapEngine({ history: [pending] }).check().reason, "unreconciled_receipt");
  const live = createCapEngine({ pendingBatchesBlock: false });
  live.record(pending);
  assert.equal(live.check(), null);
  live.record({ ...pending, reason: "usage_unavailable" });
  assert.equal(live.check().reason, "unreconciled_receipt");
});

async function proxy(t, handler, opts = {}) {
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const file = join(mkdtempSync(join(tmpdir(), "cc-batch-")), "r.jsonl");
  const p = await startMeteringProxy({ upstreams: { openai: base, anthropic: base }, receiptsPath: file, cap: createCapEngine({ pendingBatchesBlock: false }), ...opts });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = (method, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body });
  const lines = () => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { call, lines, file };
}

const anthropicUpstream = (results = ANTHROPIC_JSONL, hits = []) => (req, res) => {
  let s = ""; req.on("data", (c) => { s += c; });
  req.on("end", () => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/v1/messages/batches") return res.end(JSON.stringify({ id: "msgbatch_1", type: "message_batch", processing_status: "in_progress" }));
    if (req.url === "/v1/messages/batches/msgbatch_1/results") return res.writeHead(200, { "content-type": "application/binary" }).end(results);
    res.end(JSON.stringify({ model: SONNET, usage: { input_tokens: 10, output_tokens: 1 } }));
  });
};

test("#160 Anthropic: create is pending and not frozen; results settle once at 0.5x", async (t) => {
  const { call, lines, file } = await proxy(t, anthropicUpstream());
  const created = await call("POST", "/anthropic/v1/messages/batches", batchBody([SONNET, SONNET, SONNET]));
  assert.equal(created.status, 200);
  assert.equal((await created.json()).id, "msgbatch_1");
  assert.equal((await call("POST", "/anthropic/v1/messages", JSON.stringify({ model: SONNET }))).status, 200);
  const [pending] = lines();
  assert.deepEqual([pending.reason, pending.cost_usd, pending.batch_id, pending.request_count, pending.model], ["batch_pending", null, "msgbatch_1", 3, SONNET]);
  assert.equal(checkBudget({ receiptsPath: file }).ok, false);
  const res = await call("GET", "/anthropic/v1/messages/batches/msgbatch_1/results");
  assert.equal(await res.text(), ANTHROPIC_JSONL);
  await call("GET", "/anthropic/v1/messages/batches/msgbatch_1/results");
  const settlements = lines().filter((l) => l.event === "reconciliation");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].source, "batch_results");
  assert.equal(settlements[0].receipt_id, pending.id);
  assert.equal(settlements[0].cost_usd, Number((STD_ANTHROPIC * 0.5).toFixed(6)));
  const gets = lines().filter((l) => l.path?.endsWith("/results"));
  assert.deepEqual(gets.map((g) => [g.cost_usd, g.reason]), [[0, "batch_results"], [0, "batch_results"]]);
  assert.equal(gets[1].already_settled, true);
  const settled = loadSettledReceipts(file).find((r) => r.id === pending.id);
  assert.equal(settled.ts, pending.ts);
  assert.equal(settled.cost_usd, settlements[0].cost_usd);
  assert.equal(checkBudget({ receiptsPath: file, caps: { run: 0.02 } }).ok, true, "full rate would exceed $0.02");
});

test("#160 Anthropic: unpriced/fast/malformed results and unfetched batches stay unknown", async (t) => {
  for (const results of [okLine("u", B_USAGE, "claude-imaginary-9"), okLine("f", B_USAGE, SONNET, { speed: "fast" }), "{oops"]) {
    const { call, lines, file } = await proxy(t, anthropicUpstream(results));
    await call("POST", "/anthropic/v1/messages/batches", batchBody([SONNET]));
    await call("GET", "/anthropic/v1/messages/batches/msgbatch_1/results");
    assert.equal(lines().filter((l) => l.event).length, 0, results);
    assert.match(lines()[1].reason, /^batch_(unpriced|results_malformed)$/);
    assert.equal(lines()[1].cost_usd, 0);
    const c = checkBudget({ receiptsPath: file });
    assert.deepEqual([c.ok, c.unknown_cost_count], [false, 1]);
    assert.equal((await call("POST", "/anthropic/v1/messages", JSON.stringify({ model: SONNET }))).status, 200, "not frozen");
  }
});

test("#160 allowlist: one disallowed batch model refuses the whole batch before it is sent", async (t) => {
  const hits = [];
  const { call, lines } = await proxy(t, anthropicUpstream(ANTHROPIC_JSONL, hits), { allowedModels: () => ["claude-haiku-4-5"] });
  const r = await call("POST", "/anthropic/v1/messages/batches", batchBody(["claude-haiku-4-5", "claude-opus-4-5"]));
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.deepEqual([j.error, j.model], ["model_not_allowed", "claude-opus-4-5"]);
  assert.deepEqual([lines()[0].outcome, lines()[0].cost_usd], ["blocked_model", 0]);
  assert.equal(hits.length, 0);
  assert.equal((await call("POST", "/anthropic/v1/messages/batches", batchBody(["claude-haiku-4-5"]))).status, 200);
  assert.equal((await call("POST", "/anthropic/v1/messages", JSON.stringify({ model: "claude-haiku-4-5" }))).status, 200, "not frozen");
  assert.equal((await call("POST", "/anthropic/v1/messages/batches", "{}")).status, 403, "no models: refused");
  assert.equal((await call("POST", "/openai/v1/batches", '{"input_file_id":"f"}')).status, 403, "OpenAI batch create stays refused under an allowlist");
});

test("#160 --unknown-models refuse checks every batch model", async (t) => {
  const hits = [];
  const { call } = await proxy(t, anthropicUpstream(ANTHROPIC_JSONL, hits), { unknownModels: "refuse" });
  const r = await call("POST", "/anthropic/v1/messages/batches", batchBody([SONNET, "claude-imaginary-9"]));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "model_unpriced");
  assert.equal(hits.length, 0);
});

const openaiUpstream = (req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/v1/batches") return res.end(JSON.stringify({ id: "batch_1", object: "batch", input_file_id: "file-in", status: "validating", request_counts: { total: 3, completed: 0, failed: 0 } }));
    if (req.url === "/v1/batches/batch_1") return res.end(JSON.stringify({ id: "batch_1", object: "batch", status: "completed", output_file_id: "file-out" }));
    if (req.url === "/v1/files/file-out/content") return res.end(OPENAI_JSONL);
    if (req.url === "/v1/files/file-other/content") return res.end(OPENAI_JSONL);
    res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
};

test("#160 OpenAI: create, link output_file_id, settle from file content at 0.5x; unrelated file stays $0", async (t) => {
  const { call, lines, file } = await proxy(t, openaiUpstream);
  assert.equal((await call("POST", "/openai/v1/batches", '{"input_file_id":"file-in","endpoint":"/v1/chat/completions","completion_window":"24h"}')).status, 200);
  assert.equal((await call("POST", "/openai/v1/chat/completions", '{"model":"gpt-4o-mini"}')).status, 200);
  await call("GET", "/openai/v1/files/file-out/content"); // before the link: not metered
  await call("GET", "/openai/v1/batches/batch_1");
  await call("GET", "/openai/v1/files/file-out/content");
  await call("GET", "/openai/v1/files/file-out/content");
  await call("GET", "/openai/v1/files/file-other/content");
  const all = lines();
  assert.deepEqual([all[0].reason, all[0].batch_id, all[0].request_count, all[0].cost_usd], ["batch_pending", "batch_1", 3, null]);
  assert.equal(all[2].reason, "non_billable_request");
  assert.equal(all[3].output_file_id, "file-out");
  const settlements = all.filter((l) => l.event === "reconciliation");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].cost_usd, Number((STD_OPENAI * 0.5).toFixed(6)));
  assert.deepEqual([all.at(-1).cost_usd, all.at(-1).reason], [0, "non_billable_request"]);
  assert.equal(checkBudget({ receiptsPath: file }).ok, true);
});

test("#160 a later proxy on the same ledger settles a batch created earlier", async (t) => {
  const first = await proxy(t, anthropicUpstream());
  await first.call("POST", "/anthropic/v1/messages/batches", batchBody([SONNET]));
  const second = await proxy(t, anthropicUpstream(), { receiptsPath: first.file });
  await second.call("GET", "/anthropic/v1/messages/batches/msgbatch_1/results");
  assert.equal(first.lines().filter((l) => l.event === "reconciliation").length, 1);
});

test("#160 a results fetch for an untracked batch is a plain $0 GET", async (t) => {
  const { call, lines } = await proxy(t, anthropicUpstream());
  await call("GET", "/anthropic/v1/messages/batches/msgbatch_1/results");
  assert.deepEqual([lines()[0].cost_usd, lines()[0].reason], [0, "non_billable_request"]);
});

test("#160 agent budgets: a pending batch is not an unreconciled receipt, other unknowns still are", async () => {
  const { createAgentBudgets } = await import("../src/agent-budget.js");
  const who = { agent_id: "a1", run_id: "r1" };
  const ts = new Date().toISOString();
  const b = createAgentBudgets({ policy: { default: { run: 10 } }, history: [{ ts, ...who, cost_usd: null, reason: "batch_pending" }] });
  assert.equal(b.check(who), null);
  b.record({ ts, ...who, cost_usd: null, reason: "usage_unavailable" });
  assert.equal(b.check(who).verdict, "accounting_unavailable");
});
