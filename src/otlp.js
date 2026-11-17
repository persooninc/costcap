// #239: opt-in OTLP/HTTP JSON trace export for `costcap wrap --otlp URL`.
// One CLIENT span per receipt (metered, unknown-cost or blocked) and one `costcap.run`
// root span at exit, all sharing a trace id derived from run_id. Hand-encoded: no
// @opentelemetry dependency. Never exports prompt/completion/request-body content.
// Delivery is best effort and never blocks a proxied call or a cap decision.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { VERSION } from "./version.js";

export const MAX_BATCH = 100;
export const MAX_QUEUE = 10_000;
export const FLUSH_INTERVAL_MS = 5_000;
export const POST_TIMEOUT_MS = 10_000;
export const FINAL_FLUSH_MS = 5_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// Validate an --otlp / COSTCAP_OTLP_ENDPOINT value. Returns { url, insecure }.
export function parseOtlpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error(`--otlp must be an http(s) URL, got "${raw}"`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`--otlp must be an http(s) URL, got scheme ${u.protocol}`);
  if (u.username || u.password) throw new Error("--otlp URL must not embed credentials (user:pass@); put them in COSTCAP_OTLP_HEADERS");
  const base = u.toString().replace(/\/+$/, "").replace(/\/v1\/traces$/, "");
  return { url: `${base}/v1/traces`, insecure: u.protocol === "http:" && !LOOPBACK.has(u.hostname) };
}

// COSTCAP_OTLP_HEADERS: "k=v,k2=v2" (OTEL_EXPORTER_OTLP_HEADERS format, values may be %-encoded).
export function parseOtlpHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const part of String(raw).split(",")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    if (i <= 0) throw new Error("COSTCAP_OTLP_HEADERS must be k=v pairs separated by commas");
    const k = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) throw new Error("COSTCAP_OTLP_HEADERS has an invalid header name");
    if (/[\r\n]/.test(v)) throw new Error("COSTCAP_OTLP_HEADERS has an invalid header value");
    out[k] = v;
  }
  return out;
}

export const traceIdFor = (runId) => createHash("sha256").update(String(runId)).digest("hex").slice(0, 32);
const spanId = () => randomBytes(8).toString("hex");
const nanos = (ms) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

export function operationName(path = "") {
  const p = String(path).split("?")[0];
  if (/\/chat\/completions$|\/messages$|\/responses$|\/converse(-stream)?$|\/invoke(-with-response-stream)?$|:rawPredict$|:streamRawPredict$/.test(p)) return "chat";
  if (/\/embeddings$|:embedContent$|:batchEmbedContents$/.test(p)) return "embeddings";
  if (/:(stream)?generateContent$/.test(p)) return "generate_content";
  if (/\/completions$/.test(p)) return "text_completion";
  if (/\/realtime$/.test(p)) return "realtime";
  if (/\/live\/sessions$/.test(p)) return "live";
  const last = p.split("/").filter(Boolean).pop() ?? "call";
  return last.replace(/^.*:/, "") || "call";
}

const attr = (key, v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return { key, value: { boolValue: v } };
  if (typeof v === "number") return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  return { key, value: { stringValue: String(v) } };
};
const dbl = (key, v) => (typeof v === "number" && Number.isFinite(v) ? { key, value: { doubleValue: v } } : null);
const attrs = (list) => list.filter(Boolean);

// Receipt -> OTLP span. Returns null for ledger events (settlements, warnings).
export function receiptToSpan(r, { startMs, traceId, parentSpanId } = {}) {
  if (!r || r.event || typeof r.id !== "string") return null;
  const endMs = Date.parse(r.ts);
  const end = Number.isFinite(endMs) ? endMs : Date.now();
  const start = Number.isFinite(startMs) && startMs <= end ? startMs : end;
  const op = operationName(r.path);
  const model = r.model ?? "unknown";
  const errored = r.blocked === true || (Number.isInteger(r.status) && r.status >= 400);
  const tagAttrs = r.tags && typeof r.tags === "object" ? Object.entries(r.tags).map(([k, v]) => attr(`costcap.tag.${k}`, v)) : [];
  return {
    traceId: traceId ?? traceIdFor(r.run_id ?? r.id), spanId: spanId(), ...(parentSpanId && { parentSpanId }),
    name: `${op} ${model}`, kind: 3, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
    attributes: attrs([
      attr("gen_ai.provider.name", r.provider), attr("gen_ai.operation.name", op), attr("gen_ai.request.model", r.requested_model ?? model),
      attr("gen_ai.usage.input_tokens", r.input_tokens), attr("gen_ai.usage.output_tokens", r.output_tokens),
      attr("gen_ai.usage.cache_read.input_tokens", r.cached_input_tokens),
      attr("gen_ai.usage.cache_creation.input_tokens", r.cache_write_input_tokens == null && r.cache_write_1h_input_tokens == null ? undefined : (r.cache_write_input_tokens ?? 0) + (r.cache_write_1h_input_tokens ?? 0)),
      dbl("gen_ai.usage.cost", r.cost_usd), dbl("costcap.cost_usd", r.cost_usd), attr("costcap.cost_complete", typeof r.cost_usd === "number"),
      attr("costcap.receipt_id", r.id), attr("costcap.run_id", r.run_id), attr("costcap.agent_id", r.agent_id),
      attr("costcap.blocked", r.blocked === true), attr("costcap.reason", r.reason), attr("costcap.path", r.path),
      attr("http.response.status_code", r.status), ...tagAttrs,
    ]),
    status: errored ? { code: 2, message: String(r.reason ?? `status ${r.status}`) } : { code: 0 },
  };
}

// Run summary -> root span.
export function runSpan(summary, { startMs, endMs, traceId, spanId: id }) {
  return {
    traceId, spanId: id, name: "costcap.run", kind: 1, startTimeUnixNano: nanos(startMs), endTimeUnixNano: nanos(Math.max(endMs, startMs)),
    attributes: attrs([
      attr("costcap.run_id", summary.run_id), dbl("costcap.total_cost_usd", summary.total_cost_usd),
      attr("costcap.unknown_cost_calls", summary.unknown_cost_calls), attr("costcap.calls", summary.calls),
      attr("costcap.blocked_calls", summary.blocked_calls), attr("costcap.stopped_by", summary.stopped_by),
      attr("costcap.exit_code", summary.exit_code),
    ]),
    status: summary.stopped_by ? { code: 2, message: summary.stopped_by } : { code: 0 },
  };
}

export function encodeRequest(spans) {
  return {
    resourceSpans: [{
      resource: { attributes: [attr("service.name", "costcap"), attr("service.version", VERSION)] },
      scopeSpans: [{ scope: { name: "costcap", version: VERSION }, spans }],
    }],
  };
}

function defaultPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? https : http).request(u, { method: "POST", headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`collector returned HTTP ${res.statusCode}`))));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

// Batching exporter. add() never throws and never awaits the network.
export function createOtlpExporter({ url, headers = {}, runId, onWarning = (l) => console.error(l), post = defaultPost,
  maxBatch = MAX_BATCH, maxQueue = MAX_QUEUE, intervalMs = FLUSH_INTERVAL_MS, timeoutMs = POST_TIMEOUT_MS } = {}) {
  const traceId = traceIdFor(runId);
  const rootSpanId = spanId();
  let queue = [];
  let exported = 0, dropped = 0, warned = false, frozen = null;
  const inflight = new Map(); // promise -> span count
  const warn = (e) => {
    if (warned) return;
    warned = true;
    try { onWarning(`costcap: warning: otlp export to ${new URL(url).origin} failed (${e?.message ?? e}); spans are dropped, the run is not affected`); } catch { /* stderr best effort */ }
  };
  const send = (batch) => {
    const p = Promise.resolve().then(() => post(url, headers, JSON.stringify(encodeRequest(batch)), timeoutMs))
      .then(() => { exported += batch.length; }, (e) => { dropped += batch.length; warn(e); })
      .finally(() => inflight.delete(p));
    inflight.set(p, batch.length);
  };
  const drain = () => { while (queue.length) send(queue.splice(0, maxBatch)); };
  const timer = setInterval(drain, intervalMs);
  timer.unref?.();
  const push = (span) => {
    if (queue.length >= maxQueue) { dropped++; return; }
    queue.push(span);
    if (queue.length >= maxBatch) send(queue.splice(0, maxBatch));
  };
  const counts = () => frozen ?? { spans_exported: exported, spans_dropped: dropped + queue.length + [...inflight.values()].reduce((n, c) => n + c, 0) };
  return {
    traceId, rootSpanId, counts,
    add(receipt, meta = {}) {
      if (frozen) return;
      try { const s = receiptToSpan(receipt, { startMs: meta.startMs, traceId, parentSpanId: rootSpanId }); if (s) push(s); } catch { /* never break metering */ }
    },
    // Final flush: root span plus everything queued, capped at deadlineMs. Unsent spans count as dropped.
    async finish(summary, { startMs, endMs = Date.now(), deadlineMs = FINAL_FLUSH_MS } = {}) {
      if (frozen) return frozen;
      clearInterval(timer);
      push(runSpan(summary, { startMs, endMs, traceId, spanId: rootSpanId }));
      drain();
      // The deadline timer stays ref'd: a post that holds no handle (or a hung one) must not let the
      // event loop drain with finish() still pending, which would skip the caller's run summary/exit.
      let t;
      await Promise.race([Promise.allSettled([...inflight.keys()]), new Promise((r) => { t = setTimeout(r, deadlineMs); })]);
      clearTimeout(t);
      if (inflight.size) warn(new Error("final flush timed out"));
      frozen = counts();
      return frozen;
    },
  };
}
