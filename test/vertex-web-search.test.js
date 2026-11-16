// #222: Claude web search on Vertex AI is priced like /anthropic ($10 per 1,000), not paused as tool_use_unpriced.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { costForUsage, regionalMultiplier, toolRate, toolCallCost } from "../src/pricing.js";
import { toolWorstCase, estimateWorstCase } from "../src/preflight.js";
import { createCapEngine } from "../src/cap.js";
import { loadUpstreamPrices } from "../src/upstreams.js";

const usage = { input_tokens: 1000, output_tokens: 500, server_tool_use: { web_search_requests: 3 } };
const message = { id: "m", type: "message", role: "assistant", content: [], usage };
const stream = [
  { type: "message_start", message: { ...message, usage: { input_tokens: 1000, output_tokens: 1 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500, server_tool_use: { web_search_requests: 3 } } },
  { type: "message_stop" },
];
const VPATH = (loc, verb = "rawPredict", model = "claude-sonnet-4-5@20250929") => `/vertex/v1/projects/p/locations/${loc}/publishers/anthropic/models/${model}:${verb}`;
const tokens = (m) => costForUsage("claude-sonnet-4-5", { input_tokens: 1000, output_tokens: 500 }).cost_usd * m;
const SEARCH_TOOL = [{ type: "web_search_20250305", name: "web_search", max_uses: 50 }];

async function fakeCloud() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    req.resume();
    req.on("end", () => {
      if (req.url.includes(":streamRawPredict")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(stream.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
      } else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, url: `http://127.0.0.1:${server.address().port}` };
}

async function proxyFor(t, opts = {}) {
  const up = await fakeCloud();
  const dir = mkdtempSync(path.join(tmpdir(), "cc-vws-"));
  const receipts = [];
  const { server, port } = await startMeteringProxy({ receiptsPath: path.join(dir, "r.jsonl"), upstreams: { bedrock: up.url, vertex: up.url },
    cloudEnv: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "x", AWS_REGION: "us-east-1" }, onReceipt: (r) => receipts.push(r), onWarning: () => {}, ...opts });
  t.after(() => { server.close(); up.server.close(); });
  const post = (p, body = "{}") => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { authorization: "Bearer ya29.t" }, body });
  return { post, receipts, up };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

test("AC1: table rate for Claude on Vertex; Gemini on Vertex and Claude on Bedrock stay unpriced (AC4)", () => {
  assert.equal(toolRate("vertex", "web_search", "claude-sonnet-4-5"), 0.01);
  assert.equal(toolRate("vertex", "web_search", "gemini-2.5-pro"), null);
  assert.deepEqual(toolCallCost("vertex", "claude-opus-4-5", { web_search: 3 }), { unpriced: false, tool_cost_usd: 0.03, user_prices: false });
  assert.deepEqual(toolCallCost("bedrock", "claude-sonnet-4-5", { web_search: 3 }), { unpriced: true, tool: "web_search" });
  assert.equal(regionalMultiplier("claude-sonnet-4-5"), 1.1);
});

for (const [scope, loc, mult] of [["regional", "us-east5", 1.1], ["global", "global", 1]]) {
  test(`AC1 ${scope}: rawPredict and streamRawPredict price 3 searches at $0.03 (no ${mult}x on tools) and the next call forwards`, async (t) => {
    const { post, receipts, up } = await proxyFor(t);
    assert.equal((await post(VPATH(loc))).status, 200);
    const s = await post(VPATH(loc, "streamRawPredict"));
    await s.text();
    await settle();
    assert.equal((await post(VPATH(loc))).status, 200);
    await settle();
    assert.equal(up.hits.length, 3);
    assert.equal(receipts.length, 3);
    for (const r of receipts) {
      assert.equal(r.provider, "vertex");
      assert.equal(r.endpoint_scope, scope);
      assert.notEqual(r.reason, "tool_use_unpriced");
      assert.deepEqual(r.tool_calls, { web_search: 3 });
      assert.equal(r.tool_cost_usd, 0.03);
      assert.ok(Math.abs(r.cost_usd - (tokens(mult) + 0.03)) < 1e-5, `${r.cost_usd} vs ${tokens(mult) + 0.03}`);
    }
  });
}

test("AC3: --prices tools.web_search override applies on Vertex and marks user_prices", async (t) => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "cc-vws-p-")), "p.json");
  writeFileSync(p, JSON.stringify({ tools: { web_search: 0.008 } }));
  const { post, receipts } = await proxyFor(t, { userPrices: loadUpstreamPrices(p, []) });
  assert.equal((await post(VPATH("global"))).status, 200);
  await settle();
  assert.equal(receipts[0].tool_cost_usd, 0.024);
  assert.equal(receipts[0].cost_source, "user_prices");
});

test("AC2: preflight adds max_uses x $0.01 on Vertex Claude and refuses over the cap", async (t) => {
  assert.deepEqual(toolWorstCase("vertex", { tools: SEARCH_TOOL }, "claude-sonnet-4-5"), { ok: true, usd: 0.5, calls: 50 });
  assert.deepEqual(toolWorstCase("vertex", { tools: SEARCH_TOOL }, "claude-sonnet-4-5"), toolWorstCase("anthropic", { tools: SEARCH_TOOL }, "claude-sonnet-4-5"));
  assert.deepEqual(toolWorstCase("bedrock", { tools: SEARCH_TOOL }, "claude-sonnet-4-5"), { ok: true, usd: 0, calls: 0 });
  const body = { max_tokens: 10, messages: [], tools: SEARCH_TOOL };
  const est = estimateWorstCase("vertex", JSON.stringify(body), "/v1/x", undefined, "claude-sonnet-4-5");
  assert.equal(est.ok, true);
  assert.equal(est.tool_calls_max, 50);
  assert.equal(est.tool_usd_max, 0.5);
  const { post, up } = await proxyFor(t, { preflight: true, cap: createCapEngine({ caps: { run: 0.3 } }) });
  const refused = await post(VPATH("global"), JSON.stringify(body));
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).error.reason, "preflight_estimate");
  const { tools, ...noTools } = body;
  assert.equal((await post(VPATH("global"), JSON.stringify(noTools))).status, 200);
  assert.equal(up.hits.length, 1);
});
