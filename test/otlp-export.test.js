// #239 unit: receipt -> span mapping, OTLP JSON shape, headers, URL checks, batch and queue bounds.
import test from "node:test";
import assert from "node:assert/strict";
import { createOtlpExporter, exportRequest, operationName, parseOtlpEndpoint, parseOtlpHeaders, receiptToSpan, runSpan, traceIdFor } from "../src/otlp.js";

const A = (span) => Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
const TS = "2026-11-16T12:00:01.000Z";
const metered = { id: "r1", ts: TS, run_id: "R", agent_id: "ag", provider: "openai", path: "/v1/chat/completions", status: 200, blocked: false, model: "gpt-4o-mini", input_tokens: 10, output_tokens: 5, cost_usd: 0.25, tags: { team: "x" } };

test("metered receipt -> CLIENT span with GenAI attributes and ns timestamps", () => {
  const start = Date.parse(TS) - 1500;
  const s = receiptToSpan(metered, { startedAt: start, traceId: traceIdFor("R"), parentSpanId: "00000000000000aa" });
  assert.equal(s.name, "chat gpt-4o-mini");
  assert.equal(s.kind, 3);
  assert.equal(s.parentSpanId, "00000000000000aa");
  assert.match(s.spanId, /^[0-9a-f]{16}$/);
  assert.equal(s.startTimeUnixNano, String(BigInt(start) * 1_000_000n));
  assert.equal(s.endTimeUnixNano, String(BigInt(Date.parse(TS)) * 1_000_000n));
  const a = A(s);
  assert.equal(a["gen_ai.provider.name"], "openai");
  assert.equal(a["gen_ai.operation.name"], "chat");
  assert.equal(a["gen_ai.request.model"], "gpt-4o-mini");
  assert.equal(a["gen_ai.usage.input_tokens"], "10");
  assert.equal(a["gen_ai.usage.output_tokens"], "5");
  assert.equal(a["gen_ai.usage.cost"], 0.25);
  assert.equal(a["costcap.cost_usd"], 0.25);
  assert.equal(a["costcap.cost_complete"], true);
  assert.equal(a["costcap.receipt_id"], "r1");
  assert.equal(a["costcap.run_id"], "R");
  assert.equal(a["costcap.agent_id"], "ag");
  assert.equal(a["costcap.blocked"], false);
  assert.equal(a["costcap.tag.team"], "x");
  assert.equal(a["http.response.status_code"], "200");
  assert.deepEqual(s.status, { code: 0 });
  // whole-dollar costs stay doubles
  assert.deepEqual(receiptToSpan({ ...metered, cost_usd: 1 }, {}).attributes.find((x) => x.key === "gen_ai.usage.cost").value, { doubleValue: 1 });
});

test("unknown, blocked, upstream-error and cache receipts", () => {
  const u = A(receiptToSpan({ ...metered, cost_usd: null, reason: "usage_unavailable", input_tokens: undefined, output_tokens: undefined }, {}));
  assert.equal("gen_ai.usage.cost" in u, false);
  assert.equal("costcap.cost_usd" in u, false);
  assert.equal("gen_ai.usage.input_tokens" in u, false);
  assert.equal(u["costcap.cost_complete"], false);
  const bs = receiptToSpan({ id: "b", ts: TS, provider: "openai", path: "/v1/chat/completions", blocked: true, reason: "budget_exceeded", cost_usd: 0 }, {});
  assert.deepEqual(bs.status, { code: 2, message: "budget_exceeded" });
  assert.equal(A(bs)["costcap.blocked"], true);
  assert.equal(A(bs)["costcap.reason"], "budget_exceeded");
  assert.equal(bs.name, "chat unknown");
  assert.equal(bs.startTimeUnixNano, bs.endTimeUnixNano);
  assert.equal(receiptToSpan({ ...metered, status: 500, reason: "upstream_rejected" }, {}).status.code, 2);
  const c = A(receiptToSpan({ ...metered, provider: "anthropic", path: "/v1/messages", cache: "hit", cached_input_tokens: 7, cache_write_input_tokens: 3, cache_write_1h_input_tokens: 2 }, {}));
  assert.equal(c["gen_ai.usage.cache_read.input_tokens"], "7");
  assert.equal(c["gen_ai.usage.cache_creation.input_tokens"], "5");
  assert.equal(c["costcap.cache"], "hit");
  const d = A(receiptToSpan({ ...metered, requested_model: "gpt-4o", model: "gpt-4o-mini" }, {}));
  assert.equal(d["gen_ai.request.model"], "gpt-4o");
  assert.equal(d["gen_ai.response.model"], "gpt-4o-mini");
  // start after end (clock skew) clamps to end
  const sk = receiptToSpan(metered, { startedAt: Date.parse(TS) + 10 });
  assert.equal(sk.startTimeUnixNano, sk.endTimeUnixNano);
});

test("operation names", () => {
  const op = (path) => operationName({ path });
  assert.equal(op("/v1/chat/completions"), "chat");
  assert.equal(op("/v1/messages"), "chat");
  assert.equal(op("/v1/responses"), "chat");
  assert.equal(op("/v1/embeddings"), "embeddings");
  assert.equal(op("/v1beta/models/g:generateContent?key=REDACTED"), "generate_content");
  assert.equal(op("/v1/completions"), "text_completion");
  assert.equal(op("/v1/audio/speech"), "speech");
  assert.equal(op(undefined), "unknown");
});

test("trace id is stable per run_id and differs across runs", () => {
  assert.equal(traceIdFor("R"), traceIdFor("R"));
  assert.match(traceIdFor("R"), /^[0-9a-f]{32}$/);
  assert.notEqual(traceIdFor("R"), traceIdFor("R2"));
});

test("run span and ExportTraceServiceRequest shape", () => {
  const sum = { run_id: "R", started_at: "2026-11-16T12:00:00.000Z", ended_at: TS, calls: 2, blocked_calls: 1, unknown_cost_calls: 0, total_cost_usd: 0.5, stopped_by: "budget_exceeded", exit_code: 0 };
  const rs = runSpan(sum, { traceId: traceIdFor("R"), spanId: "0000000000000001" });
  const a = A(rs);
  assert.equal(rs.name, "costcap.run");
  assert.equal(a["costcap.total_cost_usd"], 0.5);
  assert.equal(a["costcap.calls"], "2");
  assert.equal(a["costcap.blocked_calls"], "1");
  assert.equal(a["costcap.unknown_cost_calls"], "0");
  assert.equal(a["costcap.stopped_by"], "budget_exceeded");
  assert.equal(a["costcap.exit_code"], "0");
  assert.equal(rs.status.code, 2);
  const unk = A(runSpan({ ...sum, total_cost_usd: null, unknown_cost_calls: 1, stopped_by: null }, { traceId: "t", spanId: "s" }));
  assert.equal("costcap.total_cost_usd" in unk, false);
  assert.equal(unk["costcap.unknown_cost_calls"], "1");
  const body = exportRequest([rs], { serviceVersion: "9.9.9" });
  const res = body.resourceSpans[0];
  assert.deepEqual(res.resource.attributes, [{ key: "service.name", value: { stringValue: "costcap" } }, { key: "service.version", value: { stringValue: "9.9.9" } }]);
  assert.equal(res.scopeSpans[0].scope.name, "costcap");
  assert.equal(res.scopeSpans[0].spans[0], rs);
  assert.equal(typeof rs.startTimeUnixNano, "string");
});

test("headers parse k=v,k2=v2 and never echo values in errors", () => {
  assert.deepEqual(parseOtlpHeaders("authorization=Bearer s3cret,x-tenant=a"), { authorization: "Bearer s3cret", "x-tenant": "a" });
  assert.deepEqual(parseOtlpHeaders(" A=b%20c , "), { a: "b c" });
  assert.deepEqual(parseOtlpHeaders("a=%E0"), { a: "%E0" });
  assert.deepEqual(parseOtlpHeaders(undefined), {});
  assert.throws(() => parseOtlpHeaders("nosecretvalue"), (e) => !/nosecretvalue/.test(e.message));
  assert.throws(() => parseOtlpHeaders("bad name=s3cret"), (e) => !/s3cret/.test(e.message));
});

test("URL checks", () => {
  assert.deepEqual(parseOtlpEndpoint("http://127.0.0.1:4318/"), { url: "http://127.0.0.1:4318", tracesUrl: "http://127.0.0.1:4318/v1/traces", insecure: false });
  assert.equal(parseOtlpEndpoint("http://collector.example:4318").insecure, true);
  assert.equal(parseOtlpEndpoint("https://collector.example").insecure, false);
  assert.throws(() => parseOtlpEndpoint("ftp://x"), /http\(s\)/);
  assert.throws(() => parseOtlpEndpoint("not a url"), /http\(s\)/);
  assert.throws(() => parseOtlpEndpoint("http://u:p@127.0.0.1:1"), (e) => /user:pass/.test(e.message) && !/u:p@/.test(e.message));
});

function fakeFetch(status = 200) {
  const posts = [];
  const fn = async (url, init) => { posts.push({ url, init, body: JSON.parse(init.body) }); return { status, arrayBuffer: async () => new ArrayBuffer(0) }; };
  return { fn, posts };
}

test("exporter batches at most maxBatch per POST, sends headers, adds the root span, no duplicate span ids", async () => {
  const { fn, posts } = fakeFetch();
  const ex = createOtlpExporter({ endpoint: "http://127.0.0.1:1", headers: { authorization: "Bearer x" }, runId: "R", serviceVersion: "1", fetchImpl: fn, warn: () => assert.fail("no warning") });
  for (let i = 0; i < 250; i++) ex.receipt({ ...metered, id: `r${i}` }, { startedAt: Date.parse(TS) - 1 });
  ex.receipt({ event: "cap_warning", ts: TS }); // events are not spans
  const stats = await ex.shutdown({ run_id: "R", started_at: TS, ended_at: TS, calls: 250, blocked_calls: 0, unknown_cost_calls: 0, total_cost_usd: 1, stopped_by: null, exit_code: 0 });
  assert.deepEqual(stats, { spans_exported: 251, spans_dropped: 0 });
  assert.ok(posts.length >= 3);
  const spans = posts.flatMap((p) => p.body.resourceSpans[0].scopeSpans[0].spans);
  assert.ok(posts.every((p) => p.body.resourceSpans[0].scopeSpans[0].spans.length <= 100));
  assert.equal(spans.length, 251);
  assert.equal(new Set(spans.map((s) => s.spanId)).size, 251);
  assert.ok(spans.every((s) => s.traceId === traceIdFor("R")));
  const root = spans.find((s) => s.name === "costcap.run");
  assert.equal(root.spanId, ex.rootSpanId);
  assert.ok(spans.filter((s) => s !== root).every((s) => s.parentSpanId === root.spanId));
  assert.equal(posts[0].url, "http://127.0.0.1:1/v1/traces");
  assert.equal(posts[0].init.headers["content-type"], "application/json");
  assert.equal(posts[0].init.headers.authorization, "Bearer x");
  // after shutdown, late receipts are dropped
  ex.receipt({ ...metered, id: "late" });
  assert.equal(ex.stats().spans_dropped, 1);
});

test("queue bound drops overflow; failures warn once and count drops", async () => {
  const warns = [];
  let calls = 0;
  const ex = createOtlpExporter({ endpoint: "http://127.0.0.1:1", runId: "R", serviceVersion: "1", maxQueue: 5, maxBatch: 100, warn: (l) => warns.push(l),
    fetchImpl: async () => { calls++; return { status: 500 }; } });
  for (let i = 0; i < 8; i++) ex.receipt({ ...metered, id: `r${i}` });
  const stats = await ex.shutdown(null);
  assert.deepEqual(stats, { spans_exported: 0, spans_dropped: 8 });
  assert.equal(calls, 1);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^costcap: warning: otlp /);
});

test("network errors and hung collectors are dropped; final flush is capped", async () => {
  const warns = [];
  const ex = createOtlpExporter({ endpoint: "http://127.0.0.1:1", runId: "R", serviceVersion: "1", warn: (l) => warns.push(l), fetchImpl: async () => { throw Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }); } });
  ex.receipt(metered);
  assert.deepEqual(await ex.shutdown(null), { spans_exported: 0, spans_dropped: 1 });
  assert.match(warns[0], /ECONNREFUSED/);
  const hung = createOtlpExporter({ endpoint: "http://127.0.0.1:1", runId: "R", serviceVersion: "1", finalFlushMs: 50, warn: (l) => warns.push(l),
    fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  hung.receipt(metered);
  const t0 = Date.now();
  assert.deepEqual(await hung.shutdown(null), { spans_exported: 0, spans_dropped: 1 });
  assert.ok(Date.now() - t0 < 1000);
  // per-POST timeout
  const slow = createOtlpExporter({ endpoint: "http://127.0.0.1:1", runId: "R", serviceVersion: "1", postTimeoutMs: 20, flushMs: 10, warn: () => {},
    fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  slow.receipt(metered);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(slow.stats(), { spans_exported: 0, spans_dropped: 1 });
  await slow.shutdown(null);
});
