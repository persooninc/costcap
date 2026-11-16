// #189: per-model price overrides and discounts for built-in providers.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { costForUsage } from "../src/pricing.js";
import { loadUpstreamPrices } from "../src/upstreams.js";
import { builtinOverride, costWithOverrides, effectivePrice, isPricedWithOverrides, unpricedDiscountWarnings } from "../src/price-overrides.js";
import { foldBatchResults } from "../src/batch.js";
import { auditReceipts } from "../src/pricing-digest.js";
import { pricingCommand } from "../src/pricing-cli.js";
import { estimateWorstCase } from "../src/preflight.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "cc-po-"));
const file = (doc) => { const f = path.join(tmp(), "prices.json"); writeFileSync(f, JSON.stringify(doc)); return f; };
const DOC = { version: "neg-1", upstreams: {
  anthropic: { "claude-sonnet-4-5": { discount: 0.2 } },
  openai: { "gpt-6-preview": { input: 3, output: 12 }, "gpt-4o": { input: 2, output: 8 }, "*": { discount: 0.1 } },
} };
const P = () => loadUpstreamPrices(file(DOC), []);
const r6 = (n) => Number(n.toFixed(6));

test("validation: bad built-in entries throw; built-in keys need no --upstream (AC4)", () => {
  assert.equal(P().version, "neg-1");
  const bad = [{ discount: 1 }, { discount: 0 }, { discount: -0.1 }, { input: 0, output: 1 }, { input: -1, output: 1 }, { discount: 0.2, input: 1 },
    { input: 1, ouput: 1 }, { input: 1 }, { input: 1, output: Infinity }, null, []];
  for (const e of bad) assert.throws(() => loadUpstreamPrices(file({ upstreams: { openai: { m: e } } }), []), /upstream-prices/, JSON.stringify(e));
  assert.throws(() => loadUpstreamPrices(file({ upstreams: { anthropic: { "*": { input: 1, output: 1 } } } }), []), /"\*" takes only/);
  assert.throws(() => loadUpstreamPrices(file({ upstreams: { openai: [] } }), []), /object of models/);
  // Bedrock/Vertex are out of scope (#188): still rejected as undeclared.
  assert.throws(() => loadUpstreamPrices(file({ upstreams: { bedrock: { m: { discount: 0.1 } } } }), []), /not declared/);
});

test("discount scales every tier, including cache and long context (AC1)", () => {
  const p = P();
  for (const usage of [{ input_tokens: 1000, output_tokens: 500, cached_input_tokens: 300, cache_write_input_tokens: 200, cache_write_1h_input_tokens: 100 },
    { input_tokens: 210_000, output_tokens: 1000, cached_input_tokens: 10, cache_write_input_tokens: 5 }]) {
    const t = costForUsage("claude-sonnet-4-5", usage);
    const c = costWithOverrides(p, "anthropic", "claude-sonnet-4-5-20250929", usage);
    assert.equal(c.cost_usd, r6(t.cost_usd * 0.8));
    assert.equal(c.pricing_tier, t.pricing_tier);
    assert.equal(c.cost_source, "user_prices");
    assert.equal(c.prices_sha256, p.sha256);
    assert.equal(c.table_sha256, t.table_sha256);
    assert.equal(c.discount, 0.2);
  }
  // No override for this provider: identical to the table.
  assert.deepEqual(costWithOverrides(p, "gemini", "gemini-2.5-pro", { input_tokens: 10 }), costForUsage("gemini-2.5-pro", { input_tokens: 10 }));
  assert.deepEqual(costWithOverrides(null, "openai", "gpt-4o", { input_tokens: 10 }), costForUsage("gpt-4o", { input_tokens: 10 }));
});

test("absolute rates price a new model and a snapshot of it, not the fallback (AC2)", () => {
  const p = P();
  const c = costWithOverrides(p, "openai", "gpt-6-preview-2026-12-01", { input_tokens: 1000, output_tokens: 100 });
  assert.equal(c.cost_usd, r6((1000 * 3 + 100 * 12) / 1e6));
  assert.equal(c.fallback, false);
  assert.equal(c.cost_source, "user_prices");
  assert.ok(isPricedWithOverrides(p, "openai", "gpt-6-preview"));
  assert.ok(!isPricedWithOverrides(p, "anthropic", "gpt-6-preview"));
  assert.equal(effectivePrice(p, "openai", "gpt-6-preview").input, 3);
  const est = estimateWorstCase("openai", Buffer.from(JSON.stringify({ model: "gpt-6-preview", max_tokens: 10 })), "/v1/chat/completions", (m) => effectivePrice(p, "openai", m));
  assert.equal(est.ok, true);
  assert.equal(est.cost_source, "user_prices");
});

test("absolute override never prices what it doesn't list; '*' never discounts the fallback (AC3)", () => {
  const p = P();
  for (const usage of [{ input_tokens: 10, cache_write_input_tokens: 5 }, { input_tokens: 10, cached_input_tokens: 5 }, { input_tokens: 10, service_tier: "priority" },
    { input_tokens: 10, modality_tokens: { input: { audio: 4 } } }]) {
    const c = costWithOverrides(p, "openai", "gpt-6-preview", usage);
    assert.equal(c.cost_usd, null, JSON.stringify(usage));
    assert.equal(c.reason, "user_price_unpriced");
  }
  // Long context over the table threshold under an absolute override for a table model.
  const lp = loadUpstreamPrices(file({ upstreams: { anthropic: { "claude-sonnet-4-5": { input: 2, output: 10, cached_input: 0.2, cache_write: 2.5 } } } }), []);
  assert.equal(costWithOverrides(lp, "anthropic", "claude-sonnet-4-5", { input_tokens: 250_000 }).reason, "user_price_unpriced");
  assert.equal(costWithOverrides(lp, "anthropic", "claude-sonnet-4-5", { input_tokens: 1000, cached_input_tokens: 10, cache_write_input_tokens: 10 }).cost_usd, r6((1000 * 2 + 10 * 0.2 + 10 * 2.5) / 1e6));
  assert.equal(costWithOverrides(p, "openai", "gpt-6-preview", { input_tokens: 10 }, { batch: "openai" }).reason, "user_price_unpriced");
  // '*' discount: table models are discounted, fallback models are not.
  const fb = costWithOverrides(p, "openai", "totally-new-model", { input_tokens: 1000, output_tokens: 100 });
  assert.equal(fb.cost_source, "fallback");
  assert.equal(fb.cost_usd, costForUsage("totally-new-model", { input_tokens: 1000, output_tokens: 100 }).cost_usd);
  assert.equal(builtinOverride(p, "openai", "totally-new-model"), null);
  const g5 = costWithOverrides(p, "openai", "gpt-5", { input_tokens: 1000, output_tokens: 100 });
  assert.equal(g5.cost_usd, r6(costForUsage("gpt-5", { input_tokens: 1000, output_tokens: 100 }).cost_usd * 0.9));
  // A model-specific entry wins over '*'.
  assert.deepEqual(builtinOverride(p, "openai", "gpt-4o"), { absolute: { input: 2, output: 8 } });
});

test("batch: a discount stacks on the batch multiplier; absolute is unknown", () => {
  const line = (model) => JSON.stringify({ custom_id: "a", result: { type: "succeeded", message: { model, usage: { input_tokens: 1000, output_tokens: 100 } } } });
  const p = P();
  const full = foldBatchResults("anthropic", line("claude-sonnet-4-5"));
  const disc = foldBatchResults("anthropic", line("claude-sonnet-4-5"), p);
  assert.equal(disc.cost_usd, r6(full.cost_usd * 0.8));
  const abs = loadUpstreamPrices(file({ upstreams: { anthropic: { "claude-sonnet-4-5": { input: 1, output: 1 } } } }), []);
  assert.equal(foldBatchResults("anthropic", line("claude-sonnet-4-5"), abs).ok, false);
});

test("auditReceipts and pricing verify/show count user_prices on their own (AC5)", () => {
  const p = P();
  const tableR = costForUsage("gpt-4o", { input_tokens: 10 });
  const userR = costWithOverrides(p, "anthropic", "claude-sonnet-4-5", { input_tokens: 10 });
  const a = auditReceipts([tableR, userR], tableR.table_sha256);
  assert.equal(a.ok, true);
  assert.equal(a.user_prices, 1);
  assert.equal(a.matching, 1);
  const dir = tmp();
  const receipts = path.join(dir, "r.jsonl");
  writeFileSync(receipts, [tableR, userR].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const ok = pricingCommand(["verify", "--receipts", receipts]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /1 user_prices/);
  const otherFile = file({ version: "x", upstreams: { anthropic: { "claude-sonnet-4-5": { discount: 0.3 } } } });
  const bad = pricingCommand(["verify", "--receipts", receipts, "--prices", otherFile]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /line 2: prices_different/);
  const same = path.join(dir, "same.json"); writeFileSync(same, JSON.stringify(DOC));
  assert.equal(pricingCommand(["verify", "--receipts", receipts, "--prices", same]).code, 0);
  const show = pricingCommand(["show", "claude-sonnet-4-5", "--prices", same]);
  assert.equal(show.code, 0);
  assert.match(show.out, /anthropic\/claude-sonnet-4-5 \(discount 0\.2\): input \$2\.4\b/);
  assert.match(pricingCommand(["show", "gpt-6-preview", "--prices", same]).out, /\(user_prices [0-9a-f]{8}\): input \$3/);
  assert.equal(pricingCommand(["show", "x", "--prices", path.join(dir, "nope.json")]).code, 2);
});

async function fakeUpstream(t, body) {
  const seen = [];
  const s = http.createServer((req, res) => { req.resume(); req.on("end", () => { seen.push(req.url); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body)); }); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return { seen, base: `http://127.0.0.1:${s.address().port}` };
}
async function proxy(t, base, opts) {
  const receipts = [];
  const { server, port } = await startMeteringProxy({ receiptsPath: path.join(tmp(), "r.jsonl"), onReceipt: (r) => receipts.push(r), upstreams: { anthropic: base, openai: base }, ...opts });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = async (p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.text() }; };
  return { receipts, call };
}

test("proxy: discounted receipt, cap counts discounted spend (AC1 regression)", async (t) => {
  const up = await fakeUpstream(t, { model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 50 } });
  const cap = createCapEngine({ caps: { run: 100 } });
  const p = await proxy(t, up.base, { userPrices: P(), cap });
  assert.equal((await p.call("/anthropic/v1/messages", { model: "claude-sonnet-4-5", max_tokens: 10 })).status, 200);
  const rc = p.receipts.at(-1);
  assert.equal(rc.cost_source, "user_prices");
  assert.ok(rc.prices_sha256 && rc.table_sha256);
  assert.equal(rc.cost_usd, r6(costForUsage("claude-sonnet-4-5", { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 50 }).cost_usd * 0.8));
  assert.equal(cap.spend().run, rc.cost_usd);
});

test("proxy: new model forwarded under refuse/preflight only with the file; unpriced pauses (AC2, AC3)", async (t) => {
  const up = await fakeUpstream(t, { model: "gpt-6-preview-2026-12-01", usage: { prompt_tokens: 100, completion_tokens: 10 } });
  const body = { model: "gpt-6-preview", max_tokens: 10, messages: [] };
  const withFile = await proxy(t, up.base, { userPrices: P(), unknownModels: "refuse", preflight: true, cap: createCapEngine({ caps: { day: 1 } }) });
  assert.equal((await withFile.call("/openai/v1/chat/completions", body)).status, 200);
  assert.equal(withFile.receipts.at(-1).cost_usd, r6((100 * 3 + 10 * 12) / 1e6));
  assert.equal(withFile.receipts.at(-1).fallback, false);
  const refuse = await proxy(t, up.base, { unknownModels: "refuse" });
  assert.equal((await refuse.call("/openai/v1/chat/completions", body)).status, 403);
  const pf = await proxy(t, up.base, { preflight: true, cap: createCapEngine({ caps: { day: 1 } }) });
  assert.match((await pf.call("/openai/v1/chat/completions", body)).body, /preflight_unpriced/);
  const prio = await fakeUpstream(t, { model: "gpt-6-preview", service_tier: "priority", usage: { prompt_tokens: 100, completion_tokens: 10 } });
  const pp = await proxy(t, prio.base, { userPrices: P(), cap: createCapEngine({ caps: { run: 5 } }) });
  await pp.call("/openai/v1/chat/completions", body);
  assert.equal(pp.receipts.at(-1).reason, "user_price_unpriced");
  const next = await pp.call("/openai/v1/chat/completions", body);
  assert.equal(next.status, 429);
  assert.match(next.body, /unreconciled_receipt|accounting_unavailable/);
});

// #197: a {discount} on a model the table doesn't price is ignored everywhere (never priced, never lower).
const DISC_UNPRICED = { version: "typo-1", upstreams: { openai: { "gpt-6-preview": { discount: 0.2 }, "gpt-4o": { discount: 0.2 } }, anthropic: { "claude-new-x": { input: 4, output: 9 } } } };
const PU = () => loadUpstreamPrices(file(DISC_UNPRICED), []);

test("#197 discount on an unpriced model: not priced, fallback row undiscounted, billed at full fallback (AC1, AC2)", () => {
  const p = PU();
  assert.equal(builtinOverride(p, "openai", "gpt-6-preview"), null);
  assert.equal(builtinOverride(p, "openai", "gpt-6-preview-2026-12-01"), null);
  assert.equal(isPricedWithOverrides(p, "openai", "gpt-6-preview"), false);
  assert.equal(isPricedWithOverrides(p, "anthropic", "claude-new-x"), true); // absolute still prices an unknown model
  const eff = effectivePrice(p, "openai", "gpt-6-preview");
  const fb = costForUsage("gpt-6-preview", { input_tokens: 1e6 });
  assert.equal(eff.fallback, true);
  assert.equal("discount" in eff, false);
  assert.equal("user_prices" in eff, false);
  assert.equal(eff.input, fb.cost_usd);
  const c = costWithOverrides(p, "openai", "gpt-6-preview", { input_tokens: 1e6 });
  assert.equal(c.cost_usd, fb.cost_usd);
  assert.equal(c.fallback, true);
  const est = estimateWorstCase("openai", Buffer.from(JSON.stringify({ model: "gpt-6-preview", max_tokens: 10 })), "/v1/chat/completions", (m) => effectivePrice(p, "openai", m));
  const estFb = estimateWorstCase("openai", Buffer.from(JSON.stringify({ model: "gpt-6-preview", max_tokens: 10 })), "/v1/chat/completions");
  assert.deepEqual(est, estFb); // preflight budgets at the full fallback rate
});

test("#197 unchanged: a discount on a table-priced model and its snapshot still applies (AC4)", () => {
  const p = PU();
  assert.deepEqual(builtinOverride(p, "openai", "gpt-4o"), { discount: 0.2 });
  assert.deepEqual(builtinOverride(p, "openai", "gpt-4o-2024-08-06"), { discount: 0.2 });
  const c = costWithOverrides(p, "openai", "gpt-4o-2024-08-06", { input_tokens: 1000, output_tokens: 100 });
  assert.equal(c.cost_source, "user_prices");
  assert.equal(c.cost_usd, r6(costForUsage("gpt-4o-2024-08-06", { input_tokens: 1000, output_tokens: 100 }).cost_usd * 0.8));
});

test("#197 unpricedDiscountWarnings names each ignored entry, nothing else", () => {
  assert.deepEqual(unpricedDiscountWarnings(PU()), ["costcap: warning: discount ignored: openai/gpt-6-preview is not in the pricing table; add absolute rates"]);
  assert.deepEqual(unpricedDiscountWarnings(P()), []);
  assert.deepEqual(unpricedDiscountWarnings(undefined), []);
});

test("#197 pricing show: fallback row with no discount label", () => {
  const f = file(DISC_UNPRICED);
  const out = pricingCommand(["show", "gpt-6-preview", "--prices", f]).out;
  assert.match(out, /fallback/);
  assert.doesNotMatch(out, /discount/);
  assert.match(pricingCommand(["show", "gpt-4o", "--prices", f]).out, /\(discount 0\.2\)/);
});

test("#197 proxy: --unknown-models refuse still 403s a discount-only unpriced model", async (t) => {
  const up = await fakeUpstream(t, { model: "gpt-6-preview", usage: { prompt_tokens: 100, completion_tokens: 10 } });
  const p = await proxy(t, up.base, { userPrices: PU(), unknownModels: "refuse" });
  const r = await p.call("/openai/v1/chat/completions", { model: "gpt-6-preview", max_tokens: 10, messages: [] });
  assert.equal(r.status, 403);
  assert.match(r.body, /model_unpriced/);
  assert.equal(up.seen.length, 0);
  assert.equal((await p.call("/openai/v1/chat/completions", { model: "gpt-4o", max_tokens: 10, messages: [] })).status, 200);
});
