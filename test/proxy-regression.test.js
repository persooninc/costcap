import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractUsage, isCountTokensPath, isEmbeddingsPath, isProviderError, startMeteringProxy } from "../src/proxy.js";
import { costForUsage } from "../src/pricing.js";
import { createCapEngine } from "../src/cap.js";

async function fixture(t, handler, options = {}) {
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, ...options });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  return (n = 0) => fetch(`http://127.0.0.1:${p.port}/openai/v1/chat/completions?trace=yes`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", n }) });
}

test("Gemini counts cached, generated and reasoning tokens", () => {
  assert.deepEqual(extractUsage("gemini", JSON.stringify({ modelVersion: "gemini-test", usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 30, thoughtsTokenCount: 10 } })), { model: "gemini-test", usage: { input_tokens: 80, cached_input_tokens: 20, output_tokens: 40 } });
});

test("Anthropic stream combines start input and delta output", () => {
  const text = ['data: {"message":{"model":"claude-test","usage":{"input_tokens":100,"output_tokens":0,"cache_read_input_tokens":20,"cache_creation_input_tokens":10}}}', 'data: {"usage":{"output_tokens":50}}'].join("\n");
  assert.deepEqual(extractUsage("anthropic", text), { model: "claude-test", usage: { input_tokens: 100, cache_write_input_tokens: 10, cache_write_1h_input_tokens: 0, cached_input_tokens: 20, output_tokens: 50 } });
});

test("Responses API usage is parsed and missing usage is not free", () => {
  assert.deepEqual(extractUsage("openai", '{"usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":10}}}', "model"), { model: "model", usage: { input_tokens: 90, output_tokens: 20, cached_input_tokens: 10 } });
  assert.equal(extractUsage("openai", '{}'), null);
  assert.equal(extractUsage("openai", '{"usage":{"prompt_tokens":-1}}'), null);
});

test("concurrent calls see previous cost, query survives, blocked receipt persists", async (t) => {
  let hits = 0;
  const file = join(mkdtempSync(join(tmpdir(), "cc-reg-")), "nested", "receipts.jsonl");
  const call = await fixture(t, (req, res) => {
    hits++; assert.match(req.url, /\?trace=yes$/);
    setTimeout(() => res.end('{"model":"gpt-4o-mini","usage":{"prompt_tokens":1000000,"completion_tokens":0}}'), 25);
  }, { cap: createCapEngine({ caps: { run: 0.10 } }), receiptsPath: file });
  const results = await Promise.all([call(1), call(2), call(3)]);
  assert.deepEqual(results.map((r) => r.status), [200, 429, 429]);
  assert.equal(hits, 1);
  const receipts = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(receipts.length, 3);
  assert.equal(receipts[1].reason, "budget_exceeded");
  assert.equal(new Set(receipts.map((r) => r.id)).size, 3);
});

test("unknown usage latches accounting failure before a second upstream call", async (t) => {
  let hits = 0;
  const call = await fixture(t, (req, res) => { hits++; res.end('{}'); });
  assert.equal((await call(1)).status, 200);
  const blocked = await call(2);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, "accounting_unavailable");
  assert.equal(hits, 1);
});

test("timeout latches uncertain outcome, not zero spend", async (t) => {
  let hits = 0;
  // The upstream never answers. 500ms leaves a slow runner time to deliver the request first.
  const call = await fixture(t, () => { hits++; }, { timeoutMs: 500 });
  assert.equal((await call(1)).status, 502);
  assert.equal((await call(2)).status, 429);
  assert.equal(hits, 1);
});

test("oversized body is refused without provider call", async (t) => {
  let hits = 0;
  const call = await fixture(t, () => { hits++; }, { maxBodyBytes: 1 });
  assert.equal((await call()).status, 413);
  assert.equal(hits, 0);
});

// #135: provider 4xx rejections and metadata GETs are not billed and must not freeze the run.
async function scripted(t, provider, statuses) {
  let hits = 0;
  const up = http.createServer((req, res) => {
    const status = statuses[Math.min(hits++, statuses.length - 1)];
    const body = status === 200
      ? (provider === "gemini" ? { modelVersion: "gemini-2.0-flash", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }
        : provider === "anthropic" ? { model: "claude-3-5-haiku-20241022", usage: { input_tokens: 10, output_tokens: 5 } }
          : { model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 } })
      : status === "ok-nousage" ? {} : { error: { code: status, message: "rejected", type: "rate_limit_error" } };
    res.writeHead(status === "ok-nousage" ? 200 : status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { [provider]: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const paths = { openai: "/openai/v1/chat/completions", anthropic: "/anthropic/v1/messages", gemini: "/gemini/v1beta/models/gemini-2.0-flash:generateContent" };
  const call = (i = 0, method = "POST", path = paths[provider]) => fetch(`http://127.0.0.1:${p.port}${path}`,
    { method, body: method === "GET" ? undefined : JSON.stringify({ model: provider === "gemini" ? undefined : "m", i }) });
  return { call, receipts, hits: () => hits };
}

for (const provider of ["openai", "anthropic", "gemini"]) {
  for (const status of [429, 400, 401]) {
    test(`#135 ${provider} ${status} with error body is zero-cost upstream_rejected and does not pause`, async (t) => {
      const f = await scripted(t, provider, [status, 200]);
      const r1 = await f.call(1);
      assert.equal(r1.status, status);
      assert.equal((await r1.json()).error.message, "rejected");
      assert.deepEqual([f.receipts[0].cost_usd, f.receipts[0].reason, f.receipts[0].status], [0, "upstream_rejected", status]);
      const r2 = await f.call(2);
      assert.equal(r2.status, 200);
      assert.equal(f.hits(), 2);
      assert.ok(f.receipts[1].cost_usd > 0);
    });
  }
  for (const status of [500, 502, 503]) {
    test(`#135 regression: ${provider} ${status} without usage stays unknown and pauses`, async (t) => {
      const f = await scripted(t, provider, [status, 200]);
      assert.equal((await f.call(1)).status, status);
      assert.deepEqual([f.receipts[0].cost_usd, f.receipts[0].reason], [null, "usage_unavailable"]);
      const r2 = await f.call(2);
      assert.equal(r2.status, 429);
      assert.equal((await r2.json()).error, "accounting_unavailable");
      assert.equal(f.hits(), 1);
    });
  }
  test(`#135 regression: ${provider} 200 POST without usage still pauses`, async (t) => {
    const f = await scripted(t, provider, ["ok-nousage", 200]);
    assert.equal((await f.call(1)).status, 200);
    assert.equal(f.receipts[0].reason, "usage_unavailable");
    assert.equal((await f.call(2)).status, 429);
    assert.equal(f.hits(), 1);
  });
}

test("#135 GET /openai/v1/models is non_billable_request and does not pause", async (t) => {
  const f = await scripted(t, "openai", ["ok-nousage", 200]);
  const r = await f.call(0, "GET", "/openai/v1/models");
  assert.equal(r.status, 200);
  assert.deepEqual([f.receipts[0].cost_usd, f.receipts[0].reason], [0, "non_billable_request"]);
  assert.equal((await f.call(1)).status, 200);
  assert.equal(f.hits(), 2);
});

test("#135 a 4xx without a provider error body stays unknown and pauses", async (t) => {
  let hits = 0;
  const up = http.createServer((q, res) => { hits++; res.writeHead(429, { "content-type": "text/html" }).end("<html>slow down</html>"); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const u = `http://127.0.0.1:${p.port}/openai/v1/chat/completions`;
  await fetch(u, { method: "POST", body: "{}" });
  assert.equal(receipts[0].reason, "usage_unavailable");
  assert.equal((await (await fetch(u, { method: "POST", body: "{}" })).json()).error, "accounting_unavailable");
  assert.equal(hits, 1);
});

test("#135 isProviderError recognises error objects, Gemini arrays, and rejects usage/non-JSON", () => {
  assert.equal(isProviderError(Buffer.from('{"error":{"message":"x"}}')), true);
  assert.equal(isProviderError(Buffer.from('[{"error":{"code":429}}]')), true);
  assert.equal(isProviderError(Buffer.from('{"error":{"m":1},"usage":{"prompt_tokens":1}}')), false);
  assert.equal(isProviderError(Buffer.from('{"error":"str"}')), false);
  assert.equal(isProviderError(Buffer.from('null')), false);
  assert.equal(isProviderError(Buffer.from('nope')), false);
});

test("#135 repeated identical requests that keep getting 429 still trip the spiral breaker", async (t) => {
  const { createSpiralDetector } = await import("../src/spiral.js");
  let hits = 0;
  const up = http.createServer((q, res) => { hits++; res.writeHead(429, { "content-type": "application/json" }).end('{"error":{"type":"rate_limit_error"}}'); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, spiral: createSpiralDetector({ threshold: 2 }), onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`http://127.0.0.1:${p.port}/openai/v1/chat/completions`, { method: "POST", body: '{"model":"gpt-4o-mini"}' });
    statuses.push(r.status); if (i === 2) assert.equal((await r.json()).error, "spiral_detected"); else await r.arrayBuffer();
  }
  assert.deepEqual(statuses, [429, 429, 429]);
  assert.equal(hits, 2);
  assert.equal(receipts.at(-1).reason, "spiral_detected");
});

test("#138 usage without both priceable counters is unknown, never a zero-filled $0", () => {
  assert.equal(extractUsage("openai", '{"usage":{}}'), null);
  assert.equal(extractUsage("openai", '{"usage":{"type":"duration","seconds":42}}'), null);
  assert.equal(extractUsage("openai", '{"usage":{"prompt_tokens":10}}'), null);
  assert.equal(extractUsage("openai", '{"usage":{"completion_tokens":10}}'), null);
  assert.equal(extractUsage("openai", '{"usage":{"prompt_tokens":"10","completion_tokens":1}}'), null);
  assert.equal(extractUsage("openrouter", '{"usage":{"seconds":3}}'), null);
  assert.equal(extractUsage("gemini", '{"usageMetadata":{}}'), null);
  assert.equal(extractUsage("gemini", '{"usageMetadata":{"promptTokenCount":10}}'), null);
  assert.equal(extractUsage("gemini", '{"usageMetadata":{"candidatesTokenCount":10,"thoughtsTokenCount":3}}'), null);
  assert.equal(extractUsage("anthropic", '{"usage":{}}'), null);
  assert.deepEqual(extractUsage("openai", '{"usage":{"prompt_tokens":0,"completion_tokens":0}}', "m"), { model: "m", usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } });
  assert.deepEqual(extractUsage("gemini", '{"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0}}', "g"), { model: "g", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } });
});

test("#138/#198 a 200 with duration-style usage now meters per minute; the run continues", async (t) => {
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; req.resume(); res.writeHead(200, { "content-type": "application/json" }).end('{"model":"whisper-1","usage":{"seconds":3}}'); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = () => fetch(`http://127.0.0.1:${p.port}/openai/v1/audio/transcriptions`, { method: "POST", body: '{"model":"whisper-1"}' });
  assert.equal((await call()).status, 200);
  assert.deepEqual([receipts[0].cost_usd, receipts[0].cost_basis, receipts[0].billed_seconds, receipts[0].reason], [0.0003, "duration", 3, undefined]);
  assert.equal((await call()).status, 200);
  assert.equal(hits, 2);
});

test("#138 a 200 with no usable usage (text-format transcription) records usage_unavailable and pauses", async (t) => {
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; req.resume(); res.writeHead(200, { "content-type": "text/plain" }).end("hello world"); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = () => fetch(`http://127.0.0.1:${p.port}/openai/v1/audio/transcriptions`, { method: "POST", body: '{"model":"whisper-1"}' });
  assert.equal((await call()).status, 200);
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "usage_unavailable"]);
  const r2 = await call();
  assert.equal(r2.status, 429);
  assert.equal((await r2.json()).error, "accounting_unavailable");
  assert.equal(hits, 1);
});

test("#138 explicit zero counters through the proxy stay a known $0 and do not pause", async (t) => {
  const up = http.createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "application/json" }).end('{"model":"gpt-4o-mini","usage":{"prompt_tokens":0,"completion_tokens":0}}'); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = () => fetch(`http://127.0.0.1:${p.port}/openai/v1/chat/completions`, { method: "POST", body: '{"model":"gpt-4o-mini"}' });
  assert.equal((await call()).status, 200);
  assert.equal(receipts[0].cost_usd, 0);
  assert.equal(receipts[0].reason, undefined);
  assert.equal((await call()).status, 200);
});

for (const [provider, path, keyHeader] of [["anthropic", "/anthropic/v1/messages", "x-api-key"], ["gemini", "/gemini/v1beta/models/gemini-2.0-flash:generateContent", "x-goog-api-key"], ["openai", "/openai/v1/chat/completions", "authorization"]]) {
  test(`#138 ${provider} upstream redirect is not followed and the key never reaches another host`, async (t) => {
    const seen = [];
    const second = http.createServer((req, res) => { seen.push(req.headers); req.resume(); res.end('{"usage":{"prompt_tokens":1,"completion_tokens":1}}'); });
    await new Promise((r) => second.listen(0, "127.0.0.1", r));
    const first = http.createServer((req, res) => { req.resume(); res.writeHead(302, { location: `http://localhost:${second.address().port}/steal` }).end(); });
    await new Promise((r) => first.listen(0, "127.0.0.1", r));
    const receipts = [];
    const p = await startMeteringProxy({ upstreams: { [provider]: `http://127.0.0.1:${first.address().port}` }, onReceipt: (r) => receipts.push(r) });
    t.after(() => { p.server.closeAllConnections(); p.server.close(); for (const s of [first, second]) { s.closeAllConnections(); s.close(); } });
    const r = await fetch(`http://127.0.0.1:${p.port}${path}`, { method: "POST", headers: { [keyHeader]: "test-key-not-real" }, body: '{"model":"m"}' });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, "upstream_redirect");
    assert.equal(seen.length, 0);
    assert.deepEqual([receipts[0].reason, receipts[0].cost_usd, receipts[0].status], ["upstream_redirect", 0, 302]);
  });
}

test("#138 anthropic usage needs both input and output counters", () => {
  assert.equal(extractUsage("anthropic", '{"usage":{"output_tokens":5}}'), null);
  assert.equal(extractUsage("anthropic", '{"usage":{"input_tokens":5}}'), null);
  assert.equal(extractUsage("anthropic", '[{"type":"message_delta","usage":{"output_tokens":7}}]'), null);
  const known = extractUsage("anthropic", '{"model":"claude-x","usage":{"input_tokens":0,"output_tokens":0}}');
  assert.deepEqual(known.usage, { input_tokens: 0, output_tokens: 0 });
});

// #142: provider tool billing is never silently free; count-tokens calls don't pause.
test("#142 Gemini toolUsePromptTokenCount is billed as input", () => {
  const m = extractUsage("gemini", JSON.stringify({ modelVersion: "gemini-2.5-flash", usageMetadata: { promptTokenCount: 100, toolUsePromptTokenCount: 50, candidatesTokenCount: 10 } }));
  assert.equal(m.usage.input_tokens, 150);
  const cached = extractUsage("gemini", JSON.stringify({ usageMetadata: { promptTokenCount: 100, toolUsePromptTokenCount: 50, cachedContentTokenCount: 20, candidatesTokenCount: 10 } }));
  assert.equal(cached.usage.input_tokens, 130);
  assert.ok(costForUsage("gemini-2.5-flash", m.usage).cost_usd > costForUsage("gemini-2.5-flash", { input_tokens: 100, output_tokens: 10 }).cost_usd);
});

test("#142 tool-use detection: Anthropic server_tool_use and Responses search items", () => {
  assert.equal(extractUsage("anthropic", JSON.stringify({ model: "m", usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 2 } } })).toolUseUnpriced, true);
  assert.equal(extractUsage("anthropic", JSON.stringify({ model: "m", usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 0 } } })).toolUseUnpriced, undefined);
  for (const type of ["web_search_call", "file_search_call"])
    assert.equal(extractUsage("openai", JSON.stringify({ model: "m", output: [{ type }, { type: "message" }], usage: { input_tokens: 1, output_tokens: 1 } })).toolUseUnpriced, true);
  assert.equal(extractUsage("openai", JSON.stringify({ model: "m", output: [{ type: "message" }], usage: { input_tokens: 1, output_tokens: 1 } })).toolUseUnpriced, undefined);
});

test("#142 isCountTokensPath allows only exact, normalized paths", () => {
  for (const ok of ["/anthropic/v1/messages/count_tokens", "/openai/v1/responses/input_tokens", "/gemini/v1beta/models/gemini-2.5-flash:countTokens?key=k"]) assert.equal(isCountTokensPath(ok), true, ok);
  for (const bad of ["/anthropic/v1/messages/count_tokens/../messages", "/anthropic/v1/messages/count_tokens/%2e%2e/messages", "/anthropic/v1/messages/count%5Ftokens",
    "/anthropic/v1/messages", "/anthropic//v1/messages/count_tokens", "/openai/v1/responses", "/gemini/v1beta/models/x:generateContent", undefined]) assert.equal(isCountTokensPath(bad), false, String(bad));
});

async function multi(t, handler) {
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: base, anthropic: base, gemini: base }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const post = (path, body = { model: "x" }) => fetch(`http://127.0.0.1:${p.port}${path}`, { method: "POST", body: JSON.stringify(body) });
  return { post, receipts };
}

test("#142 Anthropic web search and Responses web_search_call → tool_use_unpriced and the next call is paused", async (t) => {
  for (const [path, body] of [
    ["/anthropic/v1/messages", { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 2 } } }],
    ["/openai/v1/responses", { model: "gpt-4o-mini", output: [{ type: "web_search_call", status: "completed" }], usage: { input_tokens: 10, output_tokens: 5 } }],
  ]) {
    let hits = 0;
    const { post, receipts } = await multi(t, (req, res) => { hits++; req.resume(); res.end(JSON.stringify(body)); });
    assert.equal((await post(path)).status, 200);
    assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "tool_use_unpriced"]);
    const next = await post(path);
    assert.equal(next.status, 429);
    assert.equal((await next.json()).error, "accounting_unavailable");
    assert.equal(hits, 1);
  }
});

test("#142 count-tokens 2xx is non_billable and the next call reaches upstream; traversal is not exempt", async (t) => {
  for (const path of ["/anthropic/v1/messages/count_tokens", "/gemini/v1beta/models/gemini-2.5-flash:countTokens", "/openai/v1/responses/input_tokens"]) {
    let hits = 0;
    const { post, receipts } = await multi(t, (req, res) => { hits++; req.resume(); res.end(hits === 1 ? '{"input_tokens":12,"totalTokens":12}' : '{"model":"gpt-4o-mini","usage":{"prompt_tokens":1,"completion_tokens":1}}'); });
    assert.equal((await post(path)).status, 200);
    assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [0, "non_billable_request"], path);
    assert.equal((await post("/openai/v1/chat/completions")).status, 200);
    assert.equal(hits, 2);
  }
  for (const path of ["/anthropic/v1/messages/count_tokens/../messages", "/anthropic/v1/messages/count_tokens/%2e%2e/messages"]) {
    const { post, receipts } = await multi(t, (req, res) => { req.resume(); res.end('{"input_tokens":12}'); });
    assert.equal((await post(path)).status, 200);
    assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "usage_unavailable"], path);
    assert.equal((await post(path)).status, 429);
  }
  // A non-2xx count-tokens reply without a provider error body is still unknown.
  const { post, receipts } = await multi(t, (req, res) => { req.resume(); res.writeHead(500).end("oops"); });
  await post("/anthropic/v1/messages/count_tokens");
  assert.equal(receipts[0].reason, "usage_unavailable");
});

test("#145 embeddings usage is input-only on the exact embeddings path only", () => {
  const e = { embeddings: true };
  assert.deepEqual(extractUsage("openai", '{"model":"text-embedding-3-small","usage":{"prompt_tokens":8,"total_tokens":8}}', "x", e),
    { model: "text-embedding-3-small", usage: { input_tokens: 8, output_tokens: 0, cached_input_tokens: 0 } });
  assert.equal(extractUsage("openai", '{"model":"text-embedding-3-small"}', "x", e), null);
  assert.equal(extractUsage("openai", '{"usage":{}}', "x", e), null);
  assert.equal(extractUsage("openai", '{"usage":{"prompt_tokens":-1}}', "x", e), null);
  assert.equal(extractUsage("openai", '{"usage":{"prompt_tokens":"8"}}', "x", e), null);
  assert.equal(extractUsage("openai", '{"usage":{"prompt_tokens":8,"completion_tokens":2}}', "x", e), null);
  assert.equal(extractUsage("openai", '{"usage":{"prompt_tokens":8,"total_tokens":8}}'), null);
  assert.equal(extractUsage("openrouter", '{"usage":{"prompt_tokens":8}}', "x", e), null);
  assert.equal(isEmbeddingsPath("/openai/v1/embeddings"), true);
  assert.equal(isEmbeddingsPath("/openai/v1/embeddings?x=1"), true);
  for (const bad of ["/openai/v1/chat/completions", "/openai/v1/responses", "/openai/v1/x/../embeddings", "/openai/v1/%65mbeddings",
    "/openai//v1/embeddings", "/openai/v1/embeddings/", "/openrouter/v1/embeddings", "/gemini/v1/embeddings", null]) assert.equal(isEmbeddingsPath(bad), false, bad);
});

async function embedProxy(t, responder, options = {}) {
  const up = http.createServer((req, res) => { req.resume(); const [status, body] = responder(req); res.writeHead(status, { "content-type": "application/json" }).end(body); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r), ...options });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = (path = "/openai/v1/embeddings", model = "text-embedding-3-small") => fetch(`http://127.0.0.1:${p.port}${path}`, { method: "POST", body: JSON.stringify({ model, input: "hello" }) });
  return { call, receipts };
}

test("#145 an embeddings 2xx is priced input-only and the next call is not paused", async (t) => {
  const { call, receipts } = await embedProxy(t, () => [200, '{"model":"text-embedding-3-small","usage":{"prompt_tokens":1000,"total_tokens":1000}}']);
  assert.equal((await call()).status, 200);
  assert.equal(receipts[0].cost_usd, Number((1000 * 0.02 / 1e6).toFixed(6)));
  assert.deepEqual([receipts[0].output_tokens, receipts[0].fallback, receipts[0].reason], [0, false, undefined]);
  assert.match(receipts[0].table_sha256, /^[0-9a-f]{64}$/);
  assert.equal((await call()).status, 200);
});

test("#145 unknown embeddings model is priced at the fallback input rate, never $0", async (t) => {
  const { call, receipts } = await embedProxy(t, () => [200, '{"model":"text-embedding-foo","usage":{"prompt_tokens":1000000,"total_tokens":1000000}}']);
  assert.equal((await call("/openai/v1/embeddings", "text-embedding-foo")).status, 200);
  assert.deepEqual([receipts[0].cost_usd, receipts[0].fallback], [2.5, true]);
});

test("#145 prompt-only usage on chat/responses and usage-less embeddings still pause", async (t) => {
  for (const [path, body] of [["/openai/v1/chat/completions", '{"usage":{"prompt_tokens":8,"total_tokens":8}}'], ["/openai/v1/responses", '{"usage":{"prompt_tokens":8,"total_tokens":8}}'],
    ["/openai/v1/embeddings", '{"model":"text-embedding-3-small"}'], ["/openai/v1/embeddings", '{"usage":{"prompt_tokens":-3}}']]) {
    const { call, receipts } = await embedProxy(t, () => [200, body]);
    assert.equal((await call(path)).status, 200);
    assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "usage_unavailable"], path);
    assert.equal((await (await call(path)).json()).error, "accounting_unavailable", path);
  }
});

test("#145 embeddings spend counts toward the cap", async (t) => {
  const { call, receipts } = await embedProxy(t, () => [200, '{"model":"text-embedding-3-large","usage":{"prompt_tokens":1000000,"total_tokens":1000000}}'],
    { cap: createCapEngine({ caps: { run: 0.2 } }) });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal(receipts.filter((x) => x.cost_usd === 0.13).length, 2);
});

test("#148 AC4: a usage.cost on /openai is ignored; table pricing applies", async (t) => {
  const file = join(mkdtempSync(join(tmpdir(), "cc-148-")), "r.jsonl");
  const call = await fixture(t, (q, res) => res.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1_000_000, completion_tokens: 0, cost: 99 } })), { receiptsPath: file });
  assert.equal((await call(1)).status, 200);
  const [r] = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(r.cost_usd, costForUsage("gpt-4o-mini", { input_tokens: 1_000_000 }).cost_usd);
  assert.equal(r.cost_source, "table");
  for (const p of ["anthropic", "gemini"]) {
    assert.equal(extractUsage(p, JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1, cost: 9 }, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, cost: 9 } })).providerCost, undefined);
  }
});

test("#155 standard receipts unchanged: no speed/service_tier keys, pricing_tier standard", async (t) => {
  const receipts = [];
  const call = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1000, completion_tokens: 100 } }))); }, { onReceipt: (r) => receipts.push(r) });
  assert.equal((await call()).status, 200);
  await new Promise((r) => setImmediate(r));
  const r = receipts[0];
  assert.equal(r.pricing_tier, "standard");
  assert.equal(r.cost_usd, Number(((1000 * 0.15 + 100 * 0.6) / 1e6).toFixed(6)));
  assert.ok(!("speed" in r) && !("service_tier" in r) && !("reason" in r));
  assert.deepEqual(costForUsage("gpt-4o-mini", { input_tokens: 1000, output_tokens: 100 }), { ...costForUsage("gpt-4o-mini", { input_tokens: 1000, output_tokens: 100, speed: undefined }) });
});

// #160 e2e: `costcap wrap` against local mock OpenAI and Anthropic upstreams serving JSONL fixtures.
import { spawn as spawnBatch, spawnSync as spawnSyncBatch } from "node:child_process";
import { ANTHROPIC_EXPECTED, OPENAI_EXPECTED, mockUpstream } from "./support/batch.js";

async function wrapBatch(t, script, args = []) {
  const up = http.createServer(mockUpstream());
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => { up.closeAllConnections(); up.close(); });
  const dir = mkdtempSync(join(tmpdir(), "cc-batch-e2e-"));
  const receipts = join(dir, "receipts.jsonl");
  const base = `http://127.0.0.1:${up.address().port}`;
  const res = await new Promise((resolve) => {
    const c = spawnBatch(process.execPath, ["src/cli.js", "wrap", "--receipts", receipts, ...args, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: base, COSTCAP_TEST_ANTHROPIC_UPSTREAM: base } });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => resolve({ code, out, err }));
  });
  const lines = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cli = (...a) => spawnSyncBatch(process.execPath, ["src/cli.js", ...a, "--receipts", receipts], { encoding: "utf8" });
  return { ...res, lines, cli };
}

test("#160 e2e Anthropic batch: wrap is not frozen after create; results settle once at 0.5x; check passes under a cap the full rate would exceed", async (t) => {
  const script = `const A = process.env.ANTHROPIC_BASE_URL;
    const p = { model: "claude-sonnet-4-6", max_tokens: 10, messages: [] };
    const out = [];
    out.push((await fetch(A + "/v1/messages/batches", { method: "POST", body: JSON.stringify({ requests: [1, 2, 3].map((i) => ({ custom_id: "c" + i, params: p })) }) })).status);
    out.push((await fetch(A + "/v1/messages", { method: "POST", body: JSON.stringify(p) })).status);
    if (process.env.FETCH !== "0") for (let i = 0; i < 2; i++) out.push((await fetch(A + "/v1/messages/batches/msgbatch_01/results")).status);
    console.log(out.join(","));`;
  const r = await wrapBatch(t, script);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "200,200,200,200");
  const pend = r.lines.find((l) => l.reason === "batch_pending");
  assert.deepEqual([pend.cost_usd, pend.batch_id, pend.request_count], [null, "msgbatch_01", 3]);
  assert.equal(r.lines.some((l) => l.reason === "accounting_unavailable"), false);
  const settles = r.lines.filter((l) => l.event === "reconciliation");
  assert.deepEqual(settles.map((e) => [e.receipt_id, e.cost_usd, e.source]), [[pend.id, ANTHROPIC_EXPECTED, "batch_results"]]);
  const runs = JSON.parse(r.cli("runs", "--json").stdout);
  assert.notEqual(runs[0].total_cost_usd, null);
  const sync = r.lines.find((l) => l.path === "/v1/messages").cost_usd;
  const cap = String(Number((ANTHROPIC_EXPECTED * 1.5 + sync).toFixed(6)));
  assert.equal(r.cli("check", "--cap", cap).status, 0);
  assert.notEqual(r.cli("check", "--cap", String(Number((ANTHROPIC_EXPECTED + sync).toFixed(6)))).status, 0);
});

test("#160 e2e: a batch whose results are never fetched leaves the run unknown and check incomplete", async (t) => {
  const script = `const A = process.env.ANTHROPIC_BASE_URL;
    await fetch(A + "/v1/messages/batches", { method: "POST", body: JSON.stringify({ requests: [{ custom_id: "a", params: { model: "claude-sonnet-4-6" } }] }) });
    console.log((await fetch(A + "/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) })).status);`;
  const r = await wrapBatch(t, script);
  assert.equal(r.out.trim(), "200");
  assert.equal(JSON.parse(r.cli("runs", "--json").stdout)[0].total_cost_usd, null);
  assert.notEqual(r.cli("check").status, 0);
  assert.equal(r.lines.some((l) => l.event), false);
});

test("#160 e2e OpenAI batch: create, retrieve, file content settle at 0.5x; unrelated file content stays $0", async (t) => {
  const script = `const O = process.env.OPENAI_BASE_URL;
    const out = [];
    out.push((await fetch(O + "/batches", { method: "POST", body: JSON.stringify({ input_file_id: "file-in", endpoint: "/v1/chat/completions", completion_window: "24h" }) })).status);
    out.push((await fetch(O + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini" }) })).status);
    out.push((await fetch(O + "/files/file-unrelated/content")).status);
    out.push((await fetch(O + "/batches/batch_01")).status);
    out.push((await fetch(O + "/files/file-out/content")).status);
    console.log(out.join(","));`;
  const r = await wrapBatch(t, script);
  assert.equal(r.out.trim(), "200,200,200,200,200", r.err);
  const pend = r.lines.find((l) => l.reason === "batch_pending");
  assert.deepEqual(r.lines.filter((l) => l.event === "reconciliation").map((e) => [e.receipt_id, e.cost_usd]), [[pend.id, OPENAI_EXPECTED]]);
  const unrelated = r.lines.find((l) => l.path === "/v1/files/file-unrelated/content");
  assert.deepEqual([unrelated.cost_usd, unrelated.reason], [0, "non_billable_request"]);
  assert.equal(r.cli("check").status, 0);
});

// #163: modality pricing through the proxy, JSON and SSE, plus the unpriced 429.
async function modalProxy(t, provider, handler) {
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; handler(req, res); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = join(mkdtempSync(join(tmpdir(), "cc-163-")), "r.jsonl");
  const p = await startMeteringProxy({ upstreams: { [provider]: `http://127.0.0.1:${up.address().port}` }, receiptsPath: receipts });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  return { base: `http://127.0.0.1:${p.port}/${provider}`, receipts, hits: () => hits };
}
const readReceipts = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.event);
const AUDIO_META = { promptTokenCount: 101000, candidatesTokenCount: 500, promptTokensDetails: [{ modality: "TEXT", tokenCount: 1000 }, { modality: "AUDIO", tokenCount: 100000 }] };
const AC1 = Number(((1000 * 0.30 + 100000 * 1.00 + 500 * 2.50) / 1e6).toFixed(6));

for (const sse of [false, true]) {
  test(`#163 AC1/AC5: gemini audio priced at the audio rate (${sse ? "SSE" : "JSON"})`, async (t) => {
    const body = { modelVersion: "gemini-2.5-flash", usageMetadata: AUDIO_META };
    const f = await modalProxy(t, "gemini", (req, res) => res.end(sse ? `data: ${JSON.stringify(body)}\n\n` : JSON.stringify(body)));
    const verb = sse ? "streamGenerateContent?alt=sse" : "generateContent";
    const r = await fetch(`${f.base}/v1beta/models/gemini-2.5-flash:${verb}`, { method: "POST", body: "{}" });
    await r.text();
    const [rec] = readReceipts(f.receipts);
    assert.equal(rec.cost_usd, AC1);
    assert.equal(rec.modality_tokens.input.audio, 100000);
  });

  test(`#163 AC3/AC5: unpriced audio on a fallback model blocks the next call with 429 (${sse ? "SSE" : "JSON"})`, async (t) => {
    const body = { model: "mystery-audio-1", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { audio_tokens: 40 } } };
    const f = await modalProxy(t, "openai", (req, res) => res.end(sse ? `data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n` : JSON.stringify(body)));
    const send = () => fetch(`${f.base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "mystery-audio-1", stream: sse, stream_options: { include_usage: true } }) });
    await (await send()).text();
    const second = await send();
    assert.equal(second.status, 429);
    assert.match(await second.text(), /accounting_unavailable/);
    assert.equal(f.hits(), 1);
    const [rec] = readReceipts(f.receipts);
    assert.equal(rec.cost_usd, null);
    assert.equal(rec.reason, "modality_unpriced");
  });
}

test("#163 AC2: gpt-image-1 images/generations priced from the table", async (t) => {
  const f = await modalProxy(t, "openai", (req, res) => res.end(JSON.stringify({ created: 1, data: [{ b64_json: "x" }], usage: { input_tokens: 50, output_tokens: 4160, total_tokens: 4210, input_tokens_details: { text_tokens: 50, image_tokens: 0 } } })));
  await (await fetch(`${f.base}/v1/images/generations`, { method: "POST", body: JSON.stringify({ model: "gpt-image-1", prompt: "cat" }) })).text();
  const [rec] = readReceipts(f.receipts);
  assert.equal(rec.cost_usd, Number(((50 * 5 + 4160 * 40) / 1e6).toFixed(6)));
  assert.equal(rec.cost_source, "table");
});

test("#184 without a cache every receipt keeps its exact pre-cache shape and no cache header is sent", async (t) => {
  const up = await new Promise((r) => { const s = http.createServer((q, res) => { q.resume(); q.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 } }))); }); s.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => up.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r), spiral: null });
  t.after(() => server.close());
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0 }) });
    await res.text();
    assert.equal(res.headers.get("x-costcap-cache"), null);
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(receipts.length, 2);
  assert.deepEqual(Object.keys(receipts[1]).sort(), Object.keys(receipts[0]).sort());
  for (const r of receipts) for (const k of ["cache", "saved_usd", "cache_source_receipt"]) assert.equal(k in r, false);
});

// #194 AC5: a WebSocket upgrade on a non-realtime route used to reach the HTTP path, fail fetch,
// latch upstream_outcome_unknown and refuse every later call. It is now refused locally.
test("#194 upgrade on chat/messages -> 501 websocket_unsupported, 0 upstream hits, next call 200", async (t) => {
  const { connectRealtime, startRealtimeUpstream } = await import("./fixtures/realtime-upstream.js");
  const up = await startRealtimeUpstream();
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url, anthropic: up.url } });
  t.after(async () => { server.close(); await up.close(); });
  for (const p of ["/openai/v1/chat/completions", "/anthropic/v1/messages"]) {
    const c = await connectRealtime(port, p);
    assert.equal(c.status, 501);
    assert.equal(c.body.error, "websocket_unsupported");
  }
  assert.equal(up.requests + up.handshakes.length, 0);
  const r = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini" }) });
  assert.equal(r.status, 200);
  assert.equal(server.accountingFailure(), null);
});

test("#196 a GET whose body carries usage is $0 non_billable_request and never pauses", async (t) => {
  const f = await scripted(t, "openai", [200]);
  const r = await f.call(0, "GET", "/openai/v1/chat/completions/chatcmpl_1");
  assert.equal(r.status, 200);
  assert.deepEqual([f.receipts[0].cost_usd, f.receipts[0].reason], [0, "non_billable_request"]);
});
