// #288: non-Anthropic Bedrock InvokeModel / InvokeModelWithResponseStream metering. Local stub only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMeteringProxy, extractBedrockInvokeUsage, createBedrockInvokeStreamUsageParser } from "../src/proxy.js";
import { bedrockChunkFrame, bedrockHeaderUsage, bedrockInvokeBodyUsage, invocationMetricsUsage } from "../src/cloud.js";
import { signRequest } from "../src/sigv4.js";
import { createCapEngine } from "../src/cap.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TABLE = JSON.parse(readFileSync(path.join(ROOT, "src/pricing-table.json"), "utf8"));
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }; // AWS docs example
const ENV = { AWS_ACCESS_KEY_ID: CREDS.accessKeyId, AWS_SECRET_ACCESS_KEY: CREDS.secretAccessKey, AWS_REGION: "us-east-1" };
const NOVA = "amazon.nova-pro-v1:0";
const enc = (id) => encodeURIComponent(id);
const row = (id, region = "us-east-1") => TABLE.bedrock_models.models[id].regions[region];
const cost = (id, inp, out, cached = 0) => { const r = row(id); return Number(((inp * r.input + out * r.output + cached * (r.cached_input ?? 0)) / 1e6).toFixed(6)); };
const H = (o) => new Headers(o);

const novaInvoke = { output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn",
  usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1700, cacheReadInputTokenCount: 200 } };
const llamaInvoke = { generation: "hi", prompt_token_count: 1000, generation_token_count: 500, stop_reason: "stop" };
const oaiInvoke = { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } };
const metrics = { inputTokenCount: 1000, outputTokenCount: 500, invocationLatency: 9, firstByteLatency: 3 };
const streamFrames = [bedrockChunkFrame({ generation: "h" }), bedrockChunkFrame({ generation: "i" }),
  bedrockChunkFrame({ generation: "", stop_reason: "stop", "amazon-bedrock-invocationMetrics": metrics })];

test("body usage: Nova, Llama, OpenAI-style, invocationMetrics; malformed is null", () => {
  assert.deepEqual(bedrockInvokeBodyUsage(novaInvoke), { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 });
  assert.deepEqual(bedrockInvokeBodyUsage({ usage: { inputTokens: 1, outputTokens: 2, cacheWriteInputTokenCount: 3 } }), { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3 });
  assert.deepEqual(bedrockInvokeBodyUsage(llamaInvoke), { input_tokens: 1000, output_tokens: 500 });
  assert.deepEqual(bedrockInvokeBodyUsage(oaiInvoke), { input_tokens: 1000, output_tokens: 500 });
  assert.deepEqual(bedrockInvokeBodyUsage({ usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4 } } }), { input_tokens: 6, output_tokens: 1, cache_read_input_tokens: 4 });
  assert.deepEqual(bedrockInvokeBodyUsage({ "amazon-bedrock-invocationMetrics": metrics }), { input_tokens: 1000, output_tokens: 500 });
  for (const bad of [null, [], "x", {}, { outputs: [{ text: "mistral" }] }, { usage: { inputTokens: 1 } }, { usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokenCount: -1 } },
    { usage: { prompt_tokens: 1.5, completion_tokens: 1 } }, { usage: { prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } } },
    { prompt_token_count: 1 }]) assert.equal(bedrockInvokeBodyUsage(bad), null, JSON.stringify(bad));
  assert.equal(invocationMetricsUsage({ inputTokenCount: 1 }), null);
});

test("header usage: X-Amzn-Bedrock token counts, cache counts, malformed is null", () => {
  assert.deepEqual(bedrockHeaderUsage(H({ "X-Amzn-Bedrock-Input-Token-Count": "1000", "X-Amzn-Bedrock-Output-Token-Count": "500" })), { input_tokens: 1000, output_tokens: 500 });
  assert.deepEqual(bedrockHeaderUsage(H({ "x-amzn-bedrock-input-token-count": "1", "x-amzn-bedrock-output-token-count": "2", "x-amzn-bedrock-cache-read-input-token-count": "3" })),
    { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 });
  assert.equal(bedrockHeaderUsage(H({ "x-amzn-bedrock-input-token-count": "1" })), null);
  assert.equal(bedrockHeaderUsage(H({ "x-amzn-bedrock-input-token-count": "-1", "x-amzn-bedrock-output-token-count": "2" })), null);
  assert.equal(bedrockHeaderUsage(H({ "x-amzn-bedrock-input-token-count": "1", "x-amzn-bedrock-output-token-count": "2", "x-amzn-bedrock-cache-read-input-token-count": "x" })), null);
  assert.equal(bedrockHeaderUsage(undefined), null);
  // Body wins; headers are the fallback (Mistral's native body has no usage).
  assert.equal(extractBedrockInvokeUsage(JSON.stringify({ outputs: [{ text: "hi" }] }), H({ "x-amzn-bedrock-input-token-count": "7", "x-amzn-bedrock-output-token-count": "8" }), "m").usage.input_tokens, 7);
  assert.equal(extractBedrockInvokeUsage("not json", H({}), "m"), null);
});

test("stream parser: priced from final invocationMetrics; cut, duplicate, bad or corrupt is incomplete", () => {
  const all = Buffer.concat(streamFrames);
  const p = createBedrockInvokeStreamUsageParser("m");
  for (let i = 0; i < all.length; i += 5) p.push(all.subarray(i, i + 5));
  assert.equal(p.incomplete, false);
  assert.deepEqual(p.end().usage.input_tokens, 1000);
  const cut = createBedrockInvokeStreamUsageParser("m");
  cut.push(Buffer.concat(streamFrames.slice(0, 2)));
  assert.equal(cut.incomplete, true); assert.equal(cut.end(), null);
  const dup = createBedrockInvokeStreamUsageParser("m");
  dup.push(Buffer.concat([all, streamFrames[2]]));
  assert.equal(dup.incomplete, true); assert.equal(dup.end(), null);
  const bad = createBedrockInvokeStreamUsageParser("m");
  bad.push(bedrockChunkFrame({ "amazon-bedrock-invocationMetrics": { inputTokenCount: 1 } }));
  assert.equal(bad.incomplete, true);
  const partial = createBedrockInvokeStreamUsageParser("m");
  partial.push(all.subarray(0, all.length - 2));
  assert.equal(partial.incomplete, true);
});

// ---- proxy against a local stub ----
async function stub(handler) {
  const hits = [];
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { hits.push(req.url); handler(req, res); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, url: `http://127.0.0.1:${server.address().port}` };
}
async function proxyFor(t, up, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-288-"));
  const receipts = [];
  const { server, port } = await startMeteringProxy({ receiptsPath: path.join(dir, "r.jsonl"), upstreams: { bedrock: up.url }, cloudEnv: ENV,
    onReceipt: (r) => receipts.push(r), onWarning: () => {}, ...opts });
  t.after(() => { server.close(); up.server.close(); });
  return { base: `http://127.0.0.1:${port}`, port, receipts };
}
function post(p, pathname, body = JSON.stringify({ prompt: "hi", max_gen_len: 100 })) {
  const headers = signRequest({ method: "POST", path: pathname, headers: { "content-type": "application/json" }, body, host: `127.0.0.1:${p.port}`, region: "us-east-1", service: "bedrock" }, CREDS);
  delete headers.host;
  return fetch(`${p.base}${pathname}`, { method: "POST", headers, body });
}
const json = (body, headers = {}) => (req, res) => res.writeHead(200, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

test("AC1 Nova invoke priced at the us-east-1 row (same as Converse); the run continues", async (t) => {
  const p = await proxyFor(t, await stub(json(novaInvoke)), { cap: createCapEngine({ caps: { run: 10 } }) });
  const r = await post(p, `/bedrock/model/${enc(NOVA)}/invoke`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), novaInvoke);
  assert.deepEqual([p.receipts[0].model, p.receipts[0].cost_usd, p.receipts[0].reason], [NOVA, cost(NOVA, 1000, 500, 200), undefined]);
  assert.equal((await post(p, `/bedrock/model/${enc(`us.${NOVA}`)}/invoke`)).status, 200);
  assert.equal(p.receipts[1].cost_usd, cost(NOVA, 1000, 500, 200));
});

test("AC2 Llama / gpt-oss / Qwen / DeepSeek bodies and Mistral headers are priced", async (t) => {
  const cases = [
    ["meta.llama3-3-70b-instruct-v1:0", json(llamaInvoke)],
    ["openai.gpt-oss-120b-1:0", json(oaiInvoke)],
    ["qwen.qwen3-32b-v1:0", json(oaiInvoke)],
    ["deepseek.r1-v1:0", json({ choices: [{ text: "hi" }] }, { "x-amzn-bedrock-input-token-count": "1000", "x-amzn-bedrock-output-token-count": "500" })],
    ["mistral.mistral-large-3-675b-instruct", json({ outputs: [{ text: "hi" }] }, { "x-amzn-bedrock-input-token-count": "1000", "x-amzn-bedrock-output-token-count": "500" })],
  ];
  for (const [id, h] of cases) {
    const p = await proxyFor(t, await stub(h));
    assert.equal((await post(p, `/bedrock/model/${enc(id)}/invoke`)).status, 200, id);
    assert.deepEqual([p.receipts[0].cost_usd, p.receipts[0].reason], [cost(id, 1000, 500), undefined], id);
  }
});

test("AC3 invoke-with-response-stream priced from invocationMetrics; cut stream is stream_incomplete and pauses", async (t) => {
  const LL = "meta.llama3-3-70b-instruct-v1:0";
  const p = await proxyFor(t, await stub((req, res) => res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" }).end(Buffer.concat(streamFrames))));
  const s = await post(p, `/bedrock/model/${enc(LL)}/invoke-with-response-stream`);
  assert.ok(Buffer.from(await s.arrayBuffer()).equals(Buffer.concat(streamFrames)));
  assert.equal(p.receipts[0].cost_usd, cost(LL, 1000, 500));
  const c = await proxyFor(t, await stub((req, res) => res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" }).end(Buffer.concat(streamFrames.slice(0, 2)))));
  await (await post(c, `/bedrock/model/${enc(LL)}/invoke-with-response-stream`)).arrayBuffer();
  assert.deepEqual([c.receipts[0].cost_usd, c.receipts[0].reason], [null, "stream_incomplete"]);
  assert.equal((await post(c, `/bedrock/model/${enc(LL)}/invoke`)).status, 429);
});

test("AC4 no body usage and no headers stays usage_unavailable (null) and pauses the run", async (t) => {
  const p = await proxyFor(t, await stub(json({ outputs: [{ text: "hi" }] })));
  assert.equal((await post(p, `/bedrock/model/${enc("mistral.mistral-large-3-675b-instruct")}/invoke`)).status, 200);
  assert.deepEqual([p.receipts[0].cost_usd, p.receipts[0].reason], [null, "usage_unavailable"]);
  assert.equal((await post(p, `/bedrock/model/${enc(NOVA)}/invoke`)).status, 429);
});
