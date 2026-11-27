// #239 unit: receipt -> OTLP span mapping, trace ids, request shape, headers, URLs, batching bounds.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createOtlpExporter, encodeRequest, operationName, parseOtlpHeaders, parseOtlpUrl, receiptToSpan, runSpan, traceIdFor } from "../src/otlp.js";

const get = (span, key) => { const a = span.attributes.find((x) => x.key === key); return a && Object.values(a.value)[0]; };
const base = { id: "r1", ts: "2026-11-16T00:00:01.000Z", provider: "openai", path: "/v1/chat/completions", status: 200, blocked: false, model: "gpt-4o-mini", run_id: "RUN", input_tokens: 10, output_tokens: 5, cost_usd: 0.25 };

test("metered receipt maps to a GenAI CLIENT span", () => {
  const s = receiptToSpan({ ...base, cached_input_tokens: 3, cache_write_input_tokens: 2, cache_write_1h_input_tokens: 1, tags: { team: "x" }, agent_id: "a" }, { startMs: Date.parse(base.ts) - 500, traceId: traceIdFor("RUN"), parentSpanId: "p" });
  assert.equal(s.name, "chat gpt-4o-mini");
  assert.equal(s.kind, 3);
  assert.equal(s.parentSpanId, "p");
  assert.equal(s.startTimeUnixNano, String((Date.parse(base.ts) - 500) * 1e6));
  assert.equal(s.endTimeUnixNano, String(Date.parse(base.ts)) + "000000");
  assert.equal(get(s, "gen_ai.usage.input_tokens"), "10");
  assert.equal(get(s, "gen_ai.usage.output_tokens"), "5");
  assert.equal(get(s, "gen_ai.usage.cache_read.input_tokens"), "3");
  assert.equal(get(s, "gen_ai.usage.cache_creation.input_tokens"), "3");
  assert.equal(get(s, "gen_ai.usage.cost"), 0.25);
  assert.equal(get(s, "costcap.cost_complete"), true);
  assert.equal(get(s, "costcap.tag.team"), "x");
  assert.equal(get(s, "costcap.agent_id"), "a");
  assert.equal(get(s, "gen_ai.provider.name"), "openai");
  assert.deepEqual(s.status, { code: 0 });
  assert.match(s.spanId, /^[0-9a-f]{16}$/);
});

test("unknown cost omits gen_ai.usage.cost; blocked and >=400 are ERROR", () => {
  const u = receiptToSpan({ ...base, cost_usd: null });
  assert.equal(get(u, "gen_ai.usage.cost"), undefined);
  assert.equal(get(u, "costcap.cost_complete"), false);
  const b = receiptToSpan({ ...base, blocked: true, reason: "budget_exceeded", status: 402, input_tokens: undefined });
  assert.deepEqual(b.status, { code: 2, message: "budget_exceeded" });
  assert.equal(get(b, "costcap.blocked"), true);
  assert.equal(get(b, "gen_ai.usage.input_tokens"), undefined);
  assert.equal(receiptToSpan({ ...base, status: 500 }).status.message, "status 500");
  assert.equal(receiptToSpan({ event: "cap_warning" }), null);
  assert.equal(receiptToSpan(null), null);
  // start after end / missing start fall back to end; bad ts falls back to now
  const n = receiptToSpan({ ...base, ts: "bad" }, { startMs: 1 });
  assert.equal(n.startTimeUnixNano, "1000000");
  assert.equal(receiptToSpan(base, { startMs: Date.parse(base.ts) + 9 }).startTimeUnixNano, receiptToSpan(base).endTimeUnixNano);
});

test("operation names", () => {
  assert.equal(operationName("/v1/embeddings"), "embeddings");
  assert.equal(operationName("/v1/live/sessions"), "live"); // #273
  assert.equal(operationName("/v1beta/models/gemini:generateContent?key=REDACTED"), "generate_content");
  assert.equal(operationName("/v1/completions"), "text_completion");
  assert.equal(operationName("/v1/messages"), "chat");
  assert.equal(operationName("/v1/realtime"), "realtime");
  assert.equal(operationName("/v1/files"), "files");
  assert.equal(operationName(""), "call");
  assert.equal(operationName(), "call");
});

test("trace id is stable per run_id and distinct across runs", () => {
  assert.equal(traceIdFor("a"), traceIdFor("a"));
  assert.notEqual(traceIdFor("a"), traceIdFor("b"));
  assert.match(traceIdFor("a"), /^[0-9a-f]{32}$/);
});

test("ExportTraceServiceRequest shape and run span", () => {
  const root = runSpan({ run_id: "R", total_cost_usd: null, unknown_cost_calls: 1, calls: 2, blocked_calls: 1, stopped_by: "budget_exceeded", exit_code: 0 }, { startMs: 1000, endMs: 2000, traceId: "t", spanId: "s" });
  assert.equal(get(root, "costcap.total_cost_usd"), undefined);
  assert.equal(get(root, "costcap.unknown_cost_calls"), "1");
  assert.equal(get(root, "costcap.stopped_by"), "budget_exceeded");
  assert.equal(root.status.code, 2);
  assert.equal(get(runSpan({ total_cost_usd: 0.5, calls: 1 }, { startMs: 1, endMs: 0, traceId: "t", spanId: "s" }), "costcap.total_cost_usd"), 0.5);
  const req = encodeRequest([root]);
  const rs = req.resourceSpans[0];
  assert.equal(rs.resource.attributes.find((a) => a.key === "service.name").value.stringValue, "costcap");
  assert.ok(rs.resource.attributes.find((a) => a.key === "service.version"));
  assert.equal(rs.scopeSpans[0].spans.length, 1);
  assert.equal(typeof root.startTimeUnixNano, "string");
});

test("headers parse k=v,k2=v2 and reject junk", () => {
  assert.deepEqual(parseOtlpHeaders("Authorization=Bearer x, x-tenant=a%20b"), { authorization: "Bearer x", "x-tenant": "a b" });
  assert.deepEqual(parseOtlpHeaders(""), {});
  assert.deepEqual(parseOtlpHeaders("a=%E0%A4%A,,"), { a: "%E0%A4%A" });
  assert.throws(() => parseOtlpHeaders("novalue"), /k=v/);
  assert.throws(() => parseOtlpHeaders("bad name=1"), /header name/);
  assert.throws(() => parseOtlpHeaders("a=%0d%0aX"), /header value/);
});

test("URL validation", () => {
  assert.deepEqual(parseOtlpUrl("http://127.0.0.1:4318"), { url: "http://127.0.0.1:4318/v1/traces", insecure: false });
  assert.deepEqual(parseOtlpUrl("https://otel.example.com/v1/traces"), { url: "https://otel.example.com/v1/traces", insecure: false });
  assert.equal(parseOtlpUrl("http://otel.example.com/").insecure, true);
  assert.throws(() => parseOtlpUrl("ftp://x"), /http\(s\)/);
  assert.throws(() => parseOtlpUrl("not a url"), /http\(s\)/);
  assert.throws(() => parseOtlpUrl("http://u:p@127.0.0.1:1"), /credentials/);
});

test("exporter batches at most maxBatch spans and bounds the queue", async () => {
  const posts = [];
  const ex = createOtlpExporter({ url: "http://x/v1/traces", runId: "R", post: async (u, h, body) => { posts.push(JSON.parse(body)); }, intervalMs: 60_000 });
  for (let i = 0; i < 250; i++) ex.add({ ...base, id: `r${i}` }, { startMs: 0 });
  ex.add({ event: "reconciliation" });
  const c = await ex.finish({ run_id: "R", calls: 250 }, { startMs: 0 });
  assert.deepEqual(c, { spans_exported: 251, spans_dropped: 0 });
  assert.ok(posts.length >= 3);
  const spans = posts.flatMap((p) => p.resourceSpans[0].scopeSpans[0].spans);
  assert.ok(posts.every((p) => p.resourceSpans[0].scopeSpans[0].spans.length <= 100));
  assert.equal(new Set(spans.map((s) => s.spanId)).size, 251);
  assert.ok(spans.every((s) => s.traceId === traceIdFor("R")));
  assert.deepEqual(await ex.finish({}), c); // idempotent
  ex.add(base); // ignored after finish
  assert.deepEqual(ex.counts(), c);

  const small = createOtlpExporter({ url: "http://x", runId: "R", maxQueue: 3, maxBatch: 100, post: async () => {}, intervalMs: 60_000 });
  for (let i = 0; i < 5; i++) small.add({ ...base, id: `q${i}` });
  assert.deepEqual(await small.finish({}, { startMs: 0 }), { spans_exported: 3, spans_dropped: 3 });
});

test("exporter failures warn once, count drops, honor the final deadline", async () => {
  const lines = [];
  const ex = createOtlpExporter({ url: "http://127.0.0.1:9/v1/traces", runId: "R", onWarning: (l) => lines.push(l), post: async () => { throw new Error("boom"); }, maxBatch: 1, intervalMs: 60_000 });
  ex.add(base); ex.add({ ...base, id: "r2" });
  assert.deepEqual(await ex.finish({}, { startMs: 0 }), { spans_exported: 0, spans_dropped: 3 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^costcap: warning: otlp/);

  const hang = createOtlpExporter({ url: "http://x", runId: "R", onWarning: (l) => lines.push(l), post: () => new Promise(() => {}), intervalMs: 60_000 });
  hang.add(base);
  const t0 = Date.now();
  assert.deepEqual(await hang.finish({}, { startMs: 0, deadlineMs: 50 }), { spans_exported: 0, spans_dropped: 2 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(lines.length, 2);

  const throwsWarn = createOtlpExporter({ url: "http://x", runId: "R", onWarning: () => { throw new Error("x"); }, post: async () => { throw new Error("y"); }, intervalMs: 60_000 });
  assert.deepEqual(await throwsWarn.finish({}, { startMs: 0 }), { spans_exported: 0, spans_dropped: 1 });
});

test("interval timer drains the queue", async () => {
  let n = 0;
  const ex = createOtlpExporter({ url: "http://x", runId: "R", post: async (u, h, b) => { n += JSON.parse(b).resourceSpans[0].scopeSpans[0].spans.length; }, intervalMs: 20 });
  ex.add(base);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(n, 1);
  await ex.finish({}, { startMs: 0 });
});

test("finish() settles at the deadline even when nothing else keeps the event loop alive", () => {
  // A hung post with no socket/timer of its own: an unref'd deadline would let the process exit with finish() pending.
  const src = new URL("../src/otlp.js", import.meta.url).href;
  const code = `import { createOtlpExporter } from ${JSON.stringify(src)};
const ex = createOtlpExporter({ url: "http://x", runId: "R", onWarning: () => {}, post: () => new Promise(() => {}), intervalMs: 60000 });
ex.add(${JSON.stringify(base)});
const c = await ex.finish({}, { startMs: 0, deadlineMs: 50 });
console.log(JSON.stringify(c));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { spans_exported: 0, spans_dropped: 2 });
});
