// Batch APIs (#160): OpenAI Batch, Anthropic Message Batches and (#230) Gemini Batch Mode. Pure helpers:
// exact-path matchers, request model extraction and JSONL results folding.
// A batch create has no usage; its cost is known only once results are read.
// Results are priced at the provider's batch multiplier (pricing table `batch`).
import { createUsageAccumulator } from "./proxy.js";
import { costWithOverrides, withToolCost } from "./price-overrides.js";

const unsafe = (pathname) => /%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname);
const pathOf = (rawUrl) => {
  if (typeof rawUrl !== "string") return null;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  return unsafe(pathname) ? null : pathname;
};
const ID = "([A-Za-z0-9_-]+)";
const GV = "v1(?:beta|alpha)?";
const GEMINI_CREATE = new RegExp(`^/gemini/${GV}/models/[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*:batchGenerateContent$`);

/** "openai" | "anthropic" | "gemini" for an exact batch-create POST, else null. */
export function batchCreateProvider(method, rawUrl) {
  const p = pathOf(rawUrl);
  if (method !== "POST" || !p) return null;
  if (p === "/openai/v1/batches") return "openai";
  if (p === "/anthropic/v1/messages/batches") return "anthropic";
  if (GEMINI_CREATE.test(p)) return "gemini";
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
  if ((m = new RegExp(`^/gemini/${GV}/batches/${ID}$`).exec(p))) return { kind: "gemini_batch", id: m[1] };
  if ((m = new RegExp(`^/gemini/download/${GV}/files/${ID}:download$`).exec(p))) return { kind: "gemini_file_download", id: m[1] };
  return null;
}

/** #230: Gemini batch cancel (POST …/batches/<id>:cancel) and delete (DELETE …/batches/<id>) never bill. */
export function isGeminiBatchFreeCall(method, rawUrl) {
  const p = pathOf(rawUrl);
  if (!p) return false;
  if (method === "POST") return new RegExp(`^/gemini/${GV}/batches/${ID}:cancel$`).test(p);
  if (method === "DELETE") return new RegExp(`^/gemini/${GV}/batches/${ID}$`).test(p);
  return false;
}

/**
 * #230: inline requests of a Gemini batch create (batch.input_config.requests.requests[].request,
 * snake or camel case). Returns an array of request objects, [] for a file input, null when unusable.
 */
export function geminiBatchRequests(body) {
  let parsed;
  try { parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "")); } catch { return null; }
  const cfg = parsed?.batch?.input_config ?? parsed?.batch?.inputConfig;
  if (!cfg || typeof cfg !== "object") return null;
  const fileName = cfg.file_name ?? cfg.fileName;
  if (typeof fileName === "string" && fileName) return [];
  const reqs = cfg.requests?.requests;
  if (!Array.isArray(reqs) || !reqs.length) return null;
  return reqs.map((r) => (r?.request && typeof r.request === "object" ? r.request : null));
}

/** #230: batch id from a Gemini Operation / GenerateContentBatch (`name: "batches/<id>"`). */
export function geminiBatchId(obj) {
  const m = typeof obj?.name === "string" ? /^batches\/([A-Za-z0-9_-]+)$/.exec(obj.name) : null;
  return m ? m[1] : null;
}

/**
 * #230: classifies a Gemini batch GET body. { inline: JSONL } for done inline results,
 * { file: "<id>" } for a responses file, else null (running, failed, cancelled or expired: stays pending).
 */
export function geminiBatchOutput(text) {
  let op;
  try { op = JSON.parse(text); } catch { return null; }
  if (!op || typeof op !== "object" || op.done !== true) return null;
  const out = [op.response, op.response?.output, op.metadata?.output].find((o) => o && typeof o === "object" && (o.inlinedResponses || o.responsesFile));
  if (!out) return null;
  const inl = out.inlinedResponses?.inlinedResponses;
  if (Array.isArray(inl) && inl.length) return { inline: inl.map((e) => JSON.stringify(e ?? null)).join("\n") };
  const f = typeof out.responsesFile === "string" ? /^files\/([A-Za-z0-9_-]+)$/.exec(out.responsesFile) : null;
  return f ? { file: f[1] } : null;
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

function priceLine(provider, body, userPrices, model) {
  const acc = createUsageAccumulator(provider, model);
  acc.add(body);
  const metered = acc.result();
  if (!metered || metered.toolUseUnpriced) return null;
  // A premium speed/service tier has no published batch rate: unknown, never standard.
  if (metered.usage.speed === "fast" || metered.usage.service_tier === "priority") return null;
  // #189: a discount stacks on the batch multiplier; an absolute override has no batch rate (unknown).
  const tokens = costWithOverrides(userPrices, provider, metered.model, metered.usage, { batch: provider });
  if (tokens.fallback || tokens.cost_usd === null) return null;
  // #214: tool calls bill at the full per-call rate; the batch discount applies to tokens only.
  const c = withToolCost(tokens, userPrices, provider, metered, null, body);
  if (c.cost_usd === null) return null;
  return { ...c, model: metered.model ?? null };
}

/**
 * Folds a batch results JSONL body. Returns { ok: true, cost_usd, succeeded, free, by_model }
 * or { ok: false, reason: "batch_unpriced", line }. Any malformed, unpriced or
 * premium-speed billed line makes the whole batch unknown: never a $0 guess.
 */
export function foldBatchResults(provider, text, userPrices = null, { model } = {}) {
  let cost = 0, succeeded = 0, free = 0, n = 0;
  const byModel = {};
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
    } else if (provider === "gemini") {
      // #230: {key, response | error} (file) or {response | error, metadata} (inline). Errors are not billed.
      if (line.response == null && line.error) { free++; continue; }
      if (!line.response || typeof line.response !== "object" || !line.response.usageMetadata) return { ok: false, reason: "batch_unpriced", line: i + 1 };
      billed = line.response;
    } else {
      const status = line.response?.status_code;
      if (line.response == null && line.error) { free++; continue; }
      if (typeof status !== "number") return { ok: false, reason: "batch_unpriced", line: i + 1 };
      if (status < 200 || status >= 300) { free++; continue; }
      billed = line.response.body;
    }
    const c = priceLine(provider, billed, userPrices, model);
    if (!c) return { ok: false, reason: "batch_unpriced", line: i + 1 };
    cost += c.cost_usd;
    // #226: keep each succeeded line's model so bill-check can attribute the batch per model.
    const m = typeof c.model === "string" && c.model ? c.model : "unknown";
    byModel[m] = (byModel[m] ?? 0) + c.cost_usd;
    succeeded++;
  }
  if (!n) return { ok: false, reason: "batch_unpriced", line: 0 };
  const by_model = {};
  for (const [m, v] of Object.entries(byModel)) by_model[m] = r6(v);
  return { ok: true, cost_usd: r6(cost), succeeded, free, by_model };
}
