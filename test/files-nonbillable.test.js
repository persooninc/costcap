import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { isNonBillableFilesRequest, startMeteringProxy } from "../src/proxy.js";

async function setup(t, handler) {
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: base, anthropic: base }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = (method, path, body, headers) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body, headers });
  return { call, receipts };
}
const USAGE = '{"model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":1}}';

test("#158 isNonBillableFilesRequest matches only exact upload/delete paths", () => {
  for (const [m, u] of [["POST", "/anthropic/v1/files"], ["POST", "/openai/v1/files?x=1"], ["DELETE", "/anthropic/v1/files/file_1"], ["DELETE", "/openai/v1/files/file-abc"]])
    assert.equal(isNonBillableFilesRequest(m, u), true, `${m} ${u}`);
  for (const [m, u] of [["POST", "/anthropic/v1/messages/batches"], ["POST", "/openai/v1/batches"], ["POST", "/openai/v1/files/x/extra"],
    ["POST", "/anthropic/v1/files%2F.."], ["POST", "/anthropic//v1/files"], ["POST", "/anthropic/v1/files/../messages"], ["POST", "/anthropic/v1/files/file_1"],
    ["DELETE", "/anthropic/v1/files"], ["DELETE", "/anthropic/v1/files/a\\b"], ["PUT", "/anthropic/v1/files"], ["POST", undefined]])
    assert.equal(isNonBillableFilesRequest(m, u), false, `${m} ${u}`);
});

test("#158 files upload/delete 2xx is non_billable and later messages still work; body is byte-for-byte", async (t) => {
  const bodies = [];
  const { call, receipts } = await setup(t, (req, res) => {
    const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
      bodies.push(Buffer.concat(c));
      if (req.url.endsWith("/files")) res.end('{"id":"file_1","type":"file"}');
      else if (req.method === "DELETE") res.end('{"id":"file_1","type":"file_deleted"}');
      else res.end(USAGE);
    });
  });
  const form = new FormData();
  const bytes = crypto.randomBytes(4096);
  form.append("file", new Blob([bytes]), "doc.pdf");
  const req = new Request("http://x/", { method: "POST", body: form });
  const sent = Buffer.from(await req.arrayBuffer());
  const up = await call("POST", "/anthropic/v1/files", sent, { "content-type": req.headers.get("content-type") });
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { id: "file_1", type: "file" });
  assert.equal(crypto.createHash("sha256").update(bodies[0]).digest("hex"), crypto.createHash("sha256").update(sent).digest("hex"));
  assert.equal((await call("POST", "/openai/v1/files", "x")).status, 200);
  assert.equal((await call("DELETE", "/anthropic/v1/files/file_1")).status, 200);
  assert.equal((await call("POST", "/anthropic/v1/messages", JSON.stringify({ model: "claude-sonnet-4-6" }))).status, 200);
  assert.deepEqual(receipts.slice(0, 3).map((r) => [r.cost_usd, r.reason, r.status]), Array(3).fill([0, "non_billable_request", 200]));
  assert.notEqual(receipts[3].cost_usd, null);
});

test("#158 non-2xx files replies keep today's handling", async (t) => {
  const a = await setup(t, (req, res) => { req.resume(); res.writeHead(400, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}'); });
  assert.equal((await a.call("POST", "/anthropic/v1/files", "x")).status, 400);
  assert.equal(a.receipts[0].reason, "upstream_rejected");
  const b = await setup(t, (req, res) => { req.resume(); res.writeHead(500).end("oops"); });
  await b.call("POST", "/anthropic/v1/files", "x");
  assert.deepEqual([b.receipts[0].cost_usd, b.receipts[0].reason], [null, "usage_unavailable"]);
  assert.equal((await b.call("POST", "/anthropic/v1/messages", "{}")).status, 429);
});

test("#158/#160 batch creates are batch_pending and do not pause", async (t) => {
  for (const path of ["/anthropic/v1/messages/batches", "/openai/v1/batches"]) {
    const { call, receipts } = await setup(t, (req, res) => { req.resume(); res.end(req.url.endsWith("batches") ? '{"id":"b"}' : USAGE); });
    await call("POST", path, "{}");
    assert.deepEqual([receipts[0].cost_usd, receipts[0].reason, receipts[0].batch_id], [null, "batch_pending", "b"], path);
    assert.equal((await call("POST", "/anthropic/v1/messages", "{}")).status, 200, path);
  }
});

test("#158 non-files 2xx POSTs without usage still pause", async (t) => {
  for (const path of ["/openai/v1/files/x/extra", "/anthropic/v1/files%2F.."]) {
    const { call, receipts } = await setup(t, (req, res) => { req.resume(); res.end('{"id":"b"}'); });
    await call("POST", path, "{}");
    assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "usage_unavailable"], path);
    const next = await call("POST", "/anthropic/v1/messages", "{}");
    assert.equal(next.status, 429, path);
    assert.equal((await next.json()).error, "accounting_unavailable");
  }
});
