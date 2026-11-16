import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractUsage, isProviderError, startMeteringProxy } from "../src/proxy.js";
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

test("#138 a 200 with duration-style usage records usage_unavailable and pauses", async (t) => {
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; req.resume(); res.writeHead(200, { "content-type": "application/json" }).end('{"model":"whisper-1","usage":{"seconds":3}}'); });
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
