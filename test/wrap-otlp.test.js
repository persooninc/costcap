// #239 e2e: wrap --otlp pushes OTLP/HTTP JSON spans to a local fake collector. No paid calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const SENTINEL = "SENTINEL-PROMPT-7731";

async function listen(t, handler) {
  const s = http.createServer(handler);
  let conns = 0;
  s.on("connection", () => conns++);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return { url: `http://127.0.0.1:${s.address().port}`, conns: () => conns };
}
async function upstream(t, { usage = true } = {}) {
  return listen(t, (q, res) => { q.resume(); q.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", ...(usage && { usage: { prompt_tokens: 1000, completion_tokens: 10 } }) }))); });
}
async function collector(t, mode = "ok") {
  const posts = [];
  const c = await listen(t, (q, res) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", () => {
      posts.push({ url: q.url, headers: q.headers, body: b });
      if (mode === "hang") return;
      res.writeHead(mode === "500" ? 500 : 200, { "content-type": "application/json" }).end("{}");
    });
  });
  return { ...c, posts, spans: () => posts.flatMap((p) => JSON.parse(p.body).resourceSpans[0].scopeSpans[0].spans) };
}
function wrap(up, flags, calls, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cc-otlp-"));
  const receipts = join(dir, "r.jsonl");
  const code = `for (let i = 0; i < ${calls}; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "${SENTINEL}" }] }) }); await r.text(); } process.stdout.write("agent-exit:" + Date.now());`;
  return new Promise((resolve) => {
    const e = { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: up, ...env };
    delete e.COSTCAP_OTLP_ENDPOINT; if (!("COSTCAP_OTLP_HEADERS" in env)) delete e.COSTCAP_OTLP_HEADERS;
    Object.assign(e, env);
    const c = spawn(process.execPath, [CLI, "wrap", ...flags, "--receipts", receipts, "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", code], { env: e });
    let err = "", out = "";
    c.stderr.on("data", (d) => (err += d));
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (status) => {
      const end = Date.now();
      const lines = (() => { try { return readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } })();
      let summary = null;
      try { const d = join(dirname(receipts), "runs"); summary = JSON.parse(readFileSync(join(d, readdirSync(d)[0]), "utf8")); } catch { /* none */ }
      const agentExit = Number(/agent-exit:(\d+)/.exec(out)?.[1] ?? end);
      resolve({ status, err, out, receipts: lines.filter((l) => !l.event), ledger: (() => { try { return readFileSync(receipts, "utf8"); } catch { return ""; } })(), summary, lagMs: end - agentExit });
    });
  });
}
const get = (s, k) => { const a = s.attributes.find((x) => x.key === k); return a && Object.values(a.value)[0]; };

test("#239 AC1+AC3: two calls -> 3 spans, one trace, values match ledger; headers sent, never leaked; no content", async (t) => {
  const up = await upstream(t);
  const col = await collector(t);
  const env = { COSTCAP_OTLP_HEADERS: "authorization=Bearer test-otlp-secret,x-tenant=a" };
  const r = await wrap(up.url, ["--otlp", col.url], 2, env);
  assert.equal(r.status, 0, r.err);
  assert.ok(col.posts.every((p) => p.url === "/v1/traces" && p.headers["content-type"] === "application/json"));
  assert.equal(col.posts[0].headers.authorization, "Bearer test-otlp-secret");
  assert.equal(col.posts[0].headers["x-tenant"], "a");
  const body0 = JSON.parse(col.posts[0].body);
  assert.equal(body0.resourceSpans[0].resource.attributes.find((a) => a.key === "service.name").value.stringValue, "costcap");
  const spans = col.spans();
  assert.equal(spans.length, 3);
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  const calls = spans.filter((s) => s.name === "chat gpt-4o-mini");
  const root = spans.find((s) => s.name === "costcap.run");
  assert.equal(calls.length, 2);
  for (const s of calls) {
    const rec = r.receipts.find((x) => x.id === get(s, "costcap.receipt_id"));
    assert.ok(rec);
    assert.equal(get(s, "gen_ai.usage.input_tokens"), String(rec.input_tokens));
    assert.equal(get(s, "gen_ai.usage.output_tokens"), String(rec.output_tokens));
    assert.equal(get(s, "gen_ai.usage.cost"), rec.cost_usd);
    assert.equal(s.parentSpanId, root.spanId);
  }
  assert.equal(get(root, "costcap.total_cost_usd"), r.summary.total_cost_usd);
  assert.deepEqual(r.summary.otlp, { spans_exported: 3, spans_dropped: 0 });
  assert.match(r.err, /otlp=3 exported\/0 dropped/);
  for (const hay of [r.err, r.ledger, JSON.stringify(r.summary), ...col.posts.map((p) => p.body)]) assert.doesNotMatch(hay, /test-otlp-secret/);
  for (const p of col.posts) assert.doesNotMatch(p.body, new RegExp(SENTINEL));
  const r2 = await wrap(up.url, ["--otlp", col.url], 1);
  assert.notEqual(col.spans().at(-1).traceId, root.traceId);
});

test("#239 AC2: unknown cost and cap refusal", async (t) => {
  const up = await upstream(t, { usage: false });
  const col = await collector(t);
  const r = await wrap(up.url, ["--otlp", col.url], 1);
  assert.equal(r.status, 0, r.err);
  const [call] = col.spans().filter((s) => s.name !== "costcap.run");
  const root = col.spans().find((s) => s.name === "costcap.run");
  assert.equal(get(call, "gen_ai.usage.cost"), undefined);
  assert.equal(get(call, "costcap.cost_complete"), false);
  assert.equal(get(root, "costcap.total_cost_usd"), undefined);
  assert.equal(get(root, "costcap.unknown_cost_calls"), "1");

  const up2 = await upstream(t);
  const col2 = await collector(t);
  const r2 = await wrap(up2.url, ["--otlp", col2.url, "--cap", "0.0001"], 3);
  const blocked = col2.spans().filter((s) => get(s, "costcap.blocked") === true);
  assert.ok(blocked.length >= 1, r2.err);
  assert.equal(blocked[0].status.code, 2);
  assert.equal(get(blocked[0], "costcap.reason"), "budget_exceeded");
  assert.equal(get(col2.spans().find((s) => s.name === "costcap.run"), "costcap.stopped_by"), "budget_exceeded");
  assert.equal(up2.conns() >= 1, true);
});

test("#239 AC3: bad --otlp URLs exit non-zero before spawning", async () => {
  for (const u of ["ftp://x", "http://u:p@127.0.0.1:1"]) {
    const r = await wrap("http://127.0.0.1:1", ["--otlp", u], 1);
    assert.equal(r.status, 2, u);
    assert.doesNotMatch(r.out, /agent-exit/);
  }
});

for (const mode of ["closed", "500", "hang"]) {
  test(`#239 AC4: collector ${mode} never affects the run`, { timeout: 30_000 }, async (t) => {
    const up = await upstream(t);
    let url;
    if (mode === "closed") { const s = net.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); url = `http://127.0.0.1:${s.address().port}`; await new Promise((r) => s.close(r)); }
    else url = (await collector(t, mode)).url;
    const base = await wrap(up.url, [], 2);
    const r = await wrap(up.url, ["--otlp", url], 2);
    assert.equal(r.status, base.status);
    assert.equal(r.receipts.length, 2);
    assert.deepEqual(r.receipts.map((x) => x.cost_usd), base.receipts.map((x) => x.cost_usd));
    assert.equal((r.err.match(/costcap: warning: otlp/g) ?? []).length, 1, r.err);
    assert.ok(r.lagMs < 6000, `lag ${r.lagMs}`);
    assert.deepEqual(r.summary.otlp, { spans_exported: 0, spans_dropped: 3 });
  });
}

test("#239 AC5: 250 calls batch into >=3 POSTs of <=100; no --otlp means no collector connection", { timeout: 60_000 }, async (t) => {
  const up = await upstream(t);
  const col = await collector(t);
  const r = await wrap(up.url, ["--otlp", col.url], 250);
  assert.equal(r.status, 0, r.err);
  assert.ok(col.posts.length >= 3);
  assert.ok(col.posts.every((p) => JSON.parse(p.body).resourceSpans[0].scopeSpans[0].spans.length <= 100));
  const spans = col.spans();
  assert.equal(spans.length, 251);
  assert.equal(new Set(spans.map((s) => s.spanId)).size, 251);

  const quiet = await collector(t);
  const r2 = await wrap(up.url, [], 1, { COSTCAP_OTLP_HEADERS: "" });
  assert.equal(r2.status, 0);
  assert.equal(quiet.conns(), 0);
  assert.equal(r2.summary.otlp, undefined);
});

test("#239 COSTCAP_OTLP_ENDPOINT enables export", async (t) => {
  const up = await upstream(t);
  const col = await collector(t);
  const r = await wrap(up.url, [], 1, { COSTCAP_OTLP_ENDPOINT: col.url });
  assert.equal(r.status, 0, r.err);
  assert.equal(col.spans().length, 2);
});
