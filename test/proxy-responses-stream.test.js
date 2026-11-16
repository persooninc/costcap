// #132: streamed OpenAI Responses API calls are metered from the terminal event.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSseUsageParser, extractUsage, startMeteringProxy } from "../src/proxy.js";
import { costForUsage } from "../src/pricing.js";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const tick = () => new Promise((r) => setTimeout(r, 30));
const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const USAGE = { input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 400_000 }, output_tokens: 200_000, output_tokens_details: { reasoning_tokens: 50_000 }, total_tokens: 1_200_000 };
const resp = (status, usage) => ({ id: "resp_1", object: "response", status, model: "gpt-4o-mini-2024-07-18", usage });
const terminal = (type, usage = USAGE) => ev({ type, response: resp(type.slice(9), usage) });
const START = [ev({ type: "response.created", response: resp("in_progress", null) }), ev({ type: "response.in_progress", response: resp("in_progress", null) }),
  ev({ type: "response.output_text.delta", delta: "hi" })];
const COMPLETED = [...START, terminal("response.completed")];
const EXPECTED_USAGE = { input_tokens: 600_000, output_tokens: 200_000, cached_input_tokens: 400_000 };

function upstream(events, { cutAfter } = {}) {
  return http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const next = () => {
      if (cutAfter !== undefined && i === cutAfter) return res.destroy();
      if (i === events.length) return res.end();
      res.write(events[i++]); setTimeout(next, 5);
    };
    next();
  });
}

async function setup(t, events, opts) {
  const up = upstream(events, opts);
  const port = await listen(up);
  const receipts = [];
  const { server, port: proxy } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${port}` }, onReceipt: (r) => receipts.push(r) });
  t.after(() => { server.closeAllConnections(); server.close(); up.closeAllConnections(); up.close(); });
  const call = async () => { const r = await fetch(`http://127.0.0.1:${proxy}/openai/v1/responses`, { method: "POST", body: '{"model":"gpt-4o-mini","stream":true}' }); return { status: r.status, body: await r.text() }; };
  return { receipts, call };
}

test("parser: response.completed usage and model; null usage on early events never overwrites", () => {
  const p = createSseUsageParser("openai", "req-model");
  p.push(START.join(""));
  assert.equal(p.usage(), null);
  assert.equal(p.incomplete, true);
  p.push(terminal("response.completed"));
  p.push(ev({ type: "response.in_progress", response: resp("in_progress", null) })); // late null must not clobber
  assert.deepEqual(p.end(), { model: "gpt-4o-mini-2024-07-18", usage: EXPECTED_USAGE });
  assert.equal(p.incomplete, false);
});

test("cached tokens priced identically to the non-streamed Responses receipt", () => {
  const streamed = extractUsage("openai", COMPLETED.join(""));
  const plain = extractUsage("openai", JSON.stringify(resp("completed", USAGE)));
  assert.deepEqual(streamed, plain);
  const c = costForUsage(streamed.model, streamed.usage);
  assert.ok(c.cost_usd > 0);
  assert.equal(c.cost_usd, costForUsage("gpt-4o-mini", EXPECTED_USAGE).cost_usd);
});

test("chat-completions streams are not affected by Responses tracking", () => {
  const p = createSseUsageParser("openai");
  p.push('data: {"model":"gpt-4o-mini","usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
  assert.equal(p.incomplete, false);
  assert.deepEqual(p.end(), { model: "gpt-4o-mini", usage: { input_tokens: 3, output_tokens: 4, cached_input_tokens: 0 } });
});

test("proxy: streamed Responses call writes one priced receipt and the next call is not paused", async (t) => {
  const { receipts, call } = await setup(t, COMPLETED);
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body, COMPLETED.join(""));
  await tick();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].model, "gpt-4o-mini-2024-07-18");
  assert.equal(receipts[0].input_tokens, 600_000);
  assert.equal(receipts[0].cached_input_tokens, 400_000);
  assert.equal(receipts[0].output_tokens, 200_000);
  assert.equal(typeof receipts[0].cost_usd, "number");
  assert.equal((await call()).status, 200);
  await tick();
  assert.equal(receipts.length, 2);
});

for (const type of ["response.incomplete", "response.failed"]) {
  test(`proxy: ${type} with usage is metered`, async (t) => {
    const { receipts, call } = await setup(t, [...START, terminal(type)]);
    await call(); await tick();
    assert.equal(typeof receipts[0].cost_usd, "number");
    assert.equal(receipts[0].reason, undefined);
  });
  test(`proxy: ${type} without usage stays unknown`, async (t) => {
    const { receipts, call } = await setup(t, [...START, terminal(type, null)]);
    await call(); await tick();
    assert.equal(receipts[0].cost_usd, null);
    assert.equal(receipts[0].reason, "usage_unavailable");
  });
}

test("proxy: Responses stream ending without a terminal event is stream_incomplete and pauses", async (t) => {
  const { receipts, call } = await setup(t, START);
  await call(); await tick();
  assert.equal(receipts[0].cost_usd, null);
  assert.equal(receipts[0].reason, "stream_incomplete");
  assert.equal((await call()).status, 429);
});

test("proxy: Responses stream cut before the terminal event is stream_incomplete", async (t) => {
  const { receipts, call } = await setup(t, COMPLETED, { cutAfter: 2 });
  await call().catch(() => {}); await tick();
  assert.equal(receipts[0].cost_usd, null);
  assert.equal(receipts[0].reason, "stream_incomplete");
});

test("e2e: costcap wrap meters two streamed Responses calls and the run is not paused", async (t) => {
  const up = upstream(COMPLETED);
  const upPort = await listen(up);
  t.after(() => { up.closeAllConnections(); up.close(); });
  const dir = mkdtempSync(join(tmpdir(), "cc-resp-"));
  const receiptsPath = join(dir, "r.jsonl");
  const script = `for (let i = 0; i < 2; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + "/responses", { method: "POST", body: '{"stream":true}' }); await r.text(); console.log(r.status); }`;
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "wrap", "--receipts", receiptsPath, "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}` } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out, err: err.replace(/\x1b\[[0-9;]*m/g, "") }));
  });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trim().split("\n"), ["200", "200"]);
  const rows = readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.provider === "openai");
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(typeof r.cost_usd, "number");
  assert.doesNotMatch(result.err, /unknown|paused|accounting/i);
});
