import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCostSummary, stableStringify, diffSummaries, formatDiffMarkdown, formatDiffText, pct, fmtUsd, fmtPct, parseSummary, parseThresholds, MAX_ROWS } from "../src/cost-diff.js";
import { applySettlements } from "../src/cap.js";
import { diffOutputs } from "../src/github-output.js";

const S = (total, models, extra = {}) => ({ version: 1, total_usd: total, calls: 1, tokens: { in: 0, out: 0, cached: 0 }, unknown_cost_count: 0,
  by_model: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { calls: 1, cost_usd: v, unknown_cost_count: 0 }])), by_tag: {}, ...extra });
const base = S(1, { A: 0.6, B: 0.4 });
const head = S(1.38, { A: 0.6, B: 0.5, C: 0.28 });

test("summary aggregates models, tags, tokens; settled unknown counts; blocked/events skipped; run filter", () => {
  const lines = [
    { id: "1", model: "m1", input_tokens: 10, output_tokens: 2, cached_input_tokens: 1, cost_usd: 0.25, tags: { t: "x" }, run_id: "a" },
    { id: "2", model: "m2", cost_usd: null, tags: { t: "y" }, run_id: "b" },
    { event: "reconciliation", receipt_id: "2", cost_usd: 0.5 },
    { id: "3", model: "m1", blocked: true, cost_usd: 0 },
    { id: "4", cost_usd: null, run_id: "b" },
  ];
  const s = buildCostSummary(applySettlements(lines));
  assert.equal(s.total_usd, 0.75); assert.equal(s.calls, 3); assert.equal(s.unknown_cost_count, 1);
  assert.deepEqual(s.tokens, { in: 10, out: 2, cached: 1 });
  assert.deepEqual(s.by_tag, { t: { x: 0.25, y: 0.5 } });
  assert.equal(s.by_model.unknown.unknown_cost_count, 1);
  const r = buildCostSummary(applySettlements(lines), { runId: "a" });
  assert.equal(r.run_id, "a"); assert.equal(r.calls, 1);
  assert.equal(stableStringify(s), stableStringify(buildCostSummary(applySettlements(lines))));
  assert.match(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] }), /"a"[\s\S]*"c"[\s\S]*"d"[\s\S]*"b"/);
});

test("AC2: delta math, classification, thresholds", () => {
  const d = diffSummaries(base, head);
  assert.equal(d.verdict, "ok"); assert.equal(d.total.delta, 0.38); assert.equal(d.total.pct, 38);
  assert.deepEqual(d.changes.map((c) => [c.key, c.status, c.delta]), [["C", "added", 0.28], ["B", "changed", 0.1]]);
  assert.match(formatDiffText(d), /\+\$0\.38 \(\+38%\)/);
  assert.match(formatDiffText(d), /model B: changed \+\$0\.10/);
  assert.match(formatDiffMarkdown(d), /\| model \| C \| added \| \$0\.00 \| \$0\.28 \| \+\$0\.28/);
  assert.equal(diffSummaries(base, head, { maxPct: 25 }).verdict, "cost_regression");
  assert.equal(diffSummaries(base, head, { maxPct: 25 }).exit_code, 1);
  assert.equal(diffSummaries(base, head, { maxPct: 50, maxUsd: 1 }).verdict, "ok");
  assert.equal(diffSummaries(base, head, { maxUsd: 0.1 }).verdict, "cost_regression");
  const rem = diffSummaries(head, base);
  assert.ok(rem.changes.some((c) => c.key === "C" && c.status === "removed" && c.delta === -0.28));
  assert.match(formatDiffText(rem), /-\$0\.38 \(-27\.5%\)/);
});

test("AC3: unknown cost cases and +∞%", () => {
  const cu = diffSummaries(base, { ...head, unknown_cost_count: 2 }, { maxPct: 1000 });
  assert.equal(cu.verdict, "accounting_unavailable"); assert.equal(cu.exit_code, 3);
  assert.match(formatDiffText(cu), /≥\+\$0\.38 \(≥\+38%\)/);
  assert.match(formatDiffMarkdown(cu), /≥/);
  const bu = diffSummaries({ ...base, unknown_cost_count: 1 }, head, { maxPct: 1 });
  assert.equal(bu.verdict, "ok"); assert.deepEqual(bu.warnings, ["baseline_incomplete"]);
  assert.match(formatDiffText(bu), /baseline_incomplete; % change not gated/);
  assert.equal(diffSummaries({ ...base, unknown_cost_count: 1 }, head, { maxUsd: 0.1 }).verdict, "cost_regression");
  const z = diffSummaries(S(0, {}), S(0.5, { A: 0.5 }), { maxPct: 1000 });
  assert.equal(z.total.pct, Infinity); assert.equal(z.verdict, "cost_regression");
  assert.match(formatDiffText(z), /\+∞%/);
  assert.equal(diffSummaries(S(0, {}), S(0.5, { A: 0.5 }), { maxUsd: 1 }).verdict, "ok");
});

test("markdown truncates at 20 rows; formatting helpers", () => {
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`m${i}`, (i + 1) / 100]));
  const d = diffSummaries(S(0, {}), S(3.25, many));
  const md = formatDiffMarkdown(d);
  assert.equal(md.split("\n").filter((l) => l.startsWith("| model |")).length, MAX_ROWS);
  assert.match(md, /5 more/); assert.match(formatDiffText(d), /5 more/);
  assert.equal(pct(0, 0), 0); assert.equal(pct(0, -1), -Infinity); assert.equal(fmtPct(-Infinity), "-∞%");
  assert.equal(fmtUsd(0.000123, true), "+$0.000123"); assert.equal(fmtUsd(-2), "-$2.00");
});

test("parseSummary and thresholds validate input", () => {
  assert.throws(() => parseSummary("{"), /not valid JSON/);
  assert.throws(() => parseSummary('{"version":2}'), /not a costcap summary v1/);
  assert.equal(parseSummary('{"version":1,"total_usd":0,"by_model":{}}').calls, 0);
  assert.throws(() => parseThresholds(() => "-1"), /non-negative/);
  assert.deepEqual(parseThresholds((n) => (n === "--max-increase-usd" ? "2" : undefined)), { maxUsd: 2 });
});

test("diffOutputs: verdict escalation, inf pct, lower bound blanks", () => {
  const o = diffOutputs({ verdict: "ok" }, diffSummaries(base, head, { maxPct: 25 }));
  assert.equal(o.verdict, "cost_regression"); assert.equal(o["delta-usd"], "0.38"); assert.equal(o["delta-pct"], "38"); assert.equal(o["baseline-usd"], "1");
  assert.equal(diffOutputs({ verdict: "budget_exceeded" }, diffSummaries(base, head, { maxPct: 25 })).verdict, "budget_exceeded");
  assert.equal(diffOutputs({ verdict: "ok" }, diffSummaries(S(0, {}), S(1, { A: 1 })))["delta-pct"], "inf");
  assert.equal(diffOutputs({ verdict: "ok" }, diffSummaries(S(1, {}), S(0, {}, { total_usd: 0 })))["delta-pct"], "-100");
  const lb = diffOutputs({ verdict: "accounting_unavailable" }, diffSummaries(base, { ...head, unknown_cost_count: 1 }));
  assert.equal(lb["delta-usd"], ""); assert.equal(lb["delta-pct"], "");
});
