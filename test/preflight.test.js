// CC-9 (#117): opt-in pre-flight worst-case estimate.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateWorstCase, priceEstimate, preflightCheck, preflightBody, DEFAULT_MAX_OUTPUT_TOKENS } from "../src/preflight.js";
import { createCapEngine, loadReceipts } from "../src/cap.js";
import { startMeteringProxy } from "../src/proxy.js";
import { parseWrapArgs } from "../src/cli.js";
import { assertAgentPolicy } from "../src/agent-budget.js";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

test("estimator: OpenAI shape reads max_completion_tokens, then max_tokens", () => {
  const body = JSON.stringify({ model: "gpt-4o-mini", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  const e = estimateWorstCase("openai", Buffer.from(body));
  assert.equal(e.model, "gpt-4o-mini");
  assert.equal(e.output_tokens, 100);
  assert.equal(e.input_tokens, Math.ceil(Buffer.byteLength(body) / 4));
  assert.equal(e.max_tokens_source, "request");
  assert.equal(estimateWorstCase("openai", JSON.stringify({ model: "gpt-4o", max_completion_tokens: 7, max_tokens: 100 })).output_tokens, 7);
});

test("estimator: Anthropic shape reads max_tokens", () => {
  const e = estimateWorstCase("anthropic", JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2048, messages: [] }));
  assert.equal(e.output_tokens, 2048);
  assert.equal(e.model, "claude-sonnet-4-6");
});

test("estimator: Gemini shape reads generationConfig.maxOutputTokens and the model from the path", () => {
  const e = estimateWorstCase("gemini", JSON.stringify({ contents: [], generationConfig: { maxOutputTokens: 512 } }), "/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(e.output_tokens, 512);
  assert.equal(e.model, "gemini-2.5-flash");
});

test("estimator: OpenRouter shape reads max_tokens", () => {
  const e = estimateWorstCase("openrouter", JSON.stringify({ model: "openai/gpt-4o", max_tokens: 64 }));
  assert.equal(e.output_tokens, 64);
});

test("estimator: no max_tokens falls back to the provider default maximum for every shape", () => {
  for (const provider of ["openai", "anthropic", "gemini", "openrouter"]) {
    const e = estimateWorstCase(provider, JSON.stringify({ model: "x" }), "/v1beta/models/x:generateContent");
    assert.equal(e.output_tokens, DEFAULT_MAX_OUTPUT_TOKENS[provider], provider);
    assert.equal(e.max_tokens_source, "provider_default");
  }
  // Malformed body and invalid max still yield a conservative bound.
  const bad = estimateWorstCase("openai", "not json");
  assert.equal(bad.model, "unknown");
  assert.equal(bad.output_tokens, DEFAULT_MAX_OUTPUT_TOKENS.openai);
  assert.equal(estimateWorstCase("anthropic", JSON.stringify({ max_tokens: -5 })).output_tokens, DEFAULT_MAX_OUTPUT_TOKENS.anthropic);
});

test("pricing: known model is priced at table rates; unknown model is unpriced, never $0", () => {
  const p = priceEstimate({ model: "gpt-4o-mini", input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(p.estimate_usd, 0.75);
  assert.equal(priceEstimate({ model: "mystery-model", input_tokens: 1, output_tokens: 1 }).unpriced, true);
  const hit = preflightCheck({ provider: "openai", body: JSON.stringify({ model: "mystery-model", max_tokens: 1 }), cap: createCapEngine({}) });
  assert.equal(hit.reason, "preflight_unpriced");
  assert.equal(preflightBody(hit.reason, hit.detail).error.type, "preflight_unpriced");
});

test("cap.remaining reports per-scope headroom and preflightCheck names the scope", () => {
  const now = () => new Date("2026-11-15T12:00:00Z");
  const cap = createCapEngine({ caps: { day: 1, month: 10 }, history: [{ ts: "2026-11-15T01:00:00Z", cost_usd: 0.9 }], now });
  assert.deepEqual(cap.remaining(), { run: null, day: 0.1, month: 9.1 });
  // gpt-4o output $10/M: 20k tokens = $0.20 > $0.10 remaining today.
  const hit = preflightCheck({ provider: "openai", body: JSON.stringify({ model: "gpt-4o", max_tokens: 20_000 }), cap });
  assert.equal(hit.reason, "preflight_estimate");
  assert.equal(hit.detail.scope, "day");
  assert.equal(hit.detail.estimate, true);
  assert.ok(hit.detail.estimate_usd > 0.2);
  assert.equal(preflightCheck({ provider: "openai", body: JSON.stringify({ model: "gpt-4o", max_tokens: 10 }), cap }), null);
  assert.match(preflightBody(hit.reason, hit.detail).error.message, /estimate/);
});

async function harness(t, { preflight, caps, history }) {
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 100, completion_tokens: 50 } })); });
  const upPort = await listen(up);
  const dir = mkdtempSync(join(tmpdir(), "cc-pre-"));
  const receipts = join(dir, "r.jsonl");
  const cap = createCapEngine({ caps, history });
  const { server, port } = await startMeteringProxy({ receiptsPath: receipts, upstreams: { openai: `http://127.0.0.1:${upPort}` }, cap, preflight });
  t.after(() => { server.close(); up.close(); });
  const call = (body) => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify(body) });
  return { call, hits: () => hits, ledger: () => loadReceipts(receipts), cap };
}

const big = { model: "gpt-4o", max_tokens: 100_000, messages: [{ role: "user", content: "write a novel" }] };

test("criterion 1: preflight off forwards an oversize call exactly as before", async (t) => {
  const h = await harness(t, { preflight: false, caps: { day: 0.01 } });
  const res = await h.call(big);
  assert.equal(res.status, 200);
  assert.equal(h.hits(), 1);
  const [r] = h.ledger();
  assert.equal(r.blocked, false);
  assert.equal(r.estimate, undefined);
});

test("criteria 2 and 5: preflight on refuses a worst case over the day cap before any upstream call", async (t) => {
  const h = await harness(t, { preflight: true, caps: { day: 0.5 } });
  const res = await h.call(big);
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.type, "budget_exceeded");
  assert.equal(body.error.reason, "preflight_estimate");
  assert.equal(body.error.scope, "day");
  assert.equal(body.error.remaining_usd.day, 0.5);
  assert.ok(body.error.estimate_usd > 0.5);
  assert.equal(h.hits(), 0);
  const [r] = h.ledger();
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "preflight_estimate");
  assert.equal(r.estimate, true);
  assert.equal(r.scope, "day");
  assert.ok(r.estimate_usd > 0.5);
  assert.equal(r.cost_usd, 0);
  // Spend totals exclude the estimate.
  assert.equal(createCapEngine({ caps: { day: 0.5 }, history: h.ledger() }).spend().day, 0);
});

test("criterion 3: a call that fits is forwarded and metered at its real cost", async (t) => {
  const h = await harness(t, { preflight: true, caps: { day: 0.5 } });
  const res = await h.call({ model: "gpt-4o-mini", max_tokens: 100, messages: [] });
  assert.equal(res.status, 200);
  assert.equal(h.hits(), 1);
  const [r] = h.ledger();
  assert.equal(r.blocked, false);
  assert.equal(r.input_tokens, 100);
  assert.equal(r.output_tokens, 50);
  assert.ok(r.cost_usd > 0);
  assert.equal(h.cap.spend().day, r.cost_usd);
});

test("criterion 4: an unpriced model is refused with preflight_unpriced and never forwarded", async (t) => {
  const h = await harness(t, { preflight: true, caps: { day: 100 } });
  const res = await h.call({ model: "brand-new-model", max_tokens: 1 });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.type, "preflight_unpriced");
  assert.equal(h.hits(), 0);
  const [r] = h.ledger();
  assert.equal(r.reason, "preflight_unpriced");
  assert.equal(r.estimate, true);
});

test("--preflight, COSTCAP_PREFLIGHT and policy preflight parse; preflight is off by default", () => {
  const prev = process.env.COSTCAP_PREFLIGHT;
  delete process.env.COSTCAP_PREFLIGHT;
  try {
    assert.equal(parseWrapArgs(["--", "x"]).preflight, false);
    assert.equal(parseWrapArgs(["--preflight", "--day-cap", "1", "--", "x"]).preflight, true);
    process.env.COSTCAP_PREFLIGHT = "1";
    assert.equal(parseWrapArgs(["--", "x"]).preflight, true);
  } finally { if (prev === undefined) delete process.env.COSTCAP_PREFLIGHT; else process.env.COSTCAP_PREFLIGHT = prev; }
  assert.doesNotThrow(() => assertAgentPolicy({ preflight: true, default: { day: 1 } }));
  assert.throws(() => assertAgentPolicy({ preflight: "yes" }), /preflight must be a boolean/);
});

test("e2e: costcap wrap --preflight refuses an oversize call against a fake upstream", async (t) => {
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 } })); });
  const upPort = await listen(up);
  t.after(() => up.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-pre-e2e-"));
  const receipts = join(dir, "r.jsonl");
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const r = await fetch(u, { method: "POST", body: JSON.stringify(${JSON.stringify(big)}) });
    const b = await r.json();
    console.log(r.status, b.error.reason);`;
  writeFileSync(join(dir, "s.mjs"), script);
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--preflight", "--day-cap", "0.5", "--receipts", receipts, "--", process.execPath, join(dir, "s.mjs")],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(res.code, 0);
  assert.equal(res.out.trim(), "429 preflight_estimate");
  assert.equal(hits, 0);
  const ledger = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(ledger[0].estimate, true);
});
