import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRunSummary, rollupLine, listRunSummaries, writeRunSummary, SCHEMA } from "../src/run-summary.js";

const base = { runId: "r1", startedAt: "2026-11-15T00:00:00.000Z", endedAt: "2026-11-15T00:01:00.000Z", exitCode: 0 };

test("buildRunSummary sums per model including cache tokens", () => {
  const s = buildRunSummary({ ...base, caps: { run: 1 }, spent: { run: 0.3, day: 0.3, month: 0.3 }, receipts: [
    { model: "a", cost_usd: 0.1, input_tokens: 10, output_tokens: 5, cached_input_tokens: 3, cache_write_input_tokens: 2, cache_write_1h_input_tokens: 1 },
    { model: "a", cost_usd: 0.05, input_tokens: 1, output_tokens: 1 },
    { model: "b", cost_usd: 0.15, input_tokens: 7, output_tokens: 0 },
    { event: "kill" },
  ] });
  assert.equal(s.schema, SCHEMA);
  assert.equal(s.calls, 3);
  assert.deepEqual(s.by_model.a, { calls: 2, input_tokens: 11, output_tokens: 6, cache_read_tokens: 3, cache_write_tokens: 3, cost_usd: 0.15 });
  assert.equal(s.total_cost_usd, 0.3);
  assert.equal(s.unknown_cost_calls, 0);
  assert.deepEqual(s.caps.run, { limit_usd: 1, spent_usd: 0.3 });
  assert.equal(s.caps.day.limit_usd, null);
  assert.equal(s.stopped_by, null);
});

test("a null-cost call makes the total unknown, never $0", () => {
  const s = buildRunSummary({ ...base, receipts: [{ model: "a", cost_usd: 0.1 }, { model: "a", cost_usd: null, reason: "usage_unavailable" }] });
  assert.equal(s.total_cost_usd, null);
  assert.equal(s.by_model.a.cost_usd, null);
  assert.equal(s.unknown_cost_calls, 1);
  assert.match(rollupLine(s), /cost unknown \(1 unpriced call\)/);
});

test("zero calls gives zeros and total 0; stop causes map to stopped_by", () => {
  const z = buildRunSummary({ ...base });
  assert.equal(z.calls, 0);
  assert.equal(z.total_cost_usd, 0);
  assert.match(rollupLine(z), /0 calls across 0 models, 0 refused, cost \$0\.0000/);
  const b = buildRunSummary({ ...base, receipts: [{ blocked: true, reason: "budget_exceeded", scope: "run", cost_usd: 0 }] });
  assert.equal(b.blocked_calls, 1);
  assert.equal(b.calls, 0);
  assert.equal(b.stopped_by, "budget_exceeded");
  assert.equal(b.stopped_scope, "run");
  const v = buildRunSummary({ ...base, receipts: [{ blocked: true, reason: "step_budget", cost_usd: 0 }] });
  assert.equal(v.stopped_by, "breaker_open");
  assert.equal(v.stopped_scope, "step_budget");
  const k = buildRunSummary({ ...base, killed: true, receipts: [{ blocked: true, reason: "accounting_unavailable" }] });
  assert.equal(k.stopped_by, "killed");
  assert.equal(k.blocked_calls, 1);
});

test("listRunSummaries sorts newest first and skips corrupt files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rs-"));
  const rp = path.join(dir, "r.jsonl");
  assert.deepEqual(listRunSummaries(rp), { runs: [], errors: [] });
  writeRunSummary(rp, buildRunSummary({ ...base, runId: "old", endedAt: "2026-11-15T00:00:01.000Z" }));
  writeRunSummary(rp, buildRunSummary({ ...base, runId: "new", endedAt: "2026-11-15T00:00:09.000Z" }));
  writeFileSync(path.join(dir, "runs", "bad.json"), "{not json");
  writeFileSync(path.join(dir, "runs", "other.json"), "{}");
  const { runs, errors } = listRunSummaries(rp);
  assert.deepEqual(runs.map((r) => r.run_id), ["new", "old"]);
  assert.deepEqual(errors.map((e) => e.file).sort(), ["bad.json", "other.json"]);
});

async function fakeUpstream(t, { nullUsage = false } = {}) {
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => {
      let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
        const { model } = JSON.parse(b || "{}");
        const body = nullUsage ? { model } : { model, usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } } };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
    });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  return up;
}

function runWrap(up, dir, flags, models, extraEnv = {}, onStart) {
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    for (const model of ${JSON.stringify(models)}) await fetch(u,{method:"POST",body:JSON.stringify({model})});
    ${models.length ? "" : "await new Promise(r=>setTimeout(r,60000));"}`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...flags, "--receipts", path.join(dir, "r.jsonl"), "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}`, ...extraEnv } });
    let err = ""; c.stderr.on("data", (d) => (err += d)); c.stdout.on("data", () => {});
    onStart?.(c);
    c.on("exit", (code) => resolve({ code, err }));
  });
}

const summaries = (dir) => readdirSync(path.join(dir, "runs")).map((f) => JSON.parse(readFileSync(path.join(dir, "runs", f), "utf8")));
const receiptLines = (dir) => readFileSync(path.join(dir, "r.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.event);

test("wrap writes a summary whose by_model equals the receipt sums (3 calls, 2 models)", async (t) => {
  const up = await fakeUpstream(t);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rs-"));
  const r = await runWrap(up, dir, [], ["gpt-4o-mini", "gpt-4o", "gpt-4o-mini"]);
  assert.equal(r.code, 0);
  const [s] = summaries(dir);
  assert.equal(s.calls, 3);
  assert.equal(s.exit_code, 0);
  const rec = receiptLines(dir);
  for (const model of ["gpt-4o-mini", "gpt-4o"]) {
    const mine = rec.filter((x) => x.model === model);
    assert.equal(s.by_model[model].calls, mine.length);
    assert.equal(s.by_model[model].input_tokens, mine.reduce((a, x) => a + x.input_tokens, 0));
    assert.equal(s.by_model[model].output_tokens, mine.reduce((a, x) => a + x.output_tokens, 0));
    assert.equal(s.by_model[model].cache_read_tokens, mine.reduce((a, x) => a + x.cached_input_tokens, 0));
    assert.equal(s.by_model[model].cost_usd, Number(mine.reduce((a, x) => a + x.cost_usd, 0).toFixed(6)));
  }
  assert.equal(s.total_cost_usd, Number(rec.reduce((a, x) => a + x.cost_usd, 0).toFixed(6)));
  assert.match(r.err, /costcap: run .*: 3 calls across 2 models, 0 refused, cost \$/);
});

test("wrap with unknown cost reports total null and 'unknown'", async (t) => {
  const up = await fakeUpstream(t, { nullUsage: true });
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rs-"));
  const r = await runWrap(up, dir, [], ["gpt-4o-mini", "gpt-4o-mini"]);
  const [s] = summaries(dir);
  assert.equal(s.total_cost_usd, null);
  assert.equal(s.unknown_cost_calls, 1);
  assert.equal(s.blocked_calls, 1); // the second call is refused until reconciled
  assert.match(r.err, /cost unknown/);
});

test("wrap stopped by the run cap records stopped_by and the blocked call", async (t) => {
  const up = await fakeUpstream(t);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rs-"));
  await runWrap(up, dir, ["--cap", "0.0001"], ["gpt-4o", "gpt-4o"]);
  const [s] = summaries(dir);
  assert.equal(s.stopped_by, "budget_exceeded");
  assert.equal(s.stopped_scope, "run");
  assert.equal(s.blocked_calls, 1);
  assert.equal(s.caps.run.limit_usd, 0.0001);
});

test("wrap stopped by the breaker records breaker_open", async (t) => {
  const up = await fakeUpstream(t);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rs-"));
  await runWrap(up, dir, ["--max-steps", "1"], ["gpt-4o", "gpt-4o"]);
  const [s] = summaries(dir);
  assert.equal(s.stopped_by, "breaker_open");
  assert.equal(s.blocked_calls, 1);
});

test("wrap killed with costcap kill still writes its summary; zero calls is fine", async (t) => {
  const up = await fakeUpstream(t);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rs-"));
  const killFile = path.join(dir, "KILL");
  const r = await runWrap(up, dir, ["--kill-file", killFile], [], { COSTCAP_KILL_POLL_MS: "50" }, () => {
    setTimeout(() => spawnSync(process.execPath, ["src/cli.js", "kill", "--kill-file", killFile, "--receipts", path.join(dir, "r.jsonl")]), 500);
  });
  assert.equal(r.code, 143);
  const [s] = summaries(dir);
  assert.equal(s.stopped_by, "killed");
  assert.equal(s.calls, 0);
  assert.equal(s.total_cost_usd, 0);
});

test("e2e: costcap runs --json lists two runs newest first and skips a corrupt file", async (t) => {
  const up = await fakeUpstream(t);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rs-"));
  await runWrap(up, dir, [], ["gpt-4o-mini"]);
  await runWrap(up, dir, [], ["gpt-4o", "gpt-4o"]);
  mkdirSync(path.join(dir, "runs"), { recursive: true });
  writeFileSync(path.join(dir, "runs", "corrupt.json"), "nope");
  const res = spawnSync(process.execPath, ["src/cli.js", "runs", "--json", "--receipts", path.join(dir, "r.jsonl")], { encoding: "utf8" });
  assert.equal(res.status, 0);
  const runs = JSON.parse(res.stdout);
  assert.deepEqual(runs.map((x) => x.calls), [2, 1]);
  assert.deepEqual(Object.keys(runs[0].by_model), ["gpt-4o"]);
  assert.match(res.stderr, /skipped corrupt run summary corrupt\.json/);
  const text = spawnSync(process.execPath, ["src/cli.js", "runs", "--receipts", path.join(dir, "r.jsonl")], { encoding: "utf8" });
  assert.match(text.stdout, /2 calls across 1 model/);
  const empty = spawnSync(process.execPath, ["src/cli.js", "runs", "--receipts", path.join(dir, "none", "r.jsonl")], { encoding: "utf8" });
  assert.equal(empty.status, 0);
  assert.match(empty.stderr, /no run summaries yet/);
});

test("#160 a pending batch is unknown in the run summary, then known once settled", () => {
  const pending = { id: "p1", ts: "2026-11-16T00:00:00Z", provider: "anthropic", model: "claude-sonnet-4-6", reason: "batch_pending", batch_id: "b", cost_usd: null };
  const base = { run_id: "r", started_at: "a", ended_at: "b" };
  const open = buildRunSummary({ ...base, receipts: [pending] });
  assert.deepEqual([open.total_cost_usd, open.unknown_cost_calls], [null, 1]);
  const done = buildRunSummary({ ...base, receipts: [pending, { event: "reconciliation", source: "batch_results", receipt_id: "p1", cost_usd: 0.01605 }] });
  assert.deepEqual([done.total_cost_usd, done.unknown_cost_calls], [0.01605, 0]);
});
