// Batch APIs (#160): OpenAI Batch, Anthropic Message Batches and (#230) Gemini Batch Mode. Pure helpers:
// exact-path matchers, request model extraction and JSONL results folding.
// A batch create has no usage; its cost is known only once results are read.
// Results are priced at the provider's batch multiplier (pricing table `batch`).
import { billedAsGrounding, createUsageAccumulator } from "./proxy.js";
import { costWithOverrides, withToolCost } from "./price-overrides.js";
import { premiumTier } from "./pricing.js";

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

function priceLine(provider, body, userPrices, model, instants = [undefined]) {
  const acc = createUsageAccumulator(provider, model);
  acc.add(body);
  const metered = acc.result();
  if (!metered || metered.toolUseUnpriced) return null;
  // A premium speed/service tier has no published batch rate: unknown, never standard.
  if (premiumTier(metered.usage)) return null;
  // #189: a discount stacks on the batch multiplier; an absolute override has no batch rate (unknown).
  // #236: priced at the create and the settle instant; the higher cost is kept, never the cheaper guess.
  // #214: tool calls bill at the full per-call rate; the batch discount applies to tokens only.
  // #263: grounding follows the billed_as model's unit at each instant, as on the live path (#260).
  let c = null;
  for (const at of instants) {
    const t = costWithOverrides(userPrices, provider, metered.model, metered.usage, { batch: provider, at });
    if (t.fallback || t.cost_usd === null) return null;
    const total = withToolCost(t, userPrices, provider, billedAsGrounding(provider, null, t, metered), null, body);
    if (total.cost_usd === null) return null;
    if (!c || total.cost_usd > c.cost_usd) c = total;
  }
  return { ...c, model: metered.model ?? null };
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
