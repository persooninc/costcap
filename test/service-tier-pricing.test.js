// Premium speed / service tiers (#155): unit + proxy e2e/regression.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costForUsage, selectRates, premiumTier, lookupPrice, DEFAULT_TABLE_PATH } from "../src/pricing.js";
import { estimateWorstCase, preflightCheck } from "../src/preflight.js";
import { pricingCommand } from "../src/pricing-cli.js";
import { extractUsage, createSseUsageParser, startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { digestPathFor } from "../src/pricing-digest.js";

const table = JSON.parse(readFileSync(DEFAULT_TABLE_PATH, "utf8"));
const usd = (n) => Number(n.toFixed(6));
const OPUS = table.models["claude-opus-5-5"], GPT = table.models["gpt-4o"];

test("premiumTier: fast and priority only", () => {
  assert.equal(premiumTier({ speed: "fast" }), "fast");
  assert.equal(premiumTier({ service_tier: "priority" }), "priority");
  for (const s of [{}, { speed: "standard" }, { service_tier: "default" }, { service_tier: "flex" }, undefined]) assert.equal(premiumTier(s), null);
});

test("claude-opus-5-5 speed fast prices at the table's fast rates; without speed at standard", () => {
  const u = { input_tokens: 10_000, output_tokens: 2000, cached_input_tokens: 5000, cache_write_input_tokens: 1000, cache_write_1h_input_tokens: 500 };
  const f = costForUsage("claude-opus-5-5", { ...u, speed: "fast" });
  assert.equal(f.pricing_tier, "fast");
  assert.equal(f.speed, "fast");
  const R = OPUS.fast;
  assert.equal(f.cost_usd, usd((10_000 * R.input + 2000 * R.output + 5000 * R.cached_input + 1000 * R.cache_write + 500 * R.cache_write_1h) / 1e6));
  const s = costForUsage("claude-opus-5-5", u);
  assert.equal(s.pricing_tier, "standard");
  assert.equal(s.speed, undefined);
  assert.equal(s.cost_usd, usd((10_000 * OPUS.input + 2000 * OPUS.output + 5000 * OPUS.cached_input + 1000 * OPUS.cache_write + 500 * OPUS.cache_write_1h) / 1e6));
  assert.equal(costForUsage("claude-opus-5-5", { ...u, speed: "standard" }).cost_usd, s.cost_usd);
});

test("gpt-4o priority at priority rates; default and flex at standard with the value recorded", () => {
  const u = { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100 };
  const p = costForUsage("gpt-4o-2024-08-06", { ...u, service_tier: "priority" });
  assert.equal(p.pricing_tier, "priority");
  assert.equal(p.service_tier, "priority");
  assert.equal(p.cost_usd, usd((1000 * GPT.priority.input + 500 * GPT.priority.cached_input + 100 * GPT.priority.output) / 1e6));
  for (const tier of ["default", "flex"]) {
    const r = costForUsage("gpt-4o", { ...u, service_tier: tier });
    assert.equal(r.pricing_tier, "standard");
    assert.equal(r.service_tier, tier);
    assert.equal(r.cost_usd, usd((1000 * GPT.input + 500 * GPT.cached_input + 100 * GPT.output) / 1e6));
  }
});

test("unpriced premium (no rate, fallback model, missing cache rate) is null, never standard", () => {
  for (const [model, sig] of [["claude-haiku-4-5", { speed: "fast" }], ["unknown-model-x", { speed: "fast" }], ["unknown-model-x", { service_tier: "priority" }], ["claude-opus-5-5", { service_tier: "priority" }]]) {
    const r = costForUsage(model, { input_tokens: 10, output_tokens: 10, ...sig });
    assert.equal(r.cost_usd, null, model);
    assert.equal(r.reason, "service_tier_unpriced");
  }
  // gpt-4o priority publishes no cache_write: a write under priority is unpriced.
  const c = costForUsage("gpt-4o", { input_tokens: 10, cache_write_input_tokens: 5, service_tier: "priority" });
  assert.equal(c.reason, "service_tier_unpriced");
  assert.equal(selectRates({ fallback: true, fast: { input: 1, output: 1 } }, 1, { speed: "fast" }).rates, null);
  assert.equal(selectRates({ fast: { input: 1 } }, 1, { speed: "fast" }).rates, null);
  assert.equal(selectRates(lookupPrice("gemini-2.5-pro"), 300_000, {}).pricing_tier, "long_context");
});

test("accumulator: anthropic usage.speed in JSON and split SSE", () => {
  const json = extractUsage("anthropic", JSON.stringify({ model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 50, speed: "fast" } }));
  assert.equal(json.usage.speed, "fast");
  const sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 1, speed: "fast" } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 50, speed: "fast" } })}\n\n`;
  const p = createSseUsageParser("anthropic");
  for (let i = 0; i < sse.length; i += 7) p.push(sse.slice(i, i + 7));
  const r = p.end();
  assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 50, speed: "fast" });
  assert.equal(costForUsage(r.model, r.usage).cost_usd, usd((100 * OPUS.fast.input + 50 * OPUS.fast.output) / 1e6));
});

test("accumulator: openai service_tier on chat JSON, chat stream and Responses response.completed", () => {
  const chat = extractUsage("openai", JSON.stringify({ model: "gpt-4o", service_tier: "priority", usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  assert.equal(chat.usage.service_tier, "priority");
  const stream = `data: ${JSON.stringify({ model: "gpt-4o", service_tier: "priority", choices: [] })}\n\ndata: ${JSON.stringify({ model: "gpt-4o", service_tier: "priority", usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
  assert.equal(extractUsage("openai", stream).usage.service_tier, "priority");
  const resp = `data: ${JSON.stringify({ type: "response.created", response: { model: "gpt-4o", service_tier: "auto" } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-4o", service_tier: "priority", usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`;
  assert.equal(extractUsage("openai", resp).usage.service_tier, "priority");
  assert.equal(extractUsage("openai", JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } })).usage.service_tier, undefined);
});

test("preflight: fast / priority request bodies estimate at premium rates; unpriced premium refused", () => {
  const body = JSON.stringify({ model: "claude-opus-5-5", speed: "fast", max_tokens: 1000, messages: [] });
  const est = estimateWorstCase("anthropic", body);
  assert.equal(est.pricing_tier, "fast");
  assert.equal(est.estimate_usd, usd((est.input_tokens * OPUS.fast.input + 1000 * OPUS.fast.output) / 1e6));
  const std = estimateWorstCase("anthropic", JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1000, messages: [] }));
  assert.equal(std.pricing_tier, "standard");
  const pri = estimateWorstCase("openai", JSON.stringify({ model: "gpt-4o", service_tier: "priority", max_tokens: 100 }));
  assert.equal(pri.pricing_tier, "priority");
  const blocked = preflightCheck(createCapEngine({ caps: { run: est.estimate_usd / 1.5 } }), "anthropic", body, "/v1/messages");
  assert.equal(blocked.reason, "preflight_estimate");
  assert.equal(blocked.pricing_tier, "fast");
  assert.equal(preflightCheck(createCapEngine({ caps: { run: std.estimate_usd * 1.01 } }), "anthropic", JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1000, messages: [] }), "/v1/messages"), null);
  const un = preflightCheck(null, "anthropic", JSON.stringify({ model: "claude-haiku-4-5", speed: "fast" }), "/v1/messages");
  assert.deepEqual([un.reason, un.pricing_tier], ["preflight_unpriced", "fast"]);
});

test("pricing show lists (fast) and (priority) rows; a tampered fast rate fails verify", () => {
  assert.match(pricingCommand(["show", "claude-opus-5-5"]).out, /claude-opus-5-5 \(fast\): input \$8, cached_input \$0\.4/);
  assert.match(pricingCommand(["show", "gpt-4o"]).out, /gpt-4o \(priority\): input \$4\.25/);
  assert.match(pricingCommand(["show"]).out, /claude-opus-5 \(fast\)/);
  const dir = mkdtempSync(join(tmpdir(), "cc-tier-"));
  const p = join(dir, "pricing-table.json");
  const t = structuredClone(table); t.models["claude-opus-5-5"].fast.output = 20;
  writeFileSync(p, JSON.stringify(t));
  writeFileSync(digestPathFor(p), readFileSync(digestPathFor(DEFAULT_TABLE_PATH)));
  const v = pricingCommand(["verify"], { tablePath: p });
  assert.equal(v.code, 1);
  assert.match(v.err, /MISMATCH/);
});

function upstream(body, type) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": type }).end(body)); });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

async function through(t, provider, path, body, type, opts = {}) {
  const up = await upstream(body, type);
  t.after(() => up.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { [provider]: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r), ...opts });
  t.after(() => server.close());
  const call = async (reqBody = "{}") => { const res = await fetch(`http://127.0.0.1:${port}/${provider}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody }); const text = await res.text(); await new Promise((r) => setImmediate(r)); return { status: res.status, text }; };
  return { receipts, call };
}

const FAST_SSE = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 100_000, output_tokens: 1, speed: "fast" } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 20_000, speed: "fast" } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
const FAST_COST = usd((100_000 * OPUS.fast.input + 20_000 * OPUS.fast.output) / 1e6);

test("proxy e2e: fast-mode SSE receipt at fast rates; crossing --cap blocks the next call 429", async (t) => {
  const cap = createCapEngine({ caps: { run: FAST_COST * 0.75 } });
  const h = await through(t, "anthropic", "/v1/messages", FAST_SSE, "text/event-stream", { cap });
  assert.equal((await h.call()).status, 200);
  const r = h.receipts[0];
  assert.deepEqual([r.pricing_tier, r.speed, r.cost_usd], ["fast", "fast", FAST_COST]);
  // At standard rates this call would have fit the cap: the premium cost is what tripped it.
  assert.ok(usd((100_000 * OPUS.input + 20_000 * OPUS.output) / 1e6) < FAST_COST * 0.75);
  const next = await h.call();
  assert.equal(next.status, 429);
  assert.match(next.text, /budget_exceeded/);
});

test("proxy e2e: priority chat JSON receipt; unpriced premium latches accounting_unavailable", async (t) => {
  const h = await through(t, "openai", "/v1/chat/completions", JSON.stringify({ model: "gpt-4o", service_tier: "priority", usage: { prompt_tokens: 1000, completion_tokens: 100 } }), "application/json");
  assert.equal((await h.call()).status, 200);
  const r = h.receipts[0];
  assert.deepEqual([r.pricing_tier, r.service_tier, r.cost_usd], ["priority", "priority", usd((1000 * GPT.priority.input + 100 * GPT.priority.output) / 1e6)]);
  const u = await through(t, "anthropic", "/v1/messages", JSON.stringify({ model: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 10, speed: "fast" } }), "application/json");
  assert.equal((await u.call()).status, 200);
  assert.deepEqual([u.receipts[0].cost_usd, u.receipts[0].reason], [null, "service_tier_unpriced"]);
  const next = await u.call();
  assert.equal(next.status, 429);
  assert.match(next.text, /accounting_unavailable/);
});

test("proxy e2e: --preflight blocks a fast request over budget with pricing_tier on the receipt", async (t) => {
  const h = await through(t, "anthropic", "/v1/messages", FAST_SSE, "text/event-stream", { cap: createCapEngine({ caps: { run: 0.05 } }), preflight: true });
  const res = await h.call(JSON.stringify({ model: "claude-opus-5-5", speed: "fast", max_tokens: 2000, messages: [] }));
  assert.equal(res.status, 429);
  assert.deepEqual([h.receipts[0].reason, h.receipts[0].pricing_tier], ["preflight_estimate", "fast"]);
  assert.match(res.text, /budget_exceeded/);
  const un = await h.call(JSON.stringify({ model: "claude-haiku-4-5", speed: "fast", max_tokens: 10 }));
  assert.equal(un.status, 429);
  assert.deepEqual([h.receipts[1].reason, h.receipts[1].pricing_tier], ["preflight_unpriced", "fast"]);
});

// #232: OpenAI Fast (renamed from Priority) and Ultrafast; unrecognised tiers are never standard.
const AC2 = { input_tokens: 1000, cached_input_tokens: 4000, cache_write_input_tokens: 3000, cache_write_1h_input_tokens: 4000, output_tokens: 1000 };
test("#232 premiumTier value set", () => {
  assert.equal(premiumTier({ service_tier: "fast" }), "priority");
  assert.equal(premiumTier({ service_tier: "priority" }), "priority");
  assert.equal(premiumTier({ service_tier: "ultrafast" }), "ultrafast");
  for (const s of ["default", "auto", "flex", "scale", "standard", "batch"]) assert.equal(premiumTier({ service_tier: s }), null, s);
  assert.equal(premiumTier({ service_tier: "turbo" }), "unrecognised");
  assert.equal(premiumTier({ service_tier: 3 }), null);
});

test("#232 AC3: fast / ultrafast / unpriced tiers on GPT-6", () => {
  assert.equal(costForUsage("gpt-6.1-sol", AC2).cost_usd, 0.0399);
  const fast = costForUsage("gpt-6.1-sol", { ...AC2, service_tier: "fast" });
  assert.deepEqual([fast.cost_usd, fast.pricing_tier, fast.service_tier], [0.0798, "priority", "fast"]);
  const uf = costForUsage("gpt-6-astra", { input_tokens: 1000, output_tokens: 1000, service_tier: "ultrafast" });
  assert.deepEqual([uf.cost_usd, uf.pricing_tier], [0.36, "ultrafast"]);
  for (const [m, t] of [["gpt-6-luna", "ultrafast"], ["gpt-6-luna", "turbo"], ["gpt-4o", "ultrafast"], ["made-up-model", "fast"]]) {
    const r = costForUsage(m, { input_tokens: 1000, output_tokens: 1000, service_tier: t });
    assert.deepEqual([r.cost_usd, r.reason], [null, "service_tier_unpriced"], `${m} ${t}`);
  }
  for (const t of ["default", "flex"]) {
    const r = costForUsage("gpt-6.1-sol", { ...AC2, service_tier: t });
    assert.deepEqual([r.cost_usd, r.pricing_tier, r.service_tier], [0.0399, "standard", t]);
  }
  // gpt-4o service_tier "fast" now prices at its priority rates.
  assert.equal(costForUsage("gpt-4o", { input_tokens: 1e6, service_tier: "fast" }).cost_usd, GPT.priority.input);
});

test("#232 accumulator records service_tier fast and ultrafast from Responses bodies", () => {
  const m = extractUsage("openai", JSON.stringify({ model: "gpt-6-astra", service_tier: "ultrafast", usage: { input_tokens: 1000, output_tokens: 1000 } }));
  assert.equal(m.usage.service_tier, "ultrafast");
  assert.equal(costForUsage(m.model, m.usage).cost_usd, 0.36);
});

test("#232 pricing show gpt-6-astra lists (priority) and (ultrafast) rows", () => {
  const r = pricingCommand(["show", "gpt-6-astra"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\(priority\)/);
  assert.match(r.out, /\(ultrafast\)/);
});

test("#232 preflight: ultrafast estimates at premium rates; unrecognised tier refused", () => {
  const std = estimateWorstCase("openai", JSON.stringify({ model: "gpt-6-astra", max_output_tokens: 1000, input: "hi" }), "/v1/responses");
  const uf = estimateWorstCase("openai", JSON.stringify({ model: "gpt-6-astra", max_output_tokens: 1000, input: "hi", service_tier: "ultrafast" }), "/v1/responses");
  assert.equal(uf.pricing_tier, "ultrafast");
  assert.equal(uf.estimate_usd, Number(((uf.input_tokens * 60 + 1000 * 300) / 1e6).toFixed(6)));
  assert.ok(uf.estimate_usd > std.estimate_usd * 5);
  const un = estimateWorstCase("openai", JSON.stringify({ model: "gpt-6-astra", service_tier: "turbo" }), "/v1/responses");
  assert.equal(un.reason, "preflight_unpriced");
});
