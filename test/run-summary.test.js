import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRunSummary, rollupLine, listRunSummaries, writeRunSummary, runsCommand, stopReason, SCHEMA } from "../src/run-summary.js";
import "./support/pinned-clock.js"; // #237: prices below are pre-2026-12-01

const priced = (model, cost, extra = {}) => ({ provider: "openai", blocked: false, model, cost_usd: cost, input_tokens: 10, output_tokens: 5, cached_input_tokens: 2, cache_write_input_tokens: 1, cache_write_1h_input_tokens: 1, ...extra });

// ---------- unit ----------
test("builder sums tokens, cache tokens and cost per model", () => {
  const s = buildRunSummary({ run_id: "r1", started_at: "a", ended_at: "b", exit_code: 0,
    receipts: [priced("m1", 0.1), priced("m1", 0.2), priced("m2", 0.05), { event: "kill" }], caps: { run: 1 }, spend: { run: 0.35 } });
  assert.equal(s.schema, SCHEMA);
  assert.equal(s.calls, 3);
  assert.deepEqual(s.by_model.m1, { calls: 2, input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 4, cost_usd: 0.3 });
  assert.equal(s.by_model.m2.cost_usd, 0.05);
  assert.equal(s.total_cost_usd, 0.35);
  assert.equal(s.unknown_cost_calls, 0);
  assert.deepEqual(s.caps, { run: { limit_usd: 1, spent_usd: 0.35 } });
  assert.equal(s.stopped_by, null);
  assert.match(rollupLine(s), /calls=3 rejected=0 refused=0 models=2 cost=\$0\.3500$/);
});

test("null cost makes total unknown, never $0", () => {
  const s = buildRunSummary({ run_id: "r", receipts: [priced("m1", 0.1), priced("m1", null), { blocked: false, cost_usd: null }] });
  assert.equal(s.total_cost_usd, null);
  assert.equal(s.unknown_cost_calls, 2);
  assert.equal(s.by_model.m1.cost_usd, null);
  assert.equal(s.by_model.unknown.calls, 1);
  assert.equal(s.by_model.unknown.input_tokens, 0);
  assert.match(rollupLine(s), /cost=unknown \(2 unpriced calls\)/);
  assert.match(rollupLine(buildRunSummary({ run_id: "x", receipts: [priced("m", null)] })), /1 unpriced call\)/);
});

test("blocked calls set stopped_by and scope; kill wins; zero-call run", () => {
  const b = buildRunSummary({ run_id: "r", receipts: [priced("m", 0.5), { blocked: true, reason: "budget_exceeded", scope: "run" }, { blocked: true, reason: "step_budget" }] });
  assert.equal(b.blocked_calls, 2);
  assert.equal(b.stopped_by, "budget_exceeded");
  assert.equal(b.stopped_scope, "run");
  assert.match(rollupLine(b), /stopped_by=budget_exceeded:run/);
  const v = buildRunSummary({ run_id: "r", receipts: [{ blocked: true, reason: "cost_velocity" }, null] });
  assert.equal(v.stopped_by, "breaker_open");
  assert.match(rollupLine(v), /stopped_by=breaker_open$/);
  assert.equal(buildRunSummary({ run_id: "r", killed: true, receipts: [{ blocked: true, reason: "step_budget" }] }).stopped_by, "killed");
  assert.equal(buildRunSummary({ run_id: "r", receipts: [{ blocked: true, reason: "spiral_detected" }] }).stopped_by, "breaker_open");
  assert.equal(buildRunSummary({ run_id: "r", receipts: [{ blocked: true, reason: "tag_budget_exceeded" }] }).stopped_by, "budget_exceeded");
  assert.equal(stopReason("killed"), "killed");
  const z = buildRunSummary({ run_id: "z" });
  assert.deepEqual([z.calls, z.blocked_calls, z.total_cost_usd, z.unknown_cost_calls, z.exit_code], [0, 0, 0, 0, null]);
});

test("list sorts newest first and skips corrupt files; runsCommand output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccrs-"));
  const rp = path.join(dir, "r.jsonl");
  assert.deepEqual(listRunSummaries(rp), { runs: [], errors: [] });
  const logs = [];
  runsCommand(["--receipts", rp], { log: (l) => logs.push(l) });
  assert.deepEqual(logs, ["no runs recorded"]);
  writeRunSummary(rp, buildRunSummary({ run_id: "old", ended_at: "2026-01-01T00:00:00Z", receipts: [priced("m", 0.1)] }));
  writeRunSummary(rp, buildRunSummary({ run_id: "new", ended_at: "2026-02-01T00:00:00Z", receipts: [priced("m", null), { blocked: true, reason: "killed" }] }));
  writeFileSync(path.join(dir, "runs", "bad.json"), "{nope");
  writeFileSync(path.join(dir, "runs", "other.json"), "{}");
  writeFileSync(path.join(dir, "runs", "ignore.txt"), "x");
  const { runs, errors } = listRunSummaries(rp);
  assert.deepEqual(runs.map((r) => r.run_id), ["new", "old"]);
  assert.deepEqual(errors.map((e) => e.file).sort(), ["bad.json", "other.json"]);
  const out = [], warn = [];
  runsCommand(["--receipts", rp], { log: (l) => out.push(l), warn: (l) => warn.push(l) });
  assert.match(out[0], /new\s+calls=1\s+cost=unknown\s+stopped_by=killed/);
  assert.match(out[1], /old\s+calls=1\s+cost=\$0\.1000\s+outcome=unknown$/);
  assert.equal(warn.length, 2);
});

// ---------- integration / regression / e2e ----------
async function fakeUpstream(t, handler) {
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => {
      let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(handler(JSON.parse(b || "{}")))));
    });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  return up;
}

function runWrap(up, args, script, extraEnv = {}, onSpawn) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...args, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}`, COSTCAP_KILL_POLL_MS: "50", ...extraEnv } });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    onSpawn?.(c);
    c.on("exit", (code) => resolve({ code, out, err }));
  });
}
const readSummaries = (dir) => readdirSync(path.join(dir, "runs")).map((n) => JSON.parse(readFileSync(path.join(dir, "runs", n), "utf8")));
const callLoop = (n) => `const u = process.env.OPENAI_BASE_URL + "/chat/completions";
  const models = ["gpt-4o-mini", "gpt-4o", "gpt-4o-mini"];
  for (let i = 0; i < ${n}; i++) await fetch(u, { method: "POST", body: JSON.stringify({ model: models[i % 3] }) });`;

test("wrap: 3 priced calls over 2 models; by_model equals receipt sums; runs --json lists newest first", async (t) => {
  const up = await fakeUpstream(t, (b) => ({ model: b.model, usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } } }));
  const dir = mkdtempSync(path.join(tmpdir(), "ccrs-"));
  const rp = path.join(dir, "r.jsonl");
  const first = await runWrap(up, ["--receipts", rp], callLoop(3));
  assert.equal(first.code, 0);
  assert.match(first.err, /costcap: run \S+ calls=3 rejected=0 refused=0 models=2 cost=\$/);
  const [s] = readSummaries(dir);
  const receipts = readFileSync(rp, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(receipts.length, 3);
  for (const m of ["gpt-4o-mini", "gpt-4o"]) {
    const rs = receipts.filter((r) => r.model === m);
    assert.equal(s.by_model[m].calls, rs.length);
    assert.equal(s.by_model[m].input_tokens, rs.reduce((a, r) => a + r.input_tokens, 0));
    assert.equal(s.by_model[m].output_tokens, rs.reduce((a, r) => a + r.output_tokens, 0));
    assert.equal(s.by_model[m].cache_read_tokens, rs.reduce((a, r) => a + r.cached_input_tokens, 0));
    assert.equal(s.by_model[m].cost_usd, Number(rs.reduce((a, r) => a + r.cost_usd, 0).toFixed(6)));
  }
  assert.equal(s.total_cost_usd, Number(receipts.reduce((a, r) => a + r.cost_usd, 0).toFixed(6)));
  assert.equal(s.exit_code, 0);
  assert.equal(s.stopped_by, null);
  const second = await runWrap(up, ["--receipts", rp], callLoop(0));
  assert.equal(second.code, 0);
  // E2E: spawn `costcap runs --json`
  const r = spawnSync(process.execPath, ["src/cli.js", "runs", "--json", "--receipts", rp], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const list = JSON.parse(r.stdout);
  assert.equal(list.length, 2);
  assert.equal(list[0].calls, 0);
  assert.equal(list[0].total_cost_usd, 0);
  assert.equal(list[1].run_id, s.run_id);
  assert.equal(list[1].calls, 3);
  const h = spawnSync(process.execPath, ["src/cli.js", "runs", "--receipts", rp], { encoding: "utf8" });
  assert.match(h.stdout.split("\n")[0], /calls=0\s+cost=\$0\.0000/);
});

test("wrap: call with no usage gives null total and unknown roll-up", async (t) => {
  const up = await fakeUpstream(t, () => ({ ok: true }));
  const dir = mkdtempSync(path.join(tmpdir(), "ccrs-"));
  const res = await runWrap(up, ["--receipts", path.join(dir, "r.jsonl")], callLoop(1));
  assert.match(res.err, /cost=unknown/);
  const [s] = readSummaries(dir);
  assert.equal(s.total_cost_usd, null);
  assert.ok(s.unknown_cost_calls > 0);
});

test("wrap: cap stop and breaker stop record stopped_by and blocked_calls", async (t) => {
  const up = await fakeUpstream(t, (b) => ({ model: b.model, usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }));
  const d1 = mkdtempSync(path.join(tmpdir(), "ccrs-"));
  await runWrap(up, ["--cap", "0.10", "--receipts", path.join(d1, "r.jsonl")], callLoop(3));
  const [c] = readSummaries(d1);
  assert.equal(c.stopped_by, "budget_exceeded");
  assert.equal(c.stopped_scope, "run");
  assert.equal(c.blocked_calls, 2);
  assert.equal(c.caps.run.limit_usd, 0.1);
  const d2 = mkdtempSync(path.join(tmpdir(), "ccrs-"));
  await runWrap(up, ["--max-steps", "1", "--receipts", path.join(d2, "r.jsonl")], callLoop(2));
  const [v] = readSummaries(d2);
  assert.equal(v.stopped_by, "breaker_open");
  assert.equal(v.blocked_calls, 1);
});

test("wrap: costcap kill still writes the summary with stopped_by killed", async (t) => {
  const up = await fakeUpstream(t, (b) => ({ model: b.model, usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const dir = mkdtempSync(path.join(tmpdir(), "ccrs-"));
  const kf = path.join(dir, "KILL");
  const script = `${callLoop(1)}\nconsole.log("called"); await new Promise((r) => setTimeout(r, 20000));`;
  const res = await runWrap(up, ["--kill-file", kf, "--receipts", path.join(dir, "r.jsonl")], script, {}, (c) => {
    c.stdout.on("data", (d) => { if (String(d).includes("called")) spawnSync(process.execPath, ["src/cli.js", "kill", "test", "--kill-file", kf, "--receipts", path.join(dir, "k.jsonl")]); });
  });
  assert.equal(res.code, 143);
  const [s] = readSummaries(dir);
  assert.equal(s.stopped_by, "killed");
  assert.equal(s.calls, 1);
  assert.equal(s.exit_code, 143);
});

test("wrap: unwritable runs dir warns but does not fail the run", async (t) => {
  const up = await fakeUpstream(t, () => ({}));
  const dir = mkdtempSync(path.join(tmpdir(), "ccrs-"));
  mkdirSync(path.join(dir, "runs"));
  chmodSync(path.join(dir, "runs"), 0o500);
  t.after(() => chmodSync(path.join(dir, "runs"), 0o700));
  const res = await runWrap(up, ["--receipts", path.join(dir, "r.jsonl")], callLoop(0));
  assert.equal(res.code, 0);
  if (process.getuid?.() !== 0) assert.match(res.err, /run summary not written/);
});

test("#160 a pending batch keeps the run total unknown until its batch_results settlement", () => {
  const pending = { id: "p1", provider: "anthropic", blocked: false, model: "claude-sonnet-4-6", cost_usd: null, reason: "batch_pending", batch_id: "b1", request_count: 3 };
  const open = buildRunSummary({ run_id: "r", receipts: [priced("m", 0.1), pending] });
  assert.deepEqual([open.total_cost_usd, open.unknown_cost_calls], [null, 1]);
  const settled = buildRunSummary({ run_id: "r", receipts: [priced("m", 0.1), pending, { event: "reconciliation", receipt_id: "p1", cost_usd: 0.25, source: "batch_results" }] });
  assert.deepEqual([settled.total_cost_usd, settled.unknown_cost_calls], [0.35, 0]);
});

// #184: response cache reporting.
test("#184 cache block counts hits/misses and saved_usd; roll-up shows the saving; absent without cache", () => {
  const s = buildRunSummary({ run_id: "c1", started_at: "a", ended_at: "b", receipts: [
    priced("m1", 0.2, { cache: "miss" }), priced("m1", 0, { cache: "hit", reason: "cache_hit", saved_usd: 0.2 }), priced("m1", 0, { cache: "hit", reason: "cache_hit", saved_usd: 0.2 }), priced("m1", 0.1, { cache: "bypass" })] });
  assert.deepEqual(s.cache, { hits: 2, misses: 1, saved_usd: 0.4 });
  assert.equal(s.total_cost_usd, 0.3);
  assert.match(rollupLine(s), / · cache: 2 hits, saved \$0\.4000$/);
  const plain = buildRunSummary({ run_id: "c2", started_at: "a", ended_at: "b", receipts: [priced("m1", 0.1)] });
  assert.equal("cache" in plain, false);
  assert.doesNotMatch(rollupLine(plain), /cache:/);
  const none = buildRunSummary({ run_id: "c3", started_at: "a", ended_at: "b", receipts: [], cacheEnabled: true });
  assert.deepEqual(none.cache, { hits: 0, misses: 0, saved_usd: 0 });
  assert.doesNotMatch(rollupLine(none), /cache:/);
});

test("#184 wrap --cache: repeated temperature-0 calls hit the cache, summary and roll-up report the saving", async (t) => {
  let upstreamCalls = 0;
  const up = await fakeUpstream(t, (b) => { upstreamCalls++; return { model: b.model, usage: { prompt_tokens: 1000, completion_tokens: 200 } }; });
  const dir = mkdtempSync(path.join(tmpdir(), "ccrs-"));
  const rp = path.join(dir, "r.jsonl");
  const script = `const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    for (let i = 0; i < 3; i++) await fetch(u, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0 }) });`;
  const r = await runWrap(up, ["--receipts", rp, "--cache", "1h"], script);
  assert.equal(r.code, 0);
  assert.equal(upstreamCalls, 1);
  const [s] = readSummaries(dir);
  assert.equal(s.cache.hits, 2);
  assert.equal(s.cache.misses, 1);
  assert.ok(s.cache.saved_usd > 0);
  assert.match(r.err, / · cache: 2 hits, saved \$/);
  assert.ok(readdirSync(path.join(dir, "cache")).length === 1, "default cache dir is <ledger-dir>/cache");
});

test("#239 rollup line reports otlp counts when present", () => {
  const s = buildRunSummary({ run_id: "R", receipts: [] });
  assert.doesNotMatch(rollupLine(s), /otlp/);
  assert.match(rollupLine({ ...s, otlp: { spans_exported: 3, spans_dropped: 1 } }), / otlp=3 exported\/1 dropped$/);
});
