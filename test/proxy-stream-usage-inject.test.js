// #152: inject stream_options.include_usage for OpenAI/OpenRouter chat streams, hide the extra chunk.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createUsageChunkFilter, injectStreamUsage, startMeteringProxy } from "../src/proxy.js";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const tick = () => new Promise((r) => setTimeout(r, 20));
const CONTENT = [
  'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"he"}}]}\n\n',
  'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"llo"}}]}\n\n',
];
const USAGE = 'data: {"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"prompt_tokens_details":{"cached_tokens":0}}}\n\n';
const DONE = "data: [DONE]\n\n";

// Fake upstream that honours include_usage, records each forwarded request.
async function setup(t) {
  const seen = [];
  const up = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      seen.push({ url: req.url, raw, length: req.headers["content-length"] });
      let j = {}; try { j = JSON.parse(raw); } catch { /* */ }
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Split mid-event to exercise the filter's buffering.
        const all = CONTENT.join("") + (j.stream_options?.include_usage ? USAGE : "") + DONE;
        const cut = all.indexOf("choices", CONTENT.join("").length);
        res.write(all.slice(0, cut > 0 ? cut : all.length));
        setTimeout(() => res.end(cut > 0 ? all.slice(cut) : ""), 10);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
    });
  });
  const port = await listen(up);
  const base = `http://127.0.0.1:${port}`;
  const receipts = [];
  const { server, port: proxy } = await startMeteringProxy({ upstreams: { openai: base, openrouter: base, anthropic: base, gemini: base },
    onReceipt: (r) => receipts.push(r) });
  t.after(() => { server.closeAllConnections(); server.close(); up.closeAllConnections(); up.close(); });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${proxy}${path}`, { method: "POST", body });
    return { status: res.status, text: await res.text() };
  };
  return { seen, receipts, call };
}

test("default OpenAI stream: include_usage injected, usage chunk metered but hidden, run not paused", async (t) => {
  const { seen, receipts, call } = await setup(t);
  const sent = '{"model":"gpt-4o-mini","stream":true,"messages":[]}';
  const r = await call("/openai/v1/chat/completions", sent);
  assert.equal(r.text, CONTENT.join("") + DONE);
  const fwd = JSON.parse(seen[0].raw);
  assert.deepEqual(fwd.stream_options, { include_usage: true });
  assert.equal(Number(seen[0].length), Buffer.byteLength(seen[0].raw));
  await tick();
  assert.equal(receipts[0].reason, undefined);
  assert.ok(receipts[0].cost_usd > 0);
  const again = await call("/openai/v1/chat/completions", sent);
  assert.equal(again.status, 200, "run is not paused");
});

test("include_usage:false is overridden and other stream_options keys preserved (OpenRouter)", async (t) => {
  const { seen, receipts, call } = await setup(t);
  const r = await call("/openrouter/api/v1/chat/completions", '{"model":"gpt-4o-mini","stream":true,"stream_options":{"include_usage":false,"include_obfuscation":false}}');
  assert.equal(r.text, CONTENT.join("") + DONE);
  assert.deepEqual(JSON.parse(seen[0].raw).stream_options, { include_usage: true, include_obfuscation: false });
  await tick();
  assert.ok(receipts[0].cost_usd > 0);
});

test("caller-requested include_usage: body byte-identical and usage chunk forwarded", async (t) => {
  const { seen, call } = await setup(t);
  const sent = '{"model":"gpt-4o-mini", "stream":true, "stream_options":{"include_usage":true}}';
  const r = await call("/openai/v1/chat/completions", sent);
  assert.equal(seen[0].raw, sent);
  assert.equal(r.text, CONTENT.join("") + USAGE + DONE);
});

test("non-streaming, Responses, Anthropic and Gemini requests are forwarded byte-identical", async (t) => {
  const cases = [
    ["/openai/v1/chat/completions", '{"model":"gpt-4o-mini",  "messages":[]}'],
    ["/openai/v1/responses", '{"model":"gpt-4o-mini", "stream":true}'],
    ["/anthropic/v1/messages", '{"model":"claude-sonnet-4-6", "stream":true}'],
    ["/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent", '{"stream":true}'],
  ];
  for (const [path, body] of cases) {
    const { seen, call } = await setup(t); // fresh proxy: an unterminated stream pauses the run
    await call(path, body);
    assert.equal(seen[0].raw, body, path);
  }
});

test("injectStreamUsage unit cases", () => {
  assert.equal(injectStreamUsage("openai", "POST", "/v1/chat/completions", Buffer.from("not json")), null);
  assert.equal(injectStreamUsage("openai", "POST", "/v1/chat/completions", Buffer.from('{"stream":false}')), null);
  assert.equal(injectStreamUsage("openai", "GET", "/v1/chat/completions", Buffer.from('{"stream":true}')), null);
  assert.equal(injectStreamUsage("anthropic", "POST", "/v1/chat/completions", Buffer.from('{"stream":true}')), null);
  assert.equal(injectStreamUsage("openai", "POST", "/v1/chat/completions", Buffer.from('{"stream":true,"stream_options":"x"}')), null);
  assert.deepEqual(JSON.parse(injectStreamUsage("openai", "POST", "/v1/chat/completions", Buffer.from('{"stream":true,"stream_options":null}'))).stream_options, { include_usage: true });
});

test("usage chunk filter handles CRLF, split events and trailing data", () => {
  const f = createUsageChunkFilter();
  let out = f.push('data: {"choices":[{"delta":{}}]}\r\n\r\ndata: {"choices":[],"us');
  out += f.push('age":{"prompt_tokens":1}}\r\n\r\n: comment\n\ndata: [DONE]');
  out += f.end();
  assert.equal(out, 'data: {"choices":[{"delta":{}}]}\r\n\r\n: comment\n\ndata: [DONE]');
});

// #186 AC3: custom OpenAI-compatible upstreams get the same include_usage injection.
test("custom upstream stream: include_usage injected and priced from user prices; cut stream is stream_incomplete", async (t) => {
  const prices = { version: "t", sha256: "x", upstreams: { groq: { "gpt-4o-mini": { input: 1, output: 2 } } } };
  assert.ok(injectStreamUsage("u/groq", "POST", "/v1/chat/completions", Buffer.from('{"stream":true}')));
  assert.equal(injectStreamUsage("u/groq", "POST", "/v1/embeddings", Buffer.from('{"stream":true}')), null);
  const seen = [];
  let cut = false;
  const up = http.createServer((req, res) => {
    const parts = []; req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      seen.push(Buffer.concat(parts).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(CONTENT.join(""));
      if (cut) { setTimeout(() => res.destroy(), 10); return; }
      res.end((JSON.parse(seen.at(-1)).stream_options?.include_usage ? USAGE : "") + DONE);
    });
  });
  const base = `http://127.0.0.1:${await listen(up)}`;
  const receipts = [];
  const { server, port } = await startMeteringProxy({ customUpstreams: { groq: base }, userPrices: prices, onReceipt: (r) => receipts.push(r) });
  t.after(() => { server.closeAllConnections(); server.close(); up.closeAllConnections(); up.close(); });
  const res = await fetch(`http://127.0.0.1:${port}/u/groq/v1/chat/completions`, { method: "POST", body: '{"model":"gpt-4o-mini","stream":true}' });
  assert.equal(await res.text(), CONTENT.join("") + DONE);
  assert.deepEqual(JSON.parse(seen[0]).stream_options, { include_usage: true });
  await tick();
  assert.equal(receipts[0].provider, "u/groq");
  assert.equal(receipts[0].cost_usd, Number(((1000 * 1 + 500 * 2) / 1e6).toFixed(6)));
  assert.equal(receipts[0].cost_source, "user_prices");
  cut = true;
  const { server: s2, port: p2 } = await startMeteringProxy({ customUpstreams: { groq: base }, userPrices: prices, onReceipt: (r) => receipts.push(r) });
  t.after(() => { s2.closeAllConnections(); s2.close(); });
  await fetch(`http://127.0.0.1:${p2}/u/groq/v1/chat/completions`, { method: "POST", body: '{"model":"gpt-4o-mini","stream":true}' }).then((r) => r.text()).catch(() => {});
  await tick();
  assert.equal(receipts.at(-1).reason, "stream_incomplete");
});
