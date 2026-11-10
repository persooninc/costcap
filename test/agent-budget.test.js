import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetRemaining, createAgentBudgets, UNKNOWN_AGENT } from "../src/agent-budget.js";
import { createKillCheck } from "../src/kill.js";
import { agentBudgetStatus } from "../src/check.js";
import { handleMcp } from "../src/mcp.js";
import { startMeteringProxy } from "../src/proxy.js";

const NOW = new Date("2026-03-15T12:00:00Z");
const now = () => NOW;
const who = { agent_id: "a1", run_id: "r1" };
let n = 0;
const receipt = (over = {}) => ({ id: `id-${n++}`, ts: NOW.toISOString(), ...who, cost_usd: 1, ...over });
const tmp = () => mkdtempSync(join(tmpdir(), "cc-agent-"));

test("no policy entry and no default is refused", () => {
  const b = createAgentBudgets({ policy: { agents: { other: { run: 1 } } }, now });
  assert.equal(b.check(who).verdict, "no_budget_policy");
});

test("agent entries override the default and spend is isolated per agent", () => {
  const b = createAgentBudgets({ policy: { default: { run: 10 }, agents: { a1: { run: 2 } } }, now });
  b.record(receipt({ cost_usd: 2 }));
  assert.deepEqual(b.check(who), { verdict: "budget_exceeded", reason: "budget_exceeded", scope: "run", cap_usd: 2, spent_usd: 2, ...who });
  assert.equal(b.check({ agent_id: "a2", run_id: "r1" }), null);
});

test("day and month caps span runs, and last month does not count", () => {
  const history = [receipt({ run_id: "old", ts: "2026-03-15T01:00:00Z", cost_usd: 3 }), receipt({ run_id: "old", ts: "2026-03-01T01:00:00Z", cost_usd: 4 }), receipt({ run_id: "old", ts: "2026-02-20T01:00:00Z", cost_usd: 100 })];
  const hit = (limits) => createAgentBudgets({ policy: { default: limits }, history, now }).check(who);
  assert.equal(hit({ run: 1 }), null);
  assert.equal(hit({ day: 3 }).scope, "day");
  assert.equal(hit({ month: 7 }).spent_usd, 7);
  assert.equal(hit({ month: 8 }), null);
});

test("step budget opens the breaker, per run, and blocked calls do not count", () => {
  const b = createAgentBudgets({ policy: { default: { maxSteps: 2 } }, now });
  b.record(receipt({ cost_usd: 0 }));
  b.record(receipt({ cost_usd: 0, blocked: true, reason: "spiral_detected" }));
  assert.equal(b.check(who), null);
  b.record(receipt({ cost_usd: 0 }));
  assert.deepEqual(b.check(who), { verdict: "breaker_open", reason: "step_budget", steps: 2, max_steps: 2, ...who });
  assert.equal(b.check({ agent_id: "a1", run_id: "r2" }), null);
});

test("unknown cost fails closed for that agent only", () => {
  const b = createAgentBudgets({ policy: { default: { run: 100 } }, history: [receipt({ cost_usd: null })], now });
  assert.equal(b.check(who).verdict, "accounting_unavailable");
  assert.equal(b.check({ agent_id: "a2", run_id: "r" }), null);
});

test("receipts are idempotent, and bad history or policy is rejected", () => {
  const b = createAgentBudgets({ policy: { default: { run: 5 } }, now });
  b.record(receipt({ id: "same", cost_usd: 2 }));
  b.record(receipt({ id: "same", cost_usd: 2 }));
  assert.equal(b.spend(who).run, 2);
  assert.throws(() => createAgentBudgets({ history: [receipt({ cost_usd: -1 })] }), /reconcile/);
  assert.throws(() => createAgentBudgets({ policy: { default: { maxSteps: 0 } } }), /maxSteps/);
  assert.throws(() => createAgentBudgets({ policy: { default: { maxStep: 5 } } }), /Unknown limit maxStep/);
  assert.throws(() => createAgentBudgets({ policy: { agent: {} } }), /Unknown agent policy key/);
  assert.throws(() => createAgentBudgets({ policy: [] }), /must be an object/);
});

test("unattributed receipts land in the unknown bucket", () => {
  const b = createAgentBudgets({ policy: { default: { day: 1 } }, now });
  b.record({ id: "x", ts: NOW.toISOString(), cost_usd: 1 });
  assert.equal(b.check({ agent_id: UNKNOWN_AGENT }).verdict, "budget_exceeded");
  assert.equal(b.check().verdict, "budget_exceeded");
});

test("remaining budget is reported, with null for uncapped scopes", () => {
  const b = createAgentBudgets({ policy: { default: { run: 5, maxSteps: 3 } }, now });
  b.record(receipt({ cost_usd: 1.5 }));
  assert.deepEqual(budgetRemaining(b, who), { run_usd: 3.5, day_usd: null, month_usd: null, steps: 2 });
  assert.equal(budgetRemaining(createAgentBudgets({ now }), who), null);
});

test("kill check fails closed when the kill state cannot be read", () => {
  const file = join(tmp(), "file");
  writeFileSync(file, "");
  const hit = createKillCheck(join(file, "KILL"))();
  assert.equal(hit.reason, "killed");
  assert.match(hit.note, /kill state unknown/);
  assert.equal(createKillCheck(join(tmp(), "KILL"))(), null);
});

function ledger(rows) {
  const path = join(tmp(), "r.jsonl");
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
  return path;
}

test("agent status and MCP give the same budget-exceeded verdict", () => {
  const options = { receiptsPath: ledger([receipt({ ts: new Date().toISOString() })]), policy: { default: { run: 1 } } };
  const status = agentBudgetStatus({ ...options, ...who });
  assert.equal(status.ok, false);
  assert.equal(status.verdict, "budget_exceeded");
  assert.equal(status.budget_remaining.run_usd, 0);
  const call = (args) => handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_budget_status", arguments: args } }, options).result;
  assert.deepEqual(JSON.parse(call(who).content[0].text), status);
  assert.equal(call({}).isError, true);
  const noPolicy = handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_budget_status", arguments: who } }, {}).result;
  assert.equal(noPolicy.isError, true);
  assert.equal(JSON.parse(call({ agent_id: "fresh" }).content[0].text).verdict, "allow");
});

test("the proxy tags receipts and refuses over-budget agents before the upstream call", async (t) => {
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => { up.closeAllConnections(); up.close(); });
  const receiptsPath = join(tmp(), "r.jsonl");
  const agentBudgets = createAgentBudgets({ policy: { default: { maxSteps: 1 } } });
  const { server, port } = await startMeteringProxy({ receiptsPath, who, agentBudgets, upstreams: { openai: `http://127.0.0.1:${up.address().port}` } });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = () => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini" }) });
  assert.equal((await post()).status, 200);
  const refused = await post();
  assert.equal(refused.status, 429);
  const body = await refused.json();
  assert.equal(body.error, "breaker_open");
  assert.equal(body.max_steps, 1);
  assert.equal(body.agent_id, "a1");
  assert.equal(hits, 1);
  const rows = readFileSync(receiptsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => [r.agent_id, r.run_id, Boolean(r.blocked)]), [["a1", "r1", false], ["a1", "r1", true]]);
});

test("wrap enforces a policy and agent-status exits by verdict", async (t) => {
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => { up.closeAllConnections(); up.close(); });
  const dir = tmp();
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({ agents: { bot: { maxSteps: 1 } } }));
  const receipts = join(dir, "r.jsonl");
  const script = "for (let i=0;i<2;i++){const r=await fetch(process.env.OPENAI_BASE_URL+'/chat/completions',{method:'POST',body:JSON.stringify({model:'gpt-4o-mini',n:i})});console.log(r.status);}";
  const base = ["src/cli.js", "wrap", "--receipts", receipts, "--kill-file", join(dir, "KILL"), "--policy", policy];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...base, "--agent", "bot", "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.address().port}` } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("exit", () => resolve(out));
  });
  assert.deepEqual(output.trim().split("\n"), ["200", "429"]);
  assert.equal(hits, 1);
  const rows = readFileSync(receipts, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows[0].agent_id, "bot");
  assert.ok(rows[0].run_id);
  const status = (...extra) => spawnSync(process.execPath, ["src/cli.js", "agent-status", "--receipts", receipts, "--policy", policy, ...extra], { encoding: "utf8" });
  assert.equal(status("--agent", "bot", "--run-id", rows[0].run_id).status, 1);
  assert.equal(status("--agent", "bot", "--run-id", "new-run").status, 0);
  assert.equal(status("--agent", "stranger").status, 1);
  assert.equal(status().status, 2);
  assert.equal(spawnSync(process.execPath, [...base, "--", "true"], { encoding: "utf8" }).status, 2);
});
