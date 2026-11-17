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
import { classifyCloudRoute, converseEventFrame, converseServiceTier, converseUsage, createEventStreamDecoder, mapCloudModel } from "../src/cloud.js";
import { createModelCaps, parseModelCap } from "../src/model-cap.js";
import { loadUpstreamPrices } from "../src/upstreams.js";
import { writeFileSync } from "node:fs";
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

// ---- #278: non-Anthropic Bedrock models priced per region from bedrock_models ----
const TABLE = JSON.parse(readFileSync(path.join(ROOT, "src/pricing-table.json"), "utf8"));
const NOVA = "amazon.nova-pro-v1:0";
const novaUsage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1700, cacheReadInputTokens: 200 };
const novaBody = { ...converseBody, usage: novaUsage };
const novaFrames = [...streamFrames.slice(0, 4), converseEventFrame("metadata", { usage: novaUsage, metrics: { latencyMs: 5 } })];
const novaHandler = (req, res) => {
  if (req.url.endsWith("/converse-stream")) { res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" }); res.end(Buffer.concat(novaFrames)); }
  else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(novaBody));
};
const rateCost = (r) => Number(((1000 * r.input + 200 * r.cached_input + 500 * r.output) / 1e6).toFixed(6));
const novaPath = (id, verb = "converse") => `/bedrock/model/${encodeURIComponent(id)}/${verb}`;

test("#278 table: every bedrock_models row cites the AWS Price List for each region it prices", () => {
  const rows = Object.entries(TABLE.bedrock_models);
  assert.ok(rows.length >= 20);
  for (const fam of ["amazon.nova-", "meta.llama", "mistral.", "deepseek.", "openai.gpt-oss-", "qwen."]) assert.ok(rows.some(([id]) => id.startsWith(fam)), fam);
  for (const [id, row] of rows) {
    for (const [region, r] of Object.entries(row.regions)) {
      assert.ok(r.input > 0 && r.output > 0, id);
      assert.ok(row.sources.some((s) => s.includes(`/AmazonBedrock/`) && s.includes(`/${region}/`) && /retrieved \d{4}-\d{2}-\d{2}/.test(s)), `${id} ${region}`);
    }
  }
  assert.deepEqual(TABLE.bedrock_models[NOVA].regions["us-east-1"], { input: 0.8, output: 3.2, cached_input: 0.2 });
});

test("#278 mapping: geo prefix stripped; global, ARN and unlisted ids stay null; serviceTier parsing", () => {
  assert.equal(mapCloudModel("bedrock", NOVA), NOVA);
  for (const g of ["us", "eu", "apac"]) assert.equal(mapCloudModel("bedrock", `${g}.${NOVA}`), NOVA);
  assert.equal(mapCloudModel("bedrock", `global.${NOVA}`), null);
  assert.equal(mapCloudModel("bedrock", "meta.unlisted-v1:0"), null);
  assert.equal(mapCloudModel("bedrock", `arn:aws:bedrock:us-east-1:1:inference-profile/us.${NOVA}`), null);
  assert.equal(mapCloudModel("bedrock", "openai.gpt-oss-120b-1:0"), "openai.gpt-oss-120b-1:0");
  assert.equal(mapCloudModel("vertex", NOVA), null);
  assert.equal(converseServiceTier({}), null);
  assert.equal(converseServiceTier({ serviceTier: { type: "default" } }), null);
  assert.equal(converseServiceTier({ serviceTier: { type: "priority" } }), "priority");
  assert.equal(converseServiceTier({ serviceTier: { type: "flex" } }), "flex");
});

test("#278 AC1 Converse + ConverseStream on amazon.nova-pro-v1:0 price at the us-east-1 row; run continues", async (t) => {
  const up = await stub(novaHandler);
  const { base, port, receipts } = await proxyFor(t, up, { cap: createCapEngine({ caps: { run: 10 } }) });
  assert.equal((await signedPost(base, port, novaPath(NOVA), body)).status, 200);
  const s = await signedPost(base, port, novaPath(NOVA, "converse-stream"), body);
  assert.equal(s.status, 200);
  await s.arrayBuffer();
  await new Promise((r) => setTimeout(r, 50));
  const want = rateCost(TABLE.bedrock_models[NOVA].regions["us-east-1"]);
  assert.equal(want, 0.00244);
  for (const r of receipts) {
    assert.deepEqual([r.provider, r.model, r.cost_usd, r.reason, r.fallback, r.cost_source, r.region], ["bedrock", NOVA, want, undefined, false, "table", "us-east-1"]);
    assert.equal(r.regional_multiplier, undefined);
  }
  assert.equal(receipts.length, 2);
  assert.equal((await signedPost(base, port, novaPath(NOVA), body)).status, 200);
});

test("#278 AC2 region selects the row; no-row region, unlisted, ARN, global and priority tier are unknown", async (t) => {
  const up = await stub(novaHandler);
  const west = await proxyFor(t, up, { cloudEnv: { ...ENV, AWS_REGION: "us-west-2" } });
  assert.equal((await signedPost(west.base, west.port, novaPath(`us.${NOVA}`), body, "us-west-2")).status, 200);
  assert.equal(west.receipts[0].cost_usd, rateCost(TABLE.bedrock_models[NOVA].regions["us-west-2"]));
  const eu = await proxyFor(t, await stub(novaHandler), { cloudEnv: { ...ENV, AWS_REGION: "eu-west-1" } });
  assert.equal((await signedPost(eu.base, eu.port, novaPath(`eu.${NOVA}`), body, "eu-west-1")).status, 200);
  assert.equal(eu.receipts[0].cost_usd, rateCost(TABLE.bedrock_models[NOVA].regions["eu-west-1"]));
  const cases = [
    [`us.${NOVA}`, body, "ap-southeast-3", "cloud_model_unpriced"],
    ["meta.unlisted-v1:0", body, "us-east-1", "cloud_model_unpriced"],
    [`arn:aws:bedrock:us-east-1:1:inference-profile/us.${NOVA}`, body, "us-east-1", "cloud_model_unpriced"],
    [`global.${NOVA}`, body, "us-east-1", "cloud_model_unpriced"],
    [NOVA, JSON.stringify({ ...JSON.parse(body), serviceTier: { type: "priority" } }), "us-east-1", "service_tier_unpriced"],
  ];
  for (const [id, b, region, reason] of cases) {
    const p = await proxyFor(t, await stub(novaHandler), { cloudEnv: { ...ENV, AWS_REGION: region } });
    assert.equal((await signedPost(p.base, p.port, novaPath(id), b, region)).status, 200, id);
    assert.deepEqual([p.receipts[0].cost_usd, p.receipts[0].reason], [null, reason], id);
    assert.notEqual(p.receipts[0].fallback, true, id);
    assert.equal((await signedPost(p.base, p.port, novaPath(id), b, region)).status, 429, `${id} pauses`);
  }
});

test("#278 AC3 preflight, --unknown-models refuse and --model-cap use the Nova mapping", async (t) => {
  const up = await stub(novaHandler);
  const pf = await proxyFor(t, up, { preflight: true, cap: createCapEngine({ caps: { run: 0.01 } }) });
  const big = await signedPost(pf.base, pf.port, novaPath(NOVA), JSON.stringify({ messages: [], inferenceConfig: { maxTokens: 100000 } }));
  assert.equal(big.status, 429);
  assert.equal((await big.json()).error.reason, "preflight_estimate");
  assert.equal(up.hits.length, 0);
  assert.equal((await signedPost(pf.base, pf.port, novaPath(NOVA), body)).status, 200);

  const up2 = await stub(novaHandler);
  const refuse = await proxyFor(t, up2, { unknownModels: "refuse" });
  assert.equal((await signedPost(refuse.base, refuse.port, novaPath(`us.${NOVA}`), body)).status, 200);
  const no = await signedPost(refuse.base, refuse.port, novaPath("meta.unlisted-v1:0"), body);
  assert.equal(no.status, 403);
  assert.equal(up2.hits.length, 1);

  const up3 = await stub(novaHandler);
  const mc = await proxyFor(t, up3, { modelCaps: createModelCaps({ rules: [parseModelCap(`${NOVA}:day=0.002`)] }) });
  assert.equal((await signedPost(mc.base, mc.port, novaPath(NOVA), body)).status, 200);
  assert.equal((await signedPost(mc.base, mc.port, novaPath(NOVA), body)).status, 429);
  assert.equal((await signedPost(mc.base, mc.port, novaPath("openai.gpt-oss-20b-1:0"), body)).status, 200);
});

test("#278 AC4 bedrock / vertex --upstream-prices: absolute rate prices an unlisted id, discount scales a row", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-278-"));
  const f = path.join(dir, "p.json");
  writeFileSync(f, JSON.stringify({ version: "u1", upstreams: { bedrock: { "meta.llama-x-v1:0": { input: 1, output: 2, cached_input: 0.5 }, [NOVA]: { discount: 0.5 } }, vertex: { "*": { discount: 0.2 } } } }));
  const prices = loadUpstreamPrices(f, []);
  const up = await stub(novaHandler);
  const p = await proxyFor(t, up, { userPrices: prices, unknownModels: "refuse" });
  assert.equal((await signedPost(p.base, p.port, novaPath("us.meta.llama-x-v1:0"), body)).status, 200);
  assert.deepEqual([p.receipts[0].model, p.receipts[0].cost_usd, p.receipts[0].cost_source, p.receipts[0].prices_version], ["meta.llama-x-v1:0", 0.0021, "user_prices", "u1"]);
  assert.equal((await signedPost(p.base, p.port, novaPath(NOVA), body)).status, 200);
  assert.deepEqual([p.receipts[1].cost_usd, p.receipts[1].discount, p.receipts[1].cost_source], [0.00122, 0.5, "user_prices"]);
  // Still unknown: an unlisted id with no override.
  assert.equal((await signedPost(p.base, p.port, novaPath("meta.other-v1:0"), body)).status, 403);
});
