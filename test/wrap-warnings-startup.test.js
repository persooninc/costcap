// #187: a fraction already reached when wrap starts warns once; a pending batch makes spend a lower bound.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapEngine, isLowerBound } from "../src/cap.js";
import { createSettler } from "../src/settle.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;

// Each call costs $0.15 (1M gpt-4o-mini input tokens).
async function upstream(t) {
  const s = http.createServer((q, res) => { q.resume(); q.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }))); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return `http://127.0.0.1:${s.address().port}`;
}
function wrap(up, receipts, flags, calls) {
  const code = `for (let i = 0; i < ${calls}; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", n: i }) }); console.log(r.status); }`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "wrap", ...flags, "--receipts", receipts, "--kill-file", join(receipts, "..", "KILL"), "--", process.execPath, "--input-type=module", "-e", code],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: up } });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", (status) => resolve({ status, out, err }));
  });
}
const lines = (f) => readFileSync(f, "utf8").trim().split("\n").map(JSON.parse);
const warnLines = (err) => err.split("\n").filter((l) => l.startsWith("costcap: warning:") && !/run summary/.test(l));
const check = (r, flags) => JSON.parse(spawnSync(process.execPath, [CLI, "check", "--receipts", r, ...flags], { encoding: "utf8" }).stdout);

test("scenario 1: day 0.8 already reached at startup warns exactly once, not again on the next receipt or wrap", async (t) => {
  const up = await upstream(t);
  const dir = mkdtempSync(join(tmpdir(), "cc-187-"));
  const r = join(dir, "r.jsonl");
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  writeFileSync(r, JSON.stringify({ id: "seed", ts, cost_usd: 8.5, model: "gpt-4o-mini" }) + "\n");
  const a = await wrap(up, r, ["--day-cap", "10"], 1);
  assert.equal(a.status, 0, a.err);
  const evs = lines(r).filter((l) => l.event === "cap_warning");
  assert.deepEqual(evs.map((e) => [e.scope, e.fraction, e.spent_usd, e.period, e.lower_bound]), [["day", 0.8, 8.5, day, false]]);
  assert.deepEqual(warnLines(a.err), [`costcap: warning: day spend $8.5000 is 80% of $10 cap (${day} UTC)`]);
  assert.deepEqual(check(r, ["--day-cap", "10"]).warnings.map((w) => [w.scope, w.fraction]), [["day", 0.8]]);
  const b = await wrap(up, r, ["--day-cap", "10"], 1);
  assert.equal(b.status, 0, b.err);
  assert.deepEqual(warnLines(b.err), []);
  assert.equal(lines(r).filter((l) => l.event === "cap_warning").length, 1);
});

test("--warn-at off: nothing at startup", async (t) => {
  const up = await upstream(t);
  const dir = mkdtempSync(join(tmpdir(), "cc-187-"));
  const r = join(dir, "r.jsonl");
  writeFileSync(r, JSON.stringify({ id: "seed", ts: new Date().toISOString(), cost_usd: 8.5, model: "gpt-4o-mini" }) + "\n");
  const a = await wrap(up, r, ["--day-cap", "10", "--warn-at", "off"], 1);
  assert.equal(a.status, 0, a.err);
  assert.deepEqual(warnLines(a.err), []);
  assert.equal(lines(r).filter((l) => l.event === "cap_warning").length, 0);
});

test("scenario 2: a pending batch makes the warning lower_bound true, matching check; calls still allowed", async (t) => {
  const up = await upstream(t);
  const dir = mkdtempSync(join(tmpdir(), "cc-187-"));
  const r = join(dir, "r.jsonl");
  const ts = new Date().toISOString();
  writeFileSync(r, JSON.stringify({ id: "b1", ts, cost_usd: null, reason: "batch_pending", batch_id: "msgbatch_1", provider: "anthropic", model: "claude-haiku-4-5" }) + "\n");
  const a = await wrap(up, r, ["--day-cap", "1"], 6); // 0.15 x 6 = 0.90 crosses 0.80
  assert.equal(a.status, 0, a.err);
  assert.deepEqual(a.out.trim().split("\n"), ["200", "200", "200", "200", "200", "200"]);
  const evs = lines(r).filter((l) => l.event === "cap_warning");
  assert.deepEqual(evs.map((e) => [e.scope, e.fraction, e.lower_bound]), [["day", 0.8, true]]);
  assert.match(warnLines(a.err)[0], /day spend \(lower bound\) \$0\.9000 is 80%/);
  const j = check(r, ["--day-cap", "1"]);
  assert.deepEqual(j.warnings.map((w) => [w.scope, w.fraction, w.lower_bound]), [["day", 0.8, true]]);
});

test("cap engine: pending batches count toward lower bound until resolved, never toward the stop", () => {
  const ts = new Date().toISOString();
  const cap = createCapEngine({ caps: { day: 1 }, history: [{ id: "h1", ts, cost_usd: null, reason: "batch_pending" }] });
  assert.equal(cap.spend().pending_batches, 1);
  assert.equal(isLowerBound(cap.spend()), true);
  assert.equal(cap.check(), null);
  cap.record({ id: "b2", ts, cost_usd: null, reason: "batch_pending" });
  assert.equal(cap.spend().pending_batches, 2);
  assert.equal(cap.spend().unknown, 0);
  assert.equal(cap.resolvePending("h1"), true);
  // The settler resolves a settled pending batch too.
  const settle = createSettler({ cap: () => cap, agentBudgets: () => null, proxySettle: () => null });
  assert.equal(settle({ receipt_id: "b2", cost_usd: 0.2 }, { id: "b2", ts, reason: "batch_pending", cost_usd: null }), true);
  assert.equal(cap.spend().pending_batches, 0);
  assert.equal(isLowerBound(cap.spend()), false);
  assert.equal(cap.spend().day, 0.2);
  assert.equal(isLowerBound({ unknown: 1, pending_batches: 0 }), true);
});
