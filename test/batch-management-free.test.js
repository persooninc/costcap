// #233: batch cancel/delete and Gemini Files upload/delete are $0, never latch the run,
// and skip the allowlist, --unknown-models refuse and preflight checks.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isNonBillableFilesRequest, startMeteringProxy } from "../src/proxy.js";

const MGMT = [
  ["POST", "/openai/v1/batches/batch_01/cancel"],
  ["POST", "/anthropic/v1/messages/batches/msgbatch_01/cancel"],
  ["DELETE", "/anthropic/v1/messages/batches/msgbatch_01"],
  ["POST", "/gemini/v1beta/batches/gb_01:cancel"],
  ["DELETE", "/gemini/v1beta/batches/gb_01"],
  ["POST", "/gemini/upload/v1beta/files"],
  ["POST", "/gemini/upload/v1beta/files?uploadType=resumable"],
  ["POST", "/gemini/upload/v1beta/files?upload_id=abc&upload_protocol=resumable"],
  ["DELETE", "/gemini/v1beta/files/abc"],
];
const CHAT = "/openai/v1/chat/completions";
const CHAT_BODY = JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
const CHAT_REPLY = '{"model":"gpt-4o-mini","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}';

async function setup(t, opts = {}) {
  const hits = [];
  const up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { hits.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json"); res.end(req.url.includes("chat") ? CHAT_REPLY : '{"id":"x"}'); });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: base, anthropic: base, gemini: base }, onReceipt: (r) => receipts.push(r), ...opts });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = (method, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body, headers: { "content-type": "application/json" } });
  return { call, receipts, hits };
}

test("#233 matcher: batch management and Gemini files paths are exact", () => {
  for (const [m, u] of MGMT) assert.equal(isNonBillableFilesRequest(m, u), true, `${m} ${u}`);
  for (const [m, u] of [["DELETE", "/gemini/v1beta/files/a/b"], ["DELETE", "/gemini/v1beta/files/a%2Fb"], ["DELETE", "/gemini/v1beta/files/../models"],
    ["POST", "/gemini/upload/v1beta/files/x"], ["POST", "/openai/v1/batches/b/cancel/x"], ["POST", "/openai/v1/batches/b"], ["DELETE", "/openai/v1/batches/b"],
    ["GET", "/openai/v1/batches/b/cancel"], ["POST", "/anthropic/v1/messages/batches/b"], ["POST", "/gemini/v1beta/batches/b"],
    ["DELETE", "/gemini/v1beta/batches/b:cancel"], ["POST", "/gemini/v1beta/batches/b%3Acancel"], ["POST", "/gemini/v1beta/models/m:batchGenerateContent"]])
    assert.equal(isNonBillableFilesRequest(m, u), false, `${m} ${u}`);
});

const MODES = {
  "plain wrap": {},
  "--preflight": { preflight: true },
  "--models": { allowedModels: () => ["gpt-4o-mini", "claude-sonnet-4-6", "gemini-2.5-flash"] },
  "--unknown-models refuse": { unknownModels: "refuse" },
};
for (const [name, opts] of Object.entries(MODES)) {
  test(`#233 ${name}: management calls reach upstream, are $0 and never latch`, async (t) => {
    for (const [m, u] of MGMT) {
      const { call, receipts, hits } = await setup(t, opts);
      const res = await call(m, u, m === "POST" ? "{}" : undefined);
      assert.equal(res.status, 200, `${name} ${m} ${u}`);
      assert.equal(hits.length, 1, `${name} ${m} ${u} reached upstream`);
      assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [0, "non_billable_request"], `${name} ${m} ${u}`);
      assert.equal((await call("POST", CHAT, CHAT_BODY)).status, 200, `${name} follow-up after ${m} ${u}`);
    }
  });
}

test("#233 a cancelled batch stays batch_pending (cancel does not settle it)", async (t) => {
  const { call, receipts } = await setup(t);
  await call("POST", "/anthropic/v1/messages/batches", JSON.stringify({ requests: [{ custom_id: "a", params: { model: "claude-sonnet-4-6", max_tokens: 5, messages: [] } }] }));
  assert.equal(receipts[0].reason, "batch_pending");
  await call("POST", "/anthropic/v1/messages/batches/x/cancel", "{}");
  assert.deepEqual([receipts[1].reason, receipts[1].cost_usd, receipts[1].settles_batch], ["non_billable_request", 0, undefined]);
  assert.equal(receipts.filter((r) => r.reason === "batch_pending").length, 1);
});

test("#233 look-alike paths stay non-exempt and still pause", async (t) => {
  const { call, receipts } = await setup(t);
  await call("DELETE", "/gemini/v1beta/files/a/b");
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "usage_unavailable"]);
  assert.equal((await call("POST", CHAT, CHAT_BODY)).status, 429);
});
