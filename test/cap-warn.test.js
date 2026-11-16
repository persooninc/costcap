import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapWarner, crossedThresholds, currentWarnings, parseWarnAt, periodKey, warningLine, DEFAULT_WARN_AT } from "../src/cap-warn.js";
import { createCapEngine, loadReceipts } from "../src/cap.js";
import { parseWrapArgs } from "../src/cli.js";
import { buildRunSummary } from "../src/run-summary.js";

test("parseWarnAt: fractions sorted, off, and every invalid value throws", () => {
  assert.deepEqual(parseWarnAt("0.8,0.5"), [0.5, 0.8]);
  assert.deepEqual(parseWarnAt("off"), []);
  for (const bad of ["0", "1", "1.5", "abc", "0.8,0.8", "", "0.5,", "-0.1"]) assert.throws(() => parseWarnAt(bad), /--warn-at/, bad);
  assert.deepEqual(parseWrapArgs(["--", "x"]).warnAt, [...DEFAULT_WARN_AT]);
  assert.deepEqual(parseWrapArgs(["--warn-at", "0.5", "--", "x"]).warnAt, [0.5]);
  assert.throws(() => parseWrapArgs(["--warn-at", "1", "--", "x"]), /--warn-at/);
});

test("crossedThresholds: only (before, after], multi-fraction jumps ascending, uncapped scopes skipped", () => {
  const caps = { day: 1, run: 10 };
  assert.deepEqual(crossedThresholds({ caps, before: { day: 0.4 }, after: { day: 0.6 }, fractions: [0.5, 0.8] }), [{ scope: "day", fraction: 0.5 }]);
  assert.deepEqual(crossedThresholds({ caps, before: { day: 0.1 }, after: { day: 0.95 }, fractions: [0.8, 0.5] }), [{ scope: "day", fraction: 0.5 }, { scope: "day", fraction: 0.8 }]);
  assert.deepEqual(crossedThresholds({ caps, before: { day: 0.85 }, after: { day: 0.9 }, fractions: [0.8] }), []);
  assert.deepEqual(crossedThresholds({ caps: {}, before: {}, after: { month: 99 } }), []);
  assert.deepEqual(crossedThresholds({ caps: { month: 1 }, before: {}, after: { month: 0.8 } }), [{ scope: "month", fraction: 0.8 }]);
});

test("periodKey: run_id, UTC day and UTC month", () => {
  const now = new Date("2026-11-16T23:59:59-05:00");
  assert.equal(periodKey("run", { runId: "r1", now }), "r1");
  assert.equal(periodKey("day", { now }), "2026-11-17");
  assert.equal(periodKey("month", { now }), "2026-11");
  assert.throws(() => periodKey("year", { now }));
});

test("warner dedupes per scope+fraction+period, rebuilds from events, re-arms on new run and next day", () => {
  let clock = new Date("2026-11-16T10:00:00Z");
  const now = () => clock;
  const caps = { day: 1, run: 1 };
  const w = createCapWarner({ fractions: [0.5, 0.8], runId: "r1", now });
  const a = w.observe({ caps, before: { day: 0.4, run: 0.4 }, after: { day: 0.6, run: 0.6 } });
  assert.deepEqual(a.map((e) => [e.scope, e.fraction, e.period]), [["run", 0.5, "r1"], ["day", 0.5, "2026-11-16"]]);
  assert.equal(w.observe({ caps, before: { day: 0.4 }, after: { day: 0.6 } }).length, 0);
  const again = createCapWarner({ fractions: [0.5, 0.8], events: a, runId: "r1", now });
  assert.equal(again.observe({ caps, before: { day: 0.4, run: 0.4 }, after: { day: 0.6, run: 0.6 } }).length, 0);
  const newRun = createCapWarner({ fractions: [0.5], events: a, runId: "r2", now });
  assert.deepEqual(newRun.observe({ caps, before: { day: 0.4, run: 0.4 }, after: { day: 0.6, run: 0.6 } }).map((e) => e.scope), ["run"]);
  clock = new Date("2026-11-17T00:00:01Z");
  const nextDay = createCapWarner({ fractions: [0.5], events: a, runId: "r1", now });
  assert.deepEqual(nextDay.observe({ caps, before: { day: 0.4, run: 0.4 }, after: { day: 0.6, run: 0.6 } }).map((e) => [e.scope, e.period]), [["day", "2026-11-17"]]);
  assert.equal(createCapWarner({ fractions: [] }).observe({ caps, before: {}, after: { day: 1 } }).length, 0);
});

test("lower bound flag and stderr text", () => {
  const w = createCapWarner({ fractions: [0.8], runId: "r", agentId: "ag", now: () => new Date("2026-11-16T00:00:00Z") });
  const [ev] = w.observe({ caps: { day: 10 }, before: { day: 0 }, after: { day: 8.0123 }, lowerBound: true });
  assert.deepEqual(ev, { event: "cap_warning", scope: "day", fraction: 0.8, cap: 10, spent_usd: 8.0123, period: "2026-11-16", run_id: "r", agent_id: "ag", lower_bound: true });
  assert.equal(warningLine(ev), "costcap: warning: day spend (lower bound) $8.0123 is 80% of $10 cap (2026-11-16 UTC)");
  assert.equal(warningLine({ ...ev, lower_bound: false }), "costcap: warning: day spend $8.0123 is 80% of $10 cap (2026-11-16 UTC)");
  assert.match(warningLine({ ...ev, scope: "run", period: "r" }), /\(run r\)$/);
  assert.deepEqual(currentWarnings({ caps: { day: 1, run: 1 }, spend: { day: 0.8 }, lowerBound: { day: true } }), [{ scope: "day", fraction: 0.8, cap: 1, spent_usd: 0.8, lower_bound: true }]);
});

test("cap_warning lines are never spend and the run summary lists warnings", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-cw-"));
  const ts = new Date().toISOString();
  const rows = [{ id: "a", ts, cost_usd: 0.85 }];
  const plain = join(dir, "a.jsonl"), withW = join(dir, "b.jsonl");
  writeFileSync(plain, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(withW, [...rows, { ts, event: "cap_warning", scope: "day", fraction: 0.8, cap: 1, spent_usd: 0.85, period: ts.slice(0, 10) }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.deepEqual(loadReceipts(withW), loadReceipts(plain));
  assert.deepEqual(createCapEngine({ caps: { day: 1 }, history: loadReceipts(withW) }).spend(), createCapEngine({ caps: { day: 1 }, history: loadReceipts(plain) }).spend());
  const ev = { event: "cap_warning", scope: "run", fraction: 0.8, cap: 1, spent_usd: 0.9, period: "r", run_id: "r", agent_id: null, lower_bound: false };
  const s = buildRunSummary({ run_id: "r", receipts: [{ cost_usd: 0.9, model: "m" }, ev], caps: { run: 1 }, spend: { run: 0.9 }, warnings: [ev] });
  assert.equal(s.calls, 1);
  assert.deepEqual(s.warnings, [{ scope: "run", fraction: 0.8, cap: 1, spent_usd: 0.9, period: "r", lower_bound: false }]);
  assert.deepEqual(buildRunSummary({ run_id: "x" }).warnings, []);
});
