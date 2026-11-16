// #239 e2e: wrap --otlp pushes GenAI spans + a costcap.run span to a local fake collector. No paid calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const SENTINEL = "SENTINEL-PROMPT-7f3a";

async function listen(t, handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return s;
}
async function upstream(t, { usage = true } = {}) {
  const hits = [];
  const s = await listen(t, (q, res) => { hits.push(q.url); q.resume(); q.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", ...(usage && { usage: { prompt_tokens: 1_000_000, completion_tokens: 10 } }) }))); });
  return { url: `http://127.0.0.1:${s.address().port}`, hits };
}
async function collector(t, { status = 200, hang = false } = {}) {
  const posts = [];
  let connections = 0;
  const s = await listen(t, (q, res) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", () => { posts.push({ method: q.method, url: q.url, headers: q.headers, raw: b, body: JSON.parse(b) }); if (!hang) res.writeHead(status, { "content-type": "application/json" }).end("{}"); });
  });
  s.on("connection", () => connections++);
  return { url: `http://127.0.0.1:${s.address().port}`, posts, connections: () => connections, spans: () => posts.flatMap((p) => p.body.resourceSpans[0].scopeSpans[0].spans) };
}
function wrap(up, flags, calls, env = {}, path = "/chat/completions") {
  const dir = mkdtempSync(join(tmpdir(), "cc-otlp-"));
  const receipts = join(dir, "r.jsonl");
  const code = `for (let i = 0; i < ${calls}; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + ${JSON.stringify(path)}, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "${SENTINEL}" }] }) }); await r.text(); console.log(r.status); } console.error("agent-done " + Date.now());`;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "wrap", ...flags, "--receipts", receipts, "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", code],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: up, ...env } });
    let err = "", out = "";
    c.stderr.on("data", (d) => (err += d));
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (status) => {
      const lines = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse);
      const runsDir = join(dir, "runs");
      const summary = JSON.parse(readFileSync(join(runsDir, readdirSync(runsDir)[0]), "utf8"));
      resolve({ status, err, out, ms: Date.now() - t0, afterAgentMs: Date.now() - Number(/agent-done (\d+)/.exec(err)?.[1] ?? t0), receipts: lines.filter((l) => !l.event), ledgerRaw: readFileSync(receipts, "utf8"), summary, summaryRaw: JSON.stringify(summary) });
    });
  });
}
const A = (span) => Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

test("#239 AC1: two chat calls -> 3 spans in one trace, values match ledger and summary; runs differ", async (t) => {
  const up = await upstream(t);
  const col = await collector(t);
  const r = await wrap(up.url, ["--otlp", col.url], 2);
  assert.equal(r.status, 0, r.err);
  assert.ok(col.posts.length >= 1);
  for (const p of col.posts) {
    assert.equal(p.method, "POST");
    assert.equal(p.url, "/v1/traces");
    assert.match(p.headers["content-type"], /^application\/json/);
    assert.deepEqual(p.body.resourceSpans[0].resource.attributes.find((a) => a.key === "service.name").value, { stringValue: "costcap" });
  }
  const spans = col.spans();
  assert.equal(spans.length, 3);
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  const calls = spans.filter((s) => s.name === "chat gpt-4o-mini");
  assert.equal(calls.length, 2);
  for (const rec of r.receipts) {
    const a = A(calls.find((s) => A(s)["costcap.receipt_id"] === rec.id));
    assert.equal(a["gen_ai.usage.input_tokens"], String(rec.input_tokens));
    assert.equal(a["gen_ai.usage.output_tokens"], String(rec.output_tokens));
    assert.equal(a["gen_ai.usage.cost"], rec.cost_usd);
  }
  const root = spans.find((s) => s.name === "costcap.run");
  assert.equal(A(root)["costcap.total_cost_usd"], r.summary.total_cost_usd);
  assert.deepEqual(r.summary.otlp, { spans_exported: 3, spans_dropped: 0 });
  assert.match(r.err, /otlp: 3 exported, 0 dropped/);
  const col2 = await collector(t);
  await wrap(up.url, ["--otlp", col2.url], 1);
  assert.notEqual(col2.spans()[0].traceId, spans[0].traceId);
});

test("#239 AC2: unknown cost and a cap refusal", async (t) => {
  const noUsage = await upstream(t, { usage: false });
  const col = await collector(t);
  const r = await wrap(noUsage.url, [], 1, { COSTCAP_OTLP_ENDPOINT: col.url });
  assert.equal(r.status, 0, r.err);
  const call = A(col.spans().find((s) => s.name !== "costcap.run"));
  assert.equal("gen_ai.usage.cost" in call, false);
  assert.equal(call["costcap.cost_complete"], false);
  const root = A(col.spans().find((s) => s.name === "costcap.run"));
  assert.equal("costcap.total_cost_usd" in root, false);
  assert.equal(root["costcap.unknown_cost_calls"], "1");

  const up = await upstream(t);
  const col2 = await collector(t);
  const c = await wrap(up.url, ["--cap", "0.2", "--otlp", col2.url], 3);
  assert.equal(up.hits.length, 2);
  const blocked = col2.spans().find((s) => A(s)["costcap.blocked"] === true);
  assert.equal(blocked.status.code, 2);
  assert.equal(A(blocked)["costcap.reason"], "budget_exceeded");
  assert.equal(A(col2.spans().find((s) => s.name === "costcap.run"))["costcap.stopped_by"], "budget_exceeded");
  assert.equal(c.summary.otlp.spans_exported, 4);
});

test("#239 AC3: headers reach the collector but never stderr/ledger/summary/body; no content; bad URLs exit before spawn", async (t) => {
  const up = await upstream(t);
  const col = await collector(t);
  const r = await wrap(up.url, ["--otlp", col.url], 1, { COSTCAP_OTLP_HEADERS: "authorization=Bearer test-otlp-secret,x-tenant=a" });
  assert.equal(r.status, 0, r.err);
  assert.equal(col.posts[0].headers.authorization, "Bearer test-otlp-secret");
  assert.equal(col.posts[0].headers["x-tenant"], "a");
  for (const s of [r.err, r.out, r.ledgerRaw, r.summaryRaw, ...col.posts.map((p) => p.raw)]) {
    assert.doesNotMatch(s, /test-otlp-secret/);
  }
  for (const p of col.posts) assert.doesNotMatch(p.raw, new RegExp(SENTINEL));
  for (const bad of ["ftp://x", "http://u:p@127.0.0.1:1"]) {
    const dir = mkdtempSync(join(tmpdir(), "cc-otlp-"));
    const marker = join(dir, "spawned");
    const res = await new Promise((resolve) => {
      const c = spawn(process.execPath, [CLI, "wrap", "--otlp", bad, "--receipts", join(dir, "r.jsonl"), "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`]);
      let err = ""; c.stderr.on("data", (d) => (err += d)); c.on("exit", (status) => resolve({ status, err }));
    });
    assert.notEqual(res.status, 0);
    assert.match(res.err, /--otlp/);
    assert.doesNotMatch(res.err, /u:p@/);
    assert.throws(() => readFileSync(marker));
  }
});

async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${p}`;
}

test("#239 AC4: closed port, 500 and a hung collector never change the run", async (t) => {
  const up = await upstream(t);
  const base = await wrap(up.url, [], 2);
  const hung = await collector(t, { hang: true });
  const err500 = await collector(t, { status: 500 });
  for (const url of [await closedPort(), err500.url, hung.url]) {
    const r = await wrap(up.url, ["--otlp", url], 2);
    assert.equal(r.status, base.status);
    assert.deepEqual(r.out, base.out);
    assert.deepEqual(r.receipts.map((x) => [x.cost_usd, x.input_tokens, x.status]), base.receipts.map((x) => [x.cost_usd, x.input_tokens, x.status]));
    assert.equal((r.err.match(/costcap: warning: otlp/g) ?? []).length, 1, r.err);
    assert.ok(r.afterAgentMs <= 6000, `${url}: wrap exited ${r.afterAgentMs}ms after the agent`);
    assert.deepEqual(r.summary.otlp, { spans_exported: 0, spans_dropped: 3 });
  }
});

test("#239 AC5: 250 calls -> >=3 POSTs of <=100 spans, 251 unique spans; no --otlp -> no connection", async (t) => {
  const up = await upstream(t);
  const col = await collector(t);
  const r = await wrap(up.url, ["--otlp", col.url], 250);
  assert.equal(r.status, 0, r.err);
  assert.ok(col.posts.length >= 3);
  assert.ok(col.posts.every((p) => p.body.resourceSpans[0].scopeSpans[0].spans.length <= 100));
  const spans = col.spans();
  assert.equal(spans.length, 251);
  assert.equal(new Set(spans.map((s) => s.spanId)).size, 251);
  const quiet = await collector(t);
  const q = await wrap(up.url, [], 1, { OTEL_EXPORTER_OTLP_ENDPOINT: quiet.url });
  assert.equal(q.status, 0);
  assert.equal(quiet.connections(), 0);
  assert.equal("otlp" in q.summary, false);
});
