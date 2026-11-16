// Issue #178: a settled unknown cost of this wrapper's own run counts toward its --cap run budget.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapEngine } from "../src/cap.js";
import { createSettler } from "../src/settle.js";
import { openSharedLedger } from "../src/ledger-lock.js";

const ts = new Date().toISOString();
const line = (o) => JSON.stringify(o) + "\n";

test("#178 repro: settle of this run's receipt counts toward run, so a $5 run cap stops at $4.80 + next call", () => {
  const c = createCapEngine({ caps: { run: 5 }, runId: "R" });
  c.record({ id: "u", ts, run_id: "R", cost_usd: null });
  assert.equal(c.check().reason, "unreconciled_receipt");
  assert.equal(c.settle({ id: "u", ts, run_id: "R", cost_usd: 4.8 }), true);
  assert.equal(c.spend().run, 4.8);
  assert.equal(c.check(), null);
  c.record({ ts, run_id: "R", cost_usd: 0.3 });
  assert.equal(c.check().scope, "run");
});

test("#178 settlements for other run ids count only toward hour/day/month", () => {
  const c = createCapEngine({ caps: { run: 5 }, runId: "R", history: [{ id: "o", ts, run_id: "other", cost_usd: null }] });
  assert.equal(c.settle({ id: "o", ts, run_id: "other", cost_usd: 4.8 }), true);
  assert.deepEqual([c.spend().run, c.spend().day], [0, 4.8]);
  const noRun = createCapEngine({ caps: { run: 5 } });
  noRun.record({ id: "x", ts, cost_usd: null });
  noRun.settle({ id: "x", ts, cost_usd: 1 });
  assert.equal(noRun.spend().run, 0);
});

test("#178 no double counting: repeated settle of one receipt id, and settler dedup", () => {
  const c = createCapEngine({ caps: { run: 5 }, runId: "R" });
  c.record({ id: "a", ts, run_id: "R", cost_usd: null });
  c.record({ id: "b", ts, run_id: "R", cost_usd: null });
  assert.equal(c.settle({ id: "a", ts, run_id: "R", cost_usd: 1 }), true);
  assert.equal(c.settle({ receipt_id: "a", ts, run_id: "R", cost_usd: 1 }), false);
  assert.equal(c.spend().run, 1);
  assert.equal(c.spend().unknown, 1, "b is still unknown");
  const seen = [];
  const s = createSettler({ cap: () => c, agentBudgets: () => null, proxySettle: () => null, onSettled: (e) => seen.push(e) });
  assert.equal(s({ receipt_id: "b", cost_usd: 2 }, { id: "b", ts, run_id: "R" }), true);
  assert.equal(s({ receipt_id: "b", cost_usd: 2 }, { id: "b", ts, run_id: "R" }), false);
  assert.equal(c.spend().run, 3);
  assert.deepEqual(seen, [{ event: "reconciliation", receipt_id: "b", cost_usd: 2, run_id: "R" }]);
});

test("#178 settled batch of this run counts toward run; another run's batch does not", () => {
  const c = createCapEngine({ caps: { run: 5 }, runId: "R" });
  const s = createSettler({ cap: () => c, agentBudgets: () => null, proxySettle: () => null });
  s({ receipt_id: "b1", cost_usd: 1 }, { id: "b1", ts, run_id: "R", reason: "batch_pending" });
  s({ receipt_id: "b2", cost_usd: 2 }, { id: "b2", ts, run_id: "X", reason: "batch_pending" });
  assert.deepEqual([c.spend().run, c.spend().day], [1, 3]);
});

test("#178 shared ledger: reconcile --apply in another process settles this wrapper's own receipt into its run", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cc-178-")), "r.jsonl");
  const engines = {};
  const open = (runId) => {
    const settle = createSettler({ cap: () => engines[runId], agentBudgets: () => null, proxySettle: () => null });
    const led = openSharedLedger(path, { onExternal: (r) => engines[runId].record(r, { external: true }), onExternalSettle: (e, r) => settle(e, r) });
    engines[runId] = createCapEngine({ caps: { run: 5 }, runId, history: led.history() });
    return led;
  };
  const a = open("A"), b = open("B");
  const own = { id: "a1", ts, run_id: "A", cost_usd: null };
  a.withLock(() => { appendFileSync(path, line(own)); engines.A.record(own); a.track(own); });
  b.withLock(() => {});
  assert.equal(engines.A.check().reason, "unreconciled_receipt");
  assert.equal(engines.B.check().reason, "unreconciled_receipt");
  appendFileSync(path, line({ event: "reconciliation", receipt_id: "a1", cost_usd: 4.8 }));
  a.withLock(() => {}); b.withLock(() => {});
  assert.deepEqual([engines.A.spend().run, engines.A.spend().day], [4.8, 4.8]);
  assert.deepEqual([engines.B.spend().run, engines.B.spend().day], [0, 4.8]);
  assert.equal(engines.A.check(), null);
  a.close(); b.close();
});

test("#178 e2e: wrap --cap 5 --shared-ledger: settled cost is in run enforcement, stderr, runs/<id>.json and agrees with check --run-id", { timeout: 60_000 }, async (t) => {
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => {
      let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
        const usage = b.includes("poison") ? undefined : { prompt_tokens: 1000, completion_tokens: 0 };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage }));
      });
    });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-178-"));
  const path = join(dir, "r.jsonl"), go = join(dir, "go");
  const script = `
    import { existsSync } from "node:fs";
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const a = await fetch(u,{method:"POST",body:'{"poison":1}'});
    while (!existsSync(process.env.GO)) await new Promise((r) => setTimeout(r, 20));
    const b = await fetch(u,{method:"POST",body:'{"n":2}'});
    const c = await fetch(u,{method:"POST",body:'{"n":3}'});
    const j = await c.json();
    console.log(a.status, b.status, c.status, j.error?.scope);`;
  const child = spawn(process.execPath, ["src/cli.js", "wrap", "--shared-ledger", "--cap", "5", "--run-id", "run178", "--receipts", path, "--", process.execPath, "--input-type=module", "-e", script],
    { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}`, GO: go } });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
  const done = new Promise((r) => child.on("exit", r));
  const rows = () => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  while (!rows().some((r) => !r.event && r.cost_usd === null)) await new Promise((r) => setTimeout(r, 20));
  const unknown = rows().find((r) => !r.event && r.cost_usd === null);
  const provider = join(dir, "provider.jsonl");
  writeFileSync(provider, line({ id: unknown.id, cost_usd: 4.9999 }));
  const ap = spawnSync(process.execPath, ["src/cli.js", "reconcile", "--receipts", path, "--provider", provider, "--apply"], { encoding: "utf8" });
  assert.equal(ap.status, 0, ap.stderr);
  writeFileSync(go, "1");
  await done;
  assert.equal(out.trim(), "200 200 429 run", err);
  const runSpend = 4.9999 + 0.00015;
  assert.ok(err.includes(`run spend $${runSpend.toFixed(4)} of $5 cap`), err);
  const summary = JSON.parse(readFileSync(join(dir, "runs", "run178.json"), "utf8"));
  assert.equal(summary.caps.run.spent_usd, Number(runSpend.toFixed(6)));
  assert.equal(summary.total_cost_usd, Number(runSpend.toFixed(6)));
  assert.equal(summary.unknown_cost_calls, 0);
  const chk = spawnSync(process.execPath, ["src/cli.js", "check", "--run-id", "run178", "--cap", "5", "--receipts", path], { encoding: "utf8" });
  assert.match(chk.stdout + chk.stderr, new RegExp(String(Number(runSpend.toFixed(6))).replace(".", "\\.")));
});
