// Issue #264: local wrap/check/mcp --week-cap (ISO week, UTC, Monday start) in the
// wrapper's own cap engine, warnings, preflight, run summary, Action and fleet merge.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCapEngine, CAP_SCOPES, budgetExceededBody } from "../src/cap.js";
import { parseWrapArgs } from "../src/cli.js";
import { checkBudget, guardedBudgetStatus } from "../src/check.js";
import { createCapWarner, periodKey as warnPeriod, currentWarnings } from "../src/cap-warn.js";
import { checkEstimate } from "../src/preflight.js";
import { buildRunSummary } from "../src/run-summary.js";
import { checkOutputs, OUTPUT_NAMES } from "../src/github-output.js";
import { resolvePolicy } from "../src/hosted/policy.js";

const at = (iso) => () => new Date(iso);
const tmp = () => mkdtempSync(path.join(tmpdir(), "cc-week-"));

test("AC1 local engine: week spend, remaining, record and reset at the next Monday", () => {
  let now = "2026-11-16T01:00:00Z";
  const history = [{ ts: "2026-11-15T23:30:00Z", cost_usd: 6 }, { ts: "2026-11-16T00:30:00Z", cost_usd: 4 }];
  const cap = createCapEngine({ caps: { week: 10 }, history, now: () => new Date(now) });
  assert.ok(CAP_SCOPES.includes("week"));
  assert.equal(cap.spend().week, 4);
  assert.deepEqual(cap.remaining(), { week: 6 });
  assert.equal(cap.check(), null);
  cap.record({ ts: "2026-11-16T00:50:00Z", cost_usd: 6 });
  assert.deepEqual(cap.check(), { scope: "week", cap: 10, spent: 10 });
  const body = budgetExceededBody(cap.check());
  assert.equal(body.error.scope, "week");
  assert.equal("retry_after_s" in body.error, false);
  now = "2026-11-23T00:00:00Z";
  assert.equal(cap.spend().week, 0);
  assert.equal(cap.check(), null);
});

test("AC2 month and year boundaries; settlement lands in the receipt's week", () => {
  const cap = createCapEngine({ caps: { week: 10 }, history: [{ ts: "2026-11-30T10:00:00Z", cost_usd: 8 }, { ts: "2026-12-02T10:00:00Z", cost_usd: 3 }], now: at("2026-12-02T12:00:00Z") });
  assert.equal(cap.spend().week, 11);
  assert.equal(cap.spend().month, 3);
  assert.equal(cap.check().scope, "week");
  const y = [{ ts: "2027-01-03T23:59:59Z", cost_usd: 5 }];
  assert.equal(createCapEngine({ caps: { week: 5 }, history: y, now: at("2027-01-03T23:59:59Z") }).check().scope, "week");
  assert.equal(warnPeriod("week", { now: new Date("2027-01-03T23:59:59Z") }), "2026-W53");
  assert.equal(createCapEngine({ caps: { week: 5 }, history: y, now: at("2027-01-04T00:00:00Z") }).check(), null);
  const s = createCapEngine({ caps: { week: 1 }, history: [{ ts: "2026-11-16T00:00:01Z", cost_usd: null }], now: at("2026-11-18T00:00:00Z") });
  assert.equal(s.check().reason, "unreconciled_receipt");
  assert.equal(s.settle({ id: "x", ts: "2026-11-16T00:00:01Z", cost_usd: 1 }), true);
  assert.equal(s.check().scope, "week");
  const old = createCapEngine({ caps: { week: 1 }, history: [{ ts: "2026-11-15T00:00:00Z", cost_usd: null }], now: at("2026-11-18T00:00:00Z") });
  old.settle({ id: "y", ts: "2026-11-15T00:00:00Z", cost_usd: 1 });
  assert.equal(old.check(), null);
  assert.throws(() => createCapEngine({ caps: { week: 0 } }), /Invalid week cap/);
  assert.throws(() => cap.updateCaps({ week: -1 }), /Invalid updated caps/);
});

test("AC3 parse: --week-cap for wrap, check and mcp; bad values are refused like --day-cap", () => {
  assert.equal(parseWrapArgs(["--week-cap", "25", "--", "x"]).caps.week, 25);
  for (const v of ["0", "-1", "abc"]) assert.throws(() => parseWrapArgs(["--week-cap", v, "--", "x"]), new RegExp(`--week-cap must be a positive number of USD, got "${v}"`));
  for (const cmd of ["check", "mcp"]) {
    const p = spawnSync(process.execPath, ["src/cli.js", cmd, "--week-cap", "abc"], { encoding: "utf8" });
    assert.equal(p.status, 2);
    assert.match(p.stderr, /--week-cap must be a positive number of USD, got "abc"/);
  }
  assert.match(spawnSync(process.execPath, ["src/cli.js", "--help"], { encoding: "utf8" }).stdout, /--week-cap USD/);
});

test("AC3 checkBudget: week block, hit, unknown cost and run-scoped JSON", () => {
  const now = at("2026-11-18T00:00:00Z");
  const dir = tmp(); const r = path.join(dir, "r.jsonl");
  writeFileSync(r, [{ ts: "2026-11-15T12:00:00Z", cost_usd: 9, run_id: "a" }, { ts: "2026-11-16T12:00:00Z", cost_usd: 2, run_id: "a" }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const over = checkBudget({ receiptsPath: r, caps: { week: 2 }, now });
  assert.equal(over.ok, false); assert.equal(over.hit.scope, "week"); assert.equal(over.spend.week, 2);
  assert.equal(checkBudget({ receiptsPath: r, caps: { week: 3 }, now }).ok, true);
  const run = checkBudget({ receiptsPath: r, caps: { week: 3 }, runId: "a", now });
  assert.deepEqual(run.week, { spent_usd: 2, cap: 3, scope: "whole ledger, current ISO week (UTC, Monday start)" });
  assert.equal(checkBudget({ receiptsPath: r, caps: { week: 2 }, runId: "a", now }).hit.scope, "week");
  assert.equal(checkBudget({ receiptsPath: r, caps: {}, now }).spend.week, 2);
});

test("AC3 CLI check --week-cap exits 1 at/over, 0 under, 1 on unknown cost", () => {
  const dir = tmp(); const r = path.join(dir, "r.jsonl");
  writeFileSync(r, JSON.stringify({ ts: new Date().toISOString(), cost_usd: 1 }) + "\n");
  const run = (cap) => spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", r, "--week-cap", cap], { encoding: "utf8" });
  const hit = run("1");
  assert.equal(hit.status, 1);
  assert.equal(JSON.parse(hit.stdout).hit.scope, "week");
  assert.equal(run("5").status, 0);
  writeFileSync(r, JSON.stringify({ ts: new Date().toISOString(), cost_usd: null }) + "\n", { flag: "a" });
  const unk = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", r, "--week-cap", "5", "--github-output"], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: path.join(dir, "o"), GITHUB_STEP_SUMMARY: path.join(dir, "s") } });
  assert.equal(unk.status, 1);
  assert.match(readFileSync(path.join(dir, "o"), "utf8"), /verdict<<[^\n]+\naccounting_unavailable/);
});

test("AC5 warnings: one week cap_warning per ISO week, deduped on YYYY-Www", () => {
  let now = "2026-11-17T00:00:00Z";
  const w = createCapWarner({ fractions: [0.5], now: () => new Date(now) });
  const caps = { week: 10 };
  const first = w.observe({ caps, before: { week: 4 }, after: { week: 5 } });
  assert.equal(first.length, 1);
  assert.equal(first[0].scope, "week");
  assert.equal(first[0].period, "2026-W47");
  assert.deepEqual(w.reached({ caps, spend: { week: 6 } }), []);
  now = "2026-11-23T00:00:00Z";
  assert.equal(w.reached({ caps, spend: { week: 6 } })[0].period, "2026-W48");
  const prior = createCapWarner({ fractions: [0.5], events: [{ event: "cap_warning", scope: "week", fraction: 0.5, period: "2026-W48" }], now: () => new Date(now) });
  assert.deepEqual(prior.reached({ caps, spend: { week: 6 } }), []);
  assert.equal(currentWarnings({ caps, spend: { week: 5 }, fractions: [0.5] })[0].scope, "week");
});

test("AC5 preflight: a $3 worst case with $2 week remaining is refused as preflight_estimate scope week", () => {
  const cap = createCapEngine({ caps: { week: 10 }, history: [{ ts: "2026-11-16T01:00:00Z", cost_usd: 8 }], now: at("2026-11-17T00:00:00Z") });
  const refused = checkEstimate(cap, { ok: true, estimate_usd: 3, model: "m" });
  assert.equal(refused.reason, "preflight_estimate");
  assert.equal(refused.scope, "week");
  assert.equal(refused.remaining_usd.week, 2);
  assert.equal(checkEstimate(cap, { ok: true, estimate_usd: 1.5, model: "m" }), null);
});

test("run summary includes caps.week; Action output week-spent-usd (empty on unknown)", () => {
  const s = buildRunSummary({ run_id: "r", started_at: "a", ended_at: "b", caps: { week: 25 }, spend: { week: 1.25 } });
  assert.deepEqual(s.caps.week, { limit_usd: 25, spent_usd: 1.25 });
  assert.equal(buildRunSummary({ run_id: "r", started_at: "a", ended_at: "b", caps: {}, spend: { week: 1 } }).caps.week, undefined);
  assert.ok(OUTPUT_NAMES.includes("week-spent-usd"));
  assert.equal(checkOutputs({ ok: true, unknown_cost_count: 0, receipt_count: 1, spend: { week: 1.5 } })["week-spent-usd"], "1.5");
  assert.equal(checkOutputs({ ok: true, unknown_cost_count: 1, receipt_count: 1, spend: { week: 1.5 } })["week-spent-usd"], "");
});

test("AC6 action.yml passes week-cap as --week-cap; fleet caps.week min-merges with the local flag", () => {
  const yml = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(yml, /^  week-cap:$/m);
  assert.match(yml, /COSTCAP_WEEK_CAP: \$\{\{ inputs\.week-cap \}\}/);
  assert.match(yml, /args\+=\(--week-cap "\$COSTCAP_WEEK_CAP"\)/);
  assert.equal(resolvePolicy({ local: { week: 8 }, lastKnown: { version: 1, caps: { week: 5 } } }).caps.week, 5);
  assert.equal(resolvePolicy({ local: { week: 3 }, lastKnown: { version: 1, caps: { week: 5 } } }).caps.week, 3);
});

test("AC6 enrolled check: cached fleet caps.week 5 beats local --week-cap 8", () => {
  const dir = tmp(); const r = path.join(dir, "r.jsonl"); const e = path.join(dir, "enrollment.json");
  writeFileSync(r, JSON.stringify({ ts: new Date().toISOString(), cost_usd: 6 }) + "\n");
  writeFileSync(e, JSON.stringify({ url: "http://127.0.0.1:9", agentId: "a", token: "t", policy: { version: 1, caps: { week: 5 }, killed: false }, syncedIds: [] }), { mode: 0o600 });
  const j = guardedBudgetStatus({ receiptsPath: r, enrollmentPath: e, caps: { week: 8 } });
  assert.equal(j.ok, false);
  assert.equal(j.hit.scope, "week");
  assert.equal(j.hit.cap, 5);
});

function mondayUtc() {
  const d = new Date();
  const back = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

async function wrapWeek(t, seedTs) {
  let hits = 0;
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => { hits += 1; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 10 } })); });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const receipts = path.join(tmp(), "r.jsonl");
  writeFileSync(receipts, JSON.stringify({ id: "seed", ts: new Date(seedTs).toISOString(), provider: "openai", path: "/chat/completions", cost_usd: 1 }) + "\n");
  const script = `const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions",{method:"POST",body:JSON.stringify({model:"gpt-4o-mini"})});
    console.log(JSON.stringify({ status: r.status, retry: r.headers.get("retry-after"), body: await r.json() }));`;
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--week-cap", "1", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", () => resolve(out));
  });
  const line = res.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").find((l) => l.startsWith("{"));
  const ledger = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { ...JSON.parse(line), hits, ledger, receipts };
}

test("AC4 e2e: wrap --week-cap 1 refuses with $1 at this Monday 00:00:01 UTC; check agrees", async (t) => {
  const r = await wrapWeek(t, mondayUtc() + 1000);
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
  assert.equal(r.body.error.type, "budget_exceeded");
  assert.equal(r.body.error.scope, "week");
  assert.equal(r.retry, null);
  assert.equal(r.ledger.find((x) => x.blocked).scope, "week");
  const chk = spawnSync(process.execPath, ["src/cli.js", "check", "--week-cap", "1", "--receipts", r.receipts], { encoding: "utf8" });
  assert.equal(chk.status, 1);
  assert.equal(JSON.parse(chk.stdout).hit.scope, "week");
});

test("AC4 e2e: the same $1 stamped 1 s before this Monday is last week; wrap forwards", async (t) => {
  const r = await wrapWeek(t, mondayUtc() - 1000);
  assert.equal(r.status, 200);
  assert.equal(r.hits, 1);
});

test("shared ledger: a sibling wrapper's receipt counts toward this wrapper's week cap", () => {
  const cap = createCapEngine({ caps: { week: 2 }, now: at("2026-11-18T00:00:00Z") });
  cap.record({ ts: "2026-11-17T00:00:00Z", cost_usd: 2 }, { external: true });
  assert.equal(cap.spend().run, 0);
  assert.equal(cap.check().scope, "week");
});

test("utcWeekLabel matches periodKey('week') across boundaries", async () => {
  const { utcWeekLabel, periodKey } = await import("../src/period.js");
  for (const iso of ["2026-11-15T23:30:00Z", "2026-11-16T00:30:00Z", "2027-01-03T23:59:59Z", "2027-01-04T00:00:00Z", "2024-12-30T00:00:00Z", "2020-12-31T12:00:00Z"]) assert.equal(utcWeekLabel(Date.parse(iso)), periodKey("week", Date.parse(iso)), iso);
});
