import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const F = "test/fixtures/cost-diff";
const cli = (args, env = {}) => spawnSync(process.execPath, ["src/cli.js", ...args], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ...env } });
const tmp = () => mkdtempSync(join(tmpdir(), "costcap-diff-"));

test("AC1: summary --json shape, byte-identical, --run-id", () => {
  const a = cli(["summary", "--receipts", `${F}/ledger.jsonl`, "--json"]);
  assert.equal(a.status, 0, a.stderr);
  const s = JSON.parse(a.stdout);
  assert.equal(s.version, 1); assert.equal(s.total_usd, 1); assert.equal(s.calls, 3); assert.equal(s.unknown_cost_count, 0);
  assert.deepEqual(Object.keys(s.by_model), ["claude-sonnet", "gpt-4o"]);
  assert.deepEqual(s.by_tag, { team: { core: 0.6, growth: 0.4 } });
  assert.equal(cli(["summary", "--receipts", `${F}/ledger.jsonl`, "--json"]).stdout, a.stdout);
  const r = JSON.parse(cli(["summary", "--receipts", `${F}/ledger.jsonl`, "--run-id", "b", "--json"]).stdout);
  assert.equal(r.run_id, "b"); assert.equal(r.calls, 1); assert.equal(r.total_usd, 0.1);
  assert.equal(cli(["summary", "--receipts", `${F}/ledger.jsonl`, "--run-id", ""]).status, 2);
});

test("AC2: diff exit codes and markdown", () => {
  const args = ["diff", "--baseline", `${F}/base.json`, "--current", `${F}/head.json`];
  const ok = cli(args);
  assert.equal(ok.status, 0); assert.match(ok.stdout, /\+\$0\.38 \(\+38%\)/); assert.match(ok.stdout, /model C: added \+\$0\.28/);
  const bad = cli([...args, "--max-increase-pct", "25"]);
  assert.equal(bad.status, 1); assert.match(bad.stdout, /verdict: cost_regression/);
  assert.equal(cli([...args, "--max-increase-pct", "50", "--max-increase-usd", "1"]).status, 0);
  assert.match(cli([...args, "--markdown"]).stdout, /^## CostCap cost diff: ok\n\n\| \| Baseline/);
  assert.equal(JSON.parse(cli([...args, "--json"]).stdout).total.delta, 0.38);
  assert.equal(cli(["diff", "--baseline", `${F}/base.json`]).status, 2);
  assert.match(cli(["diff", "--baseline", `${F}/ledger.jsonl`, "--current", `${F}/head.json`]).stderr, /baseline is not valid JSON/);
});

test("AC3: unknown current exits 3; zero baseline +∞%", () => {
  const d = tmp();
  const cur = JSON.parse(readFileSync(`${F}/head.json`, "utf8"));
  writeFileSync(join(d, "u.json"), JSON.stringify({ ...cur, unknown_cost_count: 1 }));
  const u = cli(["diff", "--baseline", `${F}/base.json`, "--current", join(d, "u.json")]);
  assert.equal(u.status, 3); assert.match(u.stdout, /accounting_unavailable/); assert.match(u.stdout, /≥/);
  writeFileSync(join(d, "z.json"), JSON.stringify({ version: 1, total_usd: 0, by_model: {} }));
  const z = cli(["diff", "--baseline", join(d, "z.json"), "--current", `${F}/head.json`, "--max-increase-pct", "1000"]);
  assert.equal(z.status, 1); assert.match(z.stdout, /\+∞%/);
  assert.match(JSON.parse(cli(["diff", "--baseline", join(d, "z.json"), "--current", `${F}/head.json`, "--json"]).stdout).total.pct, /Infinity/);
});

test("AC4: check --github-output --baseline writes diff outputs; summary-out is a valid baseline; no baseline unchanged", () => {
  const d = tmp();
  const env = (n) => ({ GITHUB_OUTPUT: join(d, `out${n}`), GITHUB_STEP_SUMMARY: join(d, `sum${n}`) });
  const base = ["check", "--receipts", `${F}/ledger.jsonl`, "--cap", "100", "--github-output"];
  const r = cli([...base, "--baseline", `${F}/base-fail.json`, "--max-increase-pct", "25", "--summary-out", join(d, "next.json")], env(1));
  assert.equal(r.status, 1, r.stderr);
  const out = readFileSync(join(d, "out1"), "utf8");
  assert.match(out, /verdict<<(\S+)\ncost_regression\n\1\n/);
  assert.match(out, /delta-usd<<(\S+)\n0\.5\n/); assert.match(out, /delta-pct<<(\S+)\n100\n/); assert.match(out, /baseline-usd<<(\S+)\n0\.5\n/);
  assert.match(out, /diff-markdown<<(\S+)\n## CostCap cost diff: cost_regression\n[\s\S]*\n\1\n/);
  assert.match(readFileSync(join(d, "sum1"), "utf8"), /CostCap cost diff/);
  assert.equal(JSON.parse(r.stdout).cost_diff.verdict, "cost_regression");
  const pass = cli([...base, "--baseline", join(d, "next.json"), "--max-increase-pct", "0"], env(2));
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(readFileSync(join(d, "out2"), "utf8"), /verdict<<(\S+)\nok\n/);
  const plain = cli(base, env(3));
  const keys = (f) => [...readFileSync(f, "utf8").matchAll(/^([a-z-]+)<</gm)].map((m) => m[1]);
  assert.deepEqual(keys(join(d, "out3")), ["verdict", "spent-usd", "cap-usd", "hour-spent-usd", "day-spent-usd", "month-spent-usd", "unknown-receipts", "receipts-count", "warnings"]);
  assert.doesNotMatch(readFileSync(join(d, "sum3"), "utf8"), /cost diff/);
  assert.equal(plain.status, 0);
  assert.equal(cli([...base, "--max-increase-pct", "5"]).status, 2);
  assert.equal(cli([...base, "--baseline", `${F}/base.json`, "--max-increase-usd", "x"]).status, 2);
});

test("action.yml wires baseline inputs and outputs", () => {
  const a = readFileSync("action.yml", "utf8");
  for (const k of ["baseline:", "max-increase-pct:", "max-increase-usd:", "summary-out:", "delta-usd:", "delta-pct:", "baseline-usd:", "diff-markdown:", "--baseline", "--summary-out"]) assert.ok(a.includes(k), k);
});

test("AC6: README embeds the actionlint-checked example workflow with documented inputs only", () => {
  const y = readFileSync("docs/examples/cost-diff.yml", "utf8");
  assert.ok(readFileSync("README.md", "utf8").includes("```yaml\n" + y + "```"));
  const action = readFileSync("action.yml", "utf8");
  for (const m of y.matchAll(/^ {10}([a-z-]+):/gm)) if (/costcap@/.test(y)) assert.ok(["receipts", "cap", "summary-out", "baseline", "max-increase-pct", "max-increase-usd", "name", "path", "workflow", "branch"].includes(m[1]) && (["name", "path", "workflow", "branch"].includes(m[1]) || action.includes(`  ${m[1]}:`)), m[1]);
});
