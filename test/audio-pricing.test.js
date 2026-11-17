// #198: OpenAI audio metering. Unit (multipart parser, math, code points) and e2e through startMeteringProxy.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { audioRoute, audioUnitCost, billedSeconds, codePoints, MULTIPART_FIELD_MAX, parseMultipartFields } from "../src/audio.js";
import { costForUsage, isPricedModel } from "../src/pricing.js";
import { pricingCommand } from "../src/pricing-cli.js";
import { extractUsage, startMeteringProxy } from "../src/proxy.js";

const B = "----cc198";
const CT = `multipart/form-data; boundary=${B}`;
function multipart(fields, file = Buffer.from("RIFF0000WAVE")) {
  const parts = [];
  for (const [k, v] of fields) parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`), file, Buffer.from(`\r\n--${B}--\r\n`));
  return Buffer.concat(parts);
}

test("audioRoute: only POST on OpenAI audio paths", () => {
  assert.equal(audioRoute("POST", "/openai/v1/audio/transcriptions"), "transcription");
  assert.equal(audioRoute("POST", "/openai/v1/audio/translations?x=1"), "translation");
  assert.equal(audioRoute("POST", "/openai/v1/audio/speech"), "speech");
  assert.equal(audioRoute("GET", "/openai/v1/audio/speech"), null);
  assert.equal(audioRoute("POST", "/openai/v1/chat/completions"), null);
  assert.equal(audioRoute("POST", undefined), null);
});

test("parseMultipartFields: reads model/response_format/stream, skips files, bounds, duplicates, malformed", () => {
  const ok = parseMultipartFields(multipart([["model", "whisper-1"], ["response_format", "verbose_json"], ["stream", "false"], ["prompt", "x"]]), CT);
  assert.deepEqual(ok, { fields: { model: "whisper-1", response_format: "verbose_json", stream: "false" }, duplicateModel: false });
  assert.equal(parseMultipartFields(multipart([["model", "a"], ["model", "b"]]), CT).duplicateModel, true);
  // A file part named model is never read as the model.
  const fileModel = Buffer.concat([Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="model"; filename="m"\r\n\r\nwhisper-1\r\n--${B}--\r\n`)]);
  assert.deepEqual(parseMultipartFields(fileModel, CT).fields, {});
  // Over the cap: ignored (model stays undefined).
  assert.equal(parseMultipartFields(multipart([["model", "x".repeat(MULTIPART_FIELD_MAX + 1)]]), CT).fields.model, undefined);
  assert.equal(parseMultipartFields(multipart([["model", "whisper-1"]]), `multipart/form-data; boundary="${B}"`).fields.model, "whisper-1");
  assert.equal(parseMultipartFields(multipart([["model", "whisper-1"]]), "multipart/form-data"), null);
  assert.equal(parseMultipartFields(multipart([["model", "whisper-1"]]), "application/json"), null);
  assert.equal(parseMultipartFields(Buffer.from("garbage"), CT), null);
  assert.equal(parseMultipartFields(Buffer.from(`--${B}X`), CT), null);
  assert.equal(parseMultipartFields(Buffer.from(`--${B}\r\nno header end`), CT), null);
  assert.equal(parseMultipartFields("not a buffer", CT), null);
  assert.equal(parseMultipartFields(undefined, undefined), null);
  // LF-only line ending after the boundary, and a part with no closing delimiter.
  assert.deepEqual(parseMultipartFields(Buffer.from(`--${B}\nContent-Disposition: form-data; name="model"\r\n\r\ntts-1`), CT).fields, { model: "tts-1" });
  // A part without content-disposition is skipped.
  assert.deepEqual(parseMultipartFields(Buffer.from(`--${B}\r\nX-A: b\r\n\r\nv\r\n--${B}--`), CT).fields, {});
  // Garbage after a valid part keeps what was read.
  assert.equal(parseMultipartFields(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${B}XX`), CT).fields.model, "whisper-1");
  assert.equal(parseMultipartFields(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${B}\r\nbroken`), CT).fields.model, "whisper-1");
});

test("codePoints and billedSeconds", () => {
  assert.equal(codePoints("Hello world"), 11);
  assert.equal(codePoints("héllo"), 5);
  assert.equal(codePoints("👋🏽"), 2);
  assert.equal(codePoints(undefined), 0);
  assert.equal(billedSeconds({ usage: { type: "duration", seconds: 42 } }), 42);
  assert.equal(billedSeconds({ duration: 3.32 }), 4);
  assert.equal(billedSeconds({ usage: { type: "tokens", input_tokens: 1, output_tokens: 1 }, duration: 3 }), null);
  assert.equal(billedSeconds({ text: "hi" }), null);
  assert.equal(billedSeconds({ duration: -1 }), null);
  assert.equal(billedSeconds(null), null);
});

test("AC1-AC3 math: per minute, per character, per token; unknown stays unknown", () => {
  const w = audioUnitCost("transcription", "whisper-1", { responseText: '{"usage":{"type":"duration","seconds":42}}' });
  assert.deepEqual([w.cost_usd, w.cost_basis, w.billed_seconds, w.cost_source, w.fallback], [0.0042, "duration", 42, "table", false]);
  assert.equal(audioUnitCost("transcription", "whisper-1", { responseText: '{"text":"x","duration":3.32}' }).billed_seconds, 4);
  assert.equal(audioUnitCost("translation", "gpt-transcribe", { responseText: '{"usage":{"seconds":60}}' }).cost_usd, 0.0045);
  assert.equal(audioUnitCost("transcription", "whisper-1", { responseText: "plain text" }), null);
  assert.equal(audioUnitCost("transcription", "whisper-1", { responseText: '{"text":"x"}' }), null);
  assert.equal(audioUnitCost("transcription", "gpt-4o-transcribe", { responseText: '{"usage":{"seconds":3}}' }), null);
  assert.equal(audioUnitCost("transcription", "nope-model", { responseText: '{"usage":{"seconds":3}}' }), null);
  assert.equal(audioUnitCost("transcription", undefined, {}), null);
  assert.equal(audioUnitCost(null, "whisper-1", {}), null);
  const t = audioUnitCost("speech", "tts-1", { requestBody: { input: "Hello world" } });
  assert.deepEqual([t.cost_usd, t.cost_basis, t.billed_characters], [0.000165, "characters", 11]);
  const hd = audioUnitCost("speech", "tts-1-hd", { requestBody: { input: "héllo" } });
  assert.deepEqual([hd.cost_usd, hd.billed_characters], [0.00015, 5]);
  assert.equal(audioUnitCost("speech", "tts-1", { requestBody: {} }), null);
  assert.equal(audioUnitCost("speech", "tts-1", {}), null);
  assert.equal(audioUnitCost("speech", "gpt-4o-mini-tts", { requestBody: { input: "x" } }), null);
  const mini = extractUsage("openai", '{"text":"x","usage":{"type":"tokens","input_tokens":1000,"input_token_details":{"audio_tokens":1000,"text_tokens":0},"output_tokens":500}}', "gpt-4o-mini-transcribe");
  assert.deepEqual([costForUsage(mini.model, mini.usage).cost_usd, costForUsage(mini.model, mini.usage).cost_source], [0.00375, "table"]);
  const unk = extractUsage("openai", '{"usage":{"type":"tokens","input_tokens":1000,"input_token_details":{"audio_tokens":1000},"output_tokens":5}}', "gpt-9-transcribe");
  assert.deepEqual([costForUsage(unk.model, unk.usage).cost_usd, costForUsage(unk.model, unk.usage).reason], [null, "modality_unpriced"]);
  assert.equal(costForUsage("gpt-4o-mini-tts", { input_tokens: 14, output_tokens: 101 }).cost_usd, 0.00122);
  // A unit-billed model never prices token usage (no NaN, never $0).
  assert.deepEqual([costForUsage("whisper-1", { input_tokens: 5, output_tokens: 5 }).cost_usd, costForUsage("whisper-1", { input_tokens: 5 }).reason], [null, "unit_unpriced"]);
  assert.equal(isPricedModel("whisper-1"), true);
});

test("pricing show prints per-minute and per-character units", () => {
  const all = pricingCommand(["show"]).out;
  assert.match(all, /whisper-1: \$0\.006 per minute of audio/);
  assert.match(all, /tts-1-hd: \$30 per 1M characters of input text/);
  // #273: GPT-Live bills session time per second at $0.05/minute.
  assert.match(all, /gpt-live-1: \$0\.05 per minute of session time/);
  assert.equal(isPricedModel("gpt-live-1"), true);
  assert.match(pricingCommand(["show", "gpt-4o-mini-transcribe"]).out, /input \$1\.25, .*output \$5/);
});

async function harness(t, handler, opts = {}) {
  const seen = [];
  const up = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => { const body = Buffer.concat(chunks); seen.push({ url: req.url, body }); handler(req, res, body); });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r), ...opts });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const post = (route, body, ct) => fetch(`http://127.0.0.1:${p.port}/openai/v1/audio/${route}`, { method: "POST", headers: { "content-type": ct }, body });
  return { seen, receipts: () => receipts.filter((r) => "cost_usd" in r), post };
}
const json = (o) => (req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));

test("AC1 e2e: multipart whisper-1 duration usage meters and the run continues; verbose duration ceil; text format pauses", async (t) => {
  const h = await harness(t, json({ text: "hi", usage: { type: "duration", seconds: 42 } }));
  assert.equal((await h.post("transcriptions", multipart([["model", "whisper-1"], ["response_format", "json"]]), CT)).status, 200);
  assert.equal((await h.post("translations", multipart([["model", "whisper-1"]]), CT)).status, 200);
  const [a, b] = h.receipts();
  assert.deepEqual([a.model, a.cost_usd, a.cost_basis, a.billed_seconds], ["whisper-1", 0.0042, "duration", 42]);
  assert.equal(b.cost_usd, 0.0042);
  const v = await harness(t, json({ text: "hi", duration: 3.32 }));
  await v.post("transcriptions", multipart([["model", "whisper-1"], ["response_format", "verbose_json"]]), CT);
  assert.deepEqual([v.receipts()[0].billed_seconds, v.receipts()[0].cost_usd], [4, 0.0004]);
  const txt = await harness(t, (req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("hi"));
  assert.equal((await txt.post("transcriptions", multipart([["model", "whisper-1"], ["response_format", "text"]]), CT)).status, 200);
  assert.deepEqual([txt.receipts()[0].reason, txt.receipts()[0].cost_usd, txt.receipts()[0].model], ["usage_unavailable", null, "whisper-1"]);
  const r2 = await txt.post("transcriptions", multipart([["model", "whisper-1"]]), CT);
  assert.deepEqual([r2.status, (await r2.json()).error, txt.seen.length], [429, "accounting_unavailable", 1]);
});

test("AC2 e2e: tts-1 / tts-1-hd per character; binary gpt-4o-mini-tts pauses", async (t) => {
  const mp3 = (req, res) => res.writeHead(200, { "content-type": "audio/mpeg" }).end(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x7b]));
  const h = await harness(t, mp3);
  await h.post("speech", JSON.stringify({ model: "tts-1", input: "Hello world", voice: "alloy" }), "application/json");
  await h.post("speech", JSON.stringify({ model: "tts-1-hd", input: "héllo", voice: "alloy" }), "application/json");
  assert.deepEqual(h.receipts().map((r) => [r.model, r.cost_usd, r.billed_characters, r.cost_basis]), [["tts-1", 0.000165, 11, "characters"], ["tts-1-hd", 0.00015, 5, "characters"]]);
  const m = await harness(t, mp3);
  assert.equal((await m.post("speech", JSON.stringify({ model: "gpt-4o-mini-tts", input: "hi" }), "application/json")).status, 200);
  assert.deepEqual([m.receipts()[0].reason, m.receipts()[0].cost_usd], ["usage_unavailable", null]);
  assert.equal((await m.post("speech", JSON.stringify({ model: "gpt-4o-mini-tts", input: "hi" }), "application/json")).status, 429);
});

test("AC2 e2e: an upstream error on speech is not billed per character", async (t) => {
  const h = await harness(t, (req, res) => res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"bad","type":"invalid_request_error"}}'));
  await h.post("speech", JSON.stringify({ model: "tts-1", input: "Hello" }), "application/json");
  assert.deepEqual([h.receipts()[0].cost_usd, h.receipts()[0].reason], [0, "upstream_rejected"]);
});

test("AC3 e2e: token-billed transcribe (JSON and SSE) and gpt-4o-mini-tts SSE; unknown transcribe audio is modality_unpriced", async (t) => {
  const usage = { type: "tokens", input_tokens: 1000, input_token_details: { audio_tokens: 1000, text_tokens: 0 }, output_tokens: 500, total_tokens: 1500 };
  const h = await harness(t, json({ text: "hi", usage }));
  await h.post("transcriptions", multipart([["model", "gpt-4o-mini-transcribe"]]), CT);
  assert.deepEqual([h.receipts()[0].model, h.receipts()[0].cost_usd, h.receipts()[0].cost_source], ["gpt-4o-mini-transcribe", 0.00375, "table"]);
  const sse = (events) => (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`); res.end(); };
  const s = await harness(t, sse([{ type: "transcript.text.delta", delta: "hi" }, { type: "transcript.text.done", text: "hi", usage }]));
  const r = await s.post("transcriptions", multipart([["model", "gpt-4o-mini-transcribe"], ["stream", "true"]]), CT);
  await r.text();
  assert.deepEqual([s.receipts()[0].cost_usd, s.receipts()[0].cost_source], [0.00375, "table"]);
  const tts = await harness(t, sse([{ type: "speech.audio.delta", audio: "AAA" }, { type: "speech.audio.done", usage: { input_tokens: 14, output_tokens: 101, total_tokens: 115 } }]));
  await (await tts.post("speech", JSON.stringify({ model: "gpt-4o-mini-tts", input: "hi", stream_format: "sse" }), "application/json")).text();
  assert.equal(tts.receipts()[0].cost_usd, 0.00122);
  const u = await harness(t, json({ text: "hi", usage }));
  await u.post("transcriptions", multipart([["model", "gpt-9-transcribe"]]), CT);
  assert.deepEqual([u.receipts()[0].cost_usd, u.receipts()[0].reason], [null, "modality_unpriced"]);
  assert.equal((await u.post("transcriptions", multipart([["model", "gpt-9-transcribe"]]), CT)).status, 429);
});

test("AC4 e2e: allowlist and refuse read the multipart model; duplicate model parts are 400 with no upstream call", async (t) => {
  const h = await harness(t, json({ text: "hi", usage: { type: "duration", seconds: 1 } }), { allowedModels: () => ["whisper-1"] });
  assert.equal((await h.post("transcriptions", multipart([["model", "whisper-1"]]), CT)).status, 200);
  const no = await h.post("transcriptions", multipart([["model", "gpt-4o-transcribe"]]), CT);
  assert.deepEqual([no.status, (await no.json()).model], [403, "gpt-4o-transcribe"]);
  const dup = await h.post("transcriptions", multipart([["model", "whisper-1"], ["model", "gpt-4o-transcribe"]]), CT);
  assert.deepEqual([dup.status, (await dup.json()).error], [400, "invalid_model"]);
  assert.equal(h.seen.length, 1);
  const r = await harness(t, json({ text: "hi", usage: { type: "duration", seconds: 1 } }), { unknownModels: "refuse" });
  assert.equal((await r.post("transcriptions", multipart([["model", "whisper-1"]]), CT)).status, 200);
  const unp = await r.post("transcriptions", multipart([["model", "gpt-9-transcribe"]]), CT);
  assert.deepEqual([unp.status, (await unp.json()).error], [403, "model_unpriced"]);
});

test("AC5 e2e: a 5 MB multipart reaches upstream byte-for-byte; malformed multipart behaves as before", async (t) => {
  const h = await harness(t, json({ text: "hi", usage: { type: "duration", seconds: 1 } }));
  const big = multipart([["model", "whisper-1"]], Buffer.alloc(5 * 1024 * 1024, 7));
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  assert.equal((await h.post("transcriptions", big, CT)).status, 200);
  assert.equal(sha(h.seen[0].body), sha(big));
  const m = await harness(t, json({ text: "hi", usage: { type: "duration", seconds: 1 } }));
  assert.equal((await m.post("transcriptions", multipart([["model", "whisper-1"]]), "multipart/form-data")).status, 200);
  assert.deepEqual([m.receipts()[0].model, m.receipts()[0].reason], ["unknown", "usage_unavailable"]);
});
