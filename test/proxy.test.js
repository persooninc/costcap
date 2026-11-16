import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { startMeteringProxy, baseUrlOverrides } from "../src/proxy.js";
import { TABLE_VERSION } from "../src/pricing.js";

// Mock upstream provider: returns a fixed chat completion with usage.
function mockUpstream(body, contentType = "application/json") {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": contentType }).end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const COMPLETION = JSON.stringify({
  model: "gpt-4o-mini",
  usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, prompt_tokens_details: { cached_tokens: 0 } },
});

const STREAM = [
  'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"hi"}}]}',
  'data: {"model":"gpt-4o-mini","usage":{"prompt_tokens":2000,"completion_tokens":1000,"prompt_tokens_details":{"cached_tokens":1000}}}',
  "data: [DONE]",
  "",
].join("\n");

test("meters a non-streaming call and writes a versioned receipt", async (t) => {
  const up = await mockUpstream(COMPLETION);
  t.after(() => up.server.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy(
    { upstreams: { openai: `http://127.0.0.1:${up.port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(receipts.length, 1);
  const r = receipts[0];
  assert.equal(r.model, "gpt-4o-mini");
  assert.equal(r.cost_usd, 0.45); // 1M input @0.15 + 0.5M output @0.60
  assert.equal(r.table_version, TABLE_VERSION);
  assert.equal(r.fallback, false);
});

test("streaming responses are metered from the usage chunk", async (t) => {
  const up = await mockUpstream(STREAM, "text/event-stream");
  t.after(() => up.server.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy(
    { upstreams: { openai: `http://127.0.0.1:${up.port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /\[DONE\]/); // stream passed through intact
  await new Promise((r) => setImmediate(r));
  assert.equal(receipts.length, 1);
  // 1000 uncached @0.15 + 1000 cached @0.075 + 1000 output @0.60 per 1M
  assert.equal(receipts[0].cost_usd, 0.000825);
});

test("unknown provider path 404s and writes no receipt", async (t) => {
  const { server, port } = await startMeteringProxy({ upstreams: {} });
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
});

test("baseUrlOverrides emits env rewrites for the big four", () => {
  const lines = baseUrlOverrides(8080);
  assert.ok(lines.some((l) => l === "OPENAI_BASE_URL=http://127.0.0.1:8080/openai/v1"));
  assert.ok(lines.some((l) => l.startsWith("ANTHROPIC_BASE_URL=")));
  assert.ok(lines.some((l) => l.startsWith("OPENROUTER_BASE_URL=")));
  assert.ok(lines.some((l) => l.startsWith("GEMINI_BASE_URL=")));
});

test("#150 baseUrlOverrides emits GOOGLE_GEMINI_BASE_URL and keeps GEMINI_BASE_URL", () => {
  const lines = baseUrlOverrides(8080, ["gemini"]);
  assert.deepEqual(lines, ["GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8080/gemini", "GEMINI_BASE_URL=http://127.0.0.1:8080/gemini"]);
});

test("anthropic usage shape meters input/output/cache_read", async (t) => {
  const anthropicBody = JSON.stringify({
    model: "claude-unknown-future",
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 },
  });
  const up = await mockUpstream(anthropicBody);
  t.after(() => up.server.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy(
    { upstreams: { anthropic: `http://127.0.0.1:${up.port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => server.close());
  await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, { method: "POST", body: "{}" });
  await new Promise((r) => setImmediate(r));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].fallback, true); // unknown model -> declared fallback rate
  assert.equal(receipts[0].cost_usd, 2.5);
});

test("retry spiral: identical request past the threshold gets 429 spiral_detected and never reaches upstream", async (t) => {
  let upstreamHits = 0;
  const up = await new Promise((resolve) => {
    const server = http.createServer((req, res) => { upstreamHits++; res.writeHead(200, { "content-type": "application/json" }).end(COMPLETION); });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
  t.after(() => up.server.close());
  const { createSpiralDetector } = await import("../src/spiral.js");
  const receipts = [];
  const { server, port } = await startMeteringProxy(
    { upstreams: { openai: `http://127.0.0.1:${up.port}` }, spiral: createSpiralDetector({ threshold: 2 }), onReceipt: (r) => receipts.push(r) });
  t.after(() => server.close());
  const call = () => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "same" }] }),
  });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  const third = await call();
  assert.equal(third.status, 429);
  const j = await third.json();
  assert.equal(j.error, "spiral_detected");
  assert.equal(j.count, 3);
  assert.equal(upstreamHits, 2);
  assert.equal(receipts.at(-1).reason, "spiral_detected");
});

// #169: cost attribution tags.
function headerUpstream() {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { "content-type": "application/json" }).end(COMPLETION); });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

test("#169 x-costcap-tag is stripped before forwarding and merged under the wrapper's tags", async (t) => {
  const up = await headerUpstream();
  t.after(() => up.server.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.port}` }, onReceipt: (r) => receipts.push(r), tags: { env: "prod", feature: "search" } });
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", headers: { "x-costcap-tag": "customer=acme, env=dev", "x-other": "kept" }, body: "{}" });
  assert.equal(res.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(up.seen.length, 1);
  assert.equal(up.seen[0]["x-costcap-tag"], undefined);
  assert.equal(up.seen[0]["x-other"], "kept");
  assert.deepEqual(receipts[0].tags, { customer: "acme", env: "prod", feature: "search" });
  // Untagged request through an untagged proxy: no tags field at all (regression).
  const { server: s2, port: p2 } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => s2.close());
  await fetch(`http://127.0.0.1:${p2}/openai/v1/chat/completions`, { method: "POST", body: "{}" });
  await new Promise((r) => setImmediate(r));
  assert.equal("tags" in receipts[1], false);
});

test("#169 malformed x-costcap-tag returns 400 invalid_tags, writes a $0 receipt and does not block later calls", async (t) => {
  const up = await headerUpstream();
  t.after(() => up.server.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.port}` }, onReceipt: (r) => receipts.push(r), tags: { env: "prod" } });
  t.after(() => server.close());
  const bads = ["Bad=x", Array.from({ length: 11 }, (_, i) => `k${i}=v`).join(","), `k=${"x".repeat(65)}`, "novalue"];
  for (const h of bads) {
    const res = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", headers: { "x-costcap-tag": h }, body: "{}" });
    assert.equal(res.status, 400, h);
    assert.equal((await res.json()).error, "invalid_tags");
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(up.seen.length, 0);
  assert.equal(receipts.length, bads.length);
  for (const r of receipts) { assert.equal(r.reason, "invalid_tags"); assert.equal(r.cost_usd, 0); assert.deepEqual(r.tags, { env: "prod" }); }
  const ok = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", headers: { "x-costcap-tag": "customer=acme" }, body: "{}" });
  assert.equal(ok.status, 200);
  assert.equal(up.seen.length, 1);
});

test("#169 a cap-hit blocked receipt carries the request's tags", async (t) => {
  const { createCapEngine } = await import("../src/cap.js");
  const up = await headerUpstream();
  t.after(() => up.server.close());
  const receipts = [];
  const cap = createCapEngine({ caps: { run: 0.01 } });
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.port}` }, onReceipt: (r) => receipts.push(r), cap });
  t.after(() => server.close());
  assert.equal((await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: "{}" })).status, 200);
  const res = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", headers: { "x-costcap-tag": "customer=acme" }, body: "{}" });
  assert.equal(res.status, 429);
  await new Promise((r) => setImmediate(r));
  assert.equal(up.seen.length, 1);
  assert.equal(receipts[1].blocked, true);
  assert.deepEqual(receipts[1].tags, { customer: "acme" });
});

// #184: response cache (AC1, AC4) against a fake upstream.
import { createResponseCache } from "../src/response-cache.js";
import { createVelocityBreaker } from "../src/velocity.js";
import { createCapEngine } from "../src/cap.js";
import { mkdtempSync as mkdtemp184 } from "node:fs";
import { tmpdir as tmpdir184 } from "node:os";
import { join as join184 } from "node:path";

function countingUpstream(reply) {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { state.calls++; const r = reply(req, state.calls); res.writeHead(200, { "content-type": "application/json" }).end(r); });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}
const cache184 = () => createResponseCache({ dir: join184(mkdtemp184(join184(tmpdir184(), "cc-cache-proxy-")), "cache"), ttlMs: 3_600_000 });

for (const [name, provider, path, body, reply] of [
  ["OpenAI chat", "openai", "/openai/v1/chat/completions", { model: "gpt-4o-mini", temperature: 0, messages: [] },
    (_, n) => JSON.stringify({ model: "gpt-4o-mini", id: `c${n}`, usage: { prompt_tokens: 1000, completion_tokens: 500 } })],
  ["Anthropic messages", "anthropic", "/anthropic/v1/messages", { model: "claude-sonnet-4-5", temperature: 0, max_tokens: 10, messages: [] },
    (_, n) => JSON.stringify({ model: "claude-sonnet-4-5", id: `m${n}`, usage: { input_tokens: 1000, output_tokens: 500 } })],
  ["Gemini generateContent", "gemini", "/gemini/v1beta/models/gemini-2.5-flash:generateContent", { generationConfig: { temperature: 0 }, contents: [] },
    (_, n) => JSON.stringify({ modelVersion: "gemini-2.5-flash", responseId: `g${n}`, candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 } })],
  ["OpenAI embeddings", "openai", "/openai/v1/embeddings", { model: "text-embedding-3-small", input: "hello" },
    (_, n) => JSON.stringify({ model: "text-embedding-3-small", data: [{ embedding: [n] }], usage: { prompt_tokens: 1000, total_tokens: 1000 } })],
]) {
  test(`#184 --cache: two identical ${name} calls make one upstream request; the hit is byte-identical and $0`, async (t) => {
    const up = await countingUpstream(reply);
    const receipts = [];
    const { server, port } = await startMeteringProxy({ upstreams: { [provider]: up.url }, onReceipt: (r) => receipts.push(r), cache: cache184() });
    t.after(() => { server.closeAllConnections(); server.close(); up.server.close(); });
    const call = () => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k" }, body: JSON.stringify(body) });
    const a = await call(); const aText = await a.text();
    const b = await call(); const bText = await b.text();
    assert.equal(up.state.calls, 1);
    assert.equal(a.headers.get("x-costcap-cache"), "miss");
    assert.equal(b.headers.get("x-costcap-cache"), "hit");
    assert.equal(b.status, a.status);
    assert.equal(b.headers.get("content-type"), a.headers.get("content-type"));
    assert.equal(bText, aText);
    assert.equal(receipts.length, 2);
    const [miss, hit] = receipts;
    assert.equal(miss.cache, "miss");
    assert.ok(miss.cost_usd > 0);
    assert.equal(hit.cost_usd, 0);
    assert.equal(hit.reason, "cache_hit");
    assert.equal(hit.cache, "hit");
    assert.equal(hit.saved_usd, miss.cost_usd);
    assert.equal(hit.cache_source_receipt, miss.id);
    assert.equal(hit.model, miss.model);
    assert.equal(hit.status, 200);
  });
}

test("#184 --cache never bypasses a refusal: kill file, exhausted cap, open breaker (AC4)", async (t) => {
  const reply = () => JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1000, completion_tokens: 500 } });
  const body = JSON.stringify({ model: "gpt-4o-mini", temperature: 0 });
  for (const [label, opts] of [
    ["killed", (s) => ({ killCheck: () => (s.armed ? { reason: "killed", source: "file" } : null) })],
    ["budget_exceeded", () => ({ cap: createCapEngine({ caps: { run: 0.0001 } }) })],
    ["cost_velocity", (s) => ({ velocity: { record() {}, check: () => (s.armed ? { reason: "cost_velocity" } : null) } })],
  ]) {
    const up = await countingUpstream(reply);
    const receipts = [];
    const s = { armed: false };
    const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url }, onReceipt: (r) => receipts.push(r), cache: cache184(), ...opts(s) });
    const call = () => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body });
    const first = await call(); await first.text();
    assert.equal(first.status, 200, label);
    s.armed = true;
    const second = await call(); await second.text();
    assert.equal(second.status, 429, label);
    assert.equal(second.headers.get("x-costcap-cache"), null, label);
    assert.ok(!receipts.some((r) => r.reason === "cache_hit"), label);
    assert.equal(receipts.at(-1).blocked, true, label);
    assert.equal(up.state.calls, 1, label);
    server.closeAllConnections(); server.close(); up.server.close();
  }
});

test("#184 --cache hits count toward --max-steps but add no velocity spend (AC4)", async (t) => {
  const up = await countingUpstream(() => JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
  const recorded = [];
  const velocity = createVelocityBreaker({ maxSteps: 3 });
  const orig = velocity.record;
  velocity.record = (usd) => { recorded.push(usd); return orig(usd); };
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url }, onReceipt: (r) => receipts.push(r), cache: cache184(), velocity });
  t.after(() => { server.closeAllConnections(); server.close(); up.server.close(); });
  const statuses = [];
  for (let i = 0; i < 5; i++) { const r = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: '{"model":"gpt-4o-mini","temperature":0}' }); await r.text(); statuses.push(r.status); }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal(up.state.calls, 1);
  assert.deepEqual(recorded.slice(1), [0, 0]);
  assert.equal(receipts.filter((r) => r.reason === "cache_hit").length, 2);
  assert.equal(receipts.at(-1).reason, "step_budget");
});

test("#184 without a cache there is no x-costcap-cache header and no cache receipt field", async (t) => {
  const up = await countingUpstream(() => JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { server.closeAllConnections(); server.close(); up.server.close(); });
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: '{"model":"gpt-4o-mini","temperature":0}' });
    await r.text();
    assert.equal(r.headers.get("x-costcap-cache"), null);
  }
  assert.equal(up.state.calls, 2);
  assert.ok(receipts.every((r) => !("cache" in r) && !("saved_usd" in r)));
});
