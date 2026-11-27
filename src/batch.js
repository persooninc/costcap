// Batch metering (#160): OpenAI Batch API and Anthropic Message Batches.
// Pure helpers: exact-path matchers, model extraction for the allowlist, JSONL
// results folding at the provider batch rate, and an in-memory pending-batch
// index (seeded from the ledger) that links results back to the batch_pending
// receipt. Settlement lines reuse the {"event":"reconciliation"} shape that
// applySettlements in src/cap.js already folds (keeping the original ts).
// Dependencies are injected (extractUsage, costForUsage, ...) so the module stays portable.

const UNSAFE = /%|\\|\/\.{1,2}(?:\/|$)|\/\//;
const pathOf = (rawUrl) => {
  if (typeof rawUrl !== "string") return null;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  return UNSAFE.test(pathname) ? null : pathname;
};
const ID = "([A-Za-z0-9_-]+)";

/** "openai" | "anthropic" for an exact-path batch create, else null. */
export function batchCreateProvider(method, rawUrl) {
  const p = method === "POST" ? pathOf(rawUrl) : null;
  if (p === "/openai/v1/batches") return "openai";
  if (p === "/anthropic/v1/messages/batches") return "anthropic";
  return null;
}

/** Batch id for GET /anthropic/v1/messages/batches/:id/results, else null. */
export function anthropicResultsBatchId(method, rawUrl) {
  const p = method === "GET" ? pathOf(rawUrl) : null;
  return p ? new RegExp(`^/anthropic/v1/messages/batches/${ID}/results$`).exec(p)?.[1] ?? null : null;
}

/** Batch id for GET /openai/v1/batches/:id, else null. */
export function openaiBatchGetId(method, rawUrl) {
  const p = method === "GET" ? pathOf(rawUrl) : null;
  return p ? new RegExp(`^/openai/v1/batches/${ID}$`).exec(p)?.[1] ?? null : null;
}

/** File id for GET /openai/v1/files/:id/content, else null. */
export function openaiFileContentId(method, rawUrl) {
  const p = method === "GET" ? pathOf(rawUrl) : null;
  return p ? new RegExp(`^/openai/v1/files/${ID}/content$`).exec(p)?.[1] ?? null : null;
}

/** Anthropic batch create: every requests[].params.model, or null when the body is not a valid batch. */
export function anthropicBatchModels(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const reqs = parsed?.requests;
  if (!Array.isArray(reqs) || !reqs.length) return null;
  const models = reqs.map((r) => r?.params?.model);
  return models.every((m) => typeof m === "string" && m) ? models : null;
}

const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

/** Pending receipt fields from a 2xx batch create response (null when it has no batch id). */
export function pendingFromCreate(provider, requestBody, responseText) {
  const res = parseJson(responseText);
  if (!res || typeof res.id !== "string" || !res.id) return null;
  let request_count = null, model = "unknown";
  if (provider === "anthropic") {
    const models = anthropicBatchModels(requestBody) ?? [];
    request_count = models.length || null;
    const uniq = [...new Set(models)];
    if (uniq.length) model = uniq.length === 1 ? uniq[0] : "mixed";
  } else if (Number.isInteger(res.request_counts?.total) && res.request_counts.total > 0) {
    request_count = res.request_counts.total;
  }
  return { batch_id: res.id, request_count, model };
}

const FREE_ANTHROPIC = new Set(["errored", "canceled", "expired"]);

/**
 * Folds a JSONL results body. Returns { cost_usd, succeeded, free, by_model } when every
 * line is accounted for, else { cost_usd: null, reason } (never a $0 guess):
 * - batch_unpriced: unpublished batch rate, unpriced model, fast/priority tier, provider tool, cache write without a rate;
 * The discount applies to every component (input, output, cache read/write) and stacks on long_context.
 * - batch_results_malformed: an unparseable line, an unknown result shape, or missing usage.
 */
export function foldBatchResults(provider, text, { extractUsage, costForUsage, isPricedModel, premiumTier, multiplier }) {
  if (!multiplier) return { cost_usd: null, reason: "batch_unpriced" };
  const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { cost_usd: null, reason: "batch_results_malformed" };
  let total = 0, succeeded = 0, free = 0;
  const by_model = {};
  for (const line of lines) {
    const j = parseJson(line);
    if (!j || typeof j !== "object") return { cost_usd: null, reason: "batch_results_malformed" };
    let body;
    if (provider === "anthropic") {
      const type = j.result?.type;
      if (FREE_ANTHROPIC.has(type)) { free++; continue; }
      if (type !== "succeeded" || !j.result.message || typeof j.result.message !== "object") return { cost_usd: null, reason: "batch_results_malformed" };
      body = j.result.message;
    } else {
      const sc = j.response?.status_code;
      if (Number.isInteger(sc) && (sc < 200 || sc >= 300)) { free++; continue; }
      if (!Number.isInteger(sc)) { if (j.error) { free++; continue; } return { cost_usd: null, reason: "batch_results_malformed" }; }
      body = j.response.body;
      if (!body || typeof body !== "object") return { cost_usd: null, reason: "batch_results_malformed" };
    }
    const m = extractUsage(provider, JSON.stringify(body));
    if (!m) return { cost_usd: null, reason: "batch_results_malformed" };
    if (m.toolUseUnpriced || premiumTier(m.usage) || !isPricedModel(m.model)) return { cost_usd: null, reason: "batch_unpriced", model: m.model };
    // Standard cost per line (6 dp, as a receipt would be), discounted once on the total.
    const c = costForUsage(m.model, m.usage);
    if (c.cost_usd === null) return { cost_usd: null, reason: "batch_unpriced", model: m.model };
    succeeded++;
    total += c.cost_usd;
    const b = (by_model[m.model] ??= { calls: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, cache_write_1h_input_tokens: 0, standard_cost_usd: 0 });
    b.calls++;
    for (const k of ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "cache_write_1h_input_tokens"]) b[k] += c[k] ?? 0;
    b.standard_cost_usd += c.cost_usd;
  }
  for (const b of Object.values(by_model)) { b.cost_usd = Number((b.standard_cost_usd * multiplier).toFixed(6)); b.standard_cost_usd = Number(b.standard_cost_usd.toFixed(6)); }
  return { cost_usd: Number((total * multiplier).toFixed(6)), succeeded, free, by_model, multiplier };
}

/**
 * Pending-batch index. Tracks batch_pending receipts, OpenAI output_file_id links
 * (stored on the batch GET receipt itself) and which receipts are already settled,
 * so fetching results twice settles once.
 */
export function createBatchIndex(lines = []) {
  const pending = new Map(); // `${provider}:${batch_id}` -> receipt
  const files = new Map(); // output_file_id -> batch_id (openai)
  const settled = new Set(); // receipt ids
  const observe = (r) => {
    if (!r || typeof r !== "object") return;
    if (r.event === "reconciliation" && typeof r.receipt_id === "string") { settled.add(r.receipt_id); return; }
    if (r.event) return;
    if (r.reason === "batch_pending" && typeof r.batch_id === "string" && typeof r.id === "string") pending.set(`${r.provider}:${r.batch_id}`, r);
    if (r.provider === "openai" && typeof r.batch_id === "string" && typeof r.output_file_id === "string") files.set(r.output_file_id, r.batch_id);
  };
  for (const l of lines) observe(l);
  return {
    observe,
    pendingFor(provider, batchId) {
      const r = pending.get(`${provider}:${batchId}`);
      return r && r.cost_usd === null && !settled.has(r.id) ? r : null;
    },
    isTracked: (provider, batchId) => pending.has(`${provider}:${batchId}`),
    batchForFile: (fileId) => files.get(fileId) ?? null,
  };
}

/** Settlement line for a pending batch receipt (folded by applySettlements; keeps the receipt's ts). */
export function batchSettlement(pendingReceipt, fold, { ts = new Date().toISOString() } = {}) {
  return { event: "reconciliation", source: "batch_results", ts, receipt_id: pendingReceipt.id,
    provider: pendingReceipt.provider, batch_id: pendingReceipt.batch_id, cost_usd: fold.cost_usd,
    succeeded: fold.succeeded, free: fold.free, batch_multiplier: fold.multiplier, by_model: fold.by_model };
}
