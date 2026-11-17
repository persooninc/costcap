import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAgentPolicy, budgetRemaining, createAgentBudgets } from "../src/agent-budget.js";

const now = () => new Date("2026-11-15T12:00:00Z");
const r = (id, agent_id, cost_usd, extra = {}) => ({ id, agent_id, cost_usd, ts: "2026-11-15T10:00:00Z", run_id: `run-${agent_id}`, ...extra });
const teams = { ops: { agents: ["a", "b"], day: 1, month: 5 } };

test("team cap blocks an agent whose own cap still has room", () => {
  const b = createAgentBudgets({ policy: { default: { day: 10 }, teams }, history: [r(1, "a", 0.6), r(2, "b", 0.5)], now });
  const v = b.check({ agent_id: "a", run_id: "x" });
  assert.equal(v.verdict, "budget_exceeded");
  assert.equal(v.team, "ops");
  assert.equal(v.scope, "day");
  assert.equal(v.spent_usd, 1.1);
  assert.deepEqual(budgetRemaining(b, { agent_id: "a", run_id: "x" }), { run_usd: null, day_usd: 0, month_usd: 3.9, steps: null });
});

test("own cap still wins first and non-members are untouched", () => {
  const b = createAgentBudgets({ policy: { agents: { a: { day: 0.5 }, c: { day: 1 } }, teams }, history: [r(1, "a", 0.6), r(2, "b", 0.5), r(3, "c", 0.2)], now });
  const v = b.check({ agent_id: "a" });
  assert.equal(v.team, undefined);
  assert.equal(v.cap_usd, 0.5);
  assert.equal(b.check({ agent_id: "c" }), null);
  assert.equal(b.teamSpend({ agent_id: "c" }), null);
});

test("team membership alone is a budget policy; under cap passes", () => {
  const b = createAgentBudgets({ policy: { teams }, history: [r(1, "a", 0.2)], now });
  assert.equal(b.check({ agent_id: "b" }), null);
  assert.deepEqual(budgetRemaining(b, { agent_id: "b" }), { run_usd: null, day_usd: 0.8, month_usd: 4.8, steps: null });
  assert.equal(b.check({ agent_id: "z" }).verdict, "no_budget_policy");
  assert.equal(budgetRemaining(b, { agent_id: "z" }), null);
});

test("agent remainder is used when tighter than the team's", () => {
  const b = createAgentBudgets({ policy: { agents: { a: { day: 0.3, maxSteps: 5 } }, teams }, history: [r(1, "a", 0.1)], now });
  assert.deepEqual(budgetRemaining(b, { agent_id: "a", run_id: "run-a" }), { run_usd: null, day_usd: 0.2, month_usd: 4.9, steps: 4 });
});

test("a teammate's unknown cost is never counted as zero", () => {
  const b = createAgentBudgets({ policy: { teams }, history: [r(1, "b", null)], now });
  const v = b.check({ agent_id: "a" });
  assert.equal(v.verdict, "accounting_unavailable");
  assert.equal(v.team, "ops");
  assert.equal(v.unknown_receipts, 1);
});

test("team policy validation refuses bad shapes", () => {
  const bad = [
    { teams: { t: null } }, { teams: { t: [] } }, { teams: { t: { agents: ["a"], weekly: 1 } } },
    { teams: { t: { agents: ["a"], day: -1 } } }, { teams: { t: { agents: [] } } }, { teams: { t: { day: 1 } } },
    { teams: { t: { agents: [""] } } }, { teams: { t: { agents: [7] } } },
    { teams: { t: { agents: ["a"] }, u: { agents: ["a"] } } },
  ];
  for (const policy of bad) assert.throws(() => assertAgentPolicy(policy), undefined, JSON.stringify(policy));
  assert.ok(assertAgentPolicy({ teams }));
});

test("regression: agent-status CLI enforces a team cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "costcap-team-"));
  const policy = join(dir, "policy.json");
  const receipts = join(dir, "r.jsonl");
  const ts = new Date().toISOString();
  writeFileSync(policy, JSON.stringify({ teams: { ops: { agents: ["a", "b"], day: 1 } } }));
  writeFileSync(receipts, [r(1, "a", 0.6, { ts }), r(2, "b", 0.5, { ts })].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const run = (agent) => spawnSync(process.execPath, ["src/cli.js", "agent-status", "--receipts", receipts, "--policy", policy, "--agent", agent], { encoding: "utf8" });
  const blocked = run("a");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /"team":\s*"ops"/);
  writeFileSync(policy, JSON.stringify({ teams: { ops: { agents: ["a", "b"], day: 5 } } }));
  assert.equal(run("b").status, 0);
});

// #267: month-only entities start a new month clean; a week cap still sees last month's tail.
test("#267 previous-month unknown receipt refuses only entities that cap a week", async () => {
  const { hostedAgentVerdict } = await import("../src/hosted/agent-verdict.js");
  const { teamVerdict, agentSpendPolicy } = await import("../src/hosted/teams.js");
  const { orgBudgetVerdict } = await import("../src/hosted/org-budget.js");
  const nowMs = Date.parse("2026-12-02T10:00:00Z");
  const receipts = [{ id: "u", ts: "2026-11-30T10:00:00Z", cost_usd: null }];
  const agent = (caps) => ({ id: "a1", policy: { version: 1, caps } });
  // AC1: month/day only → ok everywhere.
  assert.equal(hostedAgentVerdict({ agent: agent({ month: 100 }), receipts, nowMs }).verdict, "ok");
  assert.equal(hostedAgentVerdict({ agent: agent({ day: 5 }), receipts, nowMs }).verdict, "ok");
  const team = teamVerdict({ team: { name: "t", agents: ["a1"], month: 100 }, receiptsByAgent: { a1: receipts }, nowMs });
  assert.equal(team.verdict, "ok");
  assert.equal(team.spend.unknown_count, 0);
  assert.equal(orgBudgetVerdict({ budget: { month: 100 }, agentIds: ["a1"], receiptsByAgent: { a1: receipts }, nowMs }).verdict, "ok");
  assert.equal(hostedAgentVerdict({ agent: agent({ month: 100 }), receipts, nowMs, team }).verdict, "ok");
  assert.equal(agentSpendPolicy(receipts, nowMs, null, null, { week: false }).unknown, 0);
  // AC2: a week cap on the agent or its team still refuses (#261 AC6).
  const wk = hostedAgentVerdict({ agent: agent({ month: 100, week: 50 }), receipts, nowMs });
  assert.equal(wk.verdict, "accounting_unavailable");
  const teamWk = teamVerdict({ team: { name: "t", agents: ["a1"], week: 50 }, receiptsByAgent: { a1: receipts }, nowMs });
  assert.equal(teamWk.verdict, "accounting_unavailable");
  assert.equal(teamWk.spend.unknown_count, 1);
  assert.equal(hostedAgentVerdict({ agent: agent({ month: 100 }), receipts, nowMs, team: teamWk }).verdict, "accounting_unavailable");
  assert.equal(agentSpendPolicy(receipts, nowMs, null, null, { week: true }).unknown, 1);
  // Same-month unknown still refuses a month cap.
  assert.equal(hostedAgentVerdict({ agent: agent({ month: 100 }), receipts: [{ id: "u2", ts: "2026-12-01T10:00:00Z", cost_usd: null }], nowMs }).verdict, "accounting_unavailable");
});
