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
