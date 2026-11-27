// #188: Claude on Amazon Bedrock and Google Vertex AI through the metering proxy.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMeteringProxy, baseUrlOverrides, createEventStreamUsageParser, isCloudError } from "../src/proxy.js";
import { bedrockChunkFrame, bedrockHost, classifyCloudRoute, crc32, createEventStreamDecoder, encodeEventFrame, mapCloudModel, parseEventHeaders, vertexHost } from "../src/cloud.js";
import { signRequest, verifyRequest } from "../src/sigv4.js";
import { costForUsage, regionalMultiplier, scalePrice, lookupPrice, resolveModelId } from "../src/pricing.js";
import { createCapEngine } from "../src/cap.js";

const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"; // AWS documentation example key
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET };
const ENV = { AWS_ACCESS_KEY_ID: CREDS.accessKeyId, AWS_SECRET_ACCESS_KEY: SECRET, AWS_REGION: "us-east-1" };
const SONNET_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 };
const message = { id: "m", type: "message", role: "assistant", content: [], usage };
const streamEvents = [
  { type: "message_start", message: { ...message, usage: { ...usage, output_tokens: 1 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } },
  { type: "message_stop" },
];

// Fake Bedrock/Vertex: verifies SigV4 for its own host when signed, records hits.
async function fakeCloud(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const hit = { method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8") };
      if (String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256")) {
        const [p, q = ""] = req.url.split("?");
        hit.sig = verifyRequest({ method: req.method, path: p, search: q ? `?${q}` : "", headers: req.headers, body }, CREDS);
      }
      hits.push(hit);
      handler(req, res, hit);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, url: `http://127.0.0.1:${server.address().port}` };
}

const jsonReply = (body, status = 200) => (req, res) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

async function proxyFor(t, upstream, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-cloud-"));
  const receiptsPath = path.join(dir, "r.jsonl");
  const receipts = [];
  const { server, port } = await startMeteringProxy({ receiptsPath, upstreams: { bedrock: upstream.url, vertex: upstream.url }, cloudEnv: ENV,
    onReceipt: (r) => receipts.push(r), onWarning: () => {}, ...opts });
  t.after(() => { server.close(); upstream.server.close(); });
  return { base: `http://127.0.0.1:${port}`, port, receipts, receiptsPath };
}

function signedPost(base, port, pathname, body, creds = CREDS) {
  const headers = signRequest({ method: "POST", path: pathname, headers: { "content-type": "application/json" }, body, host: `127.0.0.1:${port}`, region: "us-east-1", service: "bedrock" }, creds);
  delete headers.host;
  return fetch(`${base}${pathname}`, { method: "POST", headers, body });
}
const enc = (id) => id.replace(/:/g, "%3A");

const rate = (model, k) => lookupPrice(model)[k];
const expected = (model, m) => Number(((usage.input_tokens * rate(model, "input") * m + usage.cache_read_input_tokens * rate(model, "cached_input") * m
  + usage.cache_creation_input_tokens * rate(model, "cache_write") * m + usage.output_tokens * rate(model, "output") * m) / 1e6).toFixed(6));

test("routes: classification, host derivation and unsupported paths", () => {
  assert.deepEqual(classifyCloudRoute("bedrock", "POST", `/model/${enc(SONNET_ID)}/invoke`), { modelId: SONNET_ID, stream: false, countTokens: false, scope: "regional" });
  assert.equal(classifyCloudRoute("bedrock", "POST", "/model/global.anthropic.claude-haiku-4-5-v1:0/invoke-with-response-stream").scope, "global");
  assert.equal(classifyCloudRoute("bedrock", "POST", "/model/x/count-tokens").countTokens, true);
  assert.equal(classifyCloudRoute("bedrock", "GET", "/inference-profiles"), null);
  assert.equal(classifyCloudRoute("bedrock", "POST", "/model/x/converse-x"), null);
  assert.equal(classifyCloudRoute("bedrock", "POST", "/model/%E0%A4%A/invoke"), null);
  assert.equal(classifyCloudRoute("bedrock", "POST", "/model/../invoke"), null);
  const v = "/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-5@20251101:rawPredict";
  assert.deepEqual(classifyCloudRoute("vertex", "POST", v), { modelId: "claude-opus-4-5@20251101", publisher: "anthropic", stream: false, countTokens: false, scope: "regional", location: "us-east5" });
  assert.equal(classifyCloudRoute("vertex", "POST", v.replace("us-east5", "global")).scope, "global");
  assert.equal(classifyCloudRoute("vertex", "POST", v.replace("us-east5", "us")), null);
  assert.equal(classifyCloudRoute("vertex", "POST", v.replace(":rawPredict", ":streamRawPredict")).stream, true);
  assert.equal(classifyCloudRoute("vertex", "POST", v.replace("claude-opus-4-5@20251101", "count-tokens")).countTokens, true);
  assert.equal(classifyCloudRoute("vertex", "POST", v.replace("claude-opus-4-5@20251101:rawPredict", "count-tokens:streamRawPredict")), null);
  assert.equal(classifyCloudRoute("vertex", "POST", v.replace("anthropic", "google")).modelId, "google/claude-opus-4-5@20251101");
  assert.equal(classifyCloudRoute("vertex", "POST", "/v1/projects/p/locations/us-east5/endpoints/e:predict"), null);
  assert.equal(classifyCloudRoute("other", "POST", "/x"), null);
  assert.equal(vertexHost("global"), "aiplatform.googleapis.com");
  assert.equal(vertexHost("europe-west1"), "europe-west1-aiplatform.googleapis.com");
  assert.equal(bedrockHost("eu-west-1"), "bedrock-runtime.eu-west-1.amazonaws.com");
});

test("model mapping: geo/anthropic prefixes and version suffix stripped; non-Anthropic, ARN and unlisted ids are null", () => {
  assert.equal(mapCloudModel("bedrock", SONNET_ID), "claude-sonnet-4-5");
  assert.equal(mapCloudModel("bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0"), "claude-haiku-4-5");
  assert.equal(mapCloudModel("bedrock", "anthropic.claude-opus-4-5-20251101-v1"), "claude-opus-4-5");
  for (const g of ["eu", "apac", "jp", "au"]) assert.equal(mapCloudModel("bedrock", `${g}.anthropic.claude-sonnet-4-5-20250929-v1:0`), "claude-sonnet-4-5");
  // #278: listed non-Anthropic models map to their base id; unlisted ones stay null.
  assert.equal(mapCloudModel("bedrock", "meta.llama3-70b-instruct-v1:0"), "meta.llama3-70b-instruct-v1:0");
  assert.equal(mapCloudModel("bedrock", "meta.unlisted-v1:0"), null);
  assert.equal(mapCloudModel("bedrock", "arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"), null);
  assert.equal(mapCloudModel("bedrock", "anthropic.claude-unlisted-9-v1:0"), null);
  assert.equal(mapCloudModel("bedrock", "anthropic.titan-v1"), null);
  assert.equal(mapCloudModel("vertex", "claude-opus-4-5@20251101"), "claude-opus-4-5");
  assert.equal(mapCloudModel("vertex", "claude-sonnet-4-5@latest"), "claude-sonnet-4-5");
  assert.equal(mapCloudModel("vertex", "google/gemini-2.5-pro"), "gemini-2.5-pro"); // #217
  assert.equal(mapCloudModel("vertex", "meta/llama-4"), null);
  assert.equal(mapCloudModel("other", "claude-opus-4-5"), null);
  assert.equal(mapCloudModel("vertex", ""), null);
  assert.equal(resolveModelId(42), null);
});

test("regional multiplier: listed 4.5+ models only; stacks with long context and batch", () => {
  assert.equal(regionalMultiplier("claude-sonnet-4-5"), 1.1);
  assert.equal(regionalMultiplier("gpt-4o"), null);
  const u = { input_tokens: 250_000, output_tokens: 1000 };
  const base = costForUsage("claude-sonnet-4-5", u);
  const reg = costForUsage("claude-sonnet-4-5", u, { regional: true });
  assert.equal(base.pricing_tier, "long_context");
  assert.equal(reg.regional_multiplier, 1.1);
  assert.equal(reg.cost_usd, Number((base.cost_usd * 1.1).toFixed(6)));
  const both = costForUsage("claude-sonnet-4-5", u, { regional: true, batch: "anthropic" });
  assert.equal(both.batch_multiplier, 0.5);
  assert.equal(both.cost_usd, Number((base.cost_usd * 0.55).toFixed(6)));
  assert.equal(costForUsage("unknown-model", u, { regional: true }).regional_multiplier, undefined);
  const sp = scalePrice(lookupPrice("claude-sonnet-4-5"), 2);
  assert.equal(sp.long_context.threshold_input_tokens, 200000);
  assert.equal(sp.input, 6);
});

test("eventstream decoder: split frames, CRC check, exceptions and partial bytes", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const bytes = Buffer.concat(streamEvents.map(bedrockChunkFrame));
  const seen = [];
  const d = createEventStreamDecoder((e) => seen.push(e.type));
  for (let i = 0; i < bytes.length; i += 7) d.push(bytes.subarray(i, i + 7));
  assert.deepEqual(seen, ["message_start", "content_block_delta", "message_delta", "message_stop"]);
  assert.equal(d.corrupt || d.partial, false);
  const p = createEventStreamUsageParser("x");
  p.push(bytes);
  assert.equal(p.incomplete, false);
  assert.deepEqual(p.end().usage, { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 200, cache_write_input_tokens: 100, cache_write_1h_input_tokens: 0 });
  const bad = Buffer.from(bytes); bad[bad.length - 1] ^= 0xff;
  const p2 = createEventStreamUsageParser(); p2.push(bad); assert.equal(p2.incomplete, true);
  const p3 = createEventStreamUsageParser(); p3.push(bytes.subarray(0, bytes.length - 3)); assert.equal(p3.incomplete, true);
  const ex = encodeEventFrame({ ":message-type": "exception", ":exception-type": "throttlingException" }, "{}");
  const p4 = createEventStreamUsageParser(); p4.push(ex); assert.equal(p4.incomplete, true);
  const other = encodeEventFrame({ ":message-type": "event", ":event-type": "metadata" }, "{}");
  const d5 = createEventStreamDecoder(() => {}); d5.push(other); assert.equal(d5.corrupt, false);
  const junk = encodeEventFrame({ ":message-type": "event", ":event-type": "chunk" }, "not json");
  const d6 = createEventStreamDecoder(() => {}); d6.push(junk); assert.equal(d6.corrupt, true);
  const huge = Buffer.alloc(12); huge.writeUInt32BE(1, 0);
  const d7 = createEventStreamDecoder(() => {}); d7.push(huge); assert.equal(d7.corrupt, true); d7.push(bytes); assert.equal(d7.corrupt, true);
  // Non-string header types are skipped; an unknown type is corrupt.
  const h = Buffer.from([1, 0x61, 0, 1, 0x62, 4, 0, 0, 0, 1, 1, 0x63, 6, 0, 1, 0x7a]);
  assert.deepEqual(Object.keys(parseEventHeaders(h)), ["a", "b", "c"]);
  assert.throws(() => parseEventHeaders(Buffer.from([1, 0x61, 42])));
  assert.throws(() => parseEventHeaders(Buffer.from([1, 0x61, 5, 0])));
});

test("baseUrlOverrides points the Bedrock and Vertex base URLs at the proxy", () => {
  const lines = baseUrlOverrides(8080);
  assert.ok(lines.includes("ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:8080/bedrock"));
  assert.ok(lines.includes("ANTHROPIC_VERTEX_BASE_URL=http://127.0.0.1:8080/vertex/v1"));
});

test("AC1 Bedrock SigV4: verified, re-signed for the real host, priced at 1.1x regional and 1.0x global", async (t) => {
  const up = await fakeCloud(jsonReply({ ...message, model: "claude-sonnet-4-5-20250929" }));
  const { base, port, receipts, receiptsPath } = await proxyFor(t, up);
  const body = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 10, messages: [] });
  const r1 = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/invoke`, body);
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).usage.input_tokens, 1000);
  assert.equal(up.hits[0].url, `/model/${enc(SONNET_ID)}/invoke`);
  assert.deepEqual(up.hits[0].sig, { ok: true, region: "us-east-1", service: "bedrock" });
  assert.equal(up.hits[0].headers.host, new URL(up.url).host);
  const r2 = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID.replace(/^us\./, "global."))}/invoke`, body);
  assert.equal(r2.status, 200);
  assert.deepEqual(receipts.map((r) => [r.provider, r.model, r.provider_model, r.endpoint_scope, r.regional_multiplier ?? null]), [
    ["bedrock", "claude-sonnet-4-5", SONNET_ID, "regional", 1.1],
    ["bedrock", "claude-sonnet-4-5", SONNET_ID.replace(/^us\./, "global."), "global", null],
  ]);
  assert.equal(receipts[0].cost_usd, expected("claude-sonnet-4-5", 1.1));
  assert.equal(receipts[1].cost_usd, expected("claude-sonnet-4-5", 1));
  const ledger = readFileSync(receiptsPath, "utf8");
  assert.ok(!ledger.includes(SECRET) && !ledger.includes("Signature="));
});

test("AC1 cap hit on Bedrock returns the existing 429", async (t) => {
  const up = await fakeCloud(jsonReply(message));
  const cap = createCapEngine({ caps: { run: 0.001 } });
  const { base, port } = await proxyFor(t, up, { cap });
  const p = `/bedrock/model/${enc(SONNET_ID)}/invoke`;
  assert.equal((await signedPost(base, port, p, "{}")).status, 200);
  const r = await signedPost(base, port, p, "{}");
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.type, "budget_exceeded");
  assert.equal(up.hits.length, 1);
});

test("AC2 signing edge cases: tampered 403, no creds 502, bearer passes through; fake sees no signed hit", async (t) => {
  const up = await fakeCloud(jsonReply(message));
  const { base, port, receipts, receiptsPath } = await proxyFor(t, up);
  const p = `/bedrock/model/${enc(SONNET_ID)}/invoke`;
  const headers = signRequest({ method: "POST", path: p, headers: {}, body: "{}", host: `127.0.0.1:${port}`, region: "us-east-1", service: "bedrock" }, CREDS);
  delete headers.host;
  const tampered = await fetch(`${base}${p}`, { method: "POST", headers, body: '{"x":1}' });
  assert.equal(tampered.status, 403);
  assert.equal((await tampered.json()).error, "bedrock_signature_invalid");
  assert.equal(up.hits.length, 0);
  const bearer = await fetch(`${base}${p}`, { method: "POST", headers: { authorization: "Bearer BEDROCK-API-KEY" }, body: "{}" });
  assert.equal(bearer.status, 200);
  assert.equal(up.hits[0].headers.authorization, "Bearer BEDROCK-API-KEY");
  const ledger = readFileSync(receiptsPath, "utf8");
  assert.ok(!ledger.includes("BEDROCK-API-KEY") && !ledger.includes(SECRET));
  assert.equal(receipts.length, 1);

  const up2 = await fakeCloud(jsonReply(message));
  const noCreds = await proxyFor(t, up2, { cloudEnv: { AWS_REGION: "us-east-1" } });
  const r = await signedPost(noCreds.base, noCreds.port, p, "{}");
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error, "bedrock_credentials_unavailable");
  assert.match(j.message, /aws configure export-credentials/);
  assert.equal(up2.hits.length, 0);
  assert.equal(noCreds.receipts.length, 0);

  const up3 = await fakeCloud(jsonReply(message));
  const noRegion = await proxyFor(t, up3, { cloudEnv: {}, upstreams: { bedrock: "aws:bedrock-runtime" } });
  const r3 = await fetch(`${noRegion.base}${p}`, { method: "POST", headers: { authorization: "Bearer k" }, body: "{}" });
  assert.equal(r3.status, 502);
  assert.equal((await r3.json()).error, "bedrock_region_unavailable");
});

test("AC2 session token: re-signed request carries x-amz-security-token and verifies", async (t) => {
  const creds = { ...CREDS, sessionToken: "SESSION-TOKEN-VALUE" };
  const up = await fakeCloud(jsonReply(message));
  const { base, port, receiptsPath } = await proxyFor(t, up, { cloudEnv: { ...ENV, AWS_SESSION_TOKEN: creds.sessionToken } });
  const r = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/invoke`, "{}", creds);
  assert.equal(r.status, 200);
  assert.equal(up.hits[0].headers["x-amz-security-token"], creds.sessionToken);
  assert.ok(!readFileSync(receiptsPath, "utf8").includes(creds.sessionToken));
});

test("AC3 invoke-with-response-stream: real-time, byte-identical, priced from decoded usage", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const frames = streamEvents.map(bedrockChunkFrame);
  const up = await fakeCloud(async (req, res) => {
    res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    res.write(frames[0]);
    await gate;
    for (const f of frames.slice(1)) res.write(f);
    res.end();
  });
  const { base, port, receipts } = await proxyFor(t, up);
  const res = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/invoke-with-response-stream`, "{}");
  assert.equal(res.headers.get("content-type"), "application/vnd.amazon.eventstream");
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.deepEqual(Buffer.from(first.value), frames[0]);
  release();
  const rest = [Buffer.from(first.value)];
  for (;;) { const { done, value } = await reader.read(); if (done) break; rest.push(Buffer.from(value)); }
  assert.deepEqual(Buffer.concat(rest), Buffer.concat(frames));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(receipts[0].cost_usd, expected("claude-sonnet-4-5", 1.1));
  assert.equal(receipts[0].cached_input_tokens, 200);
  assert.equal(receipts[0].cache_write_input_tokens, 100);
});

for (const [name, mutate] of [
  ["a stream cut before message_stop", (frames) => frames.slice(0, 3)],
  ["a frame with a bad CRC", (frames) => { const f = Buffer.from(frames[2]); f[f.length - 1] ^= 1; return [frames[0], frames[1], f, frames[3]]; }],
]) {
  test(`AC3 ${name} is stream_incomplete and blocks the next call`, async (t) => {
    const frames = mutate(streamEvents.map(bedrockChunkFrame));
    const up = await fakeCloud((req, res) => { res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" }); res.end(Buffer.concat(frames)); });
    const { base, port, receipts } = await proxyFor(t, up);
    const p = `/bedrock/model/${enc(SONNET_ID)}/invoke-with-response-stream`;
    const res = await signedPost(base, port, p, "{}");
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "stream_incomplete"]);
    const next = await signedPost(base, port, p, "{}");
    assert.equal(next.status, 429);
    assert.equal((await next.json()).error, "accounting_unavailable");
    assert.equal(up.hits.length, 1);
  });
}

test("AC4 Vertex rawPredict: path and Authorization unchanged, 1.1x regional, 1.0x global; streamRawPredict SSE metered", async (t) => {
  const up = await fakeCloud((req, res, hit) => {
    if (hit.url.includes(":streamRawPredict")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(streamEvents.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    } else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
  });
  const { base, receipts } = await proxyFor(t, up);
  const v = "/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-5@20251101:rawPredict";
  const call = (p) => fetch(`${base}/vertex${p}`, { method: "POST", headers: { authorization: "Bearer ya29.token" }, body: "{}" });
  assert.equal((await call(v)).status, 200);
  assert.equal(up.hits[0].url, v);
  assert.equal(up.hits[0].headers.authorization, "Bearer ya29.token");
  assert.equal((await call(v.replace("us-east5", "global"))).status, 200);
  const s = await call(v.replace(":rawPredict", ":streamRawPredict"));
  await s.text();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(receipts.map((r) => [r.provider, r.model, r.endpoint_scope, r.cost_usd]), [
    ["vertex", "claude-opus-4-5", "regional", expected("claude-opus-4-5", 1.1)],
    ["vertex", "claude-opus-4-5", "global", expected("claude-opus-4-5", 1)],
    ["vertex", "claude-opus-4-5", "regional", expected("claude-opus-4-5", 1.1)],
  ]);
});

test("AC4 count-tokens is free on both clouds; multi-region Vertex and AC6 inference-profiles are local 404s", async (t) => {
  const up = await fakeCloud(jsonReply({ input_tokens: 42 }));
  const { base, port, receipts } = await proxyFor(t, up);
  const bc = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/count-tokens`, "{}");
  assert.equal(bc.status, 200);
  const vc = await fetch(`${base}/vertex/v1/projects/p/locations/us-east5/publishers/anthropic/models/count-tokens:rawPredict`,
    { method: "POST", body: JSON.stringify({ model: "claude-opus-4-5@20251101", messages: [] }) });
  assert.equal(vc.status, 200);
  assert.deepEqual(receipts.map((r) => [r.model, r.cost_usd, r.reason]), [["claude-sonnet-4-5", 0, "non_billable_request"], ["claude-opus-4-5", 0, "non_billable_request"]]);
  const mr = await fetch(`${base}/vertex/v1/projects/p/locations/us/publishers/anthropic/models/claude-opus-4-5:rawPredict`, { method: "POST", body: "{}" });
  assert.equal(mr.status, 404);
  assert.equal((await mr.json()).error, "cloud_route_unsupported");
  const ip = await fetch(`${base}/bedrock/inference-profiles?type=SYSTEM_DEFINED`);
  assert.equal(ip.status, 404);
  assert.equal(up.hits.length, 2);
  assert.equal(receipts.length, 2);
  // Not paused: a normal call still goes through.
  assert.equal((await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/invoke`, "{}")).status, 200);
});

test("AC5 unpriced cloud models record cloud_model_unpriced and pause; never the fallback", async (t) => {
  for (const id of ["meta.unlisted-v1:0", "arn:aws:bedrock:us-east-1:1:inference-profile/x", "anthropic.claude-unlisted-9-v1:0"]) {
    const up = await fakeCloud(jsonReply(message));
    const { base, port, receipts } = await proxyFor(t, up);
    const p = `/bedrock/model/${encodeURIComponent(id)}/invoke`;
    assert.equal((await signedPost(base, port, p, "{}")).status, 200);
    assert.deepEqual([receipts[0].cost_usd, receipts[0].reason, receipts[0].model, receipts[0].fallback], [null, "cloud_model_unpriced", id, undefined]);
    const next = await signedPost(base, port, p, "{}");
    assert.equal(next.status, 429, id);
  }
});

test("AC5 --unknown-models refuse, --models and --preflight use the mapped path model", async (t) => {
  const up = await fakeCloud(jsonReply(message));
  const refuse = await proxyFor(t, up, { unknownModels: "refuse" });
  const llama = await signedPost(refuse.base, refuse.port, "/bedrock/model/meta.unlisted-v1%3A0/invoke", "{}");
  assert.equal(llama.status, 403);
  assert.equal((await llama.json()).error, "model_unpriced");
  assert.equal((await signedPost(refuse.base, refuse.port, `/bedrock/model/${enc(SONNET_ID)}/invoke`, "{}")).status, 200);

  const up2 = await fakeCloud(jsonReply(message));
  const allow = await proxyFor(t, up2, { allowedModels: () => ["claude-haiku-4-5"] });
  const no = await signedPost(allow.base, allow.port, `/bedrock/model/${enc(SONNET_ID)}/invoke`, "{}");
  assert.equal(no.status, 403);
  assert.equal((await no.json()).model, "claude-sonnet-4-5");
  assert.equal((await signedPost(allow.base, allow.port, "/bedrock/model/global.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke", "{}")).status, 200);
  assert.equal(up2.hits.length, 1);

  const up3 = await fakeCloud(jsonReply(message));
  const pf = await proxyFor(t, up3, { preflight: true, cap: createCapEngine({ caps: { run: 0.01 } }) });
  const big = await fetch(`${pf.base}/vertex/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-5@20251101:rawPredict`,
    { method: "POST", body: JSON.stringify({ max_tokens: 64000, messages: [] }) });
  assert.equal(big.status, 429);
  assert.equal((await big.json()).error.reason, "preflight_estimate");
  const unpriced = await fetch(`${pf.base}/vertex/v1/projects/p/locations/us-east5/publishers/google/models/gemini-x:rawPredict`, { method: "POST", body: "{}" });
  assert.equal(unpriced.status, 429);
  assert.equal((await unpriced.json()).error.type, "preflight_unpriced");
  const small = await fetch(`${pf.base}/vertex/v1/projects/p/locations/global/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict`,
    { method: "POST", body: JSON.stringify({ max_tokens: 10, messages: [] }) });
  assert.equal(small.status, 200);
  assert.equal(up3.hits.length, 1);
});

test("cloud errors ({message}) are upstream_rejected, not a pause; cache always bypasses cloud routes", async (t) => {
  const up = await fakeCloud(jsonReply({ message: "ThrottlingException" }, 429));
  const store = new Map();
  let lookups = 0;
  const cache = { get: () => { lookups++; return null; }, set: (k, v) => store.set(k, v), hit() {}, miss() {} };
  const { base, port, receipts } = await proxyFor(t, up, { cache });
  const r = await signedPost(base, port, `/bedrock/model/${enc(SONNET_ID)}/invoke`, "{}");
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("x-costcap-cache"), "bypass");
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [0, "upstream_rejected"]);
  assert.equal(lookups, 0);
  assert.equal(isCloudError(Buffer.from("[{\"Message\":\"x\"}]")), true);
  assert.equal(isCloudError(Buffer.from("nope")), false);
  assert.equal(isCloudError(Buffer.from('{"message":"x","usage":{}}')), false);
});

test("#234 AC5: Bedrock Fable 5.2 (global) and Opus 4.8 (regional) are metered, never cloud_model_unpriced", async (t) => {
  assert.equal(mapCloudModel("bedrock", "global.anthropic.claude-fable-5-2"), "claude-fable-5-2");
  const up = await fakeCloud((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, model: "x" })));
  const { base, port, receipts } = await proxyFor(t, up, { unknownModels: "refuse" });
  const body = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 10, messages: [] });
  assert.equal((await signedPost(base, port, `/bedrock/model/${enc("global.anthropic.claude-fable-5-2")}/invoke`, body)).status, 200);
  assert.equal((await signedPost(base, port, `/bedrock/model/${enc("us.anthropic.claude-opus-4-8-v1:0")}/invoke`, body)).status, 200);
  assert.deepEqual(receipts.map((r) => [r.model, r.endpoint_scope, r.regional_multiplier ?? null, r.reason ?? null]), [
    ["claude-fable-5-2", "global", null, null], ["claude-opus-4-8", "regional", 1.1, null]]);
  assert.equal(receipts[0].cost_usd, expected("claude-fable-5-2", 1));
  assert.equal(receipts[1].cost_usd, expected("claude-opus-4-8", 1.1));
  const reg = costForUsage("claude-haiku-5-5", { input_tokens: 90_000, cached_input_tokens: 20_000, output_tokens: 1000 }, { regional: true });
  assert.deepEqual([reg.cost_usd, reg.regional_multiplier], [0.05335, 1.1]);
});
