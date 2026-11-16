// Batch APIs (#160): OpenAI Batch and Anthropic Message Batches. Pure helpers:
// exact-path matchers, request model extraction and JSONL results folding.
// A batch create has no usage; its cost is known only once results are read.
// Results are priced at the provider's batch multiplier (pricing table `batch`).
import { createUsageAccumulator } from "./proxy.js";
import { costForUsage } from "./pricing.js";

const unsafe = (pathname) => /%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname);
const pathOf = (rawUrl) => {
  if (typeof rawUrl !== "string") return null;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  return unsafe(pathname) ? null : pathname;
};
const ID = "([A-Za-z0-9_-]+)";

/** "openai" | "anthropic" for an exact batch-create POST, else null. */
export function batchCreateProvider(method, rawUrl) {
  const p = pathOf(rawUrl);
  if (method !== "POST" || !p) return null;
  if (p === "/openai/v1/batches") return "openai";
  if (p === "/anthropic/v1/messages/batches") return "anthropic";
  return null;
}

/** Classifies a GET that can carry batch state: { kind, id } or null. */
export function batchReadPath(method, rawUrl) {
  const p = pathOf(rawUrl);
  if (method !== "GET" || !p) return null;
  let m;
  if ((m = new RegExp(`^/anthropic/v1/messages/batches/${ID}/results$`).exec(p))) return { kind: "anthropic_results", id: m[1] };
  if ((m = new RegExp(`^/openai/v1/batches/${ID}$`).exec(p))) return { kind: "openai_batch", id: m[1] };
  if ((m = new RegExp(`^/openai/v1/files/${ID}/content$`).exec(p))) return { kind: "openai_file_content", id: m[1] };
  return null;
}

/** Models named by an Anthropic batch create (requests[].params.model); null when the body is unusable. */
export function anthropicBatchModels(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const reqs = parsed?.requests;
  if (!Array.isArray(reqs) || !reqs.length) return null;
  return reqs.map((r) => (typeof r?.params?.model === "string" && r.params.model ? r.params.model : null));
}

const r6 = (n) => Number(n.toFixed(6));

function priceLine(provider, body) {
  const acc = createUsageAccumulator(provider, undefined);
  acc.add(body);
  const metered = acc.result();
  if (!metered || metered.toolUseUnpriced) return null;
  // A premium speed/service tier has no published batch rate: unknown, never standard.
  if (metered.usage.speed === "fast" || metered.usage.service_tier === "priority") return null;
  const c = costForUsage(metered.model, metered.usage, { batch: provider });
  if (c.fallback || c.cost_usd === null) return null;
  return c;
}

/**
 * Folds a batch results JSONL body. Returns { ok: true, cost_usd, succeeded, free }
 * or { ok: false, reason: "batch_unpriced", line }. Any malformed, unpriced or
 * premium-speed billed line makes the whole batch unknown: never a $0 guess.
 */
export function foldBatchResults(provider, text) {
  let cost = 0, succeeded = 0, free = 0, n = 0;
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    n++;
    let line;
    try { line = JSON.parse(raw); } catch { return { ok: false, reason: "batch_unpriced", line: i + 1 }; }
    if (!line || typeof line !== "object") return { ok: false, reason: "batch_unpriced", line: i + 1 };
    let billed;
    if (provider === "anthropic") {
      const type = line.result?.type;
      if (type === "errored" || type === "canceled" || type === "expired") { free++; continue; }
      if (type !== "succeeded") return { ok: false, reason: "batch_unpriced", line: i + 1 };
      billed = line.result.message;
    } else {
      const status = line.response?.status_code;
      if (line.response == null && line.error) { free++; continue; }
      if (typeof status !== "number") return { ok: false, reason: "batch_unpriced", line: i + 1 };
      if (status < 200 || status >= 300) { free++; continue; }
      billed = line.response.body;
    }
    const c = priceLine(provider, billed);
    if (!c) return { ok: false, reason: "batch_unpriced", line: i + 1 };
    cost += c.cost_usd;
    succeeded++;
  }
  if (!n) return { ok: false, reason: "batch_unpriced", line: 0 };
  return { ok: true, cost_usd: r6(cost), succeeded, free };
}
