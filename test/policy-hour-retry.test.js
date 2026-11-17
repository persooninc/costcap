// costcap#177: policy hour refusals (agent + team) carry retry_after_s and Retry-After.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentBudgets } from "../src/agent-budget.js";
import { createCapEngine } from "../src/cap.js";

const T0 = Date.parse("2026-11-16T12:00:00Z");
const ago = (min) => new Date(T0 - min * 60_000).toISOString();
const now = () => new Date(T0);

test("policy default hour: $1 spent 30 min ago refuses with retry_after_s 1800", () => {
  const b = createAgentBudgets({ policy: { default: { hour: 1 } }, history: [{ ts: ago(30), cost_usd: 1, agent_id: "a" }], now });
  const hit = b.check({ agent_id: "a" });
  assert.equal(hit.scope, "hour");
  assert.equal(hit.retry_after_s, 1800);
});

test("team hour: retry_after_s comes from pooled team spend", () => {
  const history = [{ ts: ago(50), cost_usd: 0.6, agent_id: "a" }, { ts: ago(20), cost_usd: 0.6, agent_id: "b" }, { ts: ago(5), cost_usd: 5, agent_id: "x" }];
  const b = createAgentBudgets({ policy: { teams: { t: { hour: 1, agents: ["a", "b"] } } }, history, now });
  const hit = b.check({ agent_id: "a" });
  assert.equal(hit.team, "t");
  assert.equal(hit.scope, "hour");
  assert.equal(hit.retry_after_s, 600); // a's 0.6 ages out in 10 min, leaving 0.6 < 1; x is not in the team
});

test("several receipts must age out: matches the --hour-cap engine exactly", () => {
  const rows = [{ ts: ago(50), cost_usd: 0.5 }, { ts: ago(20), cost_usd: 0.5 }, { ts: ago(10), cost_usd: 0.5 }];
  for (const cap of [1, 1.2]) {
    const engine = createCapEngine({ caps: { hour: cap }, history: rows, now }).check();
    const agent = createAgentBudgets({ policy: { agents: { a: { hour: cap } } }, history: rows.map((r, i) => ({ ...r, id: `r${i}`, agent_id: "a" })), now }).check({ agent_id: "a" });
    assert.equal(agent.retry_after_s, engine.retry_after_s);
  }
  const agent = createAgentBudgets({ policy: { agents: { a: { hour: 1 } } }, history: rows.map((r) => ({ ...r, agent_id: "a" })), now }).check({ agent_id: "a" });
  assert.equal(agent.retry_after_s, 2400);
});

test("non-hour policy refusals carry no retry_after_s", () => {
  const history = [{ ts: ago(5), cost_usd: 2, agent_id: "a", run_id: "r" }];
  for (const scope of ["run", "day", "month"]) {
    const hit = createAgentBudgets({ policy: { default: { [scope]: 1 } }, history, now }).check({ agent_id: "a", run_id: "r" });
    assert.equal(hit.scope, scope);
    assert.equal("retry_after_s" in hit, false);
  }
  const team = createAgentBudgets({ policy: { teams: { t: { day: 1, agents: ["a"] } } }, history, now }).check({ agent_id: "a" });
  assert.equal("retry_after_s" in team, false);
  const steps = createAgentBudgets({ policy: { default: { maxSteps: 1 } }, history, now }).check({ agent_id: "a", run_id: "r" });
  assert.equal(steps.reason, "step_budget");
  assert.equal("retry_after_s" in steps, false);
});

async function wrapWithPolicy(t, policy, seedTs = new Date(Date.now() - 30 * 60_000).toISOString()) {
  let hits = 0;
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => { hits += 1; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 10 } })); });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-phour-"));
  const receipts = path.join(dir, "r.jsonl");
  const policyPath = path.join(dir, "p.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  writeFileSync(receipts, JSON.stringify({ id: "seed", ts: seedTs, provider: "openai", path: "/chat/completions", cost_usd: 1, agent_id: "a", run_id: "old" }) + "\n");
  const script = `
    const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions",{method:"POST",body:JSON.stringify({model:"gpt-4o-mini"})});
    console.log(JSON.stringify({ status: r.status, retry: r.headers.get("retry-after"), body: await r.json() }));`;
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--agent", "a", "--policy", policyPath, "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let o = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", () => {});
    c.on("exit", () => resolve(o));
  });
  const line = out.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").find((l) => l.startsWith("{"));
  return { ...JSON.parse(line), hits };
}

test("e2e: wrap --agent a --policy hour refusal returns 429 with Retry-After = retry_after_s", async (t) => {
  const r = await wrapWithPolicy(t, { default: { hour: 1 } });
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
  assert.equal(r.body.scope, "hour");
  assert.ok(Math.abs(r.body.retry_after_s - 1800) <= 5);
  assert.equal(r.retry, String(r.body.retry_after_s));
});

test("e2e: a policy day refusal has no Retry-After", async (t) => {
  // Seeded "now", not now - 30 min: the seed must fall in today's UTC day even just after midnight.
  const r = await wrapWithPolicy(t, { default: { day: 1 } }, new Date().toISOString());
  assert.equal(r.status, 429);
  assert.equal(r.body.scope, "day");
  assert.equal(r.retry, null);
  assert.equal("retry_after_s" in r.body, false);
});
