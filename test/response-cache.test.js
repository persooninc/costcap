// #184: opt-in local response cache. Keying, eligibility, TTL, LRU eviction,
// file modes and no secrets on disk, plus the proxy's never-cache cases (AC2, AC3, AC5).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, createResponseCache, isCacheable, parseTtl } from "../src/response-cache.js";
import { startMeteringProxy } from "../src/proxy.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cc-cache-"));

test("parseTtl accepts s/m/h/d up to 7d and rejects everything else", () => {
  assert.equal(parseTtl("30s"), 30_000);
  assert.equal(parseTtl("10m"), 600_000);
  assert.equal(parseTtl("24h"), 86_400_000);
  assert.equal(parseTtl("7d"), 7 * 86_400_000);
  for (const bad of ["8d", "0s", "1w", "", "10", "1.5h", "-1h", undefined]) assert.throws(() => parseTtl(bad), /--cache/);
});

test("cacheKey changes with body bytes, path, auth identity, version headers and upstream", () => {
  const base = { provider: "openai", upstream: "https://api.openai.com", method: "POST", path: "/v1/chat/completions", body: Buffer.from('{"a":1}'), headers: { authorization: "Bearer k1" } };
  const k = cacheKey(base);
  assert.equal(cacheKey({ ...base }), k);
  assert.match(k, /^[0-9a-f]{64}$/);
  const variants = [
    { body: Buffer.from('{"a":2}') },
    { path: "/v1/embeddings" },
    { upstream: "https://other.example" },
    { headers: { authorization: "Bearer k2" } },
    { headers: { authorization: "Bearer k1", "x-api-key": "x" } },
    { headers: { authorization: "Bearer k1", "anthropic-version": "2023-06-01" } },
    { headers: { authorization: "Bearer k1", "anthropic-beta": "b" } },
    { headers: { authorization: "Bearer k1", "openai-organization": "o" } },
    { headers: { authorization: "Bearer k1", "openai-project": "p" } },
    { provider: "openrouter" },
  ];
  for (const v of variants) assert.notEqual(cacheKey({ ...base, ...v }), k, JSON.stringify(v));
  const g = { ...base, provider: "gemini", path: "/v1beta/models/m:generateContent?key=AAA" };
  assert.notEqual(cacheKey(g), cacheKey({ ...g, path: "/v1beta/models/m:generateContent?key=BBB" }));
});

test("isCacheable: only POST, non-streaming, temperature 0 (or embeddings), n <= 1", () => {
  assert.equal(isCacheable("openai", "POST", "/openai/v1/chat/completions", { temperature: 0 }), true);
  assert.equal(isCacheable("anthropic", "POST", "/anthropic/v1/messages", { temperature: 0 }), true);
  assert.equal(isCacheable("gemini", "POST", "/gemini/v1beta/models/m:generateContent", { generationConfig: { temperature: 0 } }), true);
  assert.equal(isCacheable("openai", "POST", "/openai/v1/embeddings", { input: "x" }, { embeddings: true }), true);
  assert.equal(isCacheable("openai", "POST", "/openai/v1/chat/completions", {}), false);
  assert.equal(isCacheable("openai", "POST", "/openai/v1/chat/completions", { temperature: 0.7 }), false);
  assert.equal(isCacheable("gemini", "POST", "/gemini/v1beta/models/m:generateContent", { temperature: 0 }), false);
  assert.equal(isCacheable("openai", "POST", "/openai/v1/chat/completions", { temperature: 0, n: 2 }), false);
  assert.equal(isCacheable("openai", "POST", "/openai/v1/chat/completions", { temperature: 0, stream: true }), false);
  assert.equal(isCacheable("gemini", "POST", "/gemini/v1beta/models/m:streamGenerateContent", { generationConfig: { temperature: 0 } }), false);
  assert.equal(isCacheable("gemini", "POST", "/gemini/v1beta/models/m:generateContent?alt=sse", { generationConfig: { temperature: 0 } }), false);
  assert.equal(isCacheable("openai", "GET", "/openai/v1/models", { temperature: 0 }), false);
  assert.equal(isCacheable("openai", "POST", "/openai/v1/x", { temperature: 0 }, { countTokens: true }), false);
  assert.equal(isCacheable("openai", "POST", "/openai/v1/x", { temperature: 0 }, { files: true }), false);
  assert.equal(isCacheable("openai", "POST", "/openai/v1/x", { temperature: 0 }, { batch: true }), false);
  assert.equal(isCacheable("openai", "POST", "/openai/v1/x", null), false);
});

test("cache store: TTL expiry, 0700 dir, 0600 entries, LRU eviction under the size cap", () => {
  const dir = join(tmp(), "cache");
  let t = 1_000_000;
  const c = createResponseCache({ dir, ttlMs: 60_000, maxBytes: 2700, now: () => t });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const entry = (n) => ({ status: 200, contentType: "application/json", body: Buffer.from("x".repeat(n)), model: "m", cost_usd: 0.5, receipt_id: "r" });
  const key = (i) => String(i).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, "a");
  assert.equal(c.put(key(1), entry(100)), true);
  assert.equal(statSync(join(dir, `${key(1)}.json`)).mode & 0o777, 0o600);
  const hit = c.get(key(1));
  assert.equal(hit.body.toString(), "x".repeat(100));
  assert.equal(hit.cost_usd, 0.5);
  assert.equal(hit.receipt_id, "r");
  // Oversized (> 1/10 of the cap) is never stored.
  assert.equal(c.put(key(9), entry(1000)), false);
  // TTL
  t += 60_001;
  assert.equal(c.get(key(1)), null);
  // LRU: fill, touch the oldest, then overflow: the least recently used goes first.
  for (let i = 1; i <= 8; i++) { t += 1000; assert.equal(c.put(key(i), entry(100)), true); }
  t += 1000; assert.ok(c.get(key(1)));
  for (let i = 2; i <= 4; i++) { t += 1000; c.put(`b${key(i)}`.slice(0, 64).replace(/[^0-9a-f]/g, "b"), entry(100)); }
  const total = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  assert.ok(total <= 2700, `dir ${total} bytes`);
  assert.ok(c.get(key(1)), "recently used entry survives");
  assert.equal(c.get(key(2)), null, "least recently used entry is evicted");
});

// Fake upstream: counts calls, answers per path, can be told what status/body to return.
function fakeUpstream() {
  const state = { calls: 0, headers: [], reply: null };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      state.calls++;
      state.headers.push(req.headers);
      if (state.reply) { const r = state.reply(req, raw); res.writeHead(r.status, { "content-type": r.type ?? "application/json" }).end(r.body); return; }
      if (/stream/.test(raw)) {
        res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", n: state.calls, usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

async function harness(t, extra = {}) {
  const up = await fakeUpstream();
  const dir = join(tmp(), "cache");
  const cache = createResponseCache({ dir, ttlMs: 3_600_000, ...(extra.cacheOpts ?? {}) });
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url, anthropic: up.url, gemini: up.url }, onReceipt: (r) => receipts.push(r), cache: extra.noCache ? null : cache, ...(extra.proxy ?? {}) });
  t.after(() => { server.closeAllConnections(); server.close(); up.server.close(); });
  const call = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { up, dir, cache, receipts, call };
}

test("never-cache cases always go upstream (AC2)", async (t) => {
  const h = await harness(t);
  const chat = "/openai/v1/chat/completions";
  const twice = async (path, body, headersA = {}, headersB = headersA) => {
    const before = h.up.state.calls;
    const a = await h.call(path, body, headersA); await a.text();
    const b = await h.call(path, body, headersB); const bh = b.headers.get("x-costcap-cache"); await b.text();
    return { upstream: h.up.state.calls - before, header: bh };
  };
  assert.equal((await twice(chat, { temperature: 0, model: "gpt-4o-mini", x: 1 }, { authorization: "Bearer A" }, { authorization: "Bearer B" })).upstream, 2);
  assert.equal((await twice(chat, { temperature: 0, model: "gpt-4o-mini", x: 2 }, { "x-api-key": "A" }, { "x-api-key": "B" })).upstream, 2);
  assert.equal((await twice(chat, { temperature: 0, model: "gpt-4o-mini", x: 3 }, { "anthropic-version": "1" }, { "anthropic-version": "2" })).upstream, 2);
  assert.deepEqual(await twice(chat, { model: "gpt-4o-mini" }), { upstream: 2, header: "bypass" });
  assert.deepEqual(await twice(chat, { model: "gpt-4o-mini", temperature: 0.7 }), { upstream: 2, header: "bypass" });
  assert.deepEqual(await twice(chat, { model: "gpt-4o-mini", temperature: 0, n: 2 }), { upstream: 2, header: "bypass" });
  // Body differing by one byte.
  let before = h.up.state.calls;
  await (await h.call(chat, '{"temperature":0,"model":"gpt-4o-mini","q":"a"}')).text();
  await (await h.call(chat, '{"temperature":0,"model":"gpt-4o-mini","q":"b"}')).text();
  assert.equal(h.up.state.calls - before, 2);
  // Gemini ?key=
  before = h.up.state.calls;
  const gem = { generationConfig: { temperature: 0 } };
  h.up.state.reply = () => ({ status: 200, body: JSON.stringify({ modelVersion: "gemini-2.5-flash", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) });
  await (await h.call("/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=AAA", gem)).text();
  await (await h.call("/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=BBB", gem)).text();
  assert.equal(h.up.state.calls - before, 2);
  h.up.state.reply = null;
  // Request bypass header: skips lookup and is never forwarded.
  const body = { temperature: 0, model: "gpt-4o-mini", q: "bypass" };
  await (await h.call(chat, body)).text();
  before = h.up.state.calls;
  const by = await h.call(chat, body, { "x-costcap-cache": "bypass" });
  assert.equal(by.headers.get("x-costcap-cache"), "bypass");
  await by.text();
  assert.equal(h.up.state.calls - before, 1);
  assert.equal(h.up.state.headers.at(-1)["x-costcap-cache"], undefined);
  // stream: true bypasses and the SSE passes through.
  const s = await h.call(chat, { temperature: 0, model: "gpt-4o-mini", stream: true });
  assert.equal(s.headers.get("x-costcap-cache"), "bypass");
  assert.match(await s.text(), /"content":"hi"/);
});

test("TTL expiry sends the next call upstream (AC2)", async (t) => {
  let now = 1_000_000;
  const up = await fakeUpstream();
  const cache = createResponseCache({ dir: join(tmp(), "c"), ttlMs: 1000, now: () => now });
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url }, cache });
  t.after(() => { server.closeAllConnections(); server.close(); up.server.close(); });
  const call = () => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: '{"temperature":0,"model":"gpt-4o-mini"}' }).then((r) => r.headers.get("x-costcap-cache"));
  assert.equal(await call(), "miss");
  assert.equal(await call(), "hit");
  now += 1001;
  assert.equal(await call(), "miss");
  assert.equal(up.state.calls, 2);
});

test("provider errors, unknown or unpriced cost and batch creates are never stored (AC3)", async (t) => {
  const h = await harness(t);
  const chat = "/openai/v1/chat/completions";
  const cases = [
    () => ({ status: 429, body: JSON.stringify({ error: { type: "rate_limit" } }) }),
    () => ({ status: 400, body: JSON.stringify({ error: { type: "bad" } }) }),
    () => ({ status: 200, body: JSON.stringify({ model: "gpt-4o-mini" }) }), // usage_unavailable
    () => ({ status: 200, body: JSON.stringify({ model: "gpt-4o-mini", output: [{ type: "web_search_call" }], usage: { input_tokens: 1, output_tokens: 1 } }) }), // tool_use_unpriced
  ];
  // Rejections leave the run open, so the repeat goes upstream again.
  for (const [i, reply] of cases.slice(0, 2).entries()) {
    h.up.state.reply = reply;
    const body = { temperature: 0, model: "gpt-4o-mini", case: i };
    const before = h.up.state.calls;
    await (await h.call(chat, body)).text();
    await (await h.call(chat, body)).text();
    assert.equal(h.up.state.calls - before, 2, `case ${i}`);
  }
  assert.equal(readdirSync(h.dir).length, 0);
  // Unknown cost latches an accounting block (as today): nothing stored and the repeat is never a hit.
  for (const [i, reply] of cases.slice(2).entries()) {
    const u = await harness(t);
    u.up.state.reply = reply;
    const body = { temperature: 0, model: "gpt-4o-mini", case: i };
    await (await u.call(chat, body)).text();
    assert.equal(readdirSync(u.dir).length, 0, `case ${i + 2}`);
    const again = await u.call(chat, body);
    assert.notEqual(again.headers.get("x-costcap-cache"), "hit");
    await again.text();
    assert.ok(!u.receipts.some((r) => r.reason === "cache_hit"));
    assert.ok(u.receipts.some((r) => r.reason === (i === 0 ? "usage_unavailable" : "tool_use_unpriced")));
  }
});

test("batch_pending create is never stored", async (t) => {
  const h = await harness(t);
  h.up.state.reply = () => ({ status: 200, body: JSON.stringify({ id: "batch_abc", object: "batch" }) });
  const body = { temperature: 0, input_file_id: "f", endpoint: "/v1/chat/completions" };
  const r = await h.call("/openai/v1/batches", body);
  assert.equal(r.headers.get("x-costcap-cache"), null);
  await r.text();
  assert.equal(h.receipts.at(-1).reason, "batch_pending");
  assert.equal(readdirSync(h.dir).length, 0);
});

test("cache dir holds no API key, request body or auth header values (AC5)", async (t) => {
  const h = await harness(t);
  const secretBody = { temperature: 0, model: "gpt-4o-mini", messages: [{ role: "user", content: "SECRET-PROMPT-TEXT" }] };
  await (await h.call("/openai/v1/chat/completions", secretBody, { authorization: "Bearer sk-SECRET-AUTH", "x-api-key": "SECRET-XKEY" })).text();
  h.up.state.reply = () => ({ status: 200, body: JSON.stringify({ modelVersion: "gemini-2.5-flash", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) });
  await (await h.call("/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=SECRET-QUERY-KEY", { generationConfig: { temperature: 0 } })).text();
  const files = readdirSync(h.dir);
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.equal(statSync(join(h.dir, f)).mode & 0o777, 0o600);
    const text = readFileSync(join(h.dir, f), "utf8");
    const decoded = Buffer.from(JSON.parse(text).body_b64, "base64").toString();
    for (const s of ["SECRET-PROMPT-TEXT", "sk-SECRET-AUTH", "SECRET-XKEY", "SECRET-QUERY-KEY"]) {
      assert.ok(!text.includes(s) && !decoded.includes(s), `${f} contains ${s}`);
    }
  }
  assert.equal(statSync(h.dir).mode & 0o777, 0o700);
});

test("--cache-max-mb 1: writing past the cap evicts and the dir stays <= 1 MB (AC5)", async (t) => {
  const big = "y".repeat(60_000);
  const h = await harness(t, { cacheOpts: { maxBytes: 1024 * 1024 } });
  h.up.state.reply = () => ({ status: 200, body: JSON.stringify({ model: "gpt-4o-mini", pad: big, usage: { prompt_tokens: 1, completion_tokens: 1 } }) });
  for (let i = 0; i < 25; i++) await (await h.call("/openai/v1/chat/completions", { temperature: 0, model: "gpt-4o-mini", i })).text();
  const total = readdirSync(h.dir).reduce((n, f) => n + statSync(join(h.dir, f)).size, 0);
  assert.ok(total <= 1024 * 1024, `dir is ${total} bytes`);
  assert.ok(readdirSync(h.dir).length < 25);
});
