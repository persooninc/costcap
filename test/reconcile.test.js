import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { reconcile } from "../src/reconcile.js";

test("reconciliation does not treat unknown or missing provider cost as zero", () => {
  const same = reconcile({ receipts: [{ id: "a", cost_usd: 1.25 }], charges: [{ id: "a", cost_usd: 1.25 }] });
  assert.equal(same.ok, true);
  assert.equal(same.matched, 1);
  const unknown = reconcile({ receipts: [{ id: "a", cost_usd: null }, { id: "b", cost_usd: 1 }], charges: [{ id: "a", cost_usd: 0 }, { id: "b", cost_usd: 1 }] });
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.unknown, ["a"]);
  assert.equal(unknown.mismatched.includes("a"), false);
  const gap = reconcile({ receipts: [{ id: "a", cost_usd: 1 }], charges: [{ id: "b", cost_usd: 1 }] });
  assert.deepEqual(gap.receipt_only, ["a"]);
  assert.deepEqual(gap.provider_only, ["b"]);
  const drift = reconcile({ receipts: [{ id: "a", cost_usd: 1 }], charges: [{ id: "a", cost_usd: 1.5 }] });
  assert.deepEqual(drift.mismatched, ["a"]);
  assert.throws(() => reconcile({ receipts: [], charges: [] }), /No receipts/);
});

test("a duplicate or empty receipt id fails loudly, like a duplicate provider charge", () => {
  // A repeated receipt id means ledger corruption; it must never be silently
  // split across matched and receipt_only. Symmetric with the charge-side guard.
  assert.throws(
    () => reconcile({ receipts: [{ id: "a", cost_usd: 1 }, { id: "a", cost_usd: 1 }], charges: [{ id: "a", cost_usd: 1 }] }),
    /Duplicate receipt id/,
  );
  assert.throws(() => reconcile({ receipts: [{ id: "", cost_usd: 1 }], charges: [] }), /Receipt needs an id/);
  assert.throws(() => reconcile({ receipts: [{ id: "a", cost_usd: 1 }, { id: "a", cost_usd: null }], charges: [{ id: "a", cost_usd: 1 }] }), /Duplicate receipt id/);
});

test("reconcile command exits 0 on a match, 1 on a gap, and 2 without files", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-recon-"));
  const receipts = join(dir, "receipts.jsonl");
  const provider = join(dir, "provider.jsonl");
  writeFileSync(receipts, JSON.stringify({ id: "a", ts: "2026-10-06T00:00:00Z", cost_usd: 0.2 }) + "\n");
  writeFileSync(provider, JSON.stringify({ id: "a", cost_usd: 0.2 }) + "\n");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const ok = spawnSync(process.execPath, [cli, "reconcile", "--receipts", receipts, "--provider", provider], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  writeFileSync(provider, JSON.stringify({ id: "a", cost_usd: null }) + "\n");
  const bad = spawnSync(process.execPath, [cli, "reconcile", "--receipts", receipts, "--provider", provider], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const missing = spawnSync(process.execPath, [cli, "reconcile"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
});

// ---- costcap#124: reconcile --apply settles unknown-cost receipts ----
import { readFileSync, appendFileSync } from "node:fs";
import { applyReconciliation, planSettlements, reconcileFiles } from "../src/reconcile.js";
import { createCapEngine, loadSettledReceipts, applySettlements } from "../src/cap.js";
import { checkBudget, agentBudgetStatus } from "../src/check.js";
import { createAgentBudgets } from "../src/agent-budget.js";
import { buildRunSummary } from "../src/run-summary.js";

const ledger = (rows) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-apply-"));
  const receipts = join(dir, "receipts.jsonl");
  writeFileSync(receipts, rows.map((r) => JSON.stringify(r) + "\n").join(""));
  return { dir, receipts, provider: join(dir, "provider.jsonl") };
};
const writeCharges = (p, rows) => writeFileSync(p, rows.map((r) => JSON.stringify(r) + "\n").join(""));

test("apply appends one reconciliation event per settled id and keeps the original bytes (AC1)", () => {
  const f = ledger([
    { id: "u1", ts: "2026-10-31T23:59:00Z", cost_usd: null, reason: "usage_unavailable" },
    { id: "k1", ts: "2026-11-01T00:01:00Z", cost_usd: 0.5 },
  ]);
  writeCharges(f.provider, [{ id: "u1", cost_usd: 0.25 }, { id: "k1", cost_usd: 0.5 }]);
  const before = readFileSync(f.receipts, "utf8");
  const out = applyReconciliation({ receiptsPath: f.receipts, providerPath: f.provider, now: () => new Date("2026-11-15T12:00:00Z") });
  assert.deepEqual(out.settled, [{ receipt_id: "u1", cost_usd: 0.25 }]);
  assert.deepEqual(out.still_unknown, []);
  assert.equal(out.ok, true);
  const after = readFileSync(f.receipts, "utf8");
  assert.ok(after.startsWith(before), "original lines are byte-identical");
  const ev = JSON.parse(after.slice(before.length));
  assert.deepEqual(Object.keys(ev).sort(), ["cost_usd", "event", "provider_sha256", "receipt_id", "source", "ts"]);
  assert.equal(ev.event, "reconciliation");
  assert.equal(ev.source, "provider_file");
  assert.match(ev.provider_sha256, /^[0-9a-f]{64}$/);
  assert.equal(ev.ts, "2026-11-15T12:00:00.000Z");
  // non-apply reconcile now sees the settled receipt as matched
  assert.equal(reconcileFiles({ receiptsPath: f.receipts, providerPath: f.provider }).ok, true);
});

test("settled cost counts toward the ORIGINAL ts window across a UTC month boundary (AC2)", () => {
  const f = ledger([{ id: "u1", ts: "2026-10-31T23:59:00Z", cost_usd: null }]);
  writeCharges(f.provider, [{ id: "u1", cost_usd: 3 }]);
  const blocked = createCapEngine({ caps: { month: 2 }, history: loadSettledReceipts(f.receipts), now: () => new Date("2026-11-01T00:05:00Z") });
  assert.equal(blocked.check().reason, "unreconciled_receipt");
  applyReconciliation({ receiptsPath: f.receipts, providerPath: f.provider, now: () => new Date("2026-11-01T00:04:00Z") });
  const history = loadSettledReceipts(f.receipts);
  const nov = createCapEngine({ caps: { month: 2 }, history, now: () => new Date("2026-11-01T00:05:00Z") });
  assert.equal(nov.check(), null, "October spend does not count against November");
  assert.equal(nov.spend().month, 0);
  const oct = createCapEngine({ caps: { month: 2 }, history, now: () => new Date("2026-10-31T23:59:30Z") });
  assert.deepEqual(oct.check(), { scope: "month", cap: 2, spent: 3 });
  const chk = checkBudget({ receiptsPath: f.receipts, caps: { month: 2 }, now: () => new Date("2026-10-31T23:59:30Z") });
  assert.equal(chk.unknown_cost_count, 0);
  assert.equal(chk.total_usd, 3);
  assert.equal(chk.hit.scope, "month");
});

test("missing, null, negative or absent charge cost never settles as $0 (AC3)", () => {
  const f = ledger([
    { id: "a", ts: "2026-11-01T00:00:00Z", cost_usd: null },
    { id: "b", ts: "2026-11-01T00:00:00Z", cost_usd: null },
    { id: "c", ts: "2026-11-01T00:00:00Z", cost_usd: null },
    { id: "d", ts: "2026-11-01T00:00:00Z", cost_usd: null },
  ]);
  writeCharges(f.provider, [{ id: "b", cost_usd: null }, { id: "c" }, { id: "d", cost_usd: 0 }]);
  const before = readFileSync(f.receipts, "utf8");
  const out = applyReconciliation({ receiptsPath: f.receipts, providerPath: f.provider });
  assert.deepEqual(out.still_unknown, ["a", "b", "c"]);
  assert.deepEqual(out.settled, [{ receipt_id: "d", cost_usd: 0 }], "an explicit provider $0 is evidence");
  assert.equal(out.ok, false);
  assert.equal(readFileSync(f.receipts, "utf8").split("\n").filter(Boolean).length, before.split("\n").filter(Boolean).length + 1);
  assert.equal(createCapEngine({ history: loadSettledReceipts(f.receipts) }).check().reason, "unreconciled_receipt");
  // pure planner refuses negative and non-finite too
  const plan = planSettlements({ lines: [{ id: "n", cost_usd: null }, { id: "i", cost_usd: null }], charges: [{ id: "n", cost_usd: -1 }, { id: "i", cost_usd: "1" }] });
  assert.deepEqual(plan.still_unknown, ["n", "i"]);
  assert.throws(() => planSettlements({ lines: [{ cost_usd: null }], charges: [] }), /Receipt needs an id/);
  const empty = ledger([]);
  writeCharges(empty.provider, []);
  assert.throws(() => applyReconciliation({ receiptsPath: empty.receipts, providerPath: empty.provider }), /No receipts/);
});

test("apply twice is idempotent and a hand-added duplicate settlement is ignored (AC4)", () => {
  const f = ledger([{ id: "u1", ts: "2026-11-01T00:00:00Z", cost_usd: null }]);
  writeCharges(f.provider, [{ id: "u1", cost_usd: 1 }]);
  applyReconciliation({ receiptsPath: f.receipts, providerPath: f.provider });
  const once = readFileSync(f.receipts, "utf8");
  const again = applyReconciliation({ receiptsPath: f.receipts, providerPath: f.provider });
  assert.deepEqual(again.settled, []);
  assert.deepEqual(again.already_settled, ["u1"]);
  assert.equal(readFileSync(f.receipts, "utf8"), once);
  appendFileSync(f.receipts, JSON.stringify({ event: "reconciliation", receipt_id: "u1", cost_usd: 99, source: "hand" }) + "\n");
  const s = createCapEngine({ history: loadSettledReceipts(f.receipts), now: () => new Date("2026-11-01T01:00:00Z") }).spend();
  assert.equal(s.day, 1);
  // settlement never overrides a receipt that already had a cost, and invalid events are ignored
  const rows = applySettlements([{ id: "k", ts: "x", cost_usd: 2 }, { event: "reconciliation", receipt_id: "k", cost_usd: 0 },
    { id: "z", cost_usd: null }, { event: "reconciliation", receipt_id: "z", cost_usd: -1 }, { event: "kill" }]);
  assert.deepEqual(rows.map((r) => r.cost_usd), [2, null]);
});

test("agent and team verdicts move from accounting_unavailable after settlement (AC5)", () => {
  const ts = new Date().toISOString();
  const f = ledger([{ id: "u1", ts, cost_usd: null, agent_id: "bot", run_id: "r1" }]);
  writeCharges(f.provider, [{ id: "u1", cost_usd: 5 }]);
  const policy = { agents: { bot: { day: 10 } } };
  assert.equal(agentBudgetStatus({ receiptsPath: f.receipts, policy, agent_id: "bot" }).verdict, "accounting_unavailable");
  applyReconciliation({ receiptsPath: f.receipts, providerPath: f.provider });
  assert.equal(agentBudgetStatus({ receiptsPath: f.receipts, policy, agent_id: "bot" }).verdict, "allow");
  const tight = createAgentBudgets({ policy: { agents: { bot: { day: 4 } } }, history: loadSettledReceipts(f.receipts) });
  assert.equal(tight.check({ agent_id: "bot", run_id: "r2" }).verdict, "budget_exceeded");
});

test("run summary honours a settlement line in the run's receipts", () => {
  const s = buildRunSummary({ run_id: "r", receipts: [{ id: "u", model: "m", cost_usd: null }, null, { event: "reconciliation", receipt_id: "u", cost_usd: 0.3 }] });
  assert.equal(s.total_cost_usd, 0.3);
  assert.equal(s.unknown_cost_calls, 0);
});

test("CLI reconcile --apply: JSON adds settled/still_unknown, exit 1 lists unknown ids (AC6)", () => {
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const f = ledger([{ id: "a", ts: "2026-11-01T00:00:00Z", cost_usd: null }, { id: "b", ts: "2026-11-01T00:00:00Z", cost_usd: null }]);
  writeCharges(f.provider, [{ id: "a", cost_usd: 0.1 }]);
  const r = spawnSync(process.execPath, [cli, "reconcile", "--receipts", f.receipts, "--provider", f.provider, "--apply"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.settled, [{ receipt_id: "a", cost_usd: 0.1 }]);
  assert.deepEqual(out.still_unknown, ["b"]);
  assert.match(r.stderr, /still unknown.*b/);
  writeCharges(f.provider, [{ id: "a", cost_usd: 0.1 }, { id: "b", cost_usd: 0.2 }]);
  const ok = spawnSync(process.execPath, [cli, "reconcile", "--receipts", f.receipts, "--provider", f.provider, "--apply"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout).still_unknown, []);
  // without --apply the shape is unchanged (no settled/still_unknown keys)
  const plain = spawnSync(process.execPath, [cli, "reconcile", "--receipts", f.receipts, "--provider", f.provider], { encoding: "utf8" });
  assert.equal(plain.status, 0);
  assert.equal("settled" in JSON.parse(plain.stdout), false);
});
