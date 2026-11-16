// Issue #207: budget-triggered model downgrade, unit level.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DOWNGRADE_AT, createDowngrader, downgradeError, downgradeLine, downgradeRoute, downgradeTrigger, mergeDowngrade, parseDowngradeAt, parseDowngradeMap, rewriteModel, scopeUsage } from "../src/downgrade.js";
import { parseWrapArgs } from "../src/cli.js";
import { validatePolicy } from "../src/hosted/policy.js";
import { buildRunSummary, rollupLine } from "../src/run-summary.js";

test("parseDowngradeMap / parseDowngradeAt", () => {
  assert.deepEqual(parseDowngradeMap("gpt-4o=gpt-4o-mini"), { "gpt-4o": "gpt-4o-mini" });
  assert.deepEqual(parseDowngradeMap(" a=b , c=d ,"), { a: "b", c: "d" });
  for (const bad of ["", ",", "a", "=b", "a=", "a=a", "a=b,a=c"]) assert.throws(() => parseDowngradeMap(bad), /--downgrade/, bad);
  assert.equal(parseDowngradeAt("0.5"), 0.5);
  assert.equal(parseDowngradeAt("1"), 1);
  for (const bad of ["", "0", "-0.1", "1.01", "x", "NaN"]) assert.throws(() => parseDowngradeAt(bad), /--downgrade-at/, bad);
  assert.equal(DEFAULT_DOWNGRADE_AT, 0.8);
});

test("wrap flags: --downgrade, --downgrade-at, unpriced target exits at parse", () => {
  const o = parseWrapArgs(["--day-cap", "5", "--downgrade", "gpt-4o=gpt-4o-mini", "--downgrade-at", "0.7", "--", "x"]);
  assert.deepEqual(o.downgradeMap, { "gpt-4o": "gpt-4o-mini" });
  assert.equal(o.downgradeAt, 0.7);
  assert.equal(parseWrapArgs(["--", "x"]).downgradeMap, undefined);
  assert.throws(() => parseWrapArgs(["--downgrade", "gpt-4o=no-such-model-xyz", "--", "x"]), /no published rate/);
  assert.throws(() => parseWrapArgs(["--downgrade-at", "2", "--", "x"]), /--downgrade-at/);
});

test("trigger math per scope: first scope at or above F, in order", () => {
  assert.equal(downgradeTrigger([], 0.8), null);
  assert.equal(downgradeTrigger([{ scope: "run", cap: 10, spent: 7.99 }], 0.8), null);
  assert.deepEqual(downgradeTrigger([{ scope: "run", cap: 10, spent: 8 }], 0.8), { scope: "run", fraction: 0.8, cap: 10, spent_usd: 8 });
  const rows = [{ scope: "run", cap: 10, spent: 1 }, { scope: "hour", cap: 1, spent: 0.9 }, { scope: "day", cap: 2, spent: 1.9 }];
  assert.equal(downgradeTrigger(rows, 0.8).scope, "hour");
  assert.equal(downgradeTrigger([{ scope: "day", cap: null, spent: 9 }, { scope: "month", cap: 0, spent: 9 }, { scope: "x", cap: 1 }], 0.5), null);
  assert.deepEqual(scopeUsage({ run: 1, day: 2, hour: 3 }, { run: 0.5, day: 1, hour: 0, month: 4 }), [
    { scope: "run", cap: 1, spent: 0.5 }, { scope: "hour", cap: 3, spent: 0 }, { scope: "day", cap: 2, spent: 1 }]);
  assert.deepEqual(scopeUsage({ day: 2 }, { day: 1 }, "agent"), [{ scope: "agent:day", cap: 2, spent: 1 }]);
});

test("body rewrite changes only model; route support", () => {
  const parsed = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], temperature: 0.2, stream: true };
  const out = JSON.parse(rewriteModel(parsed, "gpt-4o-mini"));
  assert.deepEqual(out, { ...parsed, model: "gpt-4o-mini" });
  assert.deepEqual(Object.keys(out), Object.keys(parsed));
  const body = { model: "gpt-4o" };
  for (const provider of ["openai", "anthropic", "openrouter"]) assert.equal(downgradeRoute({ provider, parsedBody: body }), true);
  assert.equal(downgradeRoute({ provider: "u", custom: true, parsedBody: body }), true);
  assert.equal(downgradeRoute({ provider: "gemini", parsedBody: body }), false);
  assert.equal(downgradeRoute({ provider: "bedrock", cloud: true, parsedBody: body }), false);
  assert.equal(downgradeRoute({ provider: "openai", batch: true, parsedBody: body }), false);
  assert.equal(downgradeRoute({ provider: "openai", multipart: true, parsedBody: body }), false);
  assert.equal(downgradeRoute({ provider: "openrouter", routerModels: ["a", "b"], parsedBody: body }), false);
  assert.equal(downgradeRoute({ provider: "openai", parsedBody: [body] }), false);
  assert.equal(downgradeRoute({ provider: "openai", parsedBody: null }), false);
});

test("policy validation and merge: local only adds or lowers", () => {
  const ok = { at: 0.8, map: { "gpt-4o": "gpt-4o-mini" } };
  assert.equal(downgradeError(ok), null);
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, downgrade: ok }), []);
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, downgrade: null }), []);
  for (const bad of [[], "x", { at: 0, map: ok.map }, { at: 1.5, map: ok.map }, { at: "0.8", map: ok.map }, { at: 0.8, map: {} }, { at: 0.8, map: [] },
    { at: 0.8, map: { a: "a" } }, { at: 0.8, map: { a: "" } }, { at: 0.8, map: { a: 3 } }, { at: 0.8 }]) {
    assert.equal(validatePolicy({ version: 1, caps: {}, downgrade: bad }).length, 1, JSON.stringify(bad));
  }
  assert.equal(mergeDowngrade(null, null), null);
  assert.equal(mergeDowngrade(null, { at: 0.5 }), null);
  assert.deepEqual(mergeDowngrade(null, { map: { a: "b" } }), { at: 0.8, map: { a: "b" } });
  assert.deepEqual(mergeDowngrade({ at: 0.9, map: { a: "b" } }, { at: 0.6, map: { a: "x", c: "d" } }), { at: 0.6, map: { a: "b", c: "d" } });
  // A local --downgrade-at can lower but never raise the fleet fraction.
  assert.equal(mergeDowngrade({ at: 0.5, map: { a: "b" } }, { at: 0.9 }).at, 0.5);
});

test("downgrader: decide, one notice per scope and period, rebuilt from ledger", () => {
  let spent = 0.5, cfg = { at: 0.8, map: { "gpt-4o": "gpt-4o-mini" } };
  const now = () => new Date("2026-11-16T12:00:00Z");
  const d = createDowngrader({ config: () => cfg, usage: () => [{ scope: "day", cap: 1, spent }], lowerBound: () => true, runId: "r1", agentId: "a", now });
  assert.equal(d.decide("gpt-4o"), null);
  spent = 0.85;
  assert.equal(d.decide("gpt-4o-mini"), null);
  assert.equal(d.decide(undefined), null);
  const dec = d.decide("gpt-4o");
  assert.deepEqual(dec, { from: "gpt-4o", to: "gpt-4o-mini", scope: "day", fraction: 0.8, cap: 1, spent_usd: 0.85 });
  const ev = d.notice(dec);
  assert.equal(ev.event, "model_downgrade");
  assert.equal(ev.period, "2026-11-16");
  assert.equal(ev.lower_bound, true);
  assert.match(downgradeLine(ev), /model downgrade: day spend \(lower bound\) \$0\.8500 is at or above 80% of \$1 cap; gpt-4o -> gpt-4o-mini/);
  assert.equal(d.notice(dec), null);
  const again = createDowngrader({ config: () => cfg, usage: () => [{ scope: "day", cap: 1, spent }], events: [ev], now });
  assert.equal(again.notice(dec), null);
  const periods = createDowngrader({ config: () => cfg, usage: () => [], runId: "r9", now });
  for (const [scope, period] of [["run", "r9"], ["hour", "2026-11-16T12"], ["month", "2026-11"], ["fleet:day", "2026-11-16"]]) assert.equal(periods.notice({ ...dec, scope }).period, period);
  periods.note({ event: "model_downgrade", scope: "team x:month", period: "2026-11" });
  assert.equal(periods.notice({ ...dec, scope: "team x:month" }), null);
  cfg = null;
  assert.equal(d.decide("gpt-4o"), null);
});

test("run summary counts downgraded calls", () => {
  const s = buildRunSummary({ run_id: "r", receipts: [
    { model: "gpt-4o-mini", requested_model: "gpt-4o", downgrade: { scope: "day", fraction: 0.8 }, cost_usd: 0.001 },
    { model: "gemini-2.5-flash", downgrade: "unsupported_route", cost_usd: 0.001 },
    { event: "model_downgrade", scope: "day" },
  ] });
  assert.equal(s.calls, 2);
  assert.equal(s.downgraded_calls, 1);
  assert.match(rollupLine(s), /downgraded=1/);
  assert.equal("downgraded_calls" in buildRunSummary({ run_id: "r", receipts: [] }), false);
});

test("resolvePolicy carries the fleet downgrade and merges local", async () => {
  const { resolvePolicy } = await import("../src/hosted/policy.js");
  assert.equal("downgrade" in resolvePolicy({ lastKnown: { version: 1, caps: {} } }), false);
  const server = { version: 2, caps: {}, downgrade: { at: 0.7, map: { a: "b" } } };
  assert.deepEqual(resolvePolicy({ lastKnown: server }).downgrade, { at: 0.7, map: { a: "b" } });
  assert.deepEqual(resolvePolicy({ lastKnown: server, local: { downgrade: { at: 0.5, map: { c: "d" } } } }).downgrade, { at: 0.5, map: { c: "d", a: "b" } });
});
