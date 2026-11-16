// #239: OTLP/HTTP JSON trace export for `costcap wrap --otlp URL`.
// Portable: no dependencies, no globals; fetch, clock and warn are injected.
// One CLIENT span per receipt (GenAI semantic conventions) plus a `costcap.run` root span.
// Never exports prompt/completion/request-body content or header values.
import { createHash, randomBytes } from "node:crypto";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const MAX_BATCH = 100;
export const MAX_QUEUE = 10_000;
export const FLUSH_MS = 5_000;
export const POST_TIMEOUT_MS = 10_000;
// Under the 5 s cap so wrap still exits within 6 s of the agent on a loaded host.
export const FINAL_FLUSH_MS = 4_500;
const SPAN_KIND_INTERNAL = 1, SPAN_KIND_CLIENT = 3;
const STATUS_OK = 0, STATUS_ERROR = 2;

/** Validate --otlp / COSTCAP_OTLP_ENDPOINT. Returns { url, tracesUrl, insecure }. Throws on bad input. */
export function parseOtlpEndpoint(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`--otlp must be an http(s) URL, got "${raw}"`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`--otlp must be an http(s) URL, got "${url.protocol}"`);
  if (url.username || url.password) throw new Error("--otlp must not contain user:pass@; put credentials in COSTCAP_OTLP_HEADERS");
  const base = url.href.replace(/\/+$/, "");
  return { url: base, tracesUrl: `${base}/v1/traces`, insecure: url.protocol === "http:" && !LOOPBACK.has(url.hostname) };
}

/** Parse COSTCAP_OTLP_HEADERS (`k=v,k2=v2`, values may be percent-encoded). Error messages never echo values. */
export function parseOtlpHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const part of String(raw).split(",")) {
    if (!part.trim()) continue;
    const i = part.indexOf("=");
    if (i <= 0) throw new Error("COSTCAP_OTLP_HEADERS must be k=v pairs separated by commas");
    const k = part.slice(0, i).trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(k)) throw new Error("COSTCAP_OTLP_HEADERS has an invalid header name");
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    out[k] = v;
  }
  return out;
}

/** Trace id for a run: sha256(run_id), first 16 bytes, hex. */
export const traceIdFor = (runId) => createHash("sha256").update(String(runId)).digest("hex").slice(0, 32);
export const newSpanId = () => randomBytes(8).toString("hex");

const nanos = (ms) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

function attr(key, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  return { key, value: { stringValue: String(value) } };
}
// A dollar figure is always a double, even when it happens to be whole.
const dbl = (key, value) => (typeof value === "number" && Number.isFinite(value) ? { key, value: { doubleValue: value } } : null);

/** GenAI operation name from the (already redacted) receipt path. */
export function operationName(r) {
  const p = String(r.path ?? "").split("?")[0];
  if (/embed/i.test(p)) return "embeddings";
  if (/generateContent|countTokens/i.test(p)) return "generate_content";
  if (/\/chat\/completions$|\/messages$|\/responses$|\/converse(-stream)?$|\/realtime$|invoke/i.test(p)) return "chat";
  if (/\/completions$/.test(p)) return "text_completion";
  const seg = p.split("/").filter(Boolean).pop();
  return seg ? seg.replace(/[^A-Za-z0-9_.-]/g, "_") : "unknown";
}

/** Map one ledger receipt to an OTLP span. */
export function receiptToSpan(r, { startedAt, traceId, parentSpanId, spanId = newSpanId() } = {}) {
  const end = Date.parse(r.ts);
  const endMs = Number.isFinite(end) ? end : Date.now();
  const startMs = Number.isFinite(startedAt) && startedAt <= endMs ? startedAt : endMs;
  const op = operationName(r);
  const model = r.model ?? r.requested_model ?? "unknown";
  const status = Number.isInteger(r.status) ? r.status : null;
  const err = r.blocked === true || (status !== null && status >= 400);
  const attrs = [
    attr("gen_ai.provider.name", r.provider), attr("gen_ai.operation.name", op), attr("gen_ai.request.model", r.requested_model ?? model),
    r.model && r.requested_model && r.model !== r.requested_model ? attr("gen_ai.response.model", r.model) : null,
    Number.isFinite(r.input_tokens) ? attr("gen_ai.usage.input_tokens", r.input_tokens) : null,
    Number.isFinite(r.output_tokens) ? attr("gen_ai.usage.output_tokens", r.output_tokens) : null,
    Number.isFinite(r.cached_input_tokens) ? attr("gen_ai.usage.cache_read.input_tokens", r.cached_input_tokens) : null,
    Number.isFinite(r.cache_write_input_tokens) || Number.isFinite(r.cache_write_1h_input_tokens)
      ? attr("gen_ai.usage.cache_creation.input_tokens", (r.cache_write_input_tokens ?? 0) + (r.cache_write_1h_input_tokens ?? 0)) : null,
    dbl("gen_ai.usage.cost", r.cost_usd), dbl("costcap.cost_usd", r.cost_usd),
    attr("costcap.cost_complete", typeof r.cost_usd === "number"), attr("costcap.receipt_id", r.id), attr("costcap.run_id", r.run_id), attr("costcap.agent_id", r.agent_id),
    attr("costcap.blocked", r.blocked === true), attr("costcap.reason", r.reason), attr("costcap.path", r.path), attr("costcap.cache", r.cache),
    ...Object.entries(r.tags && typeof r.tags === "object" ? r.tags : {}).map(([k, v]) => attr(`costcap.tag.${k}`, v)),
    status !== null ? attr("http.response.status_code", status) : null,
  ].filter(Boolean);
  return {
    traceId, spanId, ...(parentSpanId && { parentSpanId }), name: `${op} ${model}`, kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: nanos(startMs), endTimeUnixNano: nanos(endMs), attributes: attrs,
    status: err ? { code: STATUS_ERROR, message: String(r.reason ?? (status !== null ? `http ${status}` : "error")) } : { code: STATUS_OK },
  };
}

/** The `costcap.run` root span from a run summary. */
export function runSpan(summary, { traceId, spanId }) {
  const startMs = Date.parse(summary.started_at), endMs = Date.parse(summary.ended_at);
  const attrs = [
    attr("costcap.run_id", summary.run_id), dbl("costcap.total_cost_usd", summary.total_cost_usd),
    attr("costcap.unknown_cost_calls", summary.unknown_cost_calls), attr("costcap.calls", summary.calls), attr("costcap.blocked_calls", summary.blocked_calls),
    attr("costcap.stopped_by", summary.stopped_by), attr("costcap.exit_code", summary.exit_code),
  ].filter(Boolean);
  return {
    traceId, spanId, name: "costcap.run", kind: SPAN_KIND_INTERNAL, startTimeUnixNano: nanos(startMs), endTimeUnixNano: nanos(Number.isFinite(endMs) ? endMs : startMs),
    attributes: attrs, status: summary.stopped_by ? { code: STATUS_ERROR, message: summary.stopped_by } : { code: STATUS_OK },
  };
}

/** OTLP ExportTraceServiceRequest body. */
export function exportRequest(spans, { serviceVersion }) {
  return {
    resourceSpans: [{
      resource: { attributes: [attr("service.name", "costcap"), attr("service.version", serviceVersion)].filter(Boolean) },
      scopeSpans: [{ scope: { name: "costcap", version: serviceVersion }, spans }],
    }],
  };
}

/**
 * Batching exporter. add() never blocks; spans go out at most MAX_BATCH per POST,
 * every FLUSH_MS or when a batch fills. No retries. shutdown() caps the final flush.
 */
export function createOtlpExporter({ endpoint, headers = {}, runId, serviceVersion, fetchImpl = globalThis.fetch, warn = (l) => console.error(l),
  maxBatch = MAX_BATCH, maxQueue = MAX_QUEUE, flushMs = FLUSH_MS, postTimeoutMs = POST_TIMEOUT_MS, finalFlushMs = FINAL_FLUSH_MS } = {}) {
  const { tracesUrl } = parseOtlpEndpoint(endpoint);
  const traceId = traceIdFor(runId);
  const rootSpanId = newSpanId();
  const queue = [];
  const inflight = new Set();
  const controllers = new Set();
  let exported = 0, dropped = 0, warned = false, closed = false;
  const fail = (n, why) => {
    dropped += n;
    if (!warned) { warned = true; warn(`costcap: warning: otlp export to ${tracesUrl} failed (${why}); spans are dropped, metering continues`); }
  };
  const post = (spans) => {
    const ac = new AbortController();
    controllers.add(ac);
    const timer = setTimeout(() => ac.abort(), postTimeoutMs);
    timer.unref?.();
    const p = (async () => {
      try {
        const res = await fetchImpl(tracesUrl, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(exportRequest(spans, { serviceVersion })), signal: ac.signal });
        try { await res.arrayBuffer?.(); } catch { /* body is irrelevant */ }
        if (res.status >= 200 && res.status < 300) exported += spans.length;
        else fail(spans.length, `http ${res.status}`);
      } catch (e) {
        fail(spans.length, ac.signal.aborted ? "timeout" : (e?.cause?.code ?? e?.code ?? "network error"));
      } finally { clearTimeout(timer); controllers.delete(ac); }
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  };
  const drain = (all = false) => {
    while (queue.length >= maxBatch || (all && queue.length)) post(queue.splice(0, maxBatch));
  };
  const ticker = setInterval(() => drain(true), flushMs);
  ticker.unref?.();
  const enqueue = (span) => {
    if (closed) { dropped++; return; }
    if (queue.length >= maxQueue) { fail(1, "queue full"); return; }
    queue.push(span);
    if (queue.length >= maxBatch) drain();
  };
  return {
    traceId, rootSpanId,
    /** Record one receipt (ledger events without a receipt id are ignored). */
    receipt(r, meta = {}) {
      if (!r || r.event || !r.id) return;
      try { enqueue(receiptToSpan(r, { startedAt: meta?.startedAt, traceId, parentSpanId: rootSpanId })); } catch { dropped++; }
    },
    /** Add the root span from the run summary, flush, and wait at most finalFlushMs. */
    async shutdown(summary) {
      clearInterval(ticker);
      if (summary) enqueue(runSpan(summary, { traceId, spanId: rootSpanId }));
      closed = true;
      drain(true);
      let timer;
      const deadline = new Promise((r) => { timer = setTimeout(r, finalFlushMs); timer.unref?.(); });
      await Promise.race([Promise.allSettled([...inflight]), deadline]);
      clearTimeout(timer);
      for (const ac of controllers) ac.abort();
      await Promise.allSettled([...inflight]);
      return this.stats();
    },
    stats: () => ({ spans_exported: exported, spans_dropped: dropped }),
  };
}
