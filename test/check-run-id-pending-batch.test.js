// #185: --run-id must not pass hour/day/month caps while another run's batch is pending.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkBudget } from "../src/check.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const ts = new Date().toISOString();
const BASE = [
  { id: "a1", run_id: "A", reason: "batch_pending", cost_usd: null },
  { id: "b1", run_id: "B", cost_usd: 1 },
];
function ledger(rows = BASE) {
  const r = join(mkdtempSync(join(tmpdir(), "cc-185-")), "r.jsonl");
  writeFileSync(r, rows.map((x) => JSON.stringify({ ts, ...x })).join("\n") + "\n");
  return r;
}
const cli = (args) => {
  const e = { ...process.env }; delete e.GITHUB_OUTPUT; delete e.GITHUB_STEP_SUMMARY;
  return spawnSync(process.execPath, [CLI, ...args], { env: e, encoding: "utf8" });
};

test("AC1: another run's pending batch fails --run-id with a day cap", () => {
  const r = ledger();
  const res = checkBudget({ receiptsPath: r, caps: { day: 10 }, runId: "B" });
  assert.equal(res.ok, false);
  assert.equal(res.hit.scope, "accounting"); assert.equal(res.hit.reason, "batch_pending");
  assert.equal(res.ledger_pending_batch_count, 1);
  assert.ok(res.ledger_unknown_cost_count >= 1);
  const out = cli(["check", "--receipts", r, "--run-id", "B", "--day-cap", "10"]);
  assert.equal(out.status, 1, out.stderr);
  assert.equal(JSON.parse(out.stdout).hit.reason, "batch_pending");
});

test("AC2: month cap also fails on another run's pending batch", () => {
  const res = checkBudget({ receiptsPath: ledger(), caps: { month: 100 }, runId: "B" });
  assert.equal(res.ok, false); assert.equal(res.hit.reason, "batch_pending");
  const h = checkBudget({ receiptsPath: ledger(), caps: { hour: 100 }, runId: "B" });
  assert.equal(h.hit.reason, "batch_pending");
});

test("AC3: a run-only cap is unaffected by another run's batch", () => {
  const r = ledger();
  const res = checkBudget({ receiptsPath: r, caps: { run: 5 }, runId: "B" });
  assert.equal(res.ok, true); assert.equal(res.hit, null);
  assert.equal(cli(["check", "--receipts", r, "--run-id", "B", "--cap", "5"]).status, 0);
});

test("AC4: a pending batch in the run itself is still accounting_unavailable", () => {
  const res = checkBudget({ receiptsPath: ledger(), caps: { day: 10 }, runId: "A" });
  assert.equal(res.ok, false); assert.equal(res.hit.reason, "accounting_unavailable");
});

test("AC5: once settled, the settled cost decides the day cap", () => {
  const over = ledger([...BASE, { event: "reconciliation", receipt_id: "a1", cost_usd: 30 }]);
  const o = checkBudget({ receiptsPath: over, caps: { day: 10 }, runId: "B" });
  assert.equal(o.ok, false); assert.equal(o.hit.scope, "day"); assert.equal(o.ledger_pending_batch_count, 0);
  const under = ledger([...BASE, { event: "reconciliation", receipt_id: "a1", cost_usd: 2 }]);
  const u = checkBudget({ receiptsPath: under, caps: { day: 10 }, runId: "B" });
  assert.equal(u.ok, true); assert.equal(u.hit, null);
});
