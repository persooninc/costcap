// Issue #207: budget-triggered model downgrade through the real proxy and a fake upstream.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createDowngrader, scopeUsage } from "../src/downgrade.js";
import { createResponseCache } from "../src/response-cache.js";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const MAP = { "gpt-4o": "gpt-4o-mini", "claude-sonnet-4-5": "claude-haiku-4-5", "gemini-2.5-pro": "gemini-2.5-flash" };

async function fixture(t, { daySpent = 0, at = 0.8, extra = {} } = {}) {
  const seen = [];
  const up = http.createServer((req, res) => {
    let s = "";
    req.on("data", (c) => { s += c; });
    req.on("end", () => {
      seen.push({ path: req.url, raw: s });
      let model = "x";
      try { model = JSON.parse(s).model; } catch { /* path model */ }
      if (/"stream":true/.test(s)) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ model, choices: [{ delta: { content: "hi" } }] })}\n\ndata: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.startsWith("/v1/messages")) res.end(JSON.stringify({ model, usage: { input_tokens: 10, output_tokens: 2 } }));
      else if (req.url.includes(":generateContent")) res.end(JSON.stringify({ modelVersion: "gemini-2.5-pro", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }));
      else res.end(JSON.stringify({ model, usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    });
  });
  const u = `http://127.0.0.1:${await listen(up)}`;
  const dir = mkdtempSync(join(tmpdir(), "cc-dg-"));
  const receiptsPath = join(dir, "receipts.jsonl");
  const history = daySpent ? [{ id: "seed", ts: new Date().toISOString(), provider: "openai", model: "gpt-4o", cost_usd: daySpent, blocked: false }] : [];
  const cap = createCapEngine({ caps: { day: 1 }, history, runId: "r1" });
  const downgrader = createDowngrader({ config: () => ({ at, map: MAP }), usage: () => scopeUsage(cap.limits(), cap.spend()), lowerBound: () => cap.spend().unknown > 0, runId: "r1" });
  const receipts = [], lines = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: u, anthropic: u, gemini: u, openrouter: u }, receiptsPath, cap, downgrader,
    who: { run_id: "r1" }, onReceipt: (r) => receipts.push(r), onWarning: (l) => lines.push(l), ...extra });
  t.after(() => { server.close(); up.close(); });
  const call = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, header: r.headers.get("x-costcap-model-downgraded"), text: await r.text(), cache: r.headers.get("x-costcap-cache") };
  };
  const ledger = () => readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { seen, receipts, lines, call, ledger, dir };
}

test("under F the request is byte-identical and nothing is recorded as downgraded", async (t) => {
  const f = await fixture(t, { daySpent: 0.5 });
  const raw = '{ "model":"gpt-4o",  "messages":[{"role":"user","content":"hi"}], "temperature":0.25 }';
  const r = await f.call("/openai/v1/chat/completions", raw);
  assert.equal(r.status, 200);
  assert.equal(r.header, null);
  assert.equal(f.seen[0].raw, raw);
  assert.equal(f.receipts[0].model, "gpt-4o");
  assert.equal("requested_model" in f.receipts[0], false);
  assert.equal("downgrade" in f.receipts[0], false);
  assert.equal(f.ledger().some((l) => l.event === "model_downgrade"), false);
});

test("at or above F: model rewritten, other fields kept, receipt + header + one ledger event", async (t) => {
  const f = await fixture(t, { daySpent: 0.8 });
  const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], temperature: 0.25, max_tokens: 7 };
  const r = await f.call("/openai/v1/chat/completions", body);
  assert.equal(r.status, 200);
  assert.equal(r.header, "gpt-4o->gpt-4o-mini");
  assert.deepEqual(JSON.parse(f.seen[0].raw), { ...body, model: "gpt-4o-mini" });
  const rc = f.receipts.find((x) => !x.event);
  assert.equal(rc.model, "gpt-4o-mini");
  assert.equal(rc.requested_model, "gpt-4o");
  assert.deepEqual(rc.downgrade, { scope: "day", fraction: 0.8 });
  await f.call("/anthropic/v1/messages", { model: "claude-sonnet-4-5", max_tokens: 5, messages: [] });
  assert.equal(JSON.parse(f.seen[1].raw).model, "claude-haiku-4-5");
  // A model with no mapping is untouched, even past F.
  const same = await f.call("/openai/v1/chat/completions", { model: "gpt-4.1-nano", messages: [] });
  assert.equal(same.header, null);
  const events = f.ledger().filter((l) => l.event === "model_downgrade");
  assert.equal(events.length, 1);
  assert.equal(events[0].scope, "day");
  assert.equal(events[0].from, "gpt-4o");
  assert.equal("cost_usd" in events[0], false);
  assert.equal(f.lines.filter((l) => /model downgrade/.test(l)).length, 1);
});

test("SSE stream is downgraded and stream-usage injection still works", async (t) => {
  const f = await fixture(t, { daySpent: 0.9 });
  const r = await f.call("/openai/v1/chat/completions", { model: "gpt-4o", stream: true, messages: [] });
  assert.equal(r.status, 200);
  assert.equal(r.header, "gpt-4o->gpt-4o-mini");
  const sent = JSON.parse(f.seen[0].raw);
  assert.equal(sent.model, "gpt-4o-mini");
  assert.equal(sent.stream_options?.include_usage, true);
  const rc = f.receipts.find((x) => !x.event);
  assert.equal(rc.model, "gpt-4o-mini");
  assert.equal(typeof rc.cost_usd, "number");
});

test("a disallowed or unpriced TO is refused, never sent as FROM", async (t) => {
  const f = await fixture(t, { daySpent: 0.9, extra: { allowedModels: () => ["gpt-4o"] } });
  const r = await f.call("/openai/v1/chat/completions", { model: "gpt-4o", messages: [] });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.text).error, "model_not_allowed");
  assert.equal(JSON.parse(r.text).model, "gpt-4o-mini");
  assert.equal(f.seen.length, 0);
  const g = await fixture(t, { daySpent: 0.9, extra: { unknownModels: "refuse" } });
  const map = { "gpt-4o": "no-such-model-xyz" };
  const cap = createCapEngine({ caps: { day: 1 }, history: [{ id: "s", ts: new Date().toISOString(), cost_usd: 0.9 }] });
  const dg = createDowngrader({ config: () => ({ at: 0.8, map }), usage: () => scopeUsage(cap.limits(), cap.spend()) });
  const { server, port } = await startMeteringProxy({ upstreams: { openai: "http://127.0.0.1:9" }, cap, downgrader: dg, unknownModels: "refuse" });
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o" }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "model_unpriced");
  assert.equal(g.seen.length, 0);
});

test("cache key uses TO: a downgraded call and a direct TO call share an entry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-dg-cache-"));
  const f = await fixture(t, { daySpent: 0.85, extra: { cache: createResponseCache({ dir, ttlMs: 60_000 }) } });
  const msgs = [{ role: "user", content: "same" }];
  const temperature = 0;
  const a = await f.call("/openai/v1/chat/completions", { model: "gpt-4o", messages: msgs, temperature });
  assert.equal(a.cache, "miss");
  const b = await f.call("/openai/v1/chat/completions", { model: "gpt-4o-mini", messages: msgs, temperature });
  assert.equal(b.cache, "hit");
  const c = await f.call("/openai/v1/chat/completions", { model: "gpt-4o", messages: msgs, temperature });
  assert.equal(c.cache, "hit");
  assert.equal(c.header, "gpt-4o->gpt-4o-mini");
  assert.equal(f.seen.length, 1);
  const hit = f.receipts.filter((x) => x.cache === "hit").at(-1);
  assert.equal(hit.requested_model, "gpt-4o");
});

test("at 100% the hard stop still refuses; a downgrade never bypasses a cap", async (t) => {
  const f = await fixture(t, { daySpent: 1 });
  const r = await f.call("/openai/v1/chat/completions", { model: "gpt-4o", messages: [] });
  assert.equal(r.status, 429);
  assert.equal(f.seen.length, 0);
});

test("unsupported routes pass through unchanged with downgrade: unsupported_route", async (t) => {
  const f = await fixture(t, { daySpent: 0.9 });
  const r = await f.call("/openrouter/api/v1/chat/completions", { model: "gpt-4o", models: ["gpt-4o", "gpt-4.1"], messages: [] });
  assert.equal(r.header, null);
  assert.equal(JSON.parse(f.seen[0].raw).model, "gpt-4o");
  assert.equal(f.receipts.find((x) => !x.event).downgrade, "unsupported_route");
  await f.call("/gemini/v1beta/models/gemini-2.5-pro:generateContent", { contents: [] });
  assert.match(f.seen[1].path, /gemini-2\.5-pro/);
  assert.equal(f.receipts.filter((x) => !x.event).at(-1).downgrade, "unsupported_route");
});

test("wrap end to end: --downgrade rewrites past F, unpriced target exits 2", async (t) => {
  const seen = [];
  const up = http.createServer((req, res) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => { seen.push(JSON.parse(s).model); res.end(JSON.stringify({ model: JSON.parse(s).model, usage: { prompt_tokens: 10, completion_tokens: 1 } })); }); });
  const upPort = await listen(up);
  t.after(() => up.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-dg-wrap-"));
  const receipts = join(dir, "r.jsonl");
  writeFileSync(receipts, JSON.stringify({ id: "seed", ts: new Date().toISOString(), provider: "openai", model: "gpt-4o", cost_usd: 0.9, blocked: false }) + "\n");
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}` } });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("exit", (code) => resolve({ code, out, err }));
  });
  const script = `const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-4o" }) }); console.log(r.status, r.headers.get("x-costcap-model-downgraded"));`;
  const ok = await run(["wrap", "--day-cap", "1", "--downgrade", "gpt-4o=gpt-4o-mini", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /200 gpt-4o->gpt-4o-mini/);
  assert.deepEqual(seen, ["gpt-4o-mini"]);
  assert.match(ok.err, /model downgrade: day spend/);
  assert.match(ok.err, /downgraded=1/);
  const bad = await run(["wrap", "--downgrade", "gpt-4o=no-such-model-xyz", "--receipts", receipts, "--", "true"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /no published rate/);
});
