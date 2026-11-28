// #188: Claude on Amazon Bedrock and Google Vertex AI.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMeteringProxy, baseUrlOverrides, eventStreamParser } from "../src/proxy.js";
import { bedrockChunkFrame, bedrockStartupNote, cloudUpstream, crc32, createEventStreamDecoder, encodeEventFrame, mapBedrockModel, mapVertexModel, parseCloudRoute, parseEventHeaders } from "../src/cloud.js";
import { costForUsage, lookupPrice, regionalMultiplier, resolveModelId } from "../src/pricing.js";
import { createCapEngine } from "../src/cap.js";
import { signRequest, verifyRequest } from "../src/sigv4.js";
import { BUILTIN_ENV_VARS, BUILTIN_PROVIDERS } from "../src/upstreams.js";

const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET, sessionToken: "SESSIONTOKENEXAMPLE" };
const SONNET_BEDROCK = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const USAGE = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 };
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [{ type: "text", text: "hi" }], usage: USAGE };
const STREAM_EVENTS = [
  { type: "message_start", message: { ...MESSAGE, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
  { type: "message_stop" },
];

// Fake cloud upstream: records hits, independently verifies SigV4 for its own host.
async function fakeCloud(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const [p, ...q] = req.url.split("?");
      const sig = req.headers.authorization?.startsWith("AWS4-") ? verifyRequest({ method: req.method, path: p, search: q.join("?"), headers: req.headers, body, credentials: CREDS }) : null;
      hits.push({ url: req.url, headers: req.headers, body, sig });
      handler(req, res, body);
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${port}`, hits };
}

async function proxyFor(t, upstreams, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-cloud-"));
  const receipts = path.join(dir, "r.jsonl");
  const warnings = [];
  const { server, port } = await startMeteringProxy({ receiptsPath: receipts, upstreams, onWarning: (l) => warnings.push(l), ...opts });
  t.after(() => server.close());
  const ledger = () => { try { return readFileSync(receipts, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { base: `http://127.0.0.1:${port}`, port, ledger, warnings, raw: () => { try { return readFileSync(receipts, "utf8"); } catch { return ""; } } };
}

const json = (res, status, body, type = "application/json") => res.writeHead(status, { "content-type": type }).end(typeof body === "string" ? body : JSON.stringify(body));

function signedFetch(base, port, p, body, creds = CREDS, region = "us-east-1") {
  const headers = { "content-type": "application/json" };
  const signed = signRequest({ method: "POST", host: `127.0.0.1:${port}`, path: p, headers, body, credentials: creds, region, service: "bedrock", extraSigned: ["content-type"] });
  delete signed.host;
  return fetch(`${base}${p}`, { method: "POST", headers: { ...headers, ...signed }, body });
}
const enc = (id) => id.replace(/:/g, "%3A");

test("model mapping: Bedrock geo/vendor/version, Vertex @date; unpriced ids are null", () => {
  assert.equal(mapBedrockModel(SONNET_BEDROCK), "claude-sonnet-4-5");
  assert.equal(mapBedrockModel("global.anthropic.claude-sonnet-4-5-20250929-v1:0"), "claude-sonnet-4-5");
  assert.equal(mapBedrockModel("anthropic.claude-haiku-4-5-20251001-v1:0"), "claude-haiku-4-5");
  assert.equal(mapBedrockModel("apac.anthropic.claude-opus-4-5-20251101-v1"), "claude-opus-4-5");
  assert.equal(mapBedrockModel("meta.llama3-70b-instruct-v1:0"), null);
  assert.equal(mapBedrockModel("arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"), null);
  assert.equal(mapBedrockModel("anthropic.claude-unlisted-9-v1:0"), null);
  assert.equal(mapBedrockModel(""), null);
  assert.equal(mapVertexModel("claude-opus-4-5@20251101"), "claude-opus-4-5");
  assert.equal(mapVertexModel("claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(mapVertexModel("gemini-2.5-pro"), null);
  assert.equal(mapVertexModel(undefined), null);
  assert.equal(resolveModelId("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(resolveModelId(""), null);
});

test("route parsing and host derivation; unsupported routes", () => {
  const b = parseCloudRoute("bedrock", `/model/${enc(SONNET_BEDROCK)}/invoke`);
  assert.deepEqual(b, { ok: true, provider: "bedrock", rawModel: SONNET_BEDROCK, model: "claude-sonnet-4-5", scope: "regional", countTokens: false, stream: false });
  assert.equal(parseCloudRoute("bedrock", "/model/global.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke-with-response-stream").scope, "global");
  assert.equal(parseCloudRoute("bedrock", "/model/x/count-tokens").countTokens, true);
  for (const p of ["/inference-profiles", "/model/x/converse", "/model/x/converse-stream", "/model/%E0%A4%A/invoke", "/model/a/b/invoke"]) assert.equal(parseCloudRoute("bedrock", p).ok, false, p);
  const v = parseCloudRoute("vertex", "/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-5@20251101:rawPredict");
  assert.equal(v.model, "claude-opus-4-5"); assert.equal(v.scope, "regional"); assert.equal(v.location, "us-east5");
  assert.equal(parseCloudRoute("vertex", "/v1/projects/p/locations/global/publishers/anthropic/models/claude-opus-4-5:streamRawPredict").scope, "global");
  assert.equal(parseCloudRoute("vertex", "/v1/projects/p/locations/us-east5/publishers/anthropic/models/count-tokens:rawPredict").countTokens, true);
  assert.equal(parseCloudRoute("vertex", "/v1/projects/p/locations/us-east5/publishers/google/models/gemini-2.5-pro:rawPredict").model, null);
  for (const p of ["/v1/projects/p/locations/us/publishers/anthropic/models/claude-opus-4-5:rawPredict", "/v1/projects/p/locations/eu/publishers/anthropic/models/x:rawPredict",
    "/v1/projects/p/locations/us-east5/publishers/anthropic/models/x:generateContent", "/v1/projects/p/locations/us-east5/publishers/anthropic/models/%E0%A4:rawPredict", "/v1/other"]) {
    assert.equal(parseCloudRoute("vertex", p).ok, false, p);
  }
  assert.equal(parseCloudRoute("openai", "/x").ok, false);
  assert.equal(cloudUpstream("bedrock", { region: "us-west-2" }), "https://bedrock-runtime.us-west-2.amazonaws.com");
  assert.equal(cloudUpstream("bedrock", { region: "bad/region" }), null);
  assert.equal(cloudUpstream("bedrock", {}), null);
  assert.equal(cloudUpstream("vertex", { location: "us-east5" }), "https://us-east5-aiplatform.googleapis.com");
  assert.equal(cloudUpstream("vertex", { location: "global" }), "https://aiplatform.googleapis.com");
  assert.equal(cloudUpstream("vertex", { location: "x", override: "http://o" }), "http://o");
  assert.equal(cloudUpstream("other", {}), null);
});

test("env, built-ins and the startup note", () => {
  const lines = baseUrlOverrides(4000);
  assert.ok(lines.includes("ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:4000/bedrock"));
  assert.ok(lines.includes("ANTHROPIC_VERTEX_BASE_URL=http://127.0.0.1:4000/vertex/v1"));
  assert.ok(BUILTIN_PROVIDERS.includes("bedrock") && BUILTIN_PROVIDERS.includes("vertex"));
  assert.ok(BUILTIN_ENV_VARS.includes("ANTHROPIC_BEDROCK_BASE_URL") && BUILTIN_ENV_VARS.includes("ANTHROPIC_VERTEX_BASE_URL"));
  assert.match(bedrockStartupNote({ CLAUDE_CODE_USE_BEDROCK: "1" }), /export-credentials/);
  assert.equal(bedrockStartupNote({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_BEARER_TOKEN_BEDROCK: "x" }), null);
  assert.equal(bedrockStartupNote({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }), null);
  assert.equal(bedrockStartupNote({}), null);
});

test("regional multiplier: 1.1x every component, stacks with long context; global is 1.0x", () => {
  assert.equal(regionalMultiplier("claude-sonnet-4-5"), 1.1);
  assert.equal(regionalMultiplier("gpt-4o"), null);
  assert.equal(regionalMultiplier("nope"), null);
  const usage = { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 2000, cache_write_input_tokens: 500 };
  const g = costForUsage("claude-sonnet-4-5", usage);
  const r = costForUsage("claude-sonnet-4-5", usage, { regional: true });
  assert.equal(r.regional_multiplier, 1.1);
  assert.equal(g.regional_multiplier, undefined);
  assert.ok(Math.abs(r.cost_usd - g.cost_usd * 1.1) < 1e-6);
  const lc = { input_tokens: 250_000, output_tokens: 1000 };
  const lcG = costForUsage("claude-sonnet-4-5", lc), lcR = costForUsage("claude-sonnet-4-5", lc, { regional: true });
  assert.equal(lcR.pricing_tier, "long_context");
  assert.ok(Math.abs(lcR.cost_usd - lcG.cost_usd * 1.1) < 1e-6);
  const p = lookupPrice("claude-sonnet-4-5");
  assert.ok(Math.abs(lcG.cost_usd - (250_000 * p.long_context.input + 1000 * p.long_context.output) / 1e6) < 1e-6);
  // Stacks with batch: 0.5 x 1.1.
  const br = costForUsage("claude-sonnet-4-5", usage, { batch: "anthropic", regional: true });
  assert.equal(br.batch_multiplier, 0.5); assert.equal(br.regional_multiplier, 1.1);
  assert.ok(Math.abs(br.cost_usd - g.cost_usd * 0.55) < 1e-6);
});

test("eventstream decoder: CRC, split frames, exceptions", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const frames = Buffer.concat(STREAM_EVENTS.map(bedrockChunkFrame));
  const seen = [];
  const d = createEventStreamDecoder((e) => seen.push(e.type));
  for (let i = 0; i < frames.length; i += 7) d.push(frames.subarray(i, i + 7));
  d.end();
  assert.deepEqual(seen, STREAM_EVENTS.map((e) => e.type));
  assert.equal(d.corrupt, false);
  const bad = Buffer.from(frames); bad[bad.length - 1] ^= 0xff;
  const d2 = createEventStreamDecoder(() => {}); d2.push(bad); assert.equal(d2.corrupt, true); d2.push(frames); assert.equal(d2.corrupt, true);
  const badPrelude = Buffer.from(frames); badPrelude[9] ^= 0xff;
  const d3 = createEventStreamDecoder(() => {}); d3.push(badPrelude); assert.equal(d3.corrupt, true);
  const d4 = createEventStreamDecoder(() => {}); d4.push(frames.subarray(0, 20)); d4.end(); assert.equal(d4.corrupt, true);
  const exc = encodeEventFrame({ ":message-type": "exception", ":exception-type": "throttlingException" }, "{}");
  const d5 = createEventStreamDecoder(() => {}); d5.push(exc); assert.equal(d5.corrupt, true);
  const other = encodeEventFrame({ ":message-type": "event", ":event-type": "other" }, "x");
  const junk = encodeEventFrame({ ":message-type": "event", ":event-type": "chunk" }, "not json");
  const d6 = createEventStreamDecoder(() => {}); d6.push(Buffer.concat([other, junk])); d6.end(); assert.equal(d6.corrupt, false);
  // Typed headers.
  const h = Buffer.concat([Buffer.from([1, 0x61, 0]), Buffer.from([1, 0x62, 1]), Buffer.from([1, 0x63, 2, 5]), Buffer.from([1, 0x64, 3, 0, 6]), Buffer.from([1, 0x65, 4, 0, 0, 0, 7]),
    Buffer.from([1, 0x66, 5, 0, 0, 0, 0, 0, 0, 0, 8]), Buffer.from([1, 0x67, 6, 0, 1, 9]), Buffer.from([1, 0x68, 8, 0, 0, 0, 0, 0, 0, 0, 1]), Buffer.concat([Buffer.from([1, 0x69, 9]), Buffer.alloc(16)])]);
  const parsed = parseEventHeaders(h);
  assert.equal(parsed.a, true); assert.equal(parsed.b, false); assert.equal(parsed.c, 5); assert.equal(parsed.d, 6); assert.equal(parsed.e, 7); assert.equal(parsed.f, 8); assert.equal(parsed.h, 1);
  assert.equal(parsed.g.length, 1); assert.equal(parsed.i.length, 16);
  assert.throws(() => parseEventHeaders(Buffer.from([1, 0x61, 42])), /eventstream_bad_header/);
  const p = eventStreamParser("m"); p.pushBytes(frames); const m = p.end();
  assert.equal(p.incomplete, false); assert.equal(m.usage.cached_input_tokens, 2000);
});

test("AC1/AC2: SigV4 Bedrock invoke is verified, re-signed and priced at 1.1x regional; global 1.0x; cap hit 429", async (t) => {
  const fake = await fakeCloud(t, (req, res) => json(res, 200, MESSAGE));
  const cap = createCapEngine({ caps: { run: 0.012 } });
  const px = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS, cap });
  const body = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  const r1 = await signedFetch(px.base, px.port, `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke`, body);
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), MESSAGE);
  assert.equal(fake.hits.length, 1);
  assert.deepEqual(fake.hits[0].sig, { ok: true, region: "us-east-1", service: "bedrock" });
  assert.equal(fake.hits[0].url, `/model/${enc(SONNET_BEDROCK)}/invoke`);
  const r2 = await signedFetch(px.base, px.port, `/bedrock/model/${enc("global.anthropic.claude-sonnet-4-5-20250929-v1:0")}/invoke`, body);
  assert.equal(r2.status, 200);
  const [a, b] = px.ledger();
  assert.equal(a.provider, "bedrock"); assert.equal(a.model, "claude-sonnet-4-5"); assert.equal(a.provider_model, SONNET_BEDROCK);
  assert.equal(a.endpoint_scope, "regional"); assert.equal(a.regional_multiplier, 1.1); assert.equal(a.cached_input_tokens, 2000); assert.equal(a.cache_write_input_tokens, 500);
  const g = costForUsage("claude-sonnet-4-5", { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 2000, cache_write_input_tokens: 500 });
  assert.ok(Math.abs(a.cost_usd - g.cost_usd * 1.1) < 1e-6);
  assert.equal(b.endpoint_scope, "global"); assert.equal(b.cost_usd, g.cost_usd); assert.equal(b.regional_multiplier, undefined);
  const r3 = await signedFetch(px.base, px.port, `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke`, body);
  assert.equal(r3.status, 429);
  assert.equal(fake.hits.length, 2);
  assert.doesNotMatch(px.raw(), new RegExp(`${SECRET.replace(/[/+]/g, ".")}|SESSIONTOKENEXAMPLE`));
});

test("AC2: tampered signature 403, no creds 502 with hint, Bearer passes through unchanged", async (t) => {
  const fake = await fakeCloud(t, (req, res) => json(res, 200, MESSAGE));
  const px = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS, awsRegion: "us-east-1" });
  const p = `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke`;
  const body = JSON.stringify({ max_tokens: 10 });
  const headers = { "content-type": "application/json" };
  const signed = signRequest({ method: "POST", host: `127.0.0.1:${px.port}`, path: p, headers, body, credentials: CREDS, region: "us-east-1", service: "bedrock" });
  delete signed.host;
  const tampered = await fetch(`${px.base}${p}`, { method: "POST", headers: { ...headers, ...signed, authorization: signed.authorization.replace(/.$/, (c) => (c === "0" ? "1" : "0")) }, body });
  assert.equal(tampered.status, 403);
  assert.equal((await tampered.json()).error, "bedrock_signature_invalid");
  const wrongSvc = signRequest({ method: "POST", host: `127.0.0.1:${px.port}`, path: p, body, credentials: CREDS, region: "us-east-1", service: "s3" }); delete wrongSvc.host;
  assert.equal((await fetch(`${px.base}${p}`, { method: "POST", headers: wrongSvc, body })).status, 403);
  const noCreds = await proxyFor(t, { bedrock: fake.url }, {});
  const r = await signedFetch(noCreds.base, noCreds.port, p, body);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, "bedrock_credentials_unavailable");
  assert.match(noCreds.warnings.join("\n"), /aws configure export-credentials/);
  assert.equal(fake.hits.length, 0);
  assert.deepEqual(noCreds.ledger(), []);
  const bearer = await fetch(`${px.base}${p}`, { method: "POST", headers: { ...headers, authorization: "Bearer BEDROCKKEYEXAMPLE" }, body });
  assert.equal(bearer.status, 200);
  assert.equal(fake.hits.length, 1);
  assert.equal(fake.hits[0].headers.authorization, "Bearer BEDROCKKEYEXAMPLE");
  assert.doesNotMatch(px.raw(), /BEDROCKKEYEXAMPLE|SESSIONTOKENEXAMPLE/);
  // No region anywhere: refused locally.
  const noRegion = await proxyFor(t, { bedrock: "cloud:bedrock" }, {});
  const nr = await fetch(`${noRegion.base}${p}`, { method: "POST", headers: { authorization: "Bearer x" }, body });
  assert.equal(nr.status, 502); assert.equal((await nr.json()).error, "bedrock_region_unavailable");
});

test("AC3: eventstream is forwarded in real time, byte-for-byte, and metered; cut or bad CRC is stream_incomplete", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const frames = STREAM_EVENTS.map(bedrockChunkFrame);
  let mode = "ok";
  const fake = await fakeCloud(t, async (req, res) => {
    res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    if (mode === "ok") { res.write(frames[0]); await gate; for (const f of frames.slice(1)) res.write(f); res.end(); }
    else if (mode === "cut") { res.write(frames[0]); res.write(frames[1]); res.end(); }
    else { const bad = Buffer.from(frames[2]); bad[bad.length - 1] ^= 1; for (const f of [frames[0], frames[1], bad, frames[3]]) res.write(f); res.end(); }
  });
  const cap = createCapEngine({ caps: { run: 5 } });
  const px = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS, cap });
  const p = `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke-with-response-stream`;
  const res = await signedFetch(px.base, px.port, p, "{}");
  assert.equal(res.headers.get("content-type"), "application/vnd.amazon.eventstream");
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.deepEqual(Buffer.from(first.value), frames[0]); // arrived before the fake finished
  release();
  const rest = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; rest.push(Buffer.from(value)); }
  assert.deepEqual(Buffer.concat([Buffer.from(first.value), ...rest]), Buffer.concat(frames));
  const ok = px.ledger()[0];
  assert.equal(ok.cached_input_tokens, 2000); assert.equal(ok.cache_write_input_tokens, 500); assert.equal(ok.output_tokens, 100); assert.equal(ok.regional_multiplier, 1.1);
  assert.ok(ok.cost_usd > 0);
  mode = "cut";
  await (await signedFetch(px.base, px.port, p, "{}")).arrayBuffer();
  assert.equal(px.ledger()[1].reason, "stream_incomplete"); assert.equal(px.ledger()[1].cost_usd, null);
  const blocked = await signedFetch(px.base, px.port, p, "{}");
  assert.equal(blocked.status, 429);
  // Bad CRC on a fresh proxy.
  mode = "crc";
  const px2 = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS });
  await (await signedFetch(px2.base, px2.port, p, "{}")).arrayBuffer();
  assert.equal(px2.ledger()[0].reason, "stream_incomplete");
});

test("AC4: Vertex rawPredict / streamRawPredict / count-tokens; multi-region refused", async (t) => {
  const fake = await fakeCloud(t, (req, res) => {
    if (req.url.includes("count-tokens")) return json(res, 200, { input_tokens: 12 });
    if (req.url.endsWith(":streamRawPredict")) return json(res, 200, STREAM_EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), "text/event-stream");
    json(res, 200, { ...MESSAGE, model: "claude-opus-4-5" });
  });
  const cap = createCapEngine({ caps: { run: 5 } });
  const px = await proxyFor(t, { vertex: fake.url }, { cap });
  const vp = (loc, model, m) => `/vertex/v1/projects/p/locations/${loc}/publishers/anthropic/models/${model}:${m}`;
  const post = (p, body = "{}") => fetch(`${px.base}${p}`, { method: "POST", headers: { authorization: "Bearer ya29.VERTEXTOKEN", "content-type": "application/json" }, body });
  assert.equal((await post(vp("us-east5", "claude-opus-4-5@20251101", "rawPredict"))).status, 200);
  assert.equal(fake.hits[0].url, "/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-5@20251101:rawPredict");
  assert.equal(fake.hits[0].headers.authorization, "Bearer ya29.VERTEXTOKEN");
  await post(vp("global", "claude-opus-4-5@20251101", "rawPredict"));
  const s = await post(vp("us-east5", "claude-sonnet-4-5@20250929", "streamRawPredict"));
  await s.text();
  await post(vp("us-east5", "count-tokens", "rawPredict"), JSON.stringify({ model: "claude-opus-4-5@20251101" }));
  const [reg, glob, sse, ct] = px.ledger();
  const g = costForUsage("claude-opus-4-5", { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 2000, cache_write_input_tokens: 500 });
  assert.equal(reg.provider, "vertex"); assert.equal(reg.model, "claude-opus-4-5"); assert.equal(reg.provider_model, "claude-opus-4-5@20251101");
  assert.ok(Math.abs(reg.cost_usd - g.cost_usd * 1.1) < 1e-6);
  assert.equal(glob.cost_usd, g.cost_usd); assert.equal(glob.endpoint_scope, "global");
  assert.equal(sse.model, "claude-sonnet-4-5"); assert.ok(sse.cost_usd > 0); assert.equal(sse.cached_input_tokens, 2000);
  assert.equal(ct.cost_usd, 0); assert.equal(ct.reason, "non_billable_request"); assert.equal(ct.model, "claude-opus-4-5");
  const hits = fake.hits.length;
  const multi = await post(vp("us", "claude-opus-4-5", "rawPredict"));
  assert.equal(multi.status, 404); assert.equal((await multi.json()).error, "cloud_route_unsupported");
  assert.equal(fake.hits.length, hits);
  assert.equal(px.ledger().length, 4);
  assert.doesNotMatch(px.raw(), /VERTEXTOKEN/);
});

test("AC5/AC6: unpriced cloud models record cloud_model_unpriced and pause; Bedrock count-tokens free; inference-profiles probe 404", async (t) => {
  const fake = await fakeCloud(t, (req, res) => {
    if (req.url.includes("count-tokens")) return json(res, 200, { inputTokens: 12 });
    if (req.url.includes("llama")) return json(res, 200, { generation: "hi", prompt_token_count: 5, generation_token_count: 3 });
    json(res, 200, MESSAGE);
  });
  const px = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS });
  const probe = await fetch(`${px.base}/bedrock/inference-profiles?type=SYSTEM_DEFINED`);
  assert.equal(probe.status, 404); assert.equal((await probe.json()).error, "cloud_route_unsupported");
  assert.equal(fake.hits.length, 0); assert.deepEqual(px.ledger(), []);
  assert.equal((await signedFetch(px.base, px.port, `/bedrock/model/${enc(SONNET_BEDROCK)}/count-tokens`, "{}")).status, 200);
  assert.equal(px.ledger()[0].cost_usd, 0);
  await signedFetch(px.base, px.port, `/bedrock/model/${enc("meta.llama3-70b-instruct-v1:0")}/invoke`, "{}");
  const l = px.ledger()[1];
  assert.equal(l.cost_usd, null); assert.equal(l.reason, "cloud_model_unpriced"); assert.equal(l.model, "meta.llama3-70b-instruct-v1:0");
  assert.equal((await signedFetch(px.base, px.port, `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke`, "{}")).status, 429);
  for (const id of ["arn:aws:bedrock:us-east-1:123:inference-profile/x", "anthropic.claude-unlisted-9-v1:0"]) {
    const px2 = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS });
    await signedFetch(px2.base, px2.port, `/bedrock/model/${encodeURIComponent(id)}/invoke`, "{}");
    const r = px2.ledger()[0];
    assert.equal(r.reason, "cloud_model_unpriced", id); assert.equal(r.cost_usd, null); assert.equal(r.fallback, undefined);
  }
});

test("AC5: --unknown-models refuse, --models and --preflight use the path model", async (t) => {
  const fake = await fakeCloud(t, (req, res) => json(res, 200, MESSAGE));
  const body = JSON.stringify({ max_tokens: 100, messages: [] });
  const refuse = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS, unknownModels: "refuse" });
  const r1 = await signedFetch(refuse.base, refuse.port, `/bedrock/model/${enc("anthropic.claude-unlisted-9-v1:0")}/invoke`, body);
  assert.equal(r1.status, 403); assert.equal((await r1.json()).error, "model_unpriced");
  assert.equal((await signedFetch(refuse.base, refuse.port, `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke`, body)).status, 200);
  const allow = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS, allowedModels: () => ["claude-haiku-4-5"] });
  const r2 = await signedFetch(allow.base, allow.port, `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke`, body);
  assert.equal(r2.status, 403); assert.equal((await r2.json()).model, "claude-sonnet-4-5");
  assert.equal(allow.ledger()[0].provider_model, SONNET_BEDROCK);
  assert.equal((await signedFetch(allow.base, allow.port, `/bedrock/model/${enc("us.anthropic.claude-haiku-4-5-20251001-v1:0")}/invoke`, body)).status, 200);
  const pf = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS, preflight: true, cap: createCapEngine({ caps: { run: 5 } }) });
  const r3 = await signedFetch(pf.base, pf.port, `/bedrock/model/${enc("meta.llama3-70b-instruct-v1:0")}/invoke`, body);
  assert.equal(r3.status, 429); assert.equal((await r3.json()).error.type, "preflight_unpriced");
  assert.equal((await signedFetch(pf.base, pf.port, `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke`, body)).status, 200);
  const tight = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS, preflight: true, cap: createCapEngine({ caps: { run: 0.0015 } }) });
  // 100 output tokens at $15/M = $0.0015 global; regional 1.1x does not fit.
  const r4 = await signedFetch(tight.base, tight.port, `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke`, body);
  assert.equal(r4.status, 429);
  assert.equal(fake.hits.length, 3);
});

test("cloud routes always bypass the response cache", async (t) => {
  const fake = await fakeCloud(t, (req, res) => json(res, 200, MESSAGE));
  const cache = { get() { throw new Error("cloud routes must not read the cache"); }, miss() {}, hit() {}, set() { throw new Error("no set"); } };
  const px = await proxyFor(t, { bedrock: fake.url }, { awsCredentials: CREDS, cache });
  const r = await signedFetch(px.base, px.port, `/bedrock/model/${enc(SONNET_BEDROCK)}/invoke`, JSON.stringify({ temperature: 0, max_tokens: 5 }));
  assert.equal(r.headers.get("x-costcap-cache"), "bypass");
  assert.equal(px.ledger()[0].cache, "bypass");
});
