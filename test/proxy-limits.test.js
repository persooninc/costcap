// #154: idle-based stream timeout, configurable first-byte timeout, 32 MB body limit.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy, DEFAULT_MAX_BODY_BYTES, DEFAULT_UPSTREAM_TIMEOUT_MS, DEFAULT_STREAM_IDLE_MS } from "../src/proxy.js";
import { proxyLimits, parseWrapArgs } from "../src/cli.js";

async function fixture(t, handler, options = {}) {
  const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-lim-")), "receipts.jsonl");
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, receiptsPath, ...options });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = (body = JSON.stringify({ model: "gpt-4o-mini", stream: true })) =>
    fetch(`http://127.0.0.1:${p.port}/openai/v1/chat/completions`, { method: "POST", body });
  const receipts = () => readFileSync(receiptsPath, "utf8").trim().split("\n").map(JSON.parse);
  return { call, receipts };
}

const usageChunk = 'data: {"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n';
const sse = (res) => res.writeHead(200, { "content-type": "text/event-stream" });

test("defaults match the official SDKs and Anthropic request limit", () => {
  assert.equal(DEFAULT_UPSTREAM_TIMEOUT_MS, 600_000);
  assert.equal(DEFAULT_STREAM_IDLE_MS, 300_000);
  assert.equal(DEFAULT_MAX_BODY_BYTES, 32 * 1024 * 1024);
  assert.deepEqual(proxyLimits({}, {}), { timeoutMs: 600_000, streamIdleMs: 300_000, maxBodyBytes: 32 * 1024 * 1024 });
});

test("limits come from --timeout and env; --timeout wins; bad values refused", () => {
  const env = { COSTCAP_UPSTREAM_TIMEOUT_S: "120", COSTCAP_STREAM_IDLE_TIMEOUT_S: "30", COSTCAP_MAX_REQUEST_MB: "64" };
  assert.deepEqual(proxyLimits({}, env), { timeoutMs: 120_000, streamIdleMs: 30_000, maxBodyBytes: 64 * 1024 * 1024 });
  assert.equal(proxyLimits({ timeoutS: 900 }, env).timeoutMs, 900_000);
  assert.equal(proxyLimits({}, { COSTCAP_UPSTREAM_TIMEOUT_S: "" }).timeoutMs, 600_000);
  assert.throws(() => proxyLimits({}, { COSTCAP_MAX_REQUEST_MB: "big" }), /COSTCAP_MAX_REQUEST_MB must be a positive number/);
  assert.equal(parseWrapArgs(["--timeout", "45", "--", "node"]).timeoutS, 45);
  assert.throws(() => parseWrapArgs(["--timeout", "0", "--", "node"]), /--timeout must be a positive number/);
});

test("a stream that keeps sending chunks past the idle timeout finishes and is metered", async (t) => {
  const { call, receipts } = await fixture(t, (req, res) => {
    sse(res);
    let n = 0;
    const tick = setInterval(() => {
      if (++n <= 5) { res.write(`data: {"choices":[{"delta":{"content":"${n}"}}]}\n\n`); return; }
      clearInterval(tick); res.end(usageChunk + "data: [DONE]\n\n");
    }, 300);
  }, { streamIdleMs: 500, timeoutMs: 500 });
  const r = await call();
  assert.equal(r.status, 200);
  assert.match(await r.text(), /\[DONE\]/);
  const [rec] = receipts();
  assert.equal(rec.reason, undefined);
  assert.ok(rec.cost_usd > 0);
});

test("a stream that goes silent past the idle timeout is cut as stream_incomplete", async (t) => {
  const { call, receipts } = await fixture(t, (req, res) => { sse(res); res.write('data: {"choices":[]}\n\n'); }, { streamIdleMs: 200 });
  const r = await call();
  await r.text().catch(() => {});
  const [rec] = receipts();
  assert.equal(rec.reason, "stream_incomplete");
  assert.equal(rec.cost_usd, null);
  assert.equal((await call()).status, 429);
});

test("first-byte timeout still latches an uncertain outcome", async (t) => {
  const { call, receipts } = await fixture(t, () => {}, { timeoutMs: 100 });
  assert.equal((await call()).status, 502);
  assert.equal(receipts()[0].reason, "upstream_outcome_unknown");
});

test("a 3 MB body is forwarded to the upstream by default", async (t) => {
  let got = 0;
  const { call } = await fixture(t, (req, res) => {
    req.on("data", (c) => { got += c.length; });
    req.on("end", () => res.end('{"model":"gpt-4o-mini","usage":{"prompt_tokens":1,"completion_tokens":1}}'));
  });
  const body = JSON.stringify({ model: "gpt-4o-mini", image: "x".repeat(3_000_000) });
  assert.equal((await call(body)).status, 200);
  assert.equal(got, Buffer.byteLength(body));
});

test("an over-limit body gets a 413 naming the limit, a zero-cost receipt, and no latch", async (t) => {
  let hits = 0;
  const { call, receipts } = await fixture(t, (req, res) => {
    hits++; req.resume();
    req.on("end", () => res.end('{"model":"gpt-4o-mini","usage":{"prompt_tokens":1,"completion_tokens":1}}'));
  }, { maxBodyBytes: 1024 });
  const r = await call(JSON.stringify({ model: "gpt-4o-mini", blob: "x".repeat(4096) }));
  assert.equal(r.status, 413);
  const body = await r.json();
  assert.equal(body.error, "request_too_large");
  assert.equal(body.bytes_limit, 1024);
  assert.match(body.message, /COSTCAP_MAX_REQUEST_MB/);
  assert.equal(hits, 0);
  const [rec] = receipts();
  assert.deepEqual({ blocked: rec.blocked, reason: rec.reason, cost_usd: rec.cost_usd, bytes_limit: rec.bytes_limit },
    { blocked: true, reason: "request_too_large", cost_usd: 0, bytes_limit: 1024 });
  assert.equal((await call(JSON.stringify({ model: "gpt-4o-mini" }))).status, 200);
  assert.equal(hits, 1);
});
