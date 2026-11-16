// #196 fake OpenAI Responses upstream for background mode. `state.status` and
// `state.usage` drive what a retrieve/cancel returns; streams can be cut.
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../../src/proxy.js";

export const MODEL = "gpt-4o-mini";
export const USAGE = { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 };
export const EXPECTED = 0.00045; // 1000 * 0.15/1M + 500 * 0.6/1M
export const CREATE = JSON.stringify({ model: MODEL, input: "long job", background: true });
export const CREATE_STREAM = JSON.stringify({ model: MODEL, input: "long job", background: true, stream: true });
export const CHAT = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] });
export const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
export const resp = (id, status, usage = null) => ({ id, object: "response", status, model: MODEL, usage });

export function fakeUpstream(state) {
  return (req, res) => {
    const json = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    const u = new URL(req.url, "http://x");
    let m;
    if (req.method === "POST" && u.pathname === "/v1/responses") {
      if (state.streamCreate) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(ev({ type: "response.created", sequence_number: 0, response: resp("resp_bg1", "queued") }));
        res.write(ev({ type: "response.output_text.delta", sequence_number: 1, delta: "x" }));
        return setTimeout(() => res.destroy(), 20);
      }
      return json(resp("resp_bg1", "queued"));
    }
    if (req.method === "GET" && (m = /^\/v1\/responses\/([^/]+)$/.exec(u.pathname))) {
      if (u.searchParams.get("stream") === "true") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(ev({ type: "response.output_text.delta", sequence_number: 4, delta: "y" }));
        res.write(ev({ type: `response.${state.status}`, sequence_number: 5, response: resp(m[1], state.status, state.usage) }));
        return res.end();
      }
      return json(resp(m[1], state.status, state.usage));
    }
    if (req.method === "POST" && (m = /^\/v1\/responses\/([^/]+)\/cancel$/.exec(u.pathname))) return json(resp(m[1], "cancelled", state.usage));
    if (req.method === "GET" && /^\/v1\/chat\/completions\/[^/]+$/.test(u.pathname)) return json({ id: "chatcmpl_1", object: "chat.completion", model: MODEL, usage: { prompt_tokens: 1000, completion_tokens: 500 } });
    if (req.method === "POST" && u.pathname === "/v1/chat/completions") return json({ model: MODEL, usage: { prompt_tokens: 10, completion_tokens: 5 } });
    json({ ok: true });
  };
}

export async function setup(t, opts = {}, state = { status: "queued", usage: null }) {
  const up = http.createServer((req, res) => { req.resume(); req.on("end", () => fakeUpstream(state)(req, res)); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receiptsPath = opts.receiptsPath ?? join(mkdtempSync(join(tmpdir(), "cc-bg-")), "r.jsonl");
  const make = () => startMeteringProxy({ upstreams: { openai: base }, receiptsPath, ...opts, cap: typeof opts.cap === "function" ? opts.cap() : opts.cap });
  let p = await make();
  t.after(() => { up.closeAllConnections(); up.close(); p.server.closeAllConnections(); p.server.close(); });
  return {
    state, receiptsPath,
    call: (method, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body }),
    lines: () => readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    restart: async () => { p.server.closeAllConnections(); p.server.close(); p = await make(); },
  };
}
