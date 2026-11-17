// #214: per-call pricing of provider-side tools (web search, file search).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolRate, toolRowRate, toolCallCost, requestWebSearchType, costForUsage, loadPricingTable } from "../src/pricing.js";
import { withToolCost, validateToolPrices } from "../src/price-overrides.js";
import { loadUpstreamPrices } from "../src/upstreams.js";
import { foldBatchResults } from "../src/batch.js";
import { estimateWorstCase, preflightCheck, toolWorstCase } from "../src/preflight.js";
import { createCapEngine } from "../src/cap.js";
import { pricingCommand } from "../src/pricing-cli.js";

const pricesFile = (doc) => { const p = join(mkdtempSync(join(tmpdir(), "cc-tools-")), "p.json"); writeFileSync(p, JSON.stringify(doc)); return p; };

test("table carries a tools section with sources and per-call rates", () => {
  const { table, verification } = loadPricingTable();
  assert.equal(verification.ok, true);
  assert.equal(table.tools.unit, "usd_per_call");
  assert.ok(table.sources.some((s) => s.includes("web-search-tool")));
  assert.equal(toolRate("anthropic", "web_search", "claude-sonnet-4-6"), 0.01);
  assert.equal(toolRate("openai", "file_search", "anything"), 0.0025);
});

test("OpenAI web search rate follows the tool type and the model family", () => {
  assert.equal(toolRate("openai", "web_search", "gpt-4o-mini"), 0.01);
  assert.equal(toolRate("openai", "web_search_preview", "gpt-4o-mini"), 0.025);
  assert.equal(toolRate("openai", "web_search_preview", "gpt-4.1-2025-04-14"), 0.025);
  assert.equal(toolRate("openai", "web_search_preview", "o4-mini"), 0.01);
  assert.equal(toolRate("openai", "web_search_preview", "gpt-5-mini"), 0.01);
  assert.equal(toolRate("openai", "web_search_preview", "openai/gpt-4o"), 0.025);
  assert.equal(toolRate("openai", "web_search", "gpt-3.5-turbo"), null);
  assert.equal(toolRate("openai", "web_search", 42), null);
  assert.equal(toolRate("openai", "code_interpreter", "gpt-4o"), null);
  assert.equal(toolRate("gemini", "web_search", "gemini-2.5-flash"), null);
});

test("requestWebSearchType reads the request tools", () => {
  assert.equal(requestWebSearchType({ tools: [{ type: "web_search" }] }), "web_search");
  assert.equal(requestWebSearchType({ tools: [{ type: "web_search_preview_2025_03_11" }] }), "web_search_preview");
  assert.equal(requestWebSearchType({ tools: [{ type: "web_search" }, { type: "web_search_preview" }] }), undefined);
  assert.equal(requestWebSearchType({ tools: [{ type: "function" }] }), undefined);
  assert.equal(requestWebSearchType(null), undefined);
});

test("toolCallCost: known tools priced, unknown type uses the higher rate, unknown tools unpriced", () => {
  assert.deepEqual(toolCallCost("openai", "gpt-4o", { web_search: 2, file_search: 1 }, { webSearchType: "web_search" }), { unpriced: false, tool_cost_usd: 0.0225, user_prices: false });
  assert.equal(toolCallCost("openai", "gpt-4o", { web_search: 2 }).tool_cost_usd, 0.05);
  assert.equal(toolCallCost("openai", "gpt-4o", { web_search: 0 }).tool_cost_usd, 0);
  assert.deepEqual(toolCallCost("anthropic", "claude-opus-4-6", { bogus: 1 }), { unpriced: true, tool: "bogus" });
  assert.equal(toolCallCost("openai", "gpt-3.5-turbo", { web_search: 1 }, { webSearchType: "web_search" }).unpriced, true);
});

test("AC5: a tools override replaces the table rate and pins user_prices", () => {
  const prices = loadUpstreamPrices(pricesFile({ tools: { web_search: 0.008 } }), []);
  assert.deepEqual(prices.upstreams, {});
  const metered = { model: "claude-sonnet-4-6", toolCalls: { web_search: 2 } };
  const base = costForUsage("claude-sonnet-4-6", { input_tokens: 10, output_tokens: 5 });
  const r = withToolCost(base, prices, "anthropic", metered, {});
  assert.equal(r.tool_cost_usd, 0.016);
  assert.equal(r.cost_usd, Number((base.cost_usd + 0.016).toFixed(6)));
  assert.equal(r.cost_source, "user_prices");
  assert.equal(r.prices_sha256, prices.sha256);
  const noOverride = withToolCost(base, null, "anthropic", metered, {});
  assert.equal(noOverride.cost_source, "table");
  assert.equal(noOverride.tool_cost_usd, 0.02);
});

test("withToolCost leaves receipts without tool calls alone and keeps an already-unknown cost unknown", () => {
  const base = costForUsage("gpt-4o", { input_tokens: 1, output_tokens: 1 });
  assert.equal(withToolCost(base, null, "openai", { model: "gpt-4o" }, {}), base);
  const unknown = withToolCost({ ...base, cost_usd: null, reason: "x" }, null, "openai", { model: "gpt-4o", toolCalls: { web_search: 1 } }, {});
  assert.deepEqual([unknown.cost_usd, unknown.reason, unknown.tool_calls], [null, "x", { web_search: 1 }]);
  const unp = withToolCost(base, null, "openrouter", { model: "gpt-4o", toolCalls: { web_search: 1 } }, {});
  assert.deepEqual([unp.cost_usd, unp.reason], [null, "tool_use_unpriced"]);
});

test("tools overrides are validated", () => {
  assert.throws(() => validateToolPrices("p", []), /tools must be an object/);
  assert.throws(() => validateToolPrices("p", { code_interpreter: 0.03 }), /unknown tool/);
  assert.throws(() => validateToolPrices("p", { web_search: 0 }), /> 0/);
  assert.throws(() => loadUpstreamPrices(pricesFile({ tools: { web_search: -1 } }), []), /never \$0/);
  assert.doesNotThrow(() => validateToolPrices("p", { web_search: 0.01, web_search_preview: 0.02, file_search: 0.001 }));
});

test("AC4: batch lines bill tool calls at 100% and tokens at 50%", () => {
  const msg = { model: "claude-sonnet-4-6", usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 4 } } };
  const line = JSON.stringify({ custom_id: "a", result: { type: "succeeded", message: msg } });
  const r = foldBatchResults("anthropic", line);
  const tokens = costForUsage("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 100 }, { batch: "anthropic" }).cost_usd;
  assert.equal(r.ok, true);
  assert.equal(r.cost_usd, Number((tokens + 0.04).toFixed(6)));
  const unknown = JSON.stringify({ custom_id: "b", result: { type: "succeeded", message: { ...msg, usage: { ...msg.usage, server_tool_use: { bogus_requests: 1 } } } } });
  assert.equal(foldBatchResults("anthropic", unknown).ok, false);
  const oai = JSON.stringify({ response: { status_code: 200, body: { model: "gpt-3.5-turbo", output: [{ type: "web_search_call" }], usage: { input_tokens: 1, output_tokens: 1 } } } });
  assert.equal(foldBatchResults("openai", oai).ok, false);
});

test("AC6: preflight adds max_uses x rate and refuses a call that would not fit", () => {
  const req = { model: "claude-haiku-4-5", max_tokens: 10, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] };
  const without = estimateWorstCase("anthropic", JSON.stringify({ ...req, tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  const withMax = estimateWorstCase("anthropic", JSON.stringify(req));
  assert.equal(withMax.tool_calls_max, 5);
  assert.equal(withMax.tool_usd_max, 0.05);
  assert.ok(withMax.estimate_usd - without.estimate_usd > 0.0499);
  const cap = createCapEngine({ caps: { run: 0.03 } });
  assert.equal(preflightCheck(cap, "anthropic", JSON.stringify(req), "/v1/messages").reason, "preflight_estimate");
  assert.equal(preflightCheck(createCapEngine({ caps: { run: 1 } }), "anthropic", JSON.stringify(req), "/v1/messages"), null);
  assert.deepEqual(toolWorstCase("openai", req, "gpt-4o"), { ok: true, usd: 0, calls: 0 });
  assert.equal(toolWorstCase("anthropic", req, "some-unknown").ok, true); // anthropic rate is model-independent
});

test("AC7: costcap pricing verify passes with the new digest", () => {
  const r = pricingCommand(["verify"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /2026-11-16\.22/);
});

test("#232 gpt-6 family web_search / web_search_preview at $0.01", async () => {
  const { toolRate, toolCallCost } = await import("../src/pricing.js");
  for (const m of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-astra-2026-04-30", "gpt-5.6-sol"]) {
    assert.equal(toolRate("openai", "web_search", m), 0.01, m);
    assert.equal(toolRate("openai", "web_search_preview", m), 0.01, m);
  }
  assert.deepEqual(toolCallCost("openai", "gpt-6-astra", { web_search: 1 }), { unpriced: false, tool_cost_usd: 0.01, user_prices: false });
});

// #254: Claude web fetch is free; code execution is free only alongside web_search/web_fetch dated >= 20260209.
test("#254 free rows: web_fetch $0, code_execution $0 only with a 20260209+ search/fetch tool, bare 0 stays unpriced", () => {
  assert.equal(toolRate("anthropic", "web_fetch", "claude-sonnet-4-6"), 0);
  assert.deepEqual(toolCallCost("anthropic", "claude-sonnet-4-6", { web_fetch: 2 }), { unpriced: false, tool_cost_usd: 0, user_prices: false });
  for (const type of ["web_fetch_20260209", "web_search_20260318"])
    assert.deepEqual(toolCallCost("anthropic", "claude-sonnet-4-6", { code_execution: 2 }, { requestTools: [{ type }] }).tool_cost_usd, 0, type);
  for (const tools of [[{ type: "code_execution_20260521" }], [{ type: "web_search_20250305" }], [{ type: "web_fetch_2026020" }], [], undefined, [null]])
    assert.deepEqual(toolCallCost("anthropic", "claude-sonnet-4-6", { code_execution: 2 }, { requestTools: tools }), { unpriced: true, tool: "code_execution" });
  assert.equal(toolCallCost("anthropic", "claude-sonnet-4-6", { code_execution: 2 }, { requestTools: [{ type: "code_execution_20260521" }], userTools: { code_execution: 0.005 } }).tool_cost_usd, 0.01);
  // Vertex / Bedrock list no web_fetch row: never $0.
  assert.equal(toolRate("vertex", "web_fetch", "claude-sonnet-4-5"), null);
  assert.equal(toolCallCost("bedrock", "claude-sonnet-4-5", { web_fetch: 1 }).unpriced, true);
});

test("#254 AC5: a table row with usd_per_call 0 but no free flag is unpriced", () => {
  assert.equal(toolRowRate({ usd_per_call: 0 }, "claude-sonnet-4-6"), null);
  assert.equal(toolRowRate({ usd_per_call: 0, free: "yes" }, "claude-sonnet-4-6"), null);
  assert.equal(toolRowRate({ usd_per_call: 0, free: true }, "claude-sonnet-4-6"), 0);
  assert.equal(toolRowRate({ usd_per_call: 0.5, free: true }, "claude-sonnet-4-6"), 0.5);
  assert.equal(toolRowRate(undefined, "claude-sonnet-4-6"), null);
});

test("#254 AC4/AC6: overrides accept code_execution > 0 only; batch web_fetch adds $0, code_execution is batch_unpriced unless overridden", () => {
  assert.doesNotThrow(() => validateToolPrices("p", { code_execution: 0.005 }));
  assert.throws(() => validateToolPrices("p", { code_execution: 0 }), /> 0/);
  assert.throws(() => validateToolPrices("p", { web_fetch: 0 }), /unknown tool/);
  const msg = (stu) => JSON.stringify({ custom_id: "a", result: { type: "succeeded", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: stu } } } });
  const tokens = costForUsage("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 100 }, { batch: "anthropic" }).cost_usd;
  const fetchLine = foldBatchResults("anthropic", msg({ web_fetch_requests: 1 }));
  assert.equal(fetchLine.ok, true);
  assert.equal(fetchLine.cost_usd, tokens);
  const ce = foldBatchResults("anthropic", msg({ code_execution_requests: 1 }));
  assert.deepEqual([ce.ok, ce.reason], [false, "batch_unpriced"]);
  const prices = loadUpstreamPrices(pricesFile({ tools: { code_execution: 0.005 } }), []);
  assert.equal(foldBatchResults("anthropic", msg({ code_execution_requests: 1 }), prices).cost_usd, Number((tokens + 0.005).toFixed(6)));
});
