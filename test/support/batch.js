// #160 shared batch fixtures: JSONL results and a mock OpenAI/Anthropic (#230: Gemini) upstream.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costForUsage } from "../../src/pricing.js";
import { extractUsage } from "../../src/proxy.js";

const FIX = new URL("../fixtures/batch/", import.meta.url).pathname;
export const ANTHROPIC_RESULTS = readFileSync(join(FIX, "anthropic-results.jsonl"), "utf8");
export const OPENAI_RESULTS = readFileSync(join(FIX, "openai-results.jsonl"), "utf8");
const half = (model, usage) => costForUsage(model, usage).cost_usd * 0.5;
export const ANTHROPIC_EXPECTED = Number((half("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 2000 }) +
  half("claude-sonnet-4-6", { input_tokens: 300000, output_tokens: 100 })).toFixed(6));
export const OPENAI_EXPECTED = Number((half("gpt-4o-mini", { input_tokens: 900, output_tokens: 200, cached_input_tokens: 100 }) +
  half("gpt-4o", { input_tokens: 400, output_tokens: 50 })).toFixed(6));

// #230: Gemini Batch Mode. Two priced responses (one with cache + thoughts) and one error.
export const GEMINI_OK_1 = { candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "STOP" }], modelVersion: "gemini-2.5-flash",
  usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 100, cachedContentTokenCount: 200, totalTokenCount: 1600 } };
export const GEMINI_OK_2 = { candidates: [{ content: { parts: [{ text: "b" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40, totalTokenCount: 540 } };
export const GEMINI_INLINE = [{ response: GEMINI_OK_1, metadata: { key: "r1" } }, { response: GEMINI_OK_2, metadata: { key: "r2" } }, { error: { code: 400, message: "bad" }, metadata: { key: "r3" } }];
export const GEMINI_RESULTS = [{ key: "r1", response: GEMINI_OK_1 }, { key: "r2", response: GEMINI_OK_2 }, { key: "r3", error: { code: 400 } }].map((l) => JSON.stringify(l)).join("\n") + "\n";
const interactive = (body) => { const m = extractUsage("gemini", JSON.stringify(body), "gemini-2.5-flash"); return costForUsage(m.model, m.usage).cost_usd; };
export const GEMINI_EXPECTED = Number(((interactive(GEMINI_OK_1) + interactive(GEMINI_OK_2)) * 0.5).toFixed(6));
export const geminiOp = (state, extra = {}) => ({ name: "batches/gb_01", metadata: { "@type": "type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatch", state }, ...extra });

export function mockUpstream({ anthropicResults = ANTHROPIC_RESULTS, openaiResults = OPENAI_RESULTS, geminiGet = geminiOp("BATCH_STATE_SUCCEEDED", { done: true, response: { inlinedResponses: { inlinedResponses: GEMINI_INLINE } } }), geminiResults = GEMINI_RESULTS } = {}) {
  return (req, res) => {
    const json = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    const u = req.url.split("?")[0];
    if (req.method === "POST" && u === "/v1/messages/batches") return json({ id: "msgbatch_01", type: "message_batch", processing_status: "in_progress" });
    if (req.method === "GET" && u === "/v1/messages/batches/msgbatch_01/results") return res.writeHead(200, { "content-type": "application/binary" }).end(anthropicResults);
    if (req.method === "POST" && u === "/v1/batches") return json({ id: "batch_01", object: "batch", status: "validating", input_file_id: "file-in" });
    if (req.method === "GET" && u === "/v1/batches/batch_01") return json({ id: "batch_01", object: "batch", status: "completed", output_file_id: "file-out" });
    if (req.method === "GET" && /^\/v1\/files\/[^/]+\/content$/.test(u)) return res.writeHead(200, { "content-type": "application/octet-stream" }).end(openaiResults);
    if (req.method === "POST" && u === "/v1/messages") return json({ model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5 } });
    if (req.method === "POST" && u === "/v1/chat/completions") return json({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 } });
    if (req.method === "POST" && /^\/v1beta\/models\/[^/]+:batchGenerateContent$/.test(u)) return json(geminiOp("BATCH_STATE_PENDING"));
    if (req.method === "GET" && u === "/v1beta/batches/gb_01") return json(geminiGet);
    if (req.method === "GET" && /^\/download\/v1beta\/files\/[^/]+:download$/.test(u)) return res.writeHead(200, { "content-type": "application/octet-stream" }).end(geminiResults);
    if (req.method === "POST" && u === "/v1beta/batches/gb_01:cancel") return json({});
    if (req.method === "DELETE" && u === "/v1beta/batches/gb_01") return json({});
    if (req.method === "POST" && /^\/v1beta\/models\/[^/]+:generateContent$/.test(u)) return json({ ...GEMINI_OK_2, modelVersion: "gemini-2.5-flash" });
    json({ ok: true });
  };
}

