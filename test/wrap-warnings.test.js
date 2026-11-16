// #164 e2e: `costcap wrap --warn-at` against a local fake OpenAI upstream. No paid calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("wrap --day-cap 1 --warn-at 0.5,0.8: two events, two stderr lines, no repeats, no repeat on a second wrap", async (t) => {
  const up = await upstream(t);
  const dir = mkdtempSync(join(tmpdir(), "cc-ww-"));
  const r = join(dir, "r.jsonl");
  const ts = new Date().toISOString();
  writeFileSync(r, JSON.stringify({ id: "seed", ts, cost_usd: 0.45, model: "gpt-4o-mini" }) + "\n");
  // 0.45 -> 0.60 (crosses 0.5) -> 0.75 -> 0.90 (crosses 0.8)
  const a = await wrap(up, r, ["--day-cap", "1", "--warn-at", "0.5,0.8"], 3);
  assert.equal(a.status, 0, a.err);
  assert.deepEqual(a.out.trim().split("\n"), ["200", "200", "200"]);
  const day = ts.slice(0, 10);
  const evs = lines(r).filter((l) => l.event === "cap_warning");
  assert.deepEqual(evs.map((e) => [e.scope, e.fraction, e.period, e.cap, e.lower_bound]), [["day", 0.5, day, 1, false], ["day", 0.8, day, 1, false]]);
  assert.deepEqual(evs.map((e) => e.spent_usd), [0.6, 0.9]);
  assert.equal(typeof evs[0].run_id, "string");
  const w = warnLines(a.err);
  assert.deepEqual(w, [`costcap: warning: day spend $0.6000 is 50% of $1 cap (${day} UTC)`, `costcap: warning: day spend $0.9000 is 80% of $1 cap (${day} UTC)`]);
  // The warning follows the receipt that caused it.
  const all = lines(r);
  assert.equal(all[all.indexOf(all.find((l) => l.event)) - 1].cost_usd, 0.15);
  // Run summary carries the warnings.
  const sum = JSON.parse(readFileSync(join(dir, "runs", readdirSync(join(dir, "runs"))[0]), "utf8"));
  assert.deepEqual(sum.warnings.map((x) => x.fraction), [0.5, 0.8]);
  assert.equal(sum.calls, 3);
  // Second wrap the same UTC day: raising the cap to 2 crosses 0.5 of $2 at $1.05, already warned today.
  const b = await wrap(up, r, ["--day-cap", "2", "--warn-at", "0.5,0.8"], 1);
  assert.equal(b.status, 0, b.err);
  assert.deepEqual(warnLines(b.err), []);
  assert.equal(lines(r).filter((l) => l.event === "cap_warning").length, 2);
  // Warning lines are never spend: receipts and check totals ignore them.
  const chk = spawnSync(process.execPath, [CLI, "check", "--receipts", r, "--day-cap", "2"], { encoding: "utf8" });
  const j = JSON.parse(chk.stdout);
  assert.equal(j.receipt_count, 5);
  assert.equal(j.total_usd, 1.05);
  assert.deepEqual(j.warnings, []); // $1.05 of $2 is under the default 0.8
  const j5 = JSON.parse(spawnSync(process.execPath, [CLI, "check", "--receipts", r, "--day-cap", "2", "--warn-at", "0.5"], { encoding: "utf8" }).stdout);
  assert.deepEqual(j5.warnings, [{ scope: "day", fraction: 0.5, cap: 2, spent_usd: 1.05, lower_bound: false }]);
  assert.equal(j5.ok, true);
});

test("wrap --cap with default 0.8: one run warning then the block; --warn-at off is silent", async (t) => {
  const up = await upstream(t);
  const dir = mkdtempSync(join(tmpdir(), "cc-ww-"));
  const r = join(dir, "r.jsonl");
  const a = await wrap(up, r, ["--cap", "0.40"], 4); // 0.15, 0.30, 0.45 (crosses 0.32) -> block
  assert.deepEqual(a.out.trim().split("\n"), ["200", "200", "200", "429"]);
  const evs = lines(r).filter((l) => l.event === "cap_warning");
  assert.deepEqual(evs.map((e) => [e.scope, e.fraction, e.spent_usd]), [["run", 0.8, 0.45]]);
  assert.equal(warnLines(a.err).length, 1);
  assert.match(warnLines(a.err)[0], /^costcap: warning: run spend \$0\.4500 is 80% of \$0\.4 cap \(run /);
  const r2 = join(dir, "r2.jsonl");
  const b = await wrap(up, r2, ["--cap", "0.40", "--warn-at", "off"], 3);
  assert.equal(b.status, 0);
  assert.equal(lines(r2).filter((l) => l.event).length, 0);
  assert.deepEqual(warnLines(b.err), []);
  const bad = await wrap(up, r2, ["--warn-at", "1.5"], 0);
  assert.equal(bad.status, 2);
  assert.match(bad.err, /--warn-at/);
});
