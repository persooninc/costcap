import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOutputs, formatOutputFile, formatSummary, writeGithubOutputs, OUTPUT_NAMES } from "../src/github-output.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const now = new Date().toISOString();

function parseOutputFile(text) {
  const out = {}; const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^<]+)<<(.+)$/.exec(lines[i]); if (!m) continue;
    const buf = []; i++;
    while (lines[i] !== m[2]) buf.push(lines[i++]);
    out[m[1]] = buf.join("\n");
  }
  return out;
}

function setup(receipts) {
  const dir = mkdtempSync(join(tmpdir(), "costcap-gho-"));
  const r = join(dir, "r.jsonl");
  writeFileSync(r, receipts.map((x) => JSON.stringify({ ts: now, ...x })).join("\n") + "\n");
  return { dir, r, out: join(dir, "out"), sum: join(dir, "sum") };
}
function run(args, env) {
  const e = { ...process.env }; delete e.GITHUB_OUTPUT; delete e.GITHUB_STEP_SUMMARY;
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...e, ...env }, encoding: "utf8" });
}

test("unit: verdicts and unknown cost is empty, never 0", () => {
  const base = { receipt_count: 2, total_usd: 1.5, spend: { day: 1.5, month: 1.5 } };
  assert.equal(checkOutputs({ ...base, ok: true, unknown_cost_count: 0 }, { run: 5 }).verdict, "ok");
  assert.equal(checkOutputs({ ...base, ok: false, unknown_cost_count: 0 }, { run: 1 }).verdict, "budget_exceeded");
  const u = checkOutputs({ ...base, ok: false, unknown_cost_count: 1 }, {});
  assert.deepEqual([u.verdict, u["spent-usd"], u["cap-usd"], u["day-spent-usd"], u["unknown-receipts"]], ["accounting_unavailable", "", "", "", "1"]);
});

test("unit: delimiter syntax survives newlines, % and delimiter collisions", () => {
  let n = 0; const ids = ["EOF", "EOF", "X1"];
  const text = formatOutputFile({ a: "line1\nEOF\n100%", b: "" }, () => ids[n++] ?? `d${n}`);
  assert.deepEqual(parseOutputFile(text), { a: "line1\nEOF\n100%", b: "" });
  const real = formatOutputFile({ v: "x\ny%" });
  assert.deepEqual(parseOutputFile(real), { v: "x\ny%" });
});

test("unit: summary table, disclaimer and pipe escaping", () => {
  const s = formatSummary({ verdict: "ok|x\ny", "spent-usd": "", "unknown-receipts": "2" });
  assert.match(s, /\| Field \| Value \|/);
  assert.match(s, /ok x y/);
  assert.match(s, /\| spent-usd \| unknown \|/);
  assert.match(s, /estimates/);
  assert.match(s, /2 receipt\(s\) have unknown cost/);
  assert.match(formatSummary({ verdict: "ok", "unknown-receipts": "0" }), /No receipts have unknown cost/);
});

test("unit: writeGithubOutputs is a no-op on files without env", () => {
  const o = writeGithubOutputs({ ok: true, unknown_cost_count: 0, receipt_count: 1, total_usd: 1, spend: { day: 1, month: 1 } }, { run: 2 }, {});
  assert.equal(o.verdict, "ok");
});

test("integration 1+4: under cap writes ok, spend, cap and summary; exits 0", () => {
  const t = setup([{ cost_usd: 0.25 }, { cost_usd: 0.5 }]);
  const p = run(["check", "--receipts", t.r, "--cap", "5", "--day-cap", "10", "--github-output"], { GITHUB_OUTPUT: t.out, GITHUB_STEP_SUMMARY: t.sum });
  assert.equal(p.status, 0, p.stderr);
  const o = parseOutputFile(readFileSync(t.out, "utf8"));
  assert.deepEqual(o, { verdict: "ok", "spent-usd": "0.75", "cap-usd": "5", "day-spent-usd": "0.75", "month-spent-usd": "0.75", "unknown-receipts": "0", "receipts-count": "2", warnings: "" });
  const s = readFileSync(t.sum, "utf8");
  assert.match(s, /\| verdict \| ok \|/); assert.match(s, /\| spent-usd \| 0\.75 \|/); assert.match(s, /estimates/);
});

test("integration 2: over cap writes budget_exceeded before exiting 1", () => {
  const t = setup([{ cost_usd: 3 }]);
  const p = run(["check", "--receipts", t.r, "--cap", "1", "--github-output"], { GITHUB_OUTPUT: t.out, GITHUB_STEP_SUMMARY: t.sum });
  assert.equal(p.status, 1);
  const o = parseOutputFile(readFileSync(t.out, "utf8"));
  assert.equal(o.verdict, "budget_exceeded"); assert.equal(o["spent-usd"], "3"); assert.equal(o["cap-usd"], "1");
});

test("integration 3: null cost gives accounting_unavailable and empty spend", () => {
  const t = setup([{ cost_usd: 0.1 }, { cost_usd: null }]);
  const p = run(["check", "--receipts", t.r, "--cap", "5", "--github-output"], { GITHUB_OUTPUT: t.out, GITHUB_STEP_SUMMARY: t.sum });
  assert.equal(p.status, 1);
  const o = parseOutputFile(readFileSync(t.out, "utf8"));
  assert.equal(o.verdict, "accounting_unavailable"); assert.equal(o["spent-usd"], ""); assert.ok(Number(o["unknown-receipts"]) > 0);
  assert.match(readFileSync(t.sum, "utf8"), /unknown cost/);
});

test("regression 5: env unset leaves stdout unchanged and writes nothing", () => {
  const t = setup([{ cost_usd: 0.25 }]);
  const a = run(["check", "--receipts", t.r, "--cap", "5"], {});
  const b = run(["check", "--receipts", t.r, "--cap", "5", "--github-output"], {});
  assert.equal(a.status, 0); assert.equal(b.status, 0);
  assert.equal(a.stdout, b.stdout); assert.equal(b.stderr, "");
  assert.ok(!existsSync(t.out) && !existsSync(t.sum));
});

test("regression: every output declared in action.yml is written by the CLI and wired", () => {
  const yml = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  const block = yml.split(/^outputs:\n/m)[1].split(/^runs:/m)[0];
  const declared = [...block.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), [...OUTPUT_NAMES].sort());
  for (const n of declared) assert.ok(block.includes(`steps.check.outputs.${n} }}`), n);
  assert.match(yml, /- id: check/); assert.match(yml, /--github-output/);
});

test("#164: check --day-cap 1 at $0.85 is ok with warnings=day:0.8 and a summary row; --warn-at off is empty", () => {
  const t = setup([{ cost_usd: 0.85 }]);
  const p = run(["check", "--receipts", t.r, "--day-cap", "1", "--github-output"], { GITHUB_OUTPUT: t.out, GITHUB_STEP_SUMMARY: t.sum });
  assert.equal(p.status, 0, p.stderr);
  const j = JSON.parse(p.stdout);
  assert.equal(j.ok, true);
  assert.deepEqual(j.warnings, [{ scope: "day", fraction: 0.8, cap: 1, spent_usd: 0.85, lower_bound: false }]);
  assert.equal(parseOutputFile(readFileSync(t.out, "utf8")).warnings, "day:0.8");
  assert.match(readFileSync(t.sum, "utf8"), /\| warnings \| day:0\.8 \|/);
  const t2 = setup([{ cost_usd: 0.85 }]);
  const off = run(["check", "--receipts", t2.r, "--day-cap", "1", "--warn-at", "off", "--github-output"], { GITHUB_OUTPUT: t2.out, GITHUB_STEP_SUMMARY: t2.sum });
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(off.stdout).warnings, []);
  assert.equal(parseOutputFile(readFileSync(t2.out, "utf8")).warnings, "");
  assert.match(readFileSync(t2.sum, "utf8"), /\| warnings \| none \|/);
});

test("#164 unit: warnings output joins scope:fraction pairs", () => {
  const o = checkOutputs({ ok: true, unknown_cost_count: 0, receipt_count: 1, total_usd: 1, spend: { day: 1, month: 1 },
    warnings: [{ scope: "day", fraction: 0.8 }, { scope: "month", fraction: 0.5 }] }, {});
  assert.equal(o.warnings, "day:0.8,month:0.5");
  assert.ok(OUTPUT_NAMES.includes("warnings"));
});
