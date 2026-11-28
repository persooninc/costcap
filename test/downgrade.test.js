// Issue #207: budget-triggered model downgrade, pure helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DOWNGRADE_AT, createDowngradeNotifier, downgradeError, downgradeLine, downgradePeriod, downgradeTrigger, isRewritableProvider, mergeDowngrade, parseDowngradeAt, parseDowngradeMap, rewriteModel } from "../src/downgrade.js";
import { isDowngradeTargetPriced, parseWrapArgs } from "../src/cli.js";
import { resolvePolicy, validatePolicy } from "../src/hosted/policy.js";
import { buildRunSummary, rollupLine, runsCommand } from "../src/run-summary.js";

test("parseDowngradeMap / parseDowngradeAt", () => {
  assert.deepEqual(parseDowngradeMap("gpt-4o=gpt-4o-mini, claude-sonnet-4-5=claude-haiku-4-5"), { "gpt-4o": "gpt-4o-mini", "claude-sonnet-4-5": "claude-haiku-4-5" });
  for (const bad of ["", ",", "gpt-4o", "=x", "x=", "a=a", "a=b,a=c", "a b=c"]) assert.throws(() => parseDowngradeMap(bad), /--downgrade/, bad);
  assert.equal(parseDowngradeAt("0.5"), 0.5);
  for (const bad of ["0", "1", "-1", "", "x", "1.5"]) assert.throws(() => parseDowngradeAt(bad), /--downgrade-at/, bad);
  assert.equal(DEFAULT_DOWNGRADE_AT, 0.8);
});

test("wrap flags: --downgrade and --downgrade-at, unpriced TO exits before spawning", () => {
  const o = parseWrapArgs(["--downgrade", "gpt-4o=gpt-4o-mini", "--downgrade", "o3=o4-mini", "--downgrade-at", "0.6", "--", "true"]);
  assert.deepEqual(o.downgradeMap, { "gpt-4o": "gpt-4o-mini", o3: "o4-mini" });
  assert.equal(o.downgradeAt, 0.6);
  assert.throws(() => parseWrapArgs(["--downgrade", "gpt-4o=not-a-real-model-xyz", "--", "true"]), /no published rate/);
  assert.equal(isDowngradeTargetPriced("gpt-4o-mini"), true);
  assert.equal(isDowngradeTargetPriced("nope-model"), false);
  const userPrices = { upstreams: { local: { "my-small": { input: 0.1, output: 0.2 } }, openai: { "ft:custom": { input: 1, output: 2 } } } };
  assert.equal(isDowngradeTargetPriced("nope-model", { userPrices: { upstreams: {} }, upstreams: [] }), false);
  assert.equal(isDowngradeTargetPriced("my-small", { userPrices, upstreams: [{ name: "local" }] }), true);
  assert.equal(isDowngradeTargetPriced("my-small", { userPrices, upstreams: [] }), false);
  assert.equal(isDowngradeTargetPriced("ft:custom", { userPrices }), true);
});

test("downgradeTrigger: first scope at or above F, per source; unknown-cost spend is a lower bound", () => {
  assert.equal(downgradeTrigger({ at: 0.8, sources: [] }), null);
  assert.equal(downgradeTrigger({ at: 0, sources: [{ kind: "local", caps: { run: 1 }, spend: { run: 1 } }] }), null);
  const local = { kind: "local", caps: { run: 10, day: 10 }, spend: { run: 7.99, day: 9 } };
  assert.deepEqual(downgradeTrigger({ at: 0.8, sources: [local] }), { scope: "day", kind: "local", cap: 10, spent_usd: 9, fraction: 0.9 });
  const agent = { kind: "agent", caps: { run: 1, hour: 2 }, spend: { run: 0.8, hour: 0 } };
  assert.equal(downgradeTrigger({ at: 0.8, sources: [local, agent] }).scope, "run");
  assert.equal(downgradeTrigger({ at: 0.8, sources: [local, agent] }).kind, "agent");
  assert.equal(downgradeTrigger({ at: 0.95, sources: [local, agent] }), null);
  // Uncapped / missing / non-numeric spend never triggers.
  assert.equal(downgradeTrigger({ at: 0.1, sources: [{ kind: "x", caps: { day: null, month: 5 }, spend: { day: 9, month: NaN } }, null] }), null);
  assert.equal(downgradeTrigger({ at: 0.5, sources: [{ kind: "fleet_team", caps: { month: 4 }, spend: { month: 2 } }] }).kind, "fleet_team");
});

test("rewriteModel: only the model field changes; unsupported routes are marked", () => {
  const map = { "gpt-4o": "gpt-4o-mini" };
  const parsed = { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }], temperature: 0 };
  const rw = rewriteModel({ provider: "openai", body: Buffer.from(JSON.stringify(parsed)), parsed, model: "gpt-4o", map });
  assert.equal(rw.to, "gpt-4o-mini");
  assert.deepEqual(JSON.parse(rw.body), { ...parsed, model: "gpt-4o-mini" });
  assert.equal(rewriteModel({ provider: "openai", parsed, model: "gpt-4o-mini", map }), null);
  assert.equal(rewriteModel({ provider: "openai", parsed, model: undefined, map }), null);
  assert.equal(rewriteModel({ provider: "openai", parsed, model: "gpt-4o", map: null }), null);
  for (const [provider, route, p] of [["gemini", {}, parsed], ["bedrock", {}, parsed], ["vertex", {}, parsed], ["openai", { batch: true }, parsed], ["openai", { audio: true }, parsed],
    ["openai", { realtime: true }, parsed], ["openrouter", {}, { ...parsed, models: ["gpt-4o"] }], ["openai", {}, null], ["openai", {}, [1]], ["openai", {}, { model: "other" }]]) {
    assert.deepEqual(rewriteModel({ provider, parsed: p, model: "gpt-4o", map, route }), { unsupported: true, from: "gpt-4o" }, provider);
  }
  for (const p of ["openai", "anthropic", "openrouter", "u/local"]) assert.equal(isRewritableProvider(p), true);
  assert.equal(isRewritableProvider("gemini"), false);
});

test("hosted policy: downgrade validation, resolve passes it through", () => {
  const ok = { version: 1, caps: {}, downgrade: { at: 0.7, map: { "gpt-4o": "gpt-4o-mini" } } };
  assert.deepEqual(validatePolicy(ok), []);
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, downgrade: null }), []);
  for (const [d, re] of [[[], /object/], ["x", /object/], [{ map: {} }, /empty/], [{ map: { a: "a" } }, /itself/], [{ at: 1, map: { a: "b" } }, /fraction/], [{ at: 0, map: { a: "b" } }, /fraction/],
    [{ map: [] }, /map/], [{ map: { a: 3 } }, /model ids/], [{ map: { a: "b" }, x: 1 }, /not a field/], [{ map: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`m${i}`, "x"])) }, /more than/]]) {
    const errs = validatePolicy({ version: 1, caps: {}, downgrade: d });
    assert.equal(errs.length, 1, JSON.stringify(d));
    assert.match(errs[0], re);
  }
  assert.deepEqual(resolvePolicy({ lastKnown: ok }).downgrade, ok.downgrade);
  assert.equal("downgrade" in resolvePolicy({ lastKnown: { version: 1, caps: {} } }), false);
});

test("mergeDowngrade: local adds pairs and lowers at, never raises it or overrides a fleet pair", () => {
  assert.equal(mergeDowngrade(null, null), null);
  assert.equal(mergeDowngrade(null, { map: null, at: 0.5 }), null);
  assert.deepEqual(mergeDowngrade(null, { map: { a: "b" } }), { at: 0.8, map: { a: "b" } });
  const fleet = { at: 0.7, map: { a: "b" } };
  assert.deepEqual(mergeDowngrade(fleet, null), { at: 0.7, map: { a: "b" } });
  assert.deepEqual(mergeDowngrade(fleet, { map: null, at: 0.9 }), { at: 0.7, map: { a: "b" } });
  assert.deepEqual(mergeDowngrade(fleet, { map: null, at: 0.5 }), { at: 0.5, map: { a: "b" } });
  assert.deepEqual(mergeDowngrade(fleet, { map: { a: "z", c: "d" }, at: 0.75 }), { at: 0.7, map: { a: "b", c: "d" } });
  assert.deepEqual(mergeDowngrade({ map: { a: "b" } }, { map: { c: "d" } }), { at: 0.8, map: { c: "d", a: "b" } });
  // An invalid fleet value is ignored, never trusted.
  assert.deepEqual(mergeDowngrade({ map: {} }, { map: { c: "d" } }), { at: 0.8, map: { c: "d" } });
});

test("notifier: one model_downgrade per kind/scope/period, rebuilt from the ledger", () => {
  const now = () => new Date("2026-11-16T10:20:00Z");
  assert.equal(downgradePeriod("hour", { now: now() }), "2026-11-16T10");
  assert.equal(downgradePeriod("day", { now: now() }), "2026-11-16");
  assert.equal(downgradePeriod("month", { now: now() }), "2026-11");
  assert.equal(downgradePeriod("run", { runId: "r1" }), "r1");
  assert.equal(downgradePeriod("run", {}), "");
  assert.throws(() => downgradePeriod("week"), /unknown scope/);
  const n = createDowngradeNotifier({ runId: "r1", agentId: "a", now, events: [{ event: "model_downgrade", kind: "local", scope: "month", period: "2026-11" }, { event: "cap_warning" }] });
  const trig = { scope: "day", kind: "local", cap: 10, spent_usd: 8, fraction: 0.8 };
  const ev = n.observe(trig, { from: "gpt-4o", to: "gpt-4o-mini" });
  assert.deepEqual(ev, { event: "model_downgrade", kind: "local", scope: "day", fraction: 0.8, cap: 10, spent_usd: 8, from: "gpt-4o", to: "gpt-4o-mini", period: "2026-11-16", run_id: "r1", agent_id: "a" });
  assert.equal(n.observe(trig, { from: "gpt-4o", to: "gpt-4o-mini" }), null);
  assert.equal(n.observe({ ...trig, scope: "month" }, { from: "x", to: "y" }), null);
  assert.ok(n.observe({ ...trig, scope: "run" }, { from: "x", to: "y" }));
  assert.match(downgradeLine(ev), /local day spend \$8\.0000 is 80% of \$10 cap; downgrading gpt-4o -> gpt-4o-mini \(2026-11-16 UTC\)/);
  assert.match(downgradeLine({ ...ev, scope: "run", period: "r1" }), /\(run r1\)/);
  assert.equal(createDowngradeNotifier().observe(trig, { from: "a", to: "b" }).run_id, null);
});

test("run summary counts downgraded calls; rollup and runs list show them", () => {
  const s = buildRunSummary({ run_id: "r", receipts: [
    { model: "gpt-4o-mini", requested_model: "gpt-4o", downgrade: { scope: "run", fraction: 0.8 }, cost_usd: 0.1 },
    { model: "gpt-4o", downgrade: "unsupported_route", cost_usd: 0.1 },
    { model: "gpt-4o", cost_usd: 0.1 }] });
  assert.equal(s.downgraded_calls, 1);
  assert.match(rollupLine(s), / downgraded=1/);
  assert.equal("downgraded_calls" in buildRunSummary({ run_id: "r", receipts: [] }), false);
  assert.doesNotMatch(rollupLine(buildRunSummary({ run_id: "r", receipts: [] })), /downgraded/);
});

test("costcap runs shows downgraded=N", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeRunSummary } = await import("../src/run-summary.js");
  const dir = mkdtempSync(join(tmpdir(), "cc-dg-runs-"));
  const receipts = join(dir, "receipts.jsonl");
  writeRunSummary(receipts, { ...buildRunSummary({ run_id: "r1", ended_at: "2026-11-16T00:00:00Z", receipts: [{ model: "b", requested_model: "a", downgrade: { scope: "day", fraction: 0.9 }, cost_usd: 0 }] }) });
  const out = [];
  runsCommand(["--receipts", receipts], { log: (l) => out.push(l) });
  assert.match(out.join("\n"), /downgraded=1/);
});
