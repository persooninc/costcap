// #160 shared batch fixtures: JSONL results and a mock OpenAI/Anthropic upstream.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costForUsage } from "../../src/pricing.js";

const FIX = new URL("../fixtures/batch/", import.meta.url).pathname;
export const ANTHROPIC_RESULTS = readFileSync(join(FIX, "anthropic-results.jsonl"), "utf8");
export const OPENAI_RESULTS = readFileSync(join(FIX, "openai-results.jsonl"), "utf8");
const half = (model, usage) => costForUsage(model, usage).cost_usd * 0.5;
export const ANTHROPIC_EXPECTED = Number((half("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 2000 }) +
  half("claude-sonnet-4-6", { input_tokens: 300000, output_tokens: 100 })).toFixed(6));
export const OPENAI_EXPECTED = Number((half("gpt-4o-mini", { input_tokens: 900, output_tokens: 200, cached_input_tokens: 100 }) +
  half("gpt-4o", { input_tokens: 400, output_tokens: 50 })).toFixed(6));

export function mockUpstream({ anthropicResults = ANTHROPIC_RESULTS, openaiResults = OPENAI_RESULTS } = {}) {
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
    json({ ok: true });
  };
}

