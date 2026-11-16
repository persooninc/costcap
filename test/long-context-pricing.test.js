// Long-context pricing tier (#151): unit + proxy e2e/regression.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costForUsage, selectTier, promptTokens, lookupPrice } from "../src/pricing.js";
import { estimateWorstCase, preflightCheck } from "../src/preflight.js";
import { pricingCommand } from "../src/pricing-cli.js";
import { run as digestRun } from "../scripts/pricing-digest.mjs";
import { canonicalize, verifyTableDigest } from "../src/pricing-digest.js";
import { createCapEngine } from "../src/cap.js";
import { startMeteringProxy } from "../src/proxy.js";
import "./support/pinned-clock.js"; // #237: prices below are pre-2026-12-01

const usd = (n) => Number(n.toFixed(6));

test("gemini-2.5-pro: 200000 is standard, 200001 and 250000 are long_context", () => {
  const std = costForUsage("gemini-2.5-pro", { input_tokens: 200_000, output_tokens: 1000 });
  assert.equal(std.pricing_tier, "standard");
  assert.equal(std.cost_usd, usd(200_000 * 1.25 / 1e6 + 1000 * 10 / 1e6));
  assert.equal(costForUsage("gemini-2.5-pro", { input_tokens: 200_001 }).pricing_tier, "long_context");
  const lc = costForUsage("gemini-2.5-pro", { input_tokens: 250_000, output_tokens: 1000 });
  assert.equal(lc.pricing_tier, "long_context");
  assert.equal(lc.cost_usd, usd(250_000 * 2.5 / 1e6 + 1000 * 15 / 1e6));
});

test("gemini cached tokens count toward the threshold and price at the tier", () => {
  const r = costForUsage("gemini-2.5-pro", { input_tokens: 100_000, cached_input_tokens: 150_000, output_tokens: 0 });
  assert.equal(r.pricing_tier, "long_context");
  assert.equal(r.cost_usd, usd(100_000 * 2.5 / 1e6 + 150_000 * 0.25 / 1e6));
});

test("anthropic: input + cache read + cache writes cross the threshold; every component tiered", () => {
  const u = { input_tokens: 50_000, cached_input_tokens: 100_000, cache_write_input_tokens: 40_000, cache_write_1h_input_tokens: 20_000, output_tokens: 2000 };
  assert.equal(promptTokens(u), 210_000);
  const r = costForUsage("claude-sonnet-4-6", u);
  assert.equal(r.pricing_tier, "long_context");
  assert.equal(r.cost_usd, usd((50_000 * 6 + 100_000 * 0.6 + 40_000 * 7.5 + 20_000 * 12 + 2000 * 22.5) / 1e6));
  const std = costForUsage("claude-sonnet-4-6", { ...u, cached_input_tokens: 90_000 });
  assert.equal(std.pricing_tier, "standard");
});

test("a tier without a needed cache-write rate is unpriced with a specific reason", () => {
  // gemini tiers publish no cache_write: a write above the threshold is never guessed.
  const r = costForUsage("gemini-2.5-pro", { input_tokens: 250_000, cache_write_input_tokens: 10 });
  assert.equal(r.cost_usd, null);
  assert.equal(r.reason, "long_context_cache_write_unpriced");
  assert.equal(costForUsage("gemini-2.5-pro", { input_tokens: 10, cache_write_input_tokens: 10 }).reason, "cache_write_unpriced");
});

test("untiered and fallback models never switch tier", () => {
  const r = costForUsage("gpt-4o-mini", { input_tokens: 1_000_000, output_tokens: 0 });
  assert.equal(r.pricing_tier, "standard");
  assert.equal(r.cost_usd, 0.15);
  const f = costForUsage("unknown-model-x", { input_tokens: 1_000_000 });
  assert.equal(f.pricing_tier, "standard");
  assert.equal(f.cost_usd, 2.5);
  assert.equal(selectTier({ fallback: true, long_context: { threshold_input_tokens: 1, input: 9 } }, 5).pricing_tier, "standard");
  assert.equal(selectTier(lookupPrice("claude-haiku-4-5"), 10_000_000).pricing_tier, "standard");
});

const gemBody = (bytes, max = 1000) => JSON.stringify({ model: "gemini-2.5-pro", generationConfig: { maxOutputTokens: max }, pad: "x".repeat(bytes) });

test("preflight switches tier above the threshold", () => {
  const small = estimateWorstCase("gemini", gemBody(400_000));
  assert.equal(small.pricing_tier, "standard");
  const big = estimateWorstCase("gemini", gemBody(900_000));
  assert.equal(big.pricing_tier, "long_context");
  assert.equal(big.estimate_usd, usd((big.input_tokens * 2.5 + 1000 * 15) / 1e6));
});

test("preflight refuses a request that fits at standard but not long-context rates", () => {
  const b = gemBody(900_000);
  const est = estimateWorstCase("gemini", b);
  const standardCost = (est.input_tokens * 1.25 + 1000 * 10) / 1e6;
  const cap = createCapEngine({ caps: { run: (standardCost + est.estimate_usd) / 2 } });
  const hit = preflightCheck(cap, "gemini", b);
  assert.equal(hit.reason, "preflight_estimate");
  assert.equal(hit.pricing_tier, "long_context");
});

test("pricing show prints the standard and >200000 rows", () => {
  const r = pricingCommand(["show", "gemini-2.5-pro"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /gemini-2\.5-pro: input \$1\.25, cached_input \$0\.125/);
  assert.match(r.out, /gemini-2\.5-pro \(>200000 input tokens\): input \$2\.5, cached_input \$0\.25, cache_write n\/a, cache_write_1h n\/a, output \$15/);
  assert.match(pricingCommand(["show"]).out, /claude-sonnet-4-6 \(>200000 input tokens\): input \$6/);
  assert.doesNotMatch(pricingCommand(["show", "gpt-4o"]).out, />200000/);
  assert.equal(pricingCommand(["verify"]).code, 0);
});

test("digest canonicalises a table with long_context and the committed digest matches", () => {
  assert.equal(digestRun(["--check"]).code, 0);
  const a = { version: "v", models: { m: { input: 1, long_context: { threshold_input_tokens: 2, input: 3 } } } };
  const b = { models: { m: { long_context: { input: 3, threshold_input_tokens: 2 }, input: 1 } }, version: "v" };
  assert.equal(canonicalize(a), canonicalize(b));
  const dir = mkdtempSync(join(tmpdir(), "lc-"));
  const p = join(dir, "t.json");
  writeFileSync(p, JSON.stringify(a));
  assert.equal(digestRun([], p).code, 0);
  assert.equal(digestRun(["--check"], p).code, 0);
  assert.equal(verifyTableDigest({ ...a, models: { m: { ...a.models.m, long_context: { threshold_input_tokens: 2, input: 4 } } } }, { version: "v", sha256: "x" }).ok, false);
});

// --- proxy e2e: JSON and SSE above the threshold, run cap stops on the tiered figure

function upstream(body, type = "application/json") {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": type }).end(body)); });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

async function through(t, provider, path, body, type, cap) {
  const up = await upstream(body, type);
  t.after(() => up.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { [provider]: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r), ...(cap ? { cap } : {}) });
  t.after(() => server.close());
  const call = async () => { const res = await fetch(`http://127.0.0.1:${port}/${provider}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await res.text(); await new Promise((r) => setImmediate(r)); return res.status; };
  return { receipts, call };
}

const GEM_USAGE = { promptTokenCount: 250_000, candidatesTokenCount: 1000 };
const GEM_COST = usd(250_000 * 2.5 / 1e6 + 1000 * 15 / 1e6);
const ANT_USAGE = { input_tokens: 150_000, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 0, output_tokens: 1000 };
const ANT_COST = usd((150_000 * 6 + 60_000 * 0.6 + 1000 * 22.5) / 1e6);

test("proxy: gemini JSON and SSE over 200K yield the same long_context receipt", async (t) => {
  const json = await through(t, "gemini", "/v1beta/models/gemini-2.5-pro:generateContent", JSON.stringify({ modelVersion: "gemini-2.5-pro", usageMetadata: GEM_USAGE }));
  assert.equal(await json.call(), 200);
  const sse = await through(t, "gemini", "/v1beta/models/gemini-2.5-pro:streamGenerateContent", `data: ${JSON.stringify({ modelVersion: "gemini-2.5-pro", usageMetadata: GEM_USAGE })}\n\n`, "text/event-stream");
  assert.equal(await sse.call(), 200);
  for (const r of [json.receipts[0], sse.receipts[0]]) {
    assert.equal(r.pricing_tier, "long_context");
    assert.equal(r.cost_usd, GEM_COST);
  }
});

test("proxy: anthropic JSON and SSE over 200K yield the same long_context receipt", async (t) => {
  const json = await through(t, "anthropic", "/v1/messages", JSON.stringify({ model: "claude-sonnet-4-6", usage: ANT_USAGE }));
  assert.equal(await json.call(), 200);
  const { output_tokens, ...start } = ANT_USAGE;
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-4-6", usage: { ...start, output_tokens: 1 } } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens } })}`,
    'event: message_stop\ndata: {"type":"message_stop"}', ""].join("\n\n");
  const sse = await through(t, "anthropic", "/v1/messages", events, "text/event-stream");
  assert.equal(await sse.call(), 200);
  for (const r of [json.receipts[0], sse.receipts[0]]) {
    assert.equal(r.pricing_tier, "long_context");
    assert.equal(r.cost_usd, ANT_COST);
  }
});

test("proxy: run cap stops on the long-context figure, not the standard one", async (t) => {
  // Standard-tier cost (0.3225) would leave room for a second call under 0.5; the tiered cost (0.64) does not.
  const p = await through(t, "gemini", "/v1beta/models/gemini-2.5-pro:generateContent", JSON.stringify({ modelVersion: "gemini-2.5-pro", usageMetadata: GEM_USAGE }), "application/json", createCapEngine({ caps: { run: 0.5 } }));
  assert.equal(await p.call(), 200);
  assert.equal(p.receipts[0].cost_usd, GEM_COST);
  assert.equal(await p.call(), 429);
});

test("regression: a standard-tier proxy receipt only gains pricing_tier: standard", async (t) => {
  const p = await through(t, "gemini", "/v1beta/models/gemini-2.5-pro:generateContent", JSON.stringify({ modelVersion: "gemini-2.5-pro", usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } }));
  await p.call();
  assert.equal(p.receipts[0].pricing_tier, "standard");
  assert.equal(p.receipts[0].cost_usd, usd(1000 * 1.25 / 1e6 + 100 * 10 / 1e6));
});

test("#188 regional endpoint premium stacks with the long-context tier", () => {
  const u = { input_tokens: 300_000, output_tokens: 10_000, cached_input_tokens: 1000 };
  const lc = costForUsage("claude-sonnet-4-5", u);
  const reg = costForUsage("claude-sonnet-4-5", u, { regional: true });
  assert.equal(lc.pricing_tier, "long_context");
  assert.equal(reg.pricing_tier, "long_context");
  assert.equal(reg.regional_multiplier, 1.1);
  const r = lookupPrice("claude-sonnet-4-5").long_context;
  assert.equal(reg.cost_usd, Number(((u.input_tokens * r.input * 1.1 + u.cached_input_tokens * r.cached_input * 1.1 + u.output_tokens * r.output * 1.1) / 1e6).toFixed(6)));
});

// #232: OpenAI >272K tier; Fast is 2x the applicable (long-context) rates where published.
test("#232 AC4: gpt-6.1-sol long context standard and fast", async () => {
  const { costForUsage } = await import("../src/pricing.js");
  const lc = costForUsage("gpt-6.1-sol", { input_tokens: 300_000, output_tokens: 1000 });
  assert.deepEqual([lc.cost_usd, lc.pricing_tier], [1.215, "long_context"]);
  const fast = costForUsage("gpt-6.1-sol", { input_tokens: 300_000, output_tokens: 1000, service_tier: "fast" });
  assert.deepEqual([fast.cost_usd, fast.pricing_tier, fast.long_context], [2.43, "priority", true]);
  assert.equal(costForUsage("gpt-6.1-sol", { input_tokens: 272_000, output_tokens: 1000 }).pricing_tier, "standard");
  // No stated multiple: ultrafast over 272K, and gpt-5.5 (Fast is 2.5x) Fast over 272K, are unpriced.
  for (const [m, t] of [["gpt-6.1-sol", "ultrafast"], ["gpt-5.5", "priority"]]) {
    const r = costForUsage(m, { input_tokens: 300_000, output_tokens: 1, service_tier: t });
    assert.deepEqual([r.cost_usd, r.reason], [null, "service_tier_unpriced"], m);
  }
});

// #234: Haiku 5.5 >100K prompt tier (prompt counts cache reads/writes); Fable 5.2 cache usage through the proxy.
test("#234 AC3: claude-haiku-5-5 standard up to 100000 prompt tokens, long_context above", () => {
  const a = costForUsage("claude-haiku-5-5", { input_tokens: 80_000, output_tokens: 1000 });
  assert.deepEqual([a.cost_usd, a.pricing_tier], [0.0085, "standard"]);
  const b = costForUsage("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 1000 });
  assert.deepEqual([b.cost_usd, b.pricing_tier], [0.0105, "standard"]);
  const c = costForUsage("claude-haiku-5-5", { input_tokens: 90_000, cached_input_tokens: 20_000, output_tokens: 1000 });
  assert.deepEqual([c.cost_usd, c.pricing_tier], [0.0485, "long_context"]);
  const reg = costForUsage("claude-haiku-5-5", { input_tokens: 90_000, cached_input_tokens: 20_000, output_tokens: 1000 }, { regional: true });
  assert.deepEqual([reg.cost_usd, reg.pricing_tier, reg.regional_multiplier], [0.05335, "long_context", 1.1]);
});

test("#234 pricing show prints Haiku 5.5 >100000 and Fable 5.2 fast rows; verify passes", () => {
  const out = pricingCommand(["show"]).out;
  assert.match(out, /claude-haiku-5-5 \(>100000 input tokens\): input \$0\.5, cached_input \$0\.05/);
  assert.match(out, /claude-fable-5-2 \(fast\): input \$16/);
  assert.equal(pricingCommand(["verify"]).code, 0);
});

const FABLE_USAGE = { input_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 10_000 }, output_tokens: 2000 };
test("#234 AC2 proxy: claude-fable-5-2 cache usage costs 0.368 as JSON and SSE, no fallback", async (t) => {
  const json = await through(t, "anthropic", "/v1/messages", JSON.stringify({ model: "claude-fable-5-2", usage: FABLE_USAGE }));
  assert.equal(await json.call(), 200);
  const { output_tokens, ...start } = FABLE_USAGE;
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-fable-5-2", usage: { ...start, output_tokens: 1 } } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens } })}`,
    'event: message_stop\ndata: {"type":"message_stop"}', ""].join("\n\n");
  const sse = await through(t, "anthropic", "/v1/messages", events, "text/event-stream");
  assert.equal(await sse.call(), 200);
  for (const r of [json.receipts[0], sse.receipts[0]]) {
    assert.equal(r.cost_usd, 0.368);
    assert.ok(!r.fallback);
  }
});
