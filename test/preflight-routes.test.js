// #205: --preflight estimates generating calls only; GETs, file uploads, batch
// creates and audio are no longer refused as preflight_unpriced.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateBatch, checkEstimate } from "../src/preflight.js";
import { createCapEngine } from "../src/cap.js";
import { startMeteringProxy } from "../src/proxy.js";

const j = (o) => JSON.stringify(o);

const open = [];
test.after(() => { for (const c of open) c(); });

async function harness(caps = { day: 100 }) {
  const seen = [];
  const handler = (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    const audio = req.url.includes("/audio/");
    res.writeHead(200, { "content-type": "application/json" }).end(j(audio ? { text: "hi", usage: { type: "duration", seconds: 3 } } : { id: "x", object: "list", data: [] }));
  };
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const u = `http://127.0.0.1:${up.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "cc-pfr-"));
  const receipts = join(dir, "r.jsonl");
  const cap = createCapEngine({ caps });
  const { server } = await startMeteringProxy({ receiptsPath: receipts, cap, preflight: true, upstreams: { openai: u, anthropic: u, gemini: u } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(base + path, init);
  const ledger = () => readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse);
  const close = () => { server.closeAllConnections?.(); up.closeAllConnections?.(); server.close(); up.close(); };
  open.push(close);
  return { call, ledger, seen, close: () => { server.closeAllConnections?.(); up.closeAllConnections?.(); server.close(); up.close(); } };
}

const multipart = (fields, boundary = "XyZ") => ({
  headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  body: Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"${k === "file" ? '; filename="a.bin"' : ""}\r\n\r\n${v}\r\n`).join("") + `--${boundary}--\r\n`,
});

const anthropicBatch = (n, max_tokens = 100, model = "claude-sonnet-4-6") =>
  j({ requests: Array.from({ length: n }, (_, i) => ({ custom_id: `r${i}`, params: { model, max_tokens, messages: [{ role: "user", content: "hi" }] } })) });

test("AC1: GET retrieves/polls/model lists reach upstream with preflight on", async () => {
  const h = await harness();
  for (const p of ["/openai/v1/responses/resp_1", "/openai/v1/batches/batch_1", "/openai/v1/models"]) {
    const r = await h.call(p);
    assert.equal(r.status, 200, p);
    await r.text();
  }
  assert.equal(h.seen.length, 3);
  assert.ok(h.ledger().every((r) => r.reason !== "preflight_unpriced"));
  h.close();
});

test("AC2: batch creates forwarded with budget; Anthropic batch refused when worst case exceeds it", async () => {
  const h = await harness();
  let r = await h.call("/openai/v1/batches", { method: "POST", body: j({ input_file_id: "file-1", endpoint: "/v1/chat/completions", completion_window: "24h" }) });
  assert.equal(r.status, 200); await r.text();
  r = await h.call("/anthropic/v1/messages/batches", { method: "POST", body: anthropicBatch(2) });
  assert.equal(r.status, 200); await r.text();
  assert.equal(h.seen.length, 2);
  h.close();

  const tight = await harness({ day: 0.001 });
  r = await tight.call("/anthropic/v1/messages/batches", { method: "POST", body: anthropicBatch(10, 10_000) });
  assert.equal(r.status, 429);
  const e = (await r.json()).error;
  assert.equal(e.type, "budget_exceeded");
  assert.equal(e.reason, "preflight_estimate");
  assert.equal(tight.seen.length, 0);
  tight.close();
});

test("AC2: unpriced Anthropic batch entry still refuses as preflight_unpriced naming it", async () => {
  const h = await harness();
  const b = j({ requests: [{ custom_id: "a", params: { model: "claude-sonnet-4-6", max_tokens: 5 } }, { custom_id: "b", params: { model: "mystery-1", max_tokens: 5 } }] });
  const r = await h.call("/anthropic/v1/messages/batches", { method: "POST", body: b });
  assert.equal(r.status, 429);
  const e = (await r.json()).error;
  assert.equal(e.type, "preflight_unpriced");
  assert.equal(e.model, "mystery-1");
  h.close();
});

test("AC3: multipart file upload forwarded", async () => {
  const h = await harness();
  const mp = multipart({ purpose: "batch", file: "{}" });
  const r = await h.call("/openai/v1/files", { method: "POST", ...mp });
  assert.equal(r.status, 200); await r.text();
  assert.equal(h.seen.length, 1);
  assert.equal(h.ledger()[0].preflight_estimate, false);
  h.close();
});

test("AC4: whisper-1 transcription not refused; unpriced audio model refused by name", async () => {
  const h = await harness();
  let r = await h.call("/openai/v1/audio/transcriptions", { method: "POST", ...multipart({ model: "whisper-1", file: "RIFF" }) });
  assert.notEqual(r.status, 429); await r.text();
  assert.equal(h.seen.length, 1);
  const rec = h.ledger()[0];
  assert.notEqual(rec.reason, "preflight_unpriced");
  assert.equal(rec.preflight_estimate, false);
  h.close();
  const h2 = await harness();
  r = await h2.call("/openai/v1/audio/transcriptions", { method: "POST", ...multipart({ model: "mystery-whisper", file: "RIFF" }) });
  assert.equal(r.status, 429);
  const aj = await r.json(); assert.equal(aj.error.model ?? aj.model, "mystery-whisper", JSON.stringify(aj));
  assert.equal(h2.seen.length, 0);
  h2.close();
});

test("AC5: chat with an unpriced model still refused (no #117 regression)", async () => {
  const h = await harness();
  const r = await h.call("/openai/v1/chat/completions", { method: "POST", body: j({ model: "mystery", max_tokens: 1 }) });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.type, "preflight_unpriced");
  assert.equal(h.seen.length, 0);
  h.close();
});

test("estimateBatch: sums entries at the batch multiplier; rejects unusable bodies", () => {
  const one = estimateBatch("anthropic", anthropicBatch(1));
  const three = estimateBatch("anthropic", Buffer.from(anthropicBatch(3)));
  assert.equal(one.ok, true);
  assert.equal(three.batch_entries, 3);
  assert.equal(three.batch_multiplier, 0.5);
  assert.ok(Math.abs(three.estimate_usd - 3 * one.estimate_usd) < 1e-5);
  for (const bad of ["nope", j({ requests: [] }), j({}), undefined]) assert.equal(estimateBatch("anthropic", bad).reason, "preflight_unpriced");
  assert.equal(estimateBatch("anthropic", j({ requests: [null] })).model, "unknown");
  assert.equal(estimateBatch("other", anthropicBatch(1)).batch_multiplier, 1);
  assert.equal(checkEstimate(undefined, one), null);
});

// #218: batch preflight discounts tokens only; web search max_uses bills at 100%.
const searchBatch = (n) => j({ requests: Array.from({ length: n }, (_, i) => ({ custom_id: `s${i}`,
  params: { model: "claude-sonnet-4-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }] } })) });

test("estimateBatch #218: tools at full rate, tokens at batch rate, sums tool fields", () => {
  const e = estimateBatch("anthropic", searchBatch(100));
  assert.equal(e.ok, true);
  assert.equal(e.tool_calls_max, 1000);
  assert.equal(e.tool_usd_max, 10);
  assert.ok(e.estimate_usd >= 10.0, `estimate ${e.estimate_usd}`);
  const plain = estimateBatch("anthropic", anthropicBatch(3));
  assert.equal(plain.tool_calls_max, undefined);
  assert.equal(plain.tool_usd_max, undefined);
});

test("estimateBatch #218 regression: tool-free batch keeps the old token-only estimate", () => {
  const body = anthropicBatch(4);
  const reqs = JSON.parse(body).requests;
  const e = estimateBatch("anthropic", body);
  const single = reqs.reduce((a, r) => a + estimateBatch("other", j({ requests: [r] })).estimate_usd, 0);
  assert.ok(Math.abs(e.estimate_usd - single * 0.5) < 1e-5);
});

test("checkEstimate #218: $7 left refuses the search batch over cap; $11 left forwards it", () => {
  const est = estimateBatch("anthropic", searchBatch(100));
  const r7 = checkEstimate({ remaining: () => ({ run: 7 }) }, est);
  assert.equal(r7.reason, "preflight_estimate");
  assert.equal(r7.scope, "run");
  let fit;
  assert.equal(checkEstimate({ remaining: () => ({ run: 11 }) }, est, (x) => { fit = x; }), null);
  assert.equal(fit, est);
});

test("stress: 200 mixed preflight routes, none mis-refused", async () => {
  const h = await harness();
  // Waves of 40 concurrent requests: 200 simultaneous connects overflow the
  // default macOS listen backlog (ECONNRESET), unrelated to preflight.
  const res = [];
  for (let w = 0; w < 50; w += 10) {
    const reqs = [];
    for (let i = w; i < w + 10; i++) {
      reqs.push(h.call(`/openai/v1/responses/resp_${i}`));
      reqs.push(h.call("/openai/v1/files", { method: "POST", ...multipart({ purpose: "batch", file: String(i) }) }));
      reqs.push(h.call("/anthropic/v1/messages/batches", { method: "POST", body: anthropicBatch(1 + (i % 5), 100 + i) }));
      reqs.push(h.call(`/openai/v1/models?page=${i}`));
    }
    res.push(...(await Promise.all(reqs)));
  }
  for (const r of res) { const t = await r.text(); assert.equal(r.status, 200, t); }
  assert.equal(h.seen.length, 200);
  h.close();
});

// #230: Gemini inline batch creates are estimated (sum x 0.5); file-input creates pass unestimated.
const geminiBatch = (n, maxOutputTokens = 1000) => j({ batch: { input_config: { requests: { requests: Array.from({ length: n }, (_, i) => ({
  request: { contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens } }, metadata: { key: `k${i}` } })) } } } });
const GCREATE = "/gemini/v1beta/models/gemini-2.5-flash:batchGenerateContent";

test("#230 estimateBatch gemini: sums inline requests at 0.5x the path model; unusable or unpriced refuse", () => {
  const one = estimateBatch("gemini", geminiBatch(1), undefined, "gemini-2.5-flash");
  const three = estimateBatch("gemini", geminiBatch(3), undefined, "gemini-2.5-flash");
  assert.deepEqual([three.ok, three.batch_entries, three.batch_multiplier, three.model], [true, 3, 0.5, "gemini-2.5-flash"]);
  assert.ok(Math.abs(three.estimate_usd - 3 * one.estimate_usd) < 1e-5);
  assert.equal(estimateBatch("gemini", geminiBatch(1), undefined, "gemini-made-up-9").reason, "preflight_unpriced");
  assert.equal(estimateBatch("gemini", "nope", undefined, "gemini-2.5-flash").reason, "preflight_unpriced");
});

test("#230 AC6: --preflight refuses an inline Gemini batch over the cap before sending; file input passes", async () => {
  const h = await harness({ run: 0.001 });
  let r = await h.call(GCREATE, { method: "POST", body: geminiBatch(3) });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.reason, "preflight_estimate");
  const refusal = h.ledger().at(-1);
  assert.deepEqual([refusal.reason, refusal.batch_entries], ["preflight_estimate", 3]);
  assert.equal(h.seen.length, 0);
  r = await h.call(GCREATE, { method: "POST", body: j({ batch: { input_config: { file_name: "files/in-1" } } }) });
  assert.equal(r.status, 200);
  const pend = h.ledger().at(-1);
  assert.deepEqual([pend.reason, pend.preflight_estimate], ["batch_pending", false]);
  const roomy = await harness({ day: 100 });
  r = await roomy.call(GCREATE, { method: "POST", body: geminiBatch(3) });
  assert.equal(r.status, 200);
  assert.equal(roomy.ledger().at(-1).reason, "batch_pending");
});
