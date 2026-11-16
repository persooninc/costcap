import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkBudget } from "../src/check.js";
import { checkOutputs } from "../src/github-output.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const ts = new Date().toISOString();
// Fixture: three runs — "under" ($0.30), "over" ($4), "unk" (one unknown cost).
const RUNS = [
  { run_id: "under", cost_usd: 0.1 }, { run_id: "under", cost_usd: 0.2 },
  { run_id: "over", cost_usd: 4 },
  { run_id: "unk", cost_usd: 0.1 }, { run_id: "unk", cost_usd: null },
];
function ledger(rows = RUNS) {
  const dir = mkdtempSync(join(tmpdir(), "cc-runid-"));
  const r = join(dir, "r.jsonl");
  writeFileSync(r, rows.map((x) => JSON.stringify({ ts, ...x })).join("\n") + "\n");
  return { dir, r };
}
const cli = (args, env = {}) => {
  const e = { ...process.env }; delete e.GITHUB_OUTPUT; delete e.GITHUB_STEP_SUMMARY;
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...e, ...env }, encoding: "utf8" });
};

test("AC1: run cap counts only that run's receipts", () => {
  const { r } = ledger();
  const under = checkBudget({ receiptsPath: r, caps: { run: 1 }, runId: "under" });
  assert.equal(under.ok, true); assert.equal(under.total_usd, 0.3); assert.equal(under.receipt_count, 2);
  const over = checkBudget({ receiptsPath: r, caps: { run: 1 }, runId: "over" });
  assert.equal(over.ok, false); assert.deepEqual(over.hit, { scope: "run", cap: 1, spent: 4 });
});

test("AC2: day/month caps still use the whole ledger, reported separately", () => {
  const { r } = ledger(RUNS.filter((x) => x.cost_usd !== null));
  const res = checkBudget({ receiptsPath: r, caps: { run: 1, day: 2 }, runId: "under" });
  assert.equal(res.ok, false); assert.equal(res.hit.scope, "day");
  assert.equal(res.run.total_usd, 0.3); assert.equal(res.day.spent_usd, 4.4); assert.equal(res.month.spent_usd, 4.4);
  assert.equal(res.day.cap, 2); assert.equal(res.month.cap, null);
});

test("AC3: unknown in run fails; unknown in another run only hits day/month", () => {
  const { r } = ledger();
  const unk = checkBudget({ receiptsPath: r, caps: { run: 10 }, runId: "unk" });
  assert.equal(unk.ok, false); assert.equal(unk.hit.reason, "accounting_unavailable"); assert.equal(unk.unknown_cost_count, 1);
  assert.equal(checkOutputs(unk, { run: 10 }).verdict, "accounting_unavailable");
  assert.equal(checkBudget({ receiptsPath: r, caps: { run: 10 }, runId: "under" }).ok, true);
  const withDay = checkBudget({ receiptsPath: r, caps: { run: 10, day: 100 }, runId: "under" });
  assert.equal(withDay.ok, false); assert.equal(withDay.hit.scope, "accounting");
  const o = checkOutputs(withDay, { run: 10 });
  assert.equal(o.verdict, "accounting_unavailable"); assert.equal(o["day-spent-usd"], ""); assert.equal(o["spent-usd"], "0.3");
});

test("AC4: unknown run id and empty id need evidence", () => {
  const { r } = ledger();
  assert.throws(() => checkBudget({ receiptsPath: r, caps: { run: 1 }, runId: "nope" }), /No receipts for run_id/);
  assert.throws(() => checkBudget({ receiptsPath: r, caps: { run: 1 }, runId: "" }), /non-empty/);
  assert.throws(() => checkBudget({ receiptsPath: r, caps: { run: -1 }, runId: "under" }), /Invalid run cap/);
  const p = cli(["check", "--receipts", r, "--cap", "1", "--run-id", "nope"]);
  assert.equal(p.status, 2); assert.match(p.stderr, /needs evidence/);
});

test("AC5 e2e: CLI run scope output, exit codes, and unchanged whole-ledger output", () => {
  const { r } = ledger();
  const a = cli(["check", "--receipts", r, "--cap", "1", "--run-id", "under"]);
  assert.equal(a.status, 0, a.stderr);
  const j = JSON.parse(a.stdout);
  assert.equal(j.run_id, "under"); assert.equal(j.scope, "run"); assert.doesNotMatch(a.stdout, /reconstructed/);
  assert.equal(cli(["check", "--receipts", r, "--cap", "1", "--run-id", "over"]).status, 1);
  assert.equal(cli(["check", "--receipts", r, "--cap", "10", "--run-id", "unk"]).status, 1);
  const whole = cli(["check", "--receipts", r, "--cap", "100"]);
  assert.equal(whole.status, 1);
  const w = JSON.parse(whole.stdout);
  assert.equal(w.run_id, undefined); assert.match(w.scope, /not a reconstructed process run/);
});

test("AC6: --github-output writes run-id; action.yml wires the input", () => {
  const { dir, r } = ledger();
  const out = join(dir, "out"), sum = join(dir, "sum");
  const p = cli(["check", "--receipts", r, "--cap", "1", "--run-id", "under", "--github-output"], { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum });
  assert.equal(p.status, 0, p.stderr);
  const text = readFileSync(out, "utf8");
  assert.match(text, /^run-id<<.+\nunder\n/m); assert.match(text, /^spent-usd<<.+\n0\.3\n/m);
  assert.match(readFileSync(sum, "utf8"), /\| run-id \| under \|/);
  const p2 = cli(["check", "--receipts", r, "--cap", "100", "--github-output"], { GITHUB_OUTPUT: join(dir, "o2"), GITHUB_STEP_SUMMARY: join(dir, "s2") });
  assert.doesNotMatch(readFileSync(join(dir, "o2"), "utf8"), /run-id/);
  assert.doesNotMatch(readFileSync(join(dir, "s2"), "utf8"), /run-id/);
  assert.equal(p2.status, 1);
  const yml = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(yml, /COSTCAP_RUN_ID: \$\{\{ inputs\.run-id \}\}/);
  assert.match(yml, /args\+=\(--run-id "\$COSTCAP_RUN_ID"\)/);
});
