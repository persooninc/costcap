import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { cacheKey, createResponseCache, isCacheable, isStreamRequest, parseTtl } from "../src/response-cache.js";
import { createVelocityBreaker } from "../src/velocity.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cc-cache-"));
const KEY = "sk-test-SECRETKEY-123";

const RESP = {
  openai: JSON.stringify({ model: "gpt-4o-mini", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
  embed: JSON.stringify({ model: "text-embedding-3-small", data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1000, total_tokens: 1000 } }),
  anthropic: JSON.stringify({ model: "claude-sonnet-4-20250514", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1000, output_tokens: 500 } }),
  gemini: JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], modelVersion: "gemini-2.5-flash", usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, totalTokenCount: 1500 } }),
};

// Fake upstream: counts calls, records headers; `reply` may override per request.
async function upstream(t, reply) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({ url: req.url, headers: req.headers, body });
      const [status, ct, out] = reply?.(req, body) ?? [200, "application/json",
        req.url.includes("embeddings") ? RESP.embed : req.url.startsWith("/v1/messages") ? RESP.anthropic : req.url.includes("generateContent") ? RESP.gemini : RESP.openai];
      res.writeHead(status, { "content-type": ct }).end(out);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, upstreams: { openai: base, anthropic: base, gemini: base } };
}

async function proxy(t, up, extra = {}) {
  const dir = tmp();
  const receipts = [];
  const cache = extra.cache === null ? null : createResponseCache({ dir: join(dir, "cache"), ttlMs: 3_600_000, ...(extra.cacheOpts ?? {}) });
  const { server, port } = await startMeteringProxy({ upstreams: up.upstreams, receiptsPath: join(dir, "r.jsonl"), onReceipt: (r) => receipts.push(r), ...extra, cache });
  t.after(() => server.close());
  const call = async (path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...headers }, body });
    const text = await res.text();
    await new Promise((r) => setImmediate(r));
    return { res, text, status: res.status, cacheHeader: res.headers.get("x-costcap-cache") };
  };
  return { call, receipts, cache, dir };
}

const CHAT = JSON.stringify({ model: "gpt-4o-mini", temperature: 0, messages: [{ role: "user", content: "hello" }] });

test("parseTtl accepts s/m/h/d up to 7d and rejects anything else", () => {
  assert.equal(parseTtl("30s"), 30_000);
  assert.equal(parseTtl("10m"), 600_000);
  assert.equal(parseTtl("24h"), 86_400_000);
  assert.equal(parseTtl("7d"), 7 * 86_400_000);
  for (const bad of ["8d", "0s", "1w", "", "10", "-1h", "1.5h"]) assert.throws(() => parseTtl(bad));
});

test("eligibility: temperature 0 generation and embeddings only; streams, batches, files, count-tokens, n>1 are not", () => {
  const b = (o) => Buffer.from(JSON.stringify(o));
  assert.equal(isCacheable({ method: "POST", path: "/v1/chat/completions", body: b({ temperature: 0 }) }), true);
  assert.equal(isCacheable({ method: "POST", path: "/v1beta/models/g:generateContent", body: b({ generationConfig: { temperature: 0 } }) }), true);
  assert.equal(isCacheable({ method: "POST", path: "/v1/embeddings", body: b({ input: "x" }) }), true);
  for (const [path, body] of [
    ["/v1/chat/completions", {}], ["/v1/chat/completions", { temperature: 0.7 }], ["/v1/chat/completions", { temperature: 0, n: 2 }],
    ["/v1/chat/completions", { temperature: 0, stream: true }], ["/v1beta/models/g:streamGenerateContent", { generationConfig: { temperature: 0 } }],
    ["/v1/batches", { temperature: 0 }], ["/v1/messages/batches", { temperature: 0 }], ["/v1/files", { temperature: 0 }],
    ["/v1/messages/count_tokens", { temperature: 0 }], ["/v1beta/models/g:countTokens", { generationConfig: { temperature: 0 } }],
  ]) assert.equal(isCacheable({ method: "POST", path, body: b(body) }), false, `${path} ${JSON.stringify(body)}`);
  assert.equal(isCacheable({ method: "GET", path: "/v1/models", body: Buffer.alloc(0) }), false);
  assert.equal(isCacheable({ method: "POST", path: "/v1/chat/completions", body: Buffer.from("not json") }), false);
  assert.equal(isStreamRequest({ path: "/x?alt=sse", body: Buffer.from("{}") }), true);
  assert.equal(isStreamRequest({ path: "/x", body: Buffer.from("{\"stream\":true}") }), true);
});

test("cacheKey changes with body bytes, auth identity, key= query and provider headers", () => {
  const base = { provider: "openai", upstream: "u", method: "POST", path: "/v1/chat/completions", body: Buffer.from(CHAT), headers: { authorization: "Bearer a" } };
  const k = cacheKey(base);
  assert.equal(k, cacheKey({ ...base }));
  assert.notEqual(k, cacheKey({ ...base, body: Buffer.from(CHAT + " ") }));
  assert.notEqual(k, cacheKey({ ...base, headers: { authorization: "Bearer b" } }));
  assert.notEqual(k, cacheKey({ ...base, headers: { ...base.headers, "x-api-key": "k" } }));
  assert.notEqual(k, cacheKey({ ...base, headers: { ...base.headers, "anthropic-version": "2023-06-01" } }));
  assert.notEqual(k, cacheKey({ ...base, path: "/v1/chat/completions?key=a" }));
  assert.notEqual(cacheKey({ ...base, path: "/x?key=a" }), cacheKey({ ...base, path: "/x?key=b" }));
  assert.notEqual(k, cacheKey({ ...base, upstream: "v" }));
});

test("store: dir 0700, entries 0600, TTL expiry, too-large skip, LRU eviction under the cap", () => {
  let now = 1_000_000;
  const dir = join(tmp(), "c");
  const c = createResponseCache({ dir, ttlMs: 1000, maxMb: 1, now: () => now });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(c.set("a", { status: 200, contentType: "application/json", body: Buffer.from("{}"), model: "m", cost_usd: 1, receipt_id: "r1" }), true);
  assert.equal(statSync(join(dir, "a.json")).mode & 0o777, 0o600);
  assert.equal(c.get("a").body.toString(), "{}");
  now += 1000;
  assert.equal(c.get("a"), null, "expired at TTL");
  assert.equal(c.set("big", { status: 200, contentType: "x", body: Buffer.alloc(200_000), cost_usd: 1, receipt_id: "r" }), false, "over 1/10 of cap");
  // ~90 KB entries: 1 MB holds about 11.
  const body = Buffer.alloc(65_000, 1);
  for (let i = 0; i < 20; i++) { now += 10; c.set(`k${i}`, { status: 200, contentType: "x", body, cost_usd: 1, receipt_id: "r" }); if (i === 0) { now += 5; c.get("k0"); } }
  const files = readdirSync(dir);
  const total = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  assert.ok(total <= 1024 * 1024, `dir ${total} <= 1MB`);
  assert.ok(!files.includes("k1.json"), "least recently used evicted");
  assert.ok(files.includes("k19.json"), "newest kept");
});

for (const [name, path, body, headers] of [
  ["OpenAI chat", "/openai/v1/chat/completions", CHAT, {}],
  ["Anthropic messages", "/anthropic/v1/messages", JSON.stringify({ model: "claude-sonnet-4-20250514", temperature: 0, max_tokens: 10, messages: [] }), { "anthropic-version": "2023-06-01" }],
  ["Gemini generateContent", "/gemini/v1beta/models/gemini-2.5-flash:generateContent", JSON.stringify({ contents: [], generationConfig: { temperature: 0 } }), {}],
  ["OpenAI embeddings", "/openai/v1/embeddings", JSON.stringify({ model: "text-embedding-3-small", input: "x" }), {}],
]) {
  test(`AC1 ${name}: second identical call is a $0 cache hit with saved_usd, one upstream call`, async (t) => {
    const up = await upstream(t);
    const p = await proxy(t, up);
    const first = await p.call(path, body, headers);
    const second = await p.call(path, body, headers);
    assert.equal(up.calls.length, 1);
    assert.equal(first.cacheHeader, "miss");
    assert.equal(second.cacheHeader, "hit");
    assert.equal(second.text, first.text);
    assert.equal(second.status, 200);
    const [a, b] = p.receipts;
    assert.equal(a.cache, "miss");
    assert.ok(a.cost_usd > 0);
    assert.deepEqual({ cost_usd: b.cost_usd, reason: b.reason, cache: b.cache, saved_usd: b.saved_usd, src: b.cache_source_receipt, model: b.model, status: b.status },
      { cost_usd: 0, reason: "cache_hit", cache: "hit", saved_usd: a.cost_usd, src: a.id, model: a.model, status: 200 });
    assert.deepEqual(p.cache.stats, { hits: 1, misses: 1, saved_usd: a.cost_usd });
  });
}

test("AC2: differing body/key/version/temperature/n/bypass header always go upstream", async (t) => {
  const up = await upstream(t);
  const p = await proxy(t, up, { spiral: null });
  const c = (body, headers, path = "/openai/v1/chat/completions") => p.call(path, body, headers);
  await c(CHAT);
  await c(CHAT + " ");
  await c(CHAT, { authorization: "Bearer other" });
  await c(CHAT, { "x-api-key": "other" });
  await c(CHAT, { "anthropic-version": "2023-06-01" });
  await c(CHAT, {}, "/openai/v1/chat/completions?key=a");
  await c(CHAT, {}, "/openai/v1/chat/completions?key=b");
  const noTemp = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
  assert.equal((await c(noTemp)).cacheHeader, "bypass"); await c(noTemp);
  const warm = JSON.stringify({ model: "gpt-4o-mini", temperature: 0.7, messages: [] });
  await c(warm); await c(warm);
  const n2 = JSON.stringify({ model: "gpt-4o-mini", temperature: 0, n: 2, messages: [] });
  await c(n2); await c(n2);
  const by = await c(CHAT, { "x-costcap-cache": "bypass" });
  assert.equal(by.cacheHeader, "bypass");
  assert.equal(up.calls.length, 14);
  assert.ok(up.calls.every((x) => !("x-costcap-cache" in x.headers)), "cache header never forwarded");
  assert.ok(!p.receipts.some((r) => r.reason === "cache_hit"));
});

test("AC2: stream:true bypasses and the SSE passes through unchanged", async (t) => {
  const sse = 'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n';
  const up = await upstream(t, () => [200, "text/event-stream", sse]);
  const p = await proxy(t, up);
  const body = JSON.stringify({ model: "gpt-4o-mini", temperature: 0, stream: true, stream_options: { include_usage: true }, messages: [] });
  const a = await p.call("/openai/v1/chat/completions", body);
  const b = await p.call("/openai/v1/chat/completions", body);
  assert.equal(up.calls.length, 2);
  assert.equal(a.cacheHeader, "bypass");
  assert.equal(b.text, sse);
  assert.equal(p.receipts[1].cache, "bypass");
  assert.ok(p.receipts[1].cost_usd > 0);
});

test("AC2: a call after TTL expiry goes upstream", async (t) => {
  const up = await upstream(t);
  const p = await proxy(t, up, { cacheOpts: { ttlMs: 1 } });
  await p.call("/openai/v1/chat/completions", CHAT);
  await new Promise((r) => setTimeout(r, 10));
  const b = await p.call("/openai/v1/chat/completions", CHAT);
  assert.equal(b.cacheHeader, "miss");
  assert.equal(up.calls.length, 2);
});

test("AC2: no cache option means no x-costcap-cache header and no cache receipt field", async (t) => {
  const up = await upstream(t);
  const p = await proxy(t, up, { cache: null });
  const a = await p.call("/openai/v1/chat/completions", CHAT, { "x-costcap-cache": "bypass" });
  await p.call("/openai/v1/chat/completions", CHAT);
  assert.equal(a.cacheHeader, null);
  assert.equal(up.calls.length, 2);
  assert.ok(p.receipts.every((r) => !("cache" in r)));
  assert.ok(up.calls.every((x) => !("x-costcap-cache" in x.headers)));
});

test("AC3: provider errors, usage_unavailable, tool_use_unpriced and batch_pending are never stored", async (t) => {
  for (const [status, out] of [
    [429, JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } })],
    [400, JSON.stringify({ error: { message: "bad", type: "invalid_request_error" } })],
    [200, JSON.stringify({ model: "gpt-4o-mini", choices: [] })],
  ]) {
    const up = await upstream(t, () => [status, "application/json", out]);
    const p = await proxy(t, up);
    await p.call("/openai/v1/chat/completions", CHAT);
    const again = await p.call("/openai/v1/chat/completions", CHAT).catch(() => null);
    // usage_unavailable latches the accounting failure: the repeat is refused, never served from cache.
    assert.ok(up.calls.length === 2 || (status === 200 && again.status === 429 && again.cacheHeader === null), `status ${status} repeat goes upstream`);
    assert.ok(!p.receipts.some((r) => r.reason === "cache_hit"));
    assert.equal(readdirSync(p.cache.dir).length, 0);
  }
  // usage_unavailable latches the accounting failure, so the repeat is refused, not served.
  const tool = JSON.stringify({ model: "gpt-3.5-turbo", output: [{ type: "web_search_call" }], usage: { input_tokens: 10, output_tokens: 5 } });
  const up = await upstream(t, () => [200, "application/json", tool]);
  const p = await proxy(t, up);
  await p.call("/openai/v1/responses", JSON.stringify({ model: "gpt-4o-mini", temperature: 0, input: "x" }));
  assert.equal(readdirSync(p.cache.dir).length, 0, "tool_use_unpriced / unknown cost not stored");
  const batch = await upstream(t, () => [200, "application/json", JSON.stringify({ id: "batch_1", object: "batch" })]);
  const pb = await proxy(t, batch);
  const r = await pb.call("/openai/v1/batches", JSON.stringify({ temperature: 0, input_file_id: "f" }));
  assert.equal(r.cacheHeader, "bypass");
  assert.equal(pb.receipts[0].reason, "batch_pending");
  assert.equal(readdirSync(pb.cache.dir).length, 0);
});

test("AC4: kill file, exhausted cap and spiral breaker refuse before a would-be hit", async (t) => {
  const up = await upstream(t);
  let killed = false;
  const p = await proxy(t, up, { killCheck: () => (killed ? { reason: "killed" } : null) });
  await p.call("/openai/v1/chat/completions", CHAT);
  killed = true;
  const r = await p.call("/openai/v1/chat/completions", CHAT);
  assert.equal(r.status, 429);
  assert.equal(r.cacheHeader, null);
  assert.ok(!p.receipts.some((x) => x.reason === "cache_hit"));
  assert.equal(p.receipts.at(-1).reason, "killed");

  const up2 = await upstream(t);
  const capped = await proxy(t, up2, { cap: { check: () => ({ scope: "run", limit_usd: 1, spent_usd: 1 }), record() {}, spend: () => ({}), limits: () => ({}) } });
  const c = await capped.call("/openai/v1/chat/completions", CHAT);
  assert.equal(c.status, 429);
  assert.equal(capped.receipts[0].reason, "budget_exceeded");

  const up3 = await upstream(t);
  const sp = await proxy(t, up3, { spiral: { observe: (() => { let n = 0; return () => (++n > 1 ? { repeats: n } : null); })() } });
  await sp.call("/openai/v1/chat/completions", CHAT);
  const s2 = await sp.call("/openai/v1/chat/completions", CHAT);
  assert.equal(s2.status, 429);
  assert.equal(sp.receipts.at(-1).reason, "spiral_detected");
  assert.ok(!sp.receipts.some((x) => x.reason === "cache_hit"));
});

test("AC4: hits count toward --max-steps but never toward velocity spend", async (t) => {
  const up = await upstream(t);
  const velocity = createVelocityBreaker({ maxSteps: 3 });
  const p = await proxy(t, up, { velocity, spiral: null });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await p.call("/openai/v1/chat/completions", CHAT)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal(up.calls.length, 1);
  assert.equal(p.receipts.filter((r) => r.reason === "cache_hit").length, 2);
  assert.equal(p.receipts.at(-1).reason, "step_budget");
});

test("AC5: entries are 0600 and contain no key, request body or auth values", async (t) => {
  const up = await upstream(t);
  const p = await proxy(t, up);
  const secretBody = JSON.stringify({ model: "gpt-4o-mini", temperature: 0, messages: [{ role: "user", content: "PROMPT-MARKER-xyz" }] });
  await p.call("/openai/v1/chat/completions?key=QUERYKEY-abc", secretBody, { "x-api-key": "XAPIKEY-def" });
  await p.call("/anthropic/v1/messages", JSON.stringify({ model: "claude-sonnet-4-20250514", temperature: 0, max_tokens: 1, messages: [{ role: "user", content: "PROMPT-MARKER-xyz" }] }), { "x-api-key": "XAPIKEY-def" });
  const dir = p.cache.dir;
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const files = readdirSync(dir);
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
    const text = readFileSync(join(dir, f), "utf8");
    const decoded = Buffer.from(JSON.parse(text).body_b64, "base64").toString();
    for (const s of [KEY, "QUERYKEY-abc", "XAPIKEY-def", "PROMPT-MARKER-xyz"]) {
      assert.ok(!text.includes(s) && !decoded.includes(s), `${f} leaks ${s}`);
    }
  }
});

test("AC5: --cache-max-mb 1 keeps the dir at or under 1 MB via LRU eviction", async (t) => {
  const big = JSON.stringify({ model: "gpt-4o-mini", pad: "x".repeat(60_000), usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const up = await upstream(t, () => [200, "application/json", big]);
  const p = await proxy(t, up, { cacheOpts: { maxMb: 1 } });
  for (let i = 0; i < 20; i++) await p.call("/openai/v1/chat/completions", JSON.stringify({ model: "gpt-4o-mini", temperature: 0, i }));
  const total = readdirSync(p.cache.dir).reduce((n, f) => n + statSync(join(p.cache.dir, f)).size, 0);
  assert.ok(total <= 1024 * 1024 && total > 0, `cache dir ${total} bytes`);
  // The first request was evicted, so it goes upstream again.
  const before = up.calls.length;
  await p.call("/openai/v1/chat/completions", JSON.stringify({ model: "gpt-4o-mini", temperature: 0, i: 0 }));
  assert.equal(up.calls.length, before + 1);
});

test("a corrupt entry is treated as a miss", async () => {
  const dir = join(tmp(), "c");
  const c = createResponseCache({ dir, ttlMs: 1000 });
  writeFileSync(join(dir, "bad.json"), "not json");
  assert.equal(c.get("bad"), null);
  assert.equal(c.get("absent"), null);
  assert.throws(() => createResponseCache({ ttlMs: 1 }));
});
