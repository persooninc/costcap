import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractUsage, isEmbeddingsPath, startMeteringProxy, baseUrlOverrides } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";

// OpenRouter is OpenAI-compatible, so its usage lands in the default branch.
// It is a wired, env-exposed provider; these tests keep its routing and
// metering honest so a provider-table or path-parsing regression goes red.

test("OpenRouter usage parses like OpenAI, including cached tokens and slashed model ids", () => {
  assert.deepEqual(
    extractUsage(
      "openrouter",
      '{"model":"anthropic/claude-3.5-sonnet","usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":10}}}',
    ),
    { model: "anthropic/claude-3.5-sonnet", usage: { input_tokens: 90, output_tokens: 20, cached_input_tokens: 10 } },
  );
});

test("baseUrlOverrides points OPENROUTER_BASE_URL at the proxy's openrouter path", () => {
  const line = baseUrlOverrides(8080, ["openrouter"]).find((l) => l.startsWith("OPENROUTER_BASE_URL="));
  assert.equal(line, "OPENROUTER_BASE_URL=http://127.0.0.1:8080/openrouter");
});

test("a request routed through /openrouter meters an unknown model with no usage.cost at the fallback rate and the cap hard-stops the next call", async (t) => {
  let hits = 0;
  const up = http.createServer((req, res) => {
    hits++;
    assert.equal(req.url, "/api/v1/chat/completions");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "mistralai/mistral-large", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const file = join(mkdtempSync(join(tmpdir(), "cc-or-")), "receipts.jsonl");
  const { server, port } = await startMeteringProxy({
    upstreams: { openrouter: `http://127.0.0.1:${up.address().port}` },
    cap: createCapEngine({ caps: { run: 1 } }),
    receiptsPath: file,
  });
  t.after(() => { server.closeAllConnections(); server.close(); up.closeAllConnections(); up.close(); });

  const call = (n) => fetch(`http://127.0.0.1:${port}/openrouter/api/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "mistralai/mistral-large", n }) });
  // First call: 1M input tokens at the $2.50/1M fallback input rate = $2.50 > $1 cap, so the next call is blocked.
  assert.equal((await call(1)).status, 200);
  assert.equal((await call(2)).status, 429);
  assert.equal(hits, 1, "the blocked call must not reach the upstream");

  const receipts = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].provider, "openrouter");
  assert.equal(receipts[0].path, "/api/v1/chat/completions");
  assert.equal(receipts[0].cost_usd, 2.5);
  assert.equal(receipts[0].fallback, true);
  assert.equal(receipts[0].cost_source, "fallback");
  assert.equal(receipts[1].blocked, true);
  assert.equal(receipts[1].reason, "budget_exceeded");
});

// #148: OpenRouter's provider-reported usage.cost is the exact USD charge for any routed model.

async function orProxy(t, bodies, { cap = 1, stream = false } = {}) {
  let hits = 0;
  const up = http.createServer((req, res) => {
    const body = bodies[Math.min(hits++, bodies.length - 1)];
    if (stream) {
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "hi" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify(body)}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const file = join(mkdtempSync(join(tmpdir(), "cc-or148-")), "receipts.jsonl");
  const { server, port } = await startMeteringProxy({
    upstreams: { openrouter: `http://127.0.0.1:${up.address().port}` },
    cap: createCapEngine({ caps: { run: cap } }),
    receiptsPath: file,
  });
  t.after(() => { server.closeAllConnections(); server.close(); up.closeAllConnections(); up.close(); });
  const call = async (n) => { const r = await fetch(`http://127.0.0.1:${port}/openrouter/api/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: bodies[0].model, n, stream }) }); await r.text(); return r.status; };
  return { call, hits: () => hits, receipts: () => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) };
}

test("#148 extractUsage keeps a valid openrouter usage.cost and drops invalid ones", () => {
  const body = (cost) => JSON.stringify({ model: "x/y", usage: { prompt_tokens: 8, completion_tokens: 2, ...(cost !== undefined && { cost }) } });
  assert.equal(extractUsage("openrouter", body(0.5)).providerCost, 0.5);
  assert.equal(extractUsage("openrouter", body(0)).providerCost, 0);
  for (const bad of [undefined, -1, "0.5", null, true, 1e400]) {
    const r = extractUsage("openrouter", body(bad));
    assert.equal(r.providerCost, undefined, `cost ${bad}`);
    assert.deepEqual(r.usage, { input_tokens: 8, output_tokens: 2, cached_input_tokens: 0 });
  }
  // Never trusted on another route.
  assert.equal(extractUsage("openai", body(0.5)).providerCost, undefined);
  // Cost without token counters is still unknown usage (#138), never priced from cost alone.
  assert.equal(extractUsage("openrouter", JSON.stringify({ model: "x/y", usage: { cost: 0.5 } })), null);
});

test("#148 AC1: provider cost wins over the table rate, even for a table model", async (t) => {
  const f = await orProxy(t, [{ model: "openai/gpt-4o-mini", usage: { prompt_tokens: 1000, completion_tokens: 10, cost: 0.0123 } }], { cap: 100 });
  assert.equal(await f.call(1), 200);
  const [r] = f.receipts();
  assert.equal(r.cost_usd, 0.0123);
  assert.equal(r.cost_source, "provider");
  assert.equal(r.fallback, false);
  assert.equal(r.input_tokens, 1000);
  assert.equal(r.output_tokens, 10);
});

test("#148 AC2: a streamed final chunk's usage.cost is recorded and the next cap check sees it", async (t) => {
  const f = await orProxy(t, [{ model: "acme/premium", choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 1.5 } }], { stream: true });
  assert.equal(await f.call(1), 200);
  assert.equal(await f.call(2), 429);
  assert.equal(f.hits(), 1);
  const [r, blocked] = f.receipts();
  assert.deepEqual([r.cost_usd, r.cost_source, r.fallback], [1.5, "provider", false]);
  assert.equal(blocked.reason, "budget_exceeded");
});

test("#148 AC3: invalid cost falls back to table/fallback pricing, never $0", async (t) => {
  for (const cost of [-1, "1.5", null, "NaN"]) {
    const f = await orProxy(t, [{ model: "mistralai/mistral-large", usage: { prompt_tokens: 1_000_000, completion_tokens: 0, cost } }], { cap: 100 });
    assert.equal(await f.call(1), 200);
    const [r] = f.receipts();
    assert.deepEqual([r.cost_usd, r.cost_source, r.fallback], [2.5, "fallback", true], `cost ${cost}`);
  }
});

test("#148 AC5: an unknown premium model's provider cost trips the cap that fallback pricing missed", async (t) => {
  const usage = { prompt_tokens: 1000, completion_tokens: 1000 };
  const withCost = await orProxy(t, [{ model: "acme/premium", usage: { ...usage, cost: 1.5 } }]);
  assert.equal(await withCost.call(1), 200);
  assert.equal(await withCost.call(2), 429);
  assert.equal(withCost.receipts()[0].cost_usd, 1.5);
  // Old behaviour: the same call at the flat fallback rate is far under $1 and passes.
  const noCost = await orProxy(t, [{ model: "acme/premium", usage }]);
  assert.equal(await noCost.call(1), 200);
  assert.equal(await noCost.call(2), 200);
  const old = noCost.receipts();
  assert.ok(old[0].cost_usd < 0.1);
  assert.equal(old[0].cost_source, "fallback");
});

test("#148 run summary reports each model's cost_source", async () => {
  const { buildRunSummary: summarizeRun } = await import("../src/run-summary.js");
  const s = summarizeRun({ receipts: [
    { model: "a/x", cost_usd: 1, cost_source: "provider" },
    { model: "b/y", cost_usd: 1, cost_source: "fallback" },
    { model: "b/y", cost_usd: 1, cost_source: "provider" },
  ] });
  assert.equal(s.by_model["a/x"].cost_source, "provider");
  assert.equal(s.by_model["b/y"].cost_source, "mixed");
});

test("#202 AC1-AC5 OpenRouter embeddings extractUsage and isEmbeddingsPath", () => {
  const e = { embeddings: true };
  assert.deepEqual(extractUsage("openrouter", '{"model":"openai/text-embedding-3-small","usage":{"prompt_tokens":8,"total_tokens":8,"cost":0.0001}}', "x", e),
    { model: "openai/text-embedding-3-small", usage: { input_tokens: 8, output_tokens: 0, cached_input_tokens: 0 }, providerCost: 0.0001 });
  assert.deepEqual(extractUsage("openrouter", '{"model":"qwen/qwen3-embedding-8b","usage":{"prompt_tokens":8,"total_tokens":8}}', "x", e),
    { model: "qwen/qwen3-embedding-8b", usage: { input_tokens: 8, output_tokens: 0, cached_input_tokens: 0 } });
  for (const bad of ['{"usage":{"total_tokens":8,"cost":0.1}}', '{"usage":{"prompt_tokens":"8"}}', '{"usage":{"prompt_tokens":8,"completion_tokens":1}}', '{"model":"m"}'])
    assert.equal(extractUsage("openrouter", bad, "x", e), null, bad);
  // #138 unchanged: prompt-only usage off the embeddings path is unknown.
  assert.equal(extractUsage("openrouter", '{"usage":{"prompt_tokens":8,"total_tokens":8,"cost":0.1}}', "x"), null);
  // usage.cost on OpenAI embeddings is ignored.
  assert.equal(extractUsage("openai", '{"usage":{"prompt_tokens":8,"cost":0.1}}', "x", e).providerCost, undefined);
  assert.equal(isEmbeddingsPath("/openrouter/v1/embeddings"), true);
  assert.equal(isEmbeddingsPath("/openrouter/v1/embeddings?a=1"), true);
  for (const bad of ["/openrouter/v1/embeddings/x", "/openrouter/v1/embeddings/", "/openrouter/v1/%65mbeddings", "/openrouter%2Fv1/embeddings",
    "/openrouter/v1/x/../embeddings", "/openrouter//v1/embeddings", "/openrouter/v1/chat/completions"]) assert.equal(isEmbeddingsPath(bad), false, bad);
});
