// #219: batch result lines price web_search_call by the Response body's echoed tools.
import test from "node:test";
import assert from "node:assert/strict";
import { foldBatchResults } from "../src/batch.js";
import { withToolCost } from "../src/price-overrides.js";

const calls = (n) => Array.from({ length: n }, (_, i) => ({ type: "web_search_call", id: `ws_${i}`, status: "completed" }));
const line = (tools) => JSON.stringify({ custom_id: "a", response: { status_code: 200, body: {
  object: "response", model: "gpt-4.1", output: calls(4), usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 }, ...(tools && { tools }) } } });
const TOK = 0.003; // gpt-4.1 at 0.5x: (1000 * 2 + 500 * 8) / 1M / 2
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("#219 AC2: batch web_search on gpt-4.1 adds $0.04 at the full rate; tokens keep the discount", () => {
  near(foldBatchResults("openai", line([{ type: "web_search" }])).cost_usd, TOK + 0.04);
});
test("#219 AC3: batch web_search_preview stays $25/1k; untyped falls back to the max rate", () => {
  near(foldBatchResults("openai", line([{ type: "web_search_preview" }])).cost_usd, TOK + 0.1);
  near(foldBatchResults("openai", line(null)).cost_usd, TOK + 0.1);
});
test("#219 AC4: --prices tools overrides apply on the batch path", () => {
  const up = { tools: { web_search: 0.02 } };
  near(foldBatchResults("openai", line([{ type: "web_search" }]), up).cost_usd, TOK + 0.08);
});
test("#219: the request's type wins over the response's; response decides when the request has none", () => {
  const metered = { model: "gpt-4o", toolCalls: { web_search: 4 } };
  const base = { cost_usd: 0 };
  assert.equal(withToolCost(base, null, "openai", metered, { tools: [{ type: "web_search_preview" }] }, { tools: [{ type: "web_search" }] }).tool_cost_usd, 0.1);
  assert.equal(withToolCost(base, null, "openai", metered, {}, { tools: [{ type: "web_search" }] }).tool_cost_usd, 0.04);
  const u = withToolCost(base, { tools: { web_search: 0.02 } }, "openai", metered, null, { tools: [{ type: "web_search" }] });
  assert.deepEqual([u.tool_cost_usd, u.cost_source], [0.08, "user_prices"]);
});
