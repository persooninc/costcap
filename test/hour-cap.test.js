// costcap#172: rolling 60-minute hour cap (unit + e2e regression).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCapEngine, budgetExceededBody } from "../src/cap.js";
import { createAgentBudgets, assertAgentPolicy, budgetRemaining } from "../src/agent-budget.js";
import { validatePolicy, resolvePolicy } from "../src/hosted/policy.js";
import { preflightCheck } from "../src/preflight.js";
import { parseWrapArgs } from "../src/cli.js";

const T0 = Date.parse("2026-11-16T12:00:00Z");
const ago = (min) => new Date(T0 - min * 60_000).toISOString();

test("hour cap: blocks with retry_after_s, then the window rolls without latching", () => {
  let nowMs = T0;
  const cap = createCapEngine({ caps: { hour: 1 }, history: [{ ts: ago(30), cost_usd: 1 }], now: () => new Date(nowMs) });
  const hit = cap.check();
  assert.equal(hit.scope, "hour");
  assert.equal(hit.spent, 1);
  assert.equal(hit.retry_after_s, 1800);
  assert.equal(budgetExceededBody(hit).error.retry_after_s, 1800);
  assert.equal(cap.remaining().hour, 0);
  nowMs = T0 + 30 * 60_000 - 1000;
  assert.equal(cap.check().scope, "hour");
  nowMs = T0 + 30 * 60_000; // exactly 60 min after the receipt: aged out
  assert.equal(cap.check(), null);
  assert.equal(cap.spend().hour, 0);
});

test("hour cap: boundary at exactly 60 minutes and receipts 61 min old", () => {
  const now = () => new Date(T0);
  assert.equal(createCapEngine({ caps: { hour: 1 }, history: [{ ts: ago(60), cost_usd: 1 }], now }).check(), null);
  assert.equal(createCapEngine({ caps: { hour: 1 }, history: [{ ts: ago(61), cost_usd: 1 }], now }).check(), null);
  assert.equal(createCapEngine({ caps: { hour: 1 }, history: [{ ts: ago(59.99), cost_usd: 1 }], now }).check().scope, "hour");
});

test("hour cap: retry_after_s waits only until enough spend ages out", () => {
  const history = [{ ts: ago(50), cost_usd: 0.5 }, { ts: ago(20), cost_usd: 0.5 }, { ts: ago(10), cost_usd: 0.5 }];
  const hit = createCapEngine({ caps: { hour: 1 }, history, now: () => new Date(T0) }).check();
  assert.equal(hit.spent, 1.5);
  assert.equal(hit.retry_after_s, 2400); // the 50-min-old 0.5 leaves 1.0 (still at cap); the 20-min-old one ages out in 40 min
  assert.equal(createCapEngine({ caps: { hour: 1.2 }, history, now: () => new Date(T0) }).check().retry_after_s, 600);
});

test("hour cap: remaining(), record and updateCaps validation", () => {
  const cap = createCapEngine({ caps: { hour: 2, day: 10 }, now: () => new Date(T0) });
  cap.record({ ts: ago(1), cost_usd: 0.5 });
  assert.deepEqual(cap.remaining(), { hour: 1.5, day: 9.5 });
  assert.throws(() => cap.updateCaps({ hour: 0 }), /Invalid updated caps/);
  assert.throws(() => createCapEngine({ caps: { hour: -1 } }), /Invalid hour cap/);
  cap.updateCaps({ hour: 0.5 });
  assert.equal(cap.check().scope, "hour");
});

test("hour cap: a settled receipt counts in the hour of its original ts; unknown blocks first", () => {
  const now = () => new Date(T0);
  const cap = createCapEngine({ caps: { hour: 1 }, history: [{ ts: ago(10), cost_usd: null }], now });
  assert.equal(cap.check().reason, "unreconciled_receipt");
  assert.equal(cap.settle({ ts: ago(10), cost_usd: 2 }), true);
  assert.equal(cap.check().scope, "hour");
  const old = createCapEngine({ caps: { hour: 1 }, history: [{ ts: ago(5), cost_usd: 0.2 }, { ts: ago(90), cost_usd: null }], now });
  assert.equal(old.settle({ ts: ago(90), cost_usd: 5 }), true);
  assert.equal(old.check(), null);
  assert.equal(old.spend().hour, 0.2);
  const pending = createCapEngine({ caps: { hour: 1 }, history: [{ ts: ago(5), cost_usd: null, reason: "batch_pending" }], now });
  assert.equal(pending.check(), null);
});

test("hour cap: check() stays fast on a 100k-receipt ledger", () => {
  const history = Array.from({ length: 100_000 }, (_, i) => ({ ts: new Date(T0 - (100_000 - i) * 1000).toISOString(), cost_usd: 0.0001 }));
  let nowMs = T0;
  const cap = createCapEngine({ caps: { hour: 1000 }, history, now: () => new Date(nowMs) });
  const start = process.hrtime.bigint();
  for (let i = 0; i < 20_000; i++) { nowMs += 50; cap.record({ ts: new Date(nowMs).toISOString(), cost_usd: 0.0001 }); assert.equal(cap.check(), null); }
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 2000);
  assert.ok(Math.abs(cap.spend().hour - (2600 * 0.0001 + 20_000 * 0.0001)) < 0.001);
});

test("agent policy: hour accepted on default, agents and teams; hour: 0 and 'hours' refused", () => {
  assertAgentPolicy({ default: { hour: 1 }, agents: { a: { hour: 2 } }, teams: { t: { hour: 3, agents: ["b"] } } });
  assert.throws(() => assertAgentPolicy({ default: { hour: 0 } }), /hour cap/);
  assert.throws(() => assertAgentPolicy({ default: { hours: 1 } }), /Unknown limit hours/);
  const b = createAgentBudgets({ policy: { default: { hour: 1 } }, history: [{ ts: ago(30), cost_usd: 1, agent_id: "a" }], now: () => new Date(T0) });
  assert.equal(b.check({ agent_id: "a" }).scope, "hour");
  assert.equal(budgetRemaining(b, { agent_id: "a", run_id: null }).hour_usd, 0);
  const late = createAgentBudgets({ policy: { default: { hour: 1 } }, history: [{ ts: ago(61), cost_usd: 1, agent_id: "a" }], now: () => new Date(T0) });
  assert.equal(late.check({ agent_id: "a" }), null);
  const team = createAgentBudgets({ policy: { teams: { t: { hour: 1, agents: ["a", "b"] } } }, history: [{ ts: ago(5), cost_usd: 1, agent_id: "b" }], now: () => new Date(T0) });
  assert.equal(team.check({ agent_id: "a" }).team, "t");
});

test("fleet policy: caps.hour validated and min-merged with the local flag", () => {
  assert.deepEqual(validatePolicy({ version: 1, caps: { hour: 2 } }), []);
  assert.deepEqual(validatePolicy({ version: 1, caps: { hour: 0 } }), ["caps.hour must be a positive number"]);
  assert.equal(resolvePolicy({ local: { hour: 5 }, lastKnown: { version: 1, caps: { hour: 2 } } }).caps.hour, 2);
  assert.equal(resolvePolicy({ local: { hour: 2 }, lastKnown: { version: 1, caps: { hour: 5 } } }).caps.hour, 2);
  assert.equal(resolvePolicy({ lastKnown: { version: 1, caps: { hour: 2 } } }).caps.hour, 2);
  assert.throws(() => resolvePolicy({ local: { hour: 0 } }), /Invalid local cap hour/);
});

test("preflight: a worst case that doesn't fit the hour remaining is refused", () => {
  const cap = createCapEngine({ caps: { hour: 0.0001 }, now: () => new Date(T0) });
  const pf = preflightCheck(cap, "openai", Buffer.from(JSON.stringify({ model: "gpt-4o-mini", max_tokens: 4000, messages: [{ role: "user", content: "hi" }] })), "/chat/completions");
  assert.equal(pf.reason, "preflight_estimate");
  assert.equal(pf.scope, "hour");
});

test("parseWrapArgs reads --hour-cap", () => {
  assert.equal(parseWrapArgs(["--hour-cap", "1.5", "--", "x"]).caps.hour, 1.5);
  assert.throws(() => parseWrapArgs(["--hour-cap", "0", "--", "x"]), /positive number/);
});

async function wrapAgainstMock(t, seededMinutesAgo, flags = ["--hour-cap", "1"], seedExtra = {}) {
  let hits = 0;
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => { hits += 1; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 10 } })); });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-hour-"));
  const receipts = path.join(dir, "r.jsonl");
  writeFileSync(receipts, JSON.stringify({ id: "seed", ts: new Date(Date.now() - seededMinutesAgo * 60_000).toISOString(), provider: "openai", path: "/chat/completions", cost_usd: 1, ...seedExtra }) + "\n");
  const script = `
    const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions",{method:"POST",body:JSON.stringify({model:"gpt-4o-mini"})});
    const b = await r.json();
    console.log(JSON.stringify({ status: r.status, retry: r.headers.get("retry-after"), body: b }));`;
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...(typeof flags === "function" ? flags(dir) : flags), "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out }));
  });
  const line = res.out.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").find((l) => l.startsWith("{"));
  const ledger = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { ...JSON.parse(line), hits, ledger, receipts };
}

test("e2e: wrap --hour-cap 1 refuses with 429 + Retry-After when $1 was spent 30 min ago", async (t) => {
  const r = await wrapAgainstMock(t, 30);
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
  assert.equal(r.body.error.scope, "hour");
  assert.ok(Math.abs(r.body.error.retry_after_s - 1800) <= 5);
  assert.ok(Math.abs(Number(r.retry) - 1800) <= 5);
  const blocked = r.ledger.find((x) => x.blocked);
  assert.equal(blocked.cost_usd, 0);
  assert.equal(blocked.scope, "hour");
  const chk = spawnSync(process.execPath, ["src/cli.js", "check", "--hour-cap", "1", "--receipts", r.receipts], { encoding: "utf8" });
  assert.notEqual(chk.status, 0);
  const v = JSON.parse(chk.stdout);
  assert.equal(v.hit.scope, "hour");
  assert.deepEqual(v.hour, { spent_usd: 1, cap: 1, scope: "whole ledger, last 60 minutes" });
});

test("e2e: wrap --hour-cap 1 forwards when the $1 is 61 min old; check passes", async (t) => {
  const r = await wrapAgainstMock(t, 61);
  assert.equal(r.status, 200);
  assert.equal(r.hits, 1);
  const chk = spawnSync(process.execPath, ["src/cli.js", "check", "--hour-cap", "1", "--receipts", r.receipts], { encoding: "utf8" });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
});

test("#177 agent policy hour refusal carries retry_after_s (agent and pooled team)", () => {
  const b = createAgentBudgets({ policy: { default: { hour: 1 } }, history: [{ ts: ago(30), cost_usd: 1, agent_id: "a" }], now: () => new Date(T0) });
  const hit = b.check({ agent_id: "a" });
  assert.equal(hit.scope, "hour");
  assert.ok(Math.abs(hit.retry_after_s - 1800) <= 1);
  // Several receipts must age out: 0.6 (50 min ago) + 0.6 (20 min ago) vs cap 0.5 -> both, so ~40 min.
  const multi = createAgentBudgets({ policy: { default: { hour: 0.5 } }, history: [{ ts: ago(20), cost_usd: 0.6, agent_id: "a" }, { ts: ago(50), cost_usd: 0.6, agent_id: "a" }], now: () => new Date(T0) });
  assert.ok(Math.abs(multi.check({ agent_id: "a" }).retry_after_s - 2400) <= 1);
  const team = createAgentBudgets({ policy: { teams: { t: { hour: 1, agents: ["a", "b"] } } },
    history: [{ ts: ago(40), cost_usd: 0.5, agent_id: "a" }, { ts: ago(10), cost_usd: 0.5, agent_id: "b" }, { ts: ago(5), cost_usd: 5, agent_id: "z" }], now: () => new Date(T0) });
  const th = team.check({ agent_id: "a" });
  assert.equal(th.team, "t");
  assert.ok(Math.abs(th.retry_after_s - 1200) <= 1); // a's 40-min-old receipt ages out first
});

test("#177 run/day/month and step_budget agent refusals have no retry_after_s", () => {
  for (const scope of ["run", "day", "month"]) {
    const b = createAgentBudgets({ policy: { default: { [scope]: 1 } }, history: [{ ts: ago(1), cost_usd: 1, agent_id: "a", run_id: "r" }], now: () => new Date(T0) });
    const hit = b.check({ agent_id: "a", run_id: "r" });
    assert.equal(hit.scope, scope);
    assert.equal("retry_after_s" in hit, false);
  }
  const steps = createAgentBudgets({ policy: { default: { maxSteps: 1 } }, history: [{ ts: ago(1), cost_usd: 0, agent_id: "a", run_id: "r" }], now: () => new Date(T0) });
  const sh = steps.check({ agent_id: "a", run_id: "r" });
  assert.equal(sh.reason, "step_budget");
  assert.equal("retry_after_s" in sh, false);
});

const policyFlags = (policy) => (dir) => {
  const p = path.join(dir, "p.json");
  writeFileSync(p, JSON.stringify(policy));
  return ["--agent", "a", "--policy", p];
};

test("e2e #177: wrap --agent --policy hour refusal returns 429 + Retry-After", async (t) => {
  const r = await wrapAgainstMock(t, 30, policyFlags({ default: { hour: 1 } }), { agent_id: "a" });
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
  assert.equal(r.body.scope, "hour");
  assert.ok(Math.abs(r.body.retry_after_s - 1800) <= 5);
  assert.equal(r.retry, String(r.body.retry_after_s));
});

test("e2e #177: wrap --agent --policy day refusal has no Retry-After", async (t) => {
  const r = await wrapAgainstMock(t, 1, policyFlags({ default: { day: 1 } }), { agent_id: "a" });
  assert.equal(r.status, 429);
  assert.equal(r.body.scope, "day");
  assert.equal(r.retry, null);
  assert.equal("retry_after_s" in r.body, false);
});
