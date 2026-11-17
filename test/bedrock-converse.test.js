// #216: Bedrock Converse / ConverseStream metering. Local stub only: no AWS, no live calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMeteringProxy, createConverseStreamUsageParser, extractConverseUsage, extractUsage } from "../src/proxy.js";
import { classifyCloudRoute, converseEventFrame, converseUsage, createEventStreamDecoder } from "../src/cloud.js";
import { signRequest, verifyRequest } from "../src/sigv4.js";
import { costForUsage } from "../src/pricing.js";
import { createCapEngine } from "../src/cap.js";
import { estimateWorstCase, requestedOutputTokens } from "../src/preflight.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGV4 = pathToFileURL(path.join(ROOT, "src/sigv4.js")).href;
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"; // AWS documentation example key
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET };
const ENV = { AWS_ACCESS_KEY_ID: CREDS.accessKeyId, AWS_SECRET_ACCESS_KEY: SECRET, AWS_REGION: "us-east-1" };
const SONNET_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const enc = (id) => id.replace(/:/g, "%3A");
const cUsage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1800, cacheReadInputTokens: 200, cacheWriteInputTokens: 100 };
const aUsage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 };
const converseBody = { output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: cUsage, metrics: { latencyMs: 5 } };
const streamFrames = [
  converseEventFrame("messageStart", { role: "assistant" }),
  converseEventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hi" } }),
  converseEventFrame("contentBlockStop", { contentBlockIndex: 0 }),
  converseEventFrame("messageStop", { stopReason: "end_turn" }),
  converseEventFrame("metadata", { usage: cUsage, metrics: { latencyMs: 5 } }),
];
const STREAM = Buffer.concat(streamFrames);

test("route classification: converse and converse-stream on the Bedrock mount", () => {
  assert.deepEqual(classifyCloudRoute("bedrock", "POST", `/model/${enc(SONNET_ID)}/converse`),
    { modelId: SONNET_ID, stream: false, countTokens: false, converse: true, scope: "regional" });
  assert.deepEqual(classifyCloudRoute("bedrock", "POST", "/model/global.anthropic.claude-haiku-4-5-v1:0/converse-stream"),
    { modelId: "global.anthropic.claude-haiku-4-5-v1:0", stream: true, countTokens: false, converse: true, scope: "global" });
  assert.equal(classifyCloudRoute("bedrock", "GET", "/model/x/converse"), null);
  assert.equal(classifyCloudRoute("bedrock", "POST", "/model/x/converse/extra"), null);
  assert.equal(classifyCloudRoute("bedrock", "POST", "/model/x/invoke").converse, undefined);
});

test("converseUsage maps counters; missing counters are null", () => {
  assert.deepEqual(converseUsage(cUsage), aUsage);
  assert.deepEqual(converseUsage({ inputTokens: 3, outputTokens: 4 }), { input_tokens: 3, output_tokens: 4 });
  for (const bad of [null, "x", {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1.5, outputTokens: 1 }]) assert.equal(converseUsage(bad), null);
});

test("usage extraction from Converse JSON and the ConverseStream metadata frame equals invoke usage", () => {
  const invoke = extractUsage("anthropic", JSON.stringify({ usage: aUsage }), "claude-sonnet-4-5");
  const nonStream = extractConverseUsage(JSON.stringify(converseBody), "claude-sonnet-4-5");
  assert.deepEqual(nonStream, invoke);
  assert.equal(extractConverseUsage("not json", "m"), null);
  assert.equal(extractConverseUsage(JSON.stringify({ output: {} }), "m"), null);
  // Arbitrary byte splits.
  const p = createConverseStreamUsageParser("claude-sonnet-4-5");
  for (let i = 0; i < STREAM.length; i += 7) p.push(STREAM.subarray(i, i + 7));
  assert.equal(p.incomplete, false);
  assert.deepEqual(p.end(), invoke);
  // Pricing equivalence (regional premium included).
  assert.equal(costForUsage(nonStream.model, nonStream.usage, { regional: true }).cost_usd, costForUsage(invoke.model, invoke.usage, { regional: true }).cost_usd);
});

test("ConverseStream parser: cut before metadata, bad metadata and exception frames are incomplete", () => {
  const cut = createConverseStreamUsageParser("m");
  cut.push(Buffer.concat(streamFrames.slice(0, 4)));
  assert.equal(cut.incomplete, true); assert.equal(cut.end(), null);
  const bad = createConverseStreamUsageParser("m");
  bad.push(converseEventFrame("metadata", { usage: { inputTokens: 1 } }));
  assert.equal(bad.incomplete, true); assert.equal(bad.end(), null);
  const partial = createConverseStreamUsageParser("m");
  partial.push(STREAM.subarray(0, STREAM.length - 3));
  assert.equal(partial.incomplete, true);
  const events = [];
  const d = createEventStreamDecoder((e, type) => events.push(type), { converse: true });
  d.push(STREAM);
  assert.deepEqual(events, ["messageStart", "contentBlockDelta", "contentBlockStop", "messageStop", "metadata"]);
});

test("preflight reads inferenceConfig.maxTokens", () => {
  assert.deepEqual(requestedOutputTokens("bedrock", { inferenceConfig: { maxTokens: 123 } }), { tokens: 123, defaulted: false });
  const e = estimateWorstCase("bedrock", JSON.stringify({ inferenceConfig: { maxTokens: 1000 } }), "", undefined, "claude-sonnet-4-5");
  assert.equal(e.output_tokens, 1000);
});

// ---- proxy against a local stub ----

async function stub(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const [p, q = ""] = req.url.split("?");
      const sig = String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256")
        ? verifyRequest({ method: req.method, path: p, search: q ? `?${q}` : "", headers: req.headers, body }, CREDS) : null;
      hits.push({ url: req.url, host: req.headers.host, sig });
      handler(req, res);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, url: `http://127.0.0.1:${server.address().port}` };
}
const stubState = { cut: false };
const converseHandler = (req, res) => {
  if (req.url.endsWith("/converse-stream")) {
    res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    if (stubState.cut) { res.end(Buffer.concat(streamFrames.slice(0, 4))); return; }
    let i = 0;
    const next = () => { if (i < streamFrames.length) { res.write(streamFrames[i++]); setTimeout(next, 2); } else res.end(); };
    next();
  } else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(converseBody));
};

async function proxyFor(t, upstream, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-converse-"));
  const receipts = [];
  const { server, port } = await startMeteringProxy({ receiptsPath: path.join(dir, "r.jsonl"), upstreams: { bedrock: upstream.url }, cloudEnv: ENV,
    onReceipt: (r) => receipts.push(r), onWarning: () => {}, ...opts });
  t.after(() => { server.close(); upstream.server.close(); });
  return { base: `http://127.0.0.1:${port}`, port, receipts };
}
function signedPost(base, port, pathname, body, region = "us-east-1") {
  const headers = signRequest({ method: "POST", path: pathname, headers: { "content-type": "application/json" }, body, host: `127.0.0.1:${port}`, region, service: "bedrock" }, CREDS);
  delete headers.host;
  return fetch(`${base}${pathname}`, { method: "POST", headers, body });
}
const body = JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 100 } });

test("AC1 Converse: re-signed SigV4 for the stub host, receipt equals invoke cost incl. regional premium", async (t) => {
  const up = await stub((req, res) => req.url.endsWith("/invoke")
    ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", usage: aUsage })) : converseHandler(req, res));
  const { base, port, receipts } = await proxyFor(t, up);
  const r = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/converse`, body);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), converseBody);
  assert.equal(up.hits[0].url, `/model/${enc(SONNET_ID)}/converse`);
  assert.deepEqual(up.hits[0].sig, { ok: true, region: "us-east-1", service: "bedrock" });
  assert.equal((await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/invoke`, body)).status, 200);
  const [c, i] = receipts;
  assert.deepEqual([c.provider, c.model, c.provider_model, c.endpoint_scope, c.regional_multiplier], ["bedrock", "claude-sonnet-4-5", SONNET_ID, "regional", 1.1]);
  assert.equal(c.input_tokens ?? c.usage?.input_tokens, 1000);
  assert.ok(c.cost_usd > 0);
  assert.equal(c.cost_usd, i.cost_usd);
});

test("AC2 ConverseStream: byte-identical pass-through, metered from metadata, cap refuses the next call", async (t) => {
  const up = await stub(converseHandler);
  const cap = createCapEngine({ caps: { run: 0.001 } });
  const { base, port, receipts } = await proxyFor(t, up, { cap });
  const p = `/bedrock/model/${enc(SONNET_ID)}/converse-stream`;
  const r = await signedPost(base, port, p, body);
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(STREAM));
  assert.ok(receipts[0].cost_usd > 0);
  const again = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/converse`, body);
  assert.equal(again.status, 429);
  assert.equal((await again.json()).error.type, "budget_exceeded");
  assert.equal(up.hits.length, 1);
});

test("AC3 ConverseStream cut before metadata is stream_incomplete (null, never 0) and pauses the run", async (t) => {
  stubState.cut = true;
  t.after(() => { stubState.cut = false; });
  const up = await stub(converseHandler);
  const { base, port, receipts } = await proxyFor(t, up, { cap: createCapEngine({ caps: { run: 10 } }) });
  const p = `/bedrock/model/${enc(SONNET_ID)}/converse-stream`;
  const r = await signedPost(base, port, p, body);
  await r.arrayBuffer().catch(() => {});
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "stream_incomplete"]);
  stubState.cut = false;
  const next = await signedPost(base, port, p, body);
  await next.arrayBuffer().catch(() => {});
  assert.notEqual(next.status, 200);
  assert.equal(up.hits.length, 1);
});

test("AC4 unpriced Converse model: refused under --unknown-models refuse, else unknown cost (never fallback)", async (t) => {
  const up = await stub(converseHandler);
  const refuse = await proxyFor(t, up, { unknownModels: "refuse" });
  const r = await signedPost(refuse.base, refuse.port, "/bedrock/model/meta.unlisted-v1%3A0/converse", body);
  assert.equal(r.status, 403);
  assert.equal(up.hits.length, 0);
  const up2 = await stub(converseHandler);
  const fwd = await proxyFor(t, up2);
  const r2 = await signedPost(fwd.base, fwd.port, "/bedrock/model/meta.unlisted-v1%3A0/converse", body);
  assert.equal(r2.status, 200);
  assert.equal(up2.hits.length, 1);
  assert.equal(fwd.receipts[0].cost_usd, null);
  assert.equal(fwd.receipts[0].fallback_rate ?? false, false);
});

test("AC5 --preflight with inferenceConfig.maxTokens refuses a worst case that doesn't fit", async (t) => {
  const up = await stub(converseHandler);
  const { base, port } = await proxyFor(t, up, { preflight: true, cap: createCapEngine({ caps: { run: 0.01 } }) });
  const big = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/converse`, JSON.stringify({ messages: [], inferenceConfig: { maxTokens: 100000 } }));
  assert.equal(big.status, 429);
  assert.equal((await big.json()).error.reason, "preflight_estimate");
  const small = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/converse`, JSON.stringify({ messages: [], inferenceConfig: { maxTokens: 10 } }));
  assert.equal(small.status, 200);
  assert.equal(up.hits.length, 1);
});

test("unsupported Bedrock paths still get 404 cloud_route_unsupported", async (t) => {
  const up = await stub(converseHandler);
  const { base, port } = await proxyFor(t, up);
  const r = await signedPost(base, port, "/bedrock/model/x/apply-guardrail", "{}");
  assert.equal(r.status, 404);
  assert.match(JSON.stringify(await r.json()), /cloud_route_unsupported/);
});

// ---- e2e: costcap wrap with an AWS-SDK-style child that only reads AWS_ENDPOINT_URL_BEDROCK_RUNTIME ----

function wrap(args, env, script) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AWS_|^CLAUDE_CODE_USE_/.test(k)));
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...args, "--", process.execPath, "--input-type=module", "-e", script], { cwd: ROOT, env: { ...base, ...env } });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "").trim(), err }));
  });
}
const sdkScript = (calls) => `
  import { signRequest } from ${JSON.stringify(SIGV4)};
  const ep = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
  if (!ep) { console.log("no-endpoint"); process.exit(0); }
  const base = new URL(ep);
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const out = [ep.endsWith("/bedrock")];
  for (const op of ${JSON.stringify(calls)}) {
    const path = base.pathname + "/model/" + encodeURIComponent(${JSON.stringify(SONNET_ID)}) + "/" + op;
    const body = JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 100 } });
    const headers = signRequest({ method: "POST", path, headers: { "content-type": "application/json" }, body, host: base.host, region: "us-east-1", service: "bedrock" }, creds);
    delete headers.host;
    const r = await fetch(base.origin + path, { method: "POST", headers, body });
    await r.arrayBuffer();
    out.push(r.status);
  }
  console.log(out.join(" "));`;
const awsEnv = (up) => ({ COSTCAP_TEST_BEDROCK_UPSTREAM: up.url, AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: SECRET });

test("e2e wrap: AWS_ENDPOINT_URL_BEDROCK_RUNTIME routes Converse + ConverseStream through the proxy; cap refuses next call", async (t) => {
  const up = await stub(converseHandler);
  t.after(() => up.server.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const receipts = path.join(dir, "r.jsonl");
  const res = await wrap(["--cap", "0.02", "--receipts", receipts], awsEnv(up), sdkScript(["converse", "converse-stream", "converse"]));
  assert.equal(res.out, "true 200 200 429", res.err);
  assert.ok(up.hits.every((h) => h.sig?.ok));
  const rows = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse).filter((r) => "cost_usd" in r);
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.provider, r.model, r.endpoint_scope]), [["bedrock", "claude-sonnet-4-5", "regional"], ["bedrock", "claude-sonnet-4-5", "regional"]]);
  assert.equal(rows[0].cost_usd, rows[1].cost_usd);
  assert.equal(rows[2].reason, "budget_exceeded");
  assert.ok(!readFileSync(receipts, "utf8").includes("wJalrXUtnFEMI"));
});

test("e2e wrap: a pre-set AWS_ENDPOINT_URL_BEDROCK_RUNTIME is left unchanged with one warning", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const res = await wrap(["--receipts", path.join(dir, "r.jsonl")], { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://example.invalid/x" },
    "console.log(process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME)");
  assert.equal(res.out, "http://example.invalid/x");
  assert.equal(res.err.match(/AWS_ENDPOINT_URL_BEDROCK_RUNTIME is already set/g)?.length, 1);
});

// ---- #278: non-Anthropic Bedrock models (Nova, Llama, Mistral, DeepSeek, gpt-oss, Qwen) ----
import { writeFileSync } from "node:fs";
import { mapCloudModel } from "../src/cloud.js";
import { bedrockBaseId, bedrockCost, bedrockRate, converseServiceTier, isBedrockThirdParty } from "../src/bedrock-pricing.js";
import { loadUpstreamPrices } from "../src/upstreams.js";
import { createModelCaps, parseModelCap } from "../src/model-cap.js";

const NOVA = "amazon.nova-pro-v1:0";
const TABLE = JSON.parse(readFileSync(path.join(ROOT, "src/pricing-table.json"), "utf8"));
const novaUsage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1700, cacheReadInputTokens: 200 };
const novaBody = { ...converseBody, usage: novaUsage };
const novaFrames = [...streamFrames.slice(0, 4), converseEventFrame("metadata", { usage: novaUsage, metrics: { latencyMs: 5 } })];
const novaHandler = (req, res) => {
  if (req.url.endsWith("/converse-stream")) { res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" }).end(Buffer.concat(novaFrames)); return; }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(novaBody));
};
const novaCost = (region) => { const r = TABLE.bedrock_models.models[NOVA].regions[region]; return Number(((1000 * r.input + 200 * r.cached_input + 500 * r.output) / 1e6).toFixed(6)); };
const pricesFile = (doc) => { const f = path.join(mkdtempSync(path.join(tmpdir(), "cc-278-")), "p.json"); writeFileSync(f, JSON.stringify(doc)); return loadUpstreamPrices(f, []); };

test("#278 mapping: geo prefix stripped, listed ids map, ARN / global. / unlisted stay null; Claude unchanged", () => {
  assert.equal(mapCloudModel("bedrock", NOVA), NOVA);
  assert.equal(mapCloudModel("bedrock", `us.${NOVA}`), NOVA);
  assert.equal(mapCloudModel("bedrock", `eu.${NOVA}`), NOVA);
  assert.equal(mapCloudModel("bedrock", "us.meta.llama4-scout-17b-instruct-v1:0"), "meta.llama4-scout-17b-instruct-v1:0");
  assert.equal(mapCloudModel("bedrock", "openai.gpt-oss-120b-1:0"), "openai.gpt-oss-120b-1:0");
  for (const id of ["meta.unlisted-v1:0", `global.${NOVA}`, "arn:aws:bedrock:us-east-1:1:application-inference-profile/x", "meta.llama3-70b-instruct-v1:0"]) assert.equal(mapCloudModel("bedrock", id), null, id);
  assert.equal(mapCloudModel("bedrock", SONNET_ID), "claude-sonnet-4-5");
  assert.equal(isBedrockThirdParty(SONNET_ID), false);
  assert.equal(isBedrockThirdParty(`global.${NOVA}`), true);
  assert.equal(bedrockBaseId("arn:aws:x"), null);
});

test("#278 table: every bedrock_models row covers the required families and regions, with a dated AWS source", () => {
  const rows = TABLE.bedrock_models.models;
  for (const fam of ["amazon.nova-", "meta.llama", "mistral.", "deepseek.", "openai.gpt-oss-", "qwen."]) assert.ok(Object.keys(rows).some((k) => k.startsWith(fam)), fam);
  for (const r of ["us-east-1", "us-west-2", "eu-west-1"]) assert.ok(rows[NOVA].regions[r], r);
  for (const [id, row] of Object.entries(rows)) {
    assert.match(row.source, /pricing\.us-east-1\.amazonaws\.com\/offers\/v1\.0\/aws\/AmazonBedrock.*retrieved \d{4}-\d{2}-\d{2}/, id);
    for (const [region, r] of Object.entries(row.regions)) for (const [k, v] of Object.entries(r)) assert.ok(["input", "output", "cached_input", "cache_write"].includes(k) && v > 0, `${id} ${region} ${k}`);
  }
  assert.ok(TABLE.sources.some((s) => s.includes("AmazonBedrock")));
  // AWS Price List us-east-1 NovaPro: $0.0008 / $0.0032 / $0.0002 per 1K tokens.
  assert.deepEqual(rows[NOVA].regions["us-east-1"], { input: 0.8, output: 3.2, cached_input: 0.2 });
});

test("#278 bedrockCost: region row, missing component unpriced, discount and absolute overrides", () => {
  assert.equal(bedrockRate(null, NOVA, "ap-southeast-3"), null);
  const r = bedrockRate(null, NOVA, "us-east-1");
  assert.equal(bedrockCost(null, r, NOVA, { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 200 }).cost_usd, novaCost("us-east-1"));
  const w = bedrockCost(null, r, NOVA, { input_tokens: 1, output_tokens: 1, cache_write_input_tokens: 5 });
  assert.deepEqual([w.cost_usd, w.reason], [null, "cloud_model_unpriced"]);
  const llama = bedrockRate(null, "meta.llama3-3-70b-instruct-v1:0", "us-east-1");
  assert.equal(bedrockCost(null, llama, "x", { input_tokens: 1, output_tokens: 1, cached_input_tokens: 1 }).cost_usd, null);
  const prices = pricesFile({ version: "v1", upstreams: { bedrock: { "*": { discount: 0.5 }, "meta.llama-x-v1:0": { input: 1, output: 2 } } } });
  const d = bedrockCost(prices, bedrockRate(prices, NOVA, "us-east-1"), NOVA, { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 200 });
  assert.deepEqual([d.cost_usd, d.cost_source, d.discount], [Number((novaCost("us-east-1") / 2).toFixed(6)), "user_prices", 0.5]);
  assert.equal(bedrockRate(prices, NOVA, "ap-southeast-3"), null); // a discount never prices a region without a row
  const a = bedrockRate(prices, "meta.llama-x-v1:0", "ap-southeast-3");
  assert.equal(bedrockCost(prices, a, "meta.llama-x-v1:0", { input_tokens: 1e6, output_tokens: 1e6 }).cost_usd, 3);
  assert.equal(converseServiceTier({ serviceTier: { type: "priority" } }), "priority");
  assert.equal(converseServiceTier({ serviceTier: { type: "default" } }), null);
  assert.equal(converseServiceTier(null), null);
});

test("#278 AC1 Nova Converse + ConverseStream priced at the us-east-1 row; the run continues", async (t) => {
  const up = await stub(novaHandler);
  const { base, port, receipts } = await proxyFor(t, up, { cap: createCapEngine({ caps: { run: 10 } }) });
  const r = await signedPost(base, port, `/bedrock/model/${enc(NOVA)}/converse`, body);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), novaBody);
  const s = await signedPost(base, port, `/bedrock/model/${enc(NOVA)}/converse-stream`, body);
  assert.ok(Buffer.from(await s.arrayBuffer()).equals(Buffer.concat(novaFrames)));
  for (const c of receipts) {
    assert.deepEqual([c.provider, c.model, c.cost_usd, c.fallback, c.reason, c.regional_multiplier], ["bedrock", NOVA, novaCost("us-east-1"), false, undefined, undefined]);
  }
  assert.equal(receipts.length, 2);
  assert.equal((await signedPost(base, port, `/bedrock/model/${enc(NOVA)}/converse`, body)).status, 200);
});

test("#278 AC2 geo profile priced at the request region; no row / unlisted / ARN / priority tier are unknown", async (t) => {
  const up = await stub(novaHandler);
  const west = await proxyFor(t, up, { cloudEnv: { ...ENV, AWS_REGION: "us-west-2" } });
  assert.equal((await signedPost(west.base, west.port, `/bedrock/model/${enc(`us.${NOVA}`)}/converse`, body, "us-west-2")).status, 200);
  assert.equal(west.receipts[0].cost_usd, novaCost("us-west-2"));
  const eu = await proxyFor(t, await stub(novaHandler));
  assert.equal((await signedPost(eu.base, eu.port, `/bedrock/model/${enc(`eu.${NOVA}`)}/converse`, body, "eu-west-1")).status, 200);
  assert.equal(eu.receipts[0].cost_usd, novaCost("eu-west-1"));
  const cases = [
    [`us.${NOVA}`, body, "ap-southeast-3", "cloud_model_unpriced"],
    ["meta.unlisted-v1:0", body, "us-east-1", "cloud_model_unpriced"],
    ["arn:aws:bedrock:us-east-1:1:inference-profile/us.amazon.nova-pro-v1:0", body, "us-east-1", "cloud_model_unpriced"],
    [NOVA, JSON.stringify({ messages: [], serviceTier: { type: "priority" } }), "us-east-1", "service_tier_unpriced"],
  ];
  for (const [id, b, region, reason] of cases) {
    const p = await proxyFor(t, await stub(novaHandler));
    assert.equal((await signedPost(p.base, p.port, `/bedrock/model/${encodeURIComponent(id)}/converse`, b, region)).status, 200, id);
    assert.deepEqual([p.receipts[0].cost_usd, p.receipts[0].reason, p.receipts[0].fallback ?? false], [null, reason, false], id);
    assert.equal((await signedPost(p.base, p.port, `/bedrock/model/${encodeURIComponent(id)}/converse`, b, region)).status, 429, id);
  }
});

test("#278 AC3 preflight refuses a priced Nova worst case; refuse lets listed through; --model-cap stops only Nova", async (t) => {
  const up = await stub(novaHandler);
  const pf = await proxyFor(t, up, { preflight: true, cap: createCapEngine({ caps: { run: 0.01 } }) });
  const big = await signedPost(pf.base, pf.port, `/bedrock/model/${enc(NOVA)}/converse`, JSON.stringify({ messages: [], inferenceConfig: { maxTokens: 100000 } }));
  assert.equal(big.status, 429);
  assert.equal((await big.json()).error.reason, "preflight_estimate");
  assert.equal(up.hits.length, 0);
  assert.equal((await signedPost(pf.base, pf.port, `/bedrock/model/${enc(NOVA)}/converse`, body)).status, 200);
  const up2 = await stub(novaHandler);
  const ref = await proxyFor(t, up2, { unknownModels: "refuse" });
  assert.equal((await signedPost(ref.base, ref.port, `/bedrock/model/${enc(`us.${NOVA}`)}/converse`, body)).status, 200);
  assert.equal((await signedPost(ref.base, ref.port, "/bedrock/model/meta.unlisted-v1%3A0/converse", body)).status, 403);
  assert.equal(up2.hits.length, 1);
  const up3 = await stub(novaHandler);
  const mc = await proxyFor(t, up3, { modelCaps: createModelCaps({ rules: [parseModelCap("amazon.nova-pro-v1:0:day=0.001")] }) });
  assert.equal((await signedPost(mc.base, mc.port, `/bedrock/model/${enc(NOVA)}/converse`, body)).status, 200);
  const stopped = await signedPost(mc.base, mc.port, `/bedrock/model/${enc(`us.${NOVA}`)}/converse`, body);
  assert.equal(stopped.status, 429);
  assert.equal((await signedPost(mc.base, mc.port, `/bedrock/model/${enc("amazon.nova-lite-v1:0")}/converse`, body)).status, 200);
});

test("#278 AC4 --upstream-prices bedrock entry prices an unlisted id as user_prices", async (t) => {
  const prices = pricesFile({ version: "p1", upstreams: { bedrock: { "meta.llama-x-v1:0": { input: 1, output: 2 } }, vertex: { "*": { discount: 0.2 } } } });
  const up = await stub(novaHandler);
  const p = await proxyFor(t, up, { userPrices: prices, unknownModels: "refuse" });
  const r = await signedPost(p.base, p.port, `/bedrock/model/${enc("us.meta.llama-x-v1:0")}/converse`, JSON.stringify({ messages: [] }));
  assert.equal(r.status, 200);
  // cacheReadInputTokens without a cached_input rate stays unknown; without it, priced.
  assert.deepEqual([p.receipts[0].cost_usd, p.receipts[0].reason], [null, "cloud_model_unpriced"]);
  const up2 = await stub((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...converseBody, usage: { inputTokens: 1000, outputTokens: 500 } })));
  const p2 = await proxyFor(t, up2, { userPrices: prices });
  assert.equal((await signedPost(p2.base, p2.port, `/bedrock/model/${enc("meta.llama-x-v1:0")}/converse`, body)).status, 200);
  assert.deepEqual([p2.receipts[0].cost_usd, p2.receipts[0].cost_source, p2.receipts[0].prices_version], [0.002, "user_prices", "p1"]);
  // A Claude-on-Bedrock receipt is unchanged by a bedrock entry that does not name it.
  const up3 = await stub(converseHandler);
  const p3 = await proxyFor(t, up3, { userPrices: prices });
  const p4 = await proxyFor(t, await stub(converseHandler));
  await signedPost(p3.base, p3.port, `/bedrock/model/${enc(SONNET_ID)}/converse`, body);
  await signedPost(p4.base, p4.port, `/bedrock/model/${enc(SONNET_ID)}/converse`, body);
  const pick = (c) => [c.cost_usd, c.regional_multiplier, c.cost_source, c.prices_sha256, c.model];
  assert.deepEqual(pick(p3.receipts[0]), pick(p4.receipts[0]));
  assert.equal(p3.receipts[0].regional_multiplier, 1.1);
});
