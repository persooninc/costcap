// Local, post-response metering. Only proxy-routed traffic is covered.
// Requests are serialized per proxy, so the next decision sees prior usage.
// A request already accepted by a provider can exceed the remaining budget.
import http from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { receiptPath } from "./receipt-path.js";
import { randomUUID } from "node:crypto";
import { costForUsage } from "./pricing.js";
import { budgetExceededBody } from "./cap.js";
import { createSpiralDetector } from "./spiral.js";
import { preflightCheck } from "./preflight.js";

const PROVIDERS = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api",
  gemini: "https://generativelanguage.googleapis.com",
};

export function baseUrlOverrides(port, providers = Object.keys(PROVIDERS)) {
  const lines = [];
  if (providers.includes("openai")) lines.push(`OPENAI_BASE_URL=http://127.0.0.1:${port}/openai/v1`);
  if (providers.includes("anthropic")) lines.push(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port}/anthropic`);
  if (providers.includes("openrouter")) lines.push(`OPENROUTER_BASE_URL=http://127.0.0.1:${port}/openrouter`);
  if (providers.includes("gemini")) lines.push(`GEMINI_BASE_URL=http://127.0.0.1:${port}/gemini`);
  return lines;
}

// Folds provider usage shapes from parsed JSON chunks (whole body or SSE events).
export function createUsageAccumulator(provider, requestedModel) {
  let model = requestedModel ?? "unknown";
  let usage = {};
  // OpenAI Responses API streams nest model/usage under `response` and end with
  // a terminal event (response.completed / response.incomplete / response.failed).
  let responsesStream = false, responsesTerminal = false;
  const add = (chunk) => {
    if (!chunk || typeof chunk !== "object") return;
    if (provider !== "anthropic" && provider !== "gemini" && typeof chunk.type === "string" && chunk.type.startsWith("response.")) {
      responsesStream = true;
      if (/^response\.(completed|incomplete|failed)$/.test(chunk.type)) responsesTerminal = true;
      if (chunk.response && typeof chunk.response === "object") chunk = chunk.response;
      else return;
    }
    if (chunk.model || chunk.modelVersion || chunk.message?.model) model = chunk.model ?? chunk.modelVersion ?? chunk.message.model;
    if (provider === "gemini") {
      const u = chunk.usageMetadata;
      if (u) usage = { input_tokens: (u.promptTokenCount ?? 0) - (u.cachedContentTokenCount ?? 0),
        cached_input_tokens: u.cachedContentTokenCount ?? 0,
        output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
    } else if (provider === "anthropic") {
      // message_start contains input usage; message_delta carries final output.
      const u = chunk.usage ?? chunk.message?.usage;
      if (u) {
        if (u.input_tokens != null) usage.input_tokens = u.input_tokens;
        if (u.cache_creation_input_tokens != null) {
          // Without the 5m/1h breakdown every write is priced at the 5-minute rate.
          const longLived = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          usage.cache_write_input_tokens = u.cache_creation_input_tokens - longLived;
          usage.cache_write_1h_input_tokens = longLived;
        }
        if (u.output_tokens != null) usage.output_tokens = u.output_tokens;
        if (u.cache_read_input_tokens != null) usage.cached_input_tokens = u.cache_read_input_tokens;
      }
    } else {
      const u = chunk.usage;
      if (u) usage = { input_tokens: (u.prompt_tokens ?? u.input_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0),
        output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
        cached_input_tokens: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0 };
    }
  };
  const result = () => {
    if (!Object.keys(usage).length) return null;
    for (const value of Object.values(usage)) if (!Number.isFinite(value) || value < 0) return null;
    return { model, usage: { ...usage } };
  };
  // A Responses stream that never reached a terminal event is incomplete.
  return { add, result, get incomplete() { return responsesStream && !responsesTerminal; } };
}

export function extractUsage(provider, text, requestedModel) {
  let chunks;
  try { const parsed = JSON.parse(text); chunks = Array.isArray(parsed) ? parsed : [parsed]; }
  catch {
    const parser = createSseUsageParser(provider, requestedModel);
    parser.push(text);
    return parser.end();
  }
  const acc = createUsageAccumulator(provider, requestedModel);
  for (const chunk of chunks) acc.add(chunk);
  return acc.result();
}

// Incremental SSE parser: accepts arbitrary text fragments (lines may be split
// across network chunks), joins multi-line `data:` fields per event, and
// ignores `[DONE]` and non-JSON payloads.
export function createSseUsageParser(provider, requestedModel) {
  const acc = createUsageAccumulator(provider, requestedModel);
  let pending = "";
  let data = [];
  let done = false;
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join("\n");
    data = [];
    if (payload.trim() === "[DONE]") { done = true; return; }
    try { acc.add(JSON.parse(payload)); } catch { /* non-JSON event data is passed through unmetered */ }
  };
  const line = (raw) => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text === "") return dispatch();
    if (!text.startsWith("data:")) return;
    const value = text.slice(5);
    // Lenient: some providers/fixtures omit the blank line between events, so a
    // new data line after an already-complete JSON payload starts a new event.
    if (data.length) { try { JSON.parse(data.join("\n")); dispatch(); } catch { if (data.join("\n").trim() === "[DONE]") dispatch(); } }
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  };
  return {
    push(fragment) {
      pending += fragment;
      let i;
      while ((i = pending.indexOf("\n")) !== -1) { line(pending.slice(0, i)); pending = pending.slice(i + 1); }
    },
    end() { if (pending) { line(pending); pending = ""; } dispatch(); return acc.result(); },
    usage: () => acc.result(),
    get incomplete() { return acc.incomplete; },
    get done() { return done; },
  };
}

export function createMeteringProxy({ receiptsPath, upstreams = PROVIDERS, onReceipt, cap,
  spiral = createSpiralDetector(), velocity, killCheck, who = {}, agentBudgets, teamCheck, sharedLedger, preflight = false, timeoutMs = 60_000, maxBodyBytes = 2_000_000 } = {}) {
  if (receiptsPath) mkdirSync(dirname(receiptsPath), { recursive: true });
  let queue = Promise.resolve();
  let accountingFailure = null;
  // Shared ledger (CC-5): decide and append inside the cross-process critical section.
  // Reentrant: emit() inside an already-guarded decision reuses the held section.
  let held = false;
  const guarded = (fn) => {
    if (!sharedLedger || held) return fn();
    return sharedLedger.withLock(() => { held = true; try { return fn(); } finally { held = false; } });
  };
  const emit = (receipt) => guarded(() => {
    const complete = { id: randomUUID(), ts: new Date().toISOString(), ...who, ...receipt };
    agentBudgets?.record(complete);
    // Persist before invoking integrations. Callback failures must not break metering.
    if (receiptsPath) appendFileSync(receiptsPath, JSON.stringify(complete) + "\n", { mode: 0o600 });
    try { Promise.resolve(onReceipt?.(complete)).catch(() => {}); } catch { /* delivery is outside the local ledger */ }
    return complete;
  });
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const [, provider, ...rest] = url.pathname.split("/");
    const upstream = upstreams[provider];
    const send = (status, body) => { if (!res.writableEnded && !res.destroyed) res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
    if (!upstream || !rest.length) { send(404, { error: "unknown provider path" }); return; }
    const chunks = [];
    let size = 0, tooLarge = false;
    req.on("data", (chunk) => { size += chunk.length; if (size > maxBodyBytes) { tooLarge = true; chunks.length = 0; } else if (!tooLarge) chunks.push(chunk); });
    req.on("error", () => {});
    req.on("end", () => {
      if (tooLarge) { send(413, { error: "request_too_large" }); return; }
      const body = Buffer.concat(chunks);
      const run = async () => {
        if (res.destroyed) return;
        const path = `/${rest.join("/")}${url.search}`;
        const storedPath = receiptPath(`/${rest.join("/")}`, url.search);
        const block = (reason, detail, response) => {
          emit({ provider, path: storedPath, blocked: true, reason, cost_usd: 0, ...detail });
          send(429, response);
          return "blocked";
        };
        let preflightEst;
        const verdict = guarded(() => {
          const killed = killCheck?.();
          if (killed) return block("killed", killed, { error: "killed", ...killed });
          if (accountingFailure) return block("accounting_unavailable", {}, { error: "accounting_unavailable", message: accountingFailure });
          const agentHit = agentBudgets?.check(who);
          if (agentHit) return block(agentHit.reason, agentHit, { error: agentHit.verdict, ...agentHit });
          const teamHit = teamCheck?.();
          if (teamHit) return block(teamHit.reason, teamHit, { error: teamHit.verdict, ...teamHit });
          const hit = cap?.check();
          if (hit) return block("budget_exceeded", hit, budgetExceededBody(hit));
          if (preflight) {
            const pf = preflightCheck(cap, provider, body, path, (est) => { preflightEst = est; });
            if (pf?.reason === "preflight_unpriced") return block("preflight_unpriced", pf, { error: { type: "preflight_unpriced", model: pf.model,
              message: `CostCap preflight: model "${pf.model}" has no published rate, so its worst case cannot be estimated. The upstream call was not made.` } });
            if (pf) return block("budget_exceeded", pf, { error: { type: "budget_exceeded", reason: "preflight_estimate", estimate: true,
              message: `CostCap preflight estimate: worst case $${pf.estimate_usd} does not fit the remaining ${pf.scope} budget ($${pf.remaining_usd[pf.scope]}). This is an estimate. The upstream call was not made.`,
              scope: pf.scope, estimate_usd: pf.estimate_usd, remaining_usd: pf.remaining_usd } });
          }
          const vhit = velocity?.check();
          if (vhit) return block(vhit.reason, vhit, { error: "breaker_open", ...vhit });
          const spiralHit = spiral?.observe(req.method, path, body.toString("utf8"));
          if (spiralHit) return block("spiral_detected", spiralHit, { error: "spiral_detected", ...spiralHit });
          return null;
        });
        if (verdict === "blocked") return;
        const headers = { ...req.headers };
        for (const key of ["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]) delete headers[key];
        let requestedModel;
        try { requestedModel = JSON.parse(body).model; } catch { /* provider handles malformed JSON */ }
        if (!requestedModel && provider === "gemini") requestedModel = /models\/([^/:]+)/.exec(path)?.[1];
        try {
          const abort = new AbortController();
          const onClientClose = () => { if (!res.writableFinished) abort.abort(); };
          res.once("close", onClientClose);
          const upstreamRes = await fetch(`${upstream}${path}`, { method: req.method, headers,
            body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
            signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), abort.signal]) });
          const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
          const receipt = { provider, path: storedPath, status: upstreamRes.status, blocked: false,
            ...(preflightEst && { output_tokens_est: preflightEst.output_tokens, output_multiplier: preflightEst.output_multiplier }) };
          let metered, raw, streamCut = false, sseIncomplete = false;
          if (/^text\/event-stream/i.test(contentType) && upstreamRes.body) {
            // Real-time pass-through: forward each chunk as it arrives, meter from the stream.
            const parser = createSseUsageParser(provider, requestedModel);
            const decoder = new TextDecoder();
            if (!res.destroyed) {
              res.writeHead(upstreamRes.status, { "content-type": contentType, "cache-control": "no-cache" });
              res.flushHeaders();
            }
            const reader = upstreamRes.body.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                parser.push(decoder.decode(value, { stream: true }));
                if (res.destroyed) throw new Error("client_closed");
                if (!res.write(value)) {
                  await new Promise((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
                }
              }
              parser.push(decoder.decode());
            } catch {
              streamCut = true;
              abort.abort();
              reader.cancel().catch(() => {});
            }
            metered = parser.end();
            // Responses stream ended without a terminal event: usage may be partial or absent.
            if (parser.incomplete) { sseIncomplete = true; metered = null; }
          } else {
            raw = Buffer.from(await upstreamRes.arrayBuffer());
            metered = extractUsage(provider, raw.toString("utf8"), requestedModel);
          }
          res.off("close", onClientClose);
          if (metered) {
            Object.assign(receipt, costForUsage(metered.model, metered.usage));
            cap?.record(receipt);
            if (receipt.cost_usd === null) accountingFailure = "A cache write has no published rate for this model. Restart only after reconciling this request.";
            else velocity?.record(receipt.cost_usd);
          } else if (streamCut || sseIncomplete) {
            // Stream cut (upstream error, client abort or timeout) before usage arrived.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: null, reason: "stream_incomplete" });
            accountingFailure = "A streamed response was cut before usage arrived. Restart only after reconciling this request.";
          } else {
            // Unknown spend is never silently free. Stop subsequent calls.
            Object.assign(receipt, { model: requestedModel ?? "unknown", cost_usd: null, reason: "usage_unavailable" });
            accountingFailure = "Provider returned no usable token usage. Restart only after reconciling this request.";
          }
          emit(receipt);
          if (raw) { if (!res.destroyed) res.writeHead(upstreamRes.status, { "content-type": contentType }).end(raw); }
          else if (streamCut) res.destroy();
          else if (!res.destroyed) res.end();
        } catch {
          // A failed fetch may already have billed upstream. Do not assume zero.
          accountingFailure = "Upstream outcome or receipt persistence is uncertain. Reconcile before restarting.";
          try { emit({ provider, path: storedPath, blocked: false, cost_usd: null, reason: "upstream_outcome_unknown" }); } catch { /* stop on broken ledger */ }
          send(502, { error: "upstream_outcome_unknown" });
        }
      };
      queue = queue.then(run).catch(() => { accountingFailure = "Receipt ledger unavailable."; send(503, { error: "receipt_ledger_unavailable" }); });
    });
  });
}

export function startMeteringProxy(opts = {}, port = 0) {
  const server = createMeteringProxy(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
