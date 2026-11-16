// CC-6: real-time SSE pass-through with metering from the stream (#115).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSseUsageParser, extractUsage, startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { costForUsage } from "../src/pricing.js";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const tick = () => new Promise((r) => setTimeout(r, 20));

const OPENAI_EVENTS = [
  'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"he"}}]}\n\n',
  'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"llo"}}]}\n\n',
  'data: {"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":500000,"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
  "data: [DONE]\n\n",
];
const ANTHROPIC_EVENTS = [
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1000,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2000}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function fakeUpstream(events, { gapMs = 200, cutAfter, onClose } = {}) {
  const state = { sent: [], finishedAt: 0, closed: false };
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.on("close", () => { state.closed = true; onClose?.(); });
    let i = 0;
    const next = () => {
      if (res.destroyed) return;
      if (cutAfter !== undefined && i === cutAfter) { res.destroy(); return; }
      if (i === events.length) { state.finishedAt = Date.now(); res.end(); return; }
      state.sent.push(events[i]); res.write(events[i++]);
      setTimeout(next, gapMs);
    };
    next();
  });
  return { server, state };
}

async function setup(t, events, opts = {}, proxyOpts = {}) {
  const up = fakeUpstream(events, opts);
  const port = await listen(up.server);
  const receipts = [];
  const base = `http://127.0.0.1:${port}`;
  const { server, port: proxy } = await startMeteringProxy({ upstreams: { openai: base, anthropic: base },
    onReceipt: (r) => receipts.push(r), ...proxyOpts });
  t.after(() => { server.closeAllConnections(); server.close(); up.server.closeAllConnections(); up.server.close(); });
  return { up, proxy, receipts };
}

// Caller opted in to include_usage, so the usage chunk is forwarded unchanged (#152).
async function streamCall(proxy, path, body = '{"stream":true,"stream_options":{"include_usage":true}}') {
  const res = await fetch(`http://127.0.0.1:${proxy}${path}`, { method: "POST", body });
  const chunks = [];
  let firstAt = 0;
  for await (const c of res.body) { if (!firstAt) firstAt = Date.now(); chunks.push(Buffer.from(c)); }
  return { res, firstAt, body: Buffer.concat(chunks).toString("utf8") };
}

test("parser: split lines, multi-line data, CRLF and [DONE]", () => {
  const p = createSseUsageParser("openai");
  const text = 'data: {"model":"gpt-4o-mini",\r\ndata: "usage":{"prompt_tokens":10,"completion_tokens":5}}\r\n\r\ndata: [DONE]\n\n';
  for (const ch of text) p.push(ch); // worst case: one character per network chunk
  assert.equal(p.done, true);
  assert.deepEqual(p.end(), { model: "gpt-4o-mini", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } });
});

test("parser: no usage yields null; non-JSON and comments are ignored; trailing line without newline is parsed", () => {
  const p = createSseUsageParser("openai", "gpt-4o");
  p.push(": keepalive\n\nevent: ping\ndata: not json\n\n");
  assert.equal(p.usage(), null);
  assert.equal(p.done, false);
  p.push('data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}');
  assert.deepEqual(p.end(), { model: "gpt-4o", usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 } });
});

test("parser: Anthropic message_start + message_delta usage combine", () => {
  const p = createSseUsageParser("anthropic");
  p.push(ANTHROPIC_EVENTS.join("").slice(0, 50));
  p.push(ANTHROPIC_EVENTS.join("").slice(50));
  const u = p.end();
  assert.equal(u.model, "claude-sonnet-4-6");
  assert.equal(u.usage.input_tokens, 1000);
  assert.equal(u.usage.output_tokens, 2000);
});

for (const [name, provider, path, events] of [
  ["OpenAI", "openai", "/openai/v1/chat/completions", OPENAI_EVENTS],
  ["Anthropic", "anthropic", "/anthropic/v1/messages", ANTHROPIC_EVENTS],
]) {
  test(`${name}: first chunk arrives before upstream finishes, bytes identical, cost matches non-streamed`, async (t) => {
    const { up, proxy, receipts } = await setup(t, events);
    const { res, firstAt, body } = await streamCall(proxy, path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.ok(up.state.finishedAt > 0 && firstAt < up.state.finishedAt, "first chunk must precede upstream end");
    assert.ok(up.state.finishedAt - firstAt >= 400, "streamed, not buffered");
    assert.equal(body, events.join(""));
    await tick();
    assert.equal(receipts.length, 1);
    const expected = extractUsage(provider, events.join(""));
    assert.equal(receipts[0].cost_usd, costForUsage(expected.model, expected.usage).cost_usd);
    assert.ok(receipts[0].cost_usd > 0);
  });
}

test("stream cut by upstream before usage records stream_incomplete and blocks the next call", async (t) => {
  const { proxy, receipts } = await setup(t, OPENAI_EVENTS, { gapMs: 20, cutAfter: 1 });
  await assert.rejects(streamCall(proxy, "/openai/v1/chat/completions"));
  await tick();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].cost_usd, null);
  assert.equal(receipts[0].reason, "stream_incomplete");
  const next = await fetch(`http://127.0.0.1:${proxy}/openai/v1/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(next.status, 429);
  assert.equal((await next.json()).error, "accounting_unavailable");
});

test("client abort mid-stream closes the upstream request and writes the incomplete receipt", async (t) => {
  let upstreamClosed;
  const closed = new Promise((r) => { upstreamClosed = r; });
  const { up, proxy, receipts } = await setup(t, OPENAI_EVENTS, { gapMs: 300, onClose: () => upstreamClosed() });
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${proxy}/openai/v1/chat/completions`, { method: "POST", body: "{}", signal: ac.signal });
  const reader = res.body.getReader();
  await reader.read();
  ac.abort();
  await closed;
  assert.equal(up.state.closed, true);
  assert.ok(up.state.sent.length < OPENAI_EVENTS.length, "upstream stopped early");
  for (let i = 0; i < 50 && !receipts.length; i++) await tick();
  assert.equal(receipts[0].reason, "stream_incomplete");
  assert.equal(receipts[0].cost_usd, null);
});

test("#154 idle timeout mid-stream (gap longer than streamIdleMs) is treated as a cut stream", async (t) => {
  const { receipts, proxy } = await setup(t, OPENAI_EVENTS, { gapMs: 300 }, { streamIdleMs: 150 });
  await assert.rejects(streamCall(proxy, "/openai/v1/chat/completions"));
  for (let i = 0; i < 50 && !receipts.length; i++) await tick();
  assert.equal(receipts[0].reason, "stream_incomplete");
});

test("a stream that ends cleanly without usage (even after injection) is usage_unavailable", async (t) => {
  const { proxy, receipts } = await setup(t, [OPENAI_EVENTS[0], OPENAI_EVENTS[3]], { gapMs: 5 });
  const { body } = await streamCall(proxy, "/openai/v1/chat/completions");
  assert.equal(body, OPENAI_EVENTS[0] + OPENAI_EVENTS[3]);
  await tick();
  assert.equal(receipts[0].reason, "usage_unavailable");
  assert.equal(receipts[0].cost_usd, null);
});

test("a cap hit by a streamed call's cost blocks the next call (in-flight call may overshoot)", async (t) => {
  const { proxy, receipts } = await setup(t, OPENAI_EVENTS, { gapMs: 5 }, { cap: createCapEngine({ caps: { run: 0.10 } }) });
  const first = await streamCall(proxy, "/openai/v1/chat/completions");
  assert.equal(first.res.status, 200);
  assert.equal(first.body, OPENAI_EVENTS.join(""));
  const next = await fetch(`http://127.0.0.1:${proxy}/openai/v1/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(next.status, 429);
  await tick();
  assert.ok(receipts[0].cost_usd > 0.10, "the in-flight streamed call overshot the cap");
  assert.equal(receipts.at(-1).reason, "budget_exceeded");
});

test("#138 a streamed final chunk with usage: {} is unknown (usage_unavailable), not $0", async (t) => {
  const events = ['data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: {"model":"gpt-4o-mini","choices":[],"usage":{}}\n\n', "data: [DONE]\n\n"];
  const parser = createSseUsageParser("openai", "gpt-4o-mini");
  for (const e of events) parser.push(e);
  assert.equal(parser.end(), null);
  const up = fakeUpstream(events, { gapMs: 5 });
  const upPort = await listen(up.server);
  const receipts = [];
  const proxy = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${upPort}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { proxy.server.closeAllConnections(); proxy.server.close(); up.server.closeAllConnections(); up.server.close(); });
  const r = await fetch(`http://127.0.0.1:${proxy.port}/openai/v1/chat/completions`, { method: "POST", body: '{"model":"gpt-4o-mini","stream":true}' });
  await r.text();
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "usage_unavailable"]);
  const r2 = await fetch(`http://127.0.0.1:${proxy.port}/openai/v1/chat/completions`, { method: "POST", body: '{"model":"gpt-4o-mini","stream":true}' });
  assert.equal(r2.status, 429);
});

// #142: tool billing in streams.
test("#142 Anthropic stream with server_tool_use in message_delta → tool_use_unpriced, next call paused", async (t) => {
  const events = [ANTHROPIC_EVENTS[0], ANTHROPIC_EVENTS[1],
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":20,"server_tool_use":{"web_search_requests":1}}}\n\n', ANTHROPIC_EVENTS[3]];
  const { proxy, receipts } = await setup(t, events, { gapMs: 5 });
  const { res } = await streamCall(proxy, "/anthropic/v1/messages");
  assert.equal(res.status, 200);
  await tick();
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "tool_use_unpriced"]);
  const next = await fetch(`http://127.0.0.1:${proxy}/anthropic/v1/messages`, { method: "POST", body: "{}" });
  assert.equal(next.status, 429);
  assert.equal((await next.json()).error, "accounting_unavailable");
});

test("#142 Responses stream with a web_search_call item → tool_use_unpriced; parser sees item events and completed output", () => {
  const usage = '"usage":{"input_tokens":10,"output_tokens":5}';
  const viaItem = createSseUsageParser("openai");
  viaItem.push('data: {"type":"response.output_item.done","item":{"type":"web_search_call"}}\n\n');
  viaItem.push(`data: {"type":"response.completed","response":{"model":"gpt-4o-mini",${usage}}}\n\n`);
  assert.equal(viaItem.end().toolUseUnpriced, true);
  const viaCompleted = createSseUsageParser("openai");
  viaCompleted.push(`data: {"type":"response.completed","response":{"model":"gpt-4o-mini","output":[{"type":"file_search_call"}],${usage}}}\n\n`);
  assert.equal(viaCompleted.end().toolUseUnpriced, true);
  const plain = createSseUsageParser("openai");
  plain.push(`data: {"type":"response.completed","response":{"model":"gpt-4o-mini","output":[{"type":"message"}],${usage}}}\n\n`);
  assert.equal(plain.end().toolUseUnpriced, undefined);
});

test("#142 Responses stream through the proxy with web_search_call pauses the run", async (t) => {
  const events = ['data: {"type":"response.output_item.added","item":{"type":"web_search_call"}}\n\n',
    'data: {"type":"response.completed","response":{"model":"gpt-4o-mini","usage":{"input_tokens":10,"output_tokens":5}}}\n\n'];
  const { proxy, receipts } = await setup(t, events, { gapMs: 5 });
  await streamCall(proxy, "/openai/v1/responses");
  await tick();
  assert.equal(receipts[0].reason, "tool_use_unpriced");
  assert.equal((await fetch(`http://127.0.0.1:${proxy}/openai/v1/responses`, { method: "POST", body: "{}" })).status, 429);
});

// #166: Anthropic message_start carries placeholder usage; only message_stop makes the stream complete.
const ANT_DELTA = (n) => `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tok${n}"}}\n\n`;
const ANT_OVERLOADED = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';

async function expectBlocked(proxy, receipts) {
  for (let i = 0; i < 50 && !receipts.length; i++) await tick();
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "stream_incomplete"]);
  const next = await fetch(`http://127.0.0.1:${proxy}/anthropic/v1/messages`, { method: "POST", body: "{}" });
  assert.equal(next.status, 429);
  assert.equal((await next.json()).error, "accounting_unavailable");
}

test("#166 Anthropic client abort after message_start → stream_incomplete (not priced at placeholder usage), next call blocked", async (t) => {
  let upstreamClosed;
  const closed = new Promise((r) => { upstreamClosed = r; });
  const { proxy, receipts } = await setup(t, ANTHROPIC_EVENTS, { gapMs: 300, onClose: () => upstreamClosed() });
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${proxy}/anthropic/v1/messages`, { method: "POST", body: "{}", signal: ac.signal });
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /message_start/);
  ac.abort();
  await closed;
  await expectBlocked(proxy, receipts);
});

test("#166 Anthropic upstream close after content_block_deltas → stream_incomplete, next call blocked", async (t) => {
  const events = [ANTHROPIC_EVENTS[0], ANT_DELTA(1), ANT_DELTA(2), ANT_DELTA(3), ANTHROPIC_EVENTS[2], ANTHROPIC_EVENTS[3]];
  const { proxy, receipts } = await setup(t, events, { gapMs: 10, cutAfter: 4 });
  await assert.rejects(streamCall(proxy, "/anthropic/v1/messages"));
  await expectBlocked(proxy, receipts);
});

test("#166 Anthropic stream that ends cleanly without message_stop → stream_incomplete", async (t) => {
  const { proxy, receipts } = await setup(t, [ANTHROPIC_EVENTS[0], ANT_DELTA(1)], { gapMs: 5 });
  const { res } = await streamCall(proxy, "/anthropic/v1/messages");
  assert.equal(res.status, 200);
  await expectBlocked(proxy, receipts);
});

test("#166 Anthropic mid-stream overloaded_error → stream_incomplete even if message_stop follows", async (t) => {
  for (const tail of [[], [ANTHROPIC_EVENTS[3]]]) {
    const { proxy, receipts } = await setup(t, [ANTHROPIC_EVENTS[0], ANT_DELTA(1), ANT_OVERLOADED, ...tail], { gapMs: 5 });
    const { res, body } = await streamCall(proxy, "/anthropic/v1/messages");
    assert.equal(res.status, 200);
    assert.match(body, /overloaded_error/);
    await expectBlocked(proxy, receipts);
  }
});

test("#166 complete Anthropic stream is priced from message_delta's final output_tokens", async (t) => {
  const { proxy, receipts } = await setup(t, ANTHROPIC_EVENTS, { gapMs: 5 });
  await streamCall(proxy, "/anthropic/v1/messages");
  for (let i = 0; i < 50 && !receipts.length; i++) await tick();
  assert.equal(receipts[0].output_tokens, 2000);
  assert.equal(receipts[0].cost_usd, costForUsage("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 2000 }).cost_usd);
  const p = createSseUsageParser("anthropic");
  p.push(ANTHROPIC_EVENTS.slice(0, 3).join(""));
  assert.equal(p.incomplete, true, "no message_stop yet");
  p.push(ANTHROPIC_EVENTS[3]);
  assert.equal(p.incomplete, false);
});

test("#166 Gemini stream: cumulative usageMetadata without finishReason is incomplete; finishReason or prompt block completes it", () => {
  const usage = '"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}';
  const p = createSseUsageParser("gemini", "gemini-2.5-pro");
  p.push(`data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}],${usage}}\n\n`);
  assert.equal(p.incomplete, true);
  p.push(`data: {"candidates":[{"content":{"parts":[{"text":"b"}]},"finishReason":"STOP"}],${usage}}\n\n`);
  assert.equal(p.incomplete, false);
  const blocked = createSseUsageParser("gemini", "gemini-2.5-pro");
  blocked.push(`data: {"promptFeedback":{"blockReason":"SAFETY"},${usage}}\n\n`);
  assert.equal(blocked.incomplete, false);
  // Non-streamed JSON bodies never consult incomplete; usage-only chunks (no candidates) are not treated as streams.
  const bare = createSseUsageParser("gemini", "gemini-2.5-pro");
  bare.push(`data: {${usage}}\n\n`);
  assert.equal(bare.incomplete, false);
});

// #184: with --cache on, temperature-0 streams bypass the cache and pass through unchanged.
import { createResponseCache } from "../src/response-cache.js";
import { mkdtempSync as mkdtemp184, readdirSync as readdir184 } from "node:fs";
import { tmpdir as tmpdir184 } from "node:os";
import { join as join184 } from "node:path";

for (const [name, path, body] of [
  ["OpenAI", "/openai/v1/chat/completions", '{"stream":true,"temperature":0,"stream_options":{"include_usage":true}}'],
  ["Anthropic", "/anthropic/v1/messages", '{"stream":true,"temperature":0}'],
]) {
  test(`#184 ${name}: a stream with --cache is a bypass, streamed byte-identical and never stored`, async (t) => {
    const dir = join184(mkdtemp184(join184(tmpdir184(), "cc-cache-sse-")), "cache");
    const events = name === "OpenAI" ? OPENAI_EVENTS : ANTHROPIC_EVENTS;
    const { up, proxy, receipts } = await setup(t, events, { gapMs: 20 }, { cache: createResponseCache({ dir, ttlMs: 3_600_000 }) });
    for (let i = 0; i < 2; i++) {
      const { res, body: text } = await streamCall(proxy, path, body);
      assert.equal(res.headers.get("x-costcap-cache"), "bypass");
      assert.equal(text, events.join(""));
    }
    await tick();
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((r) => r.cache === "bypass" && r.cost_usd > 0));
    assert.equal(readdir184(dir).length, 0);
    assert.ok(up.state.sent.length >= events.length * 2);
  });
}
