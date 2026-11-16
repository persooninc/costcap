// Issue #140: MCP budget tools and agent-status honour the kill switch and the
// cached fleet/team caps exactly as the wrapper does, and stay read-only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { handleMcp } from "../src/mcp.js";
import { checkBudget, guardedBudgetStatus, guardedAgentStatus } from "../src/check.js";

const NOW = new Date().toISOString();
function setup({ costs = [0.5], enrollment } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cc-guard-"));
  const receiptsPath = join(dir, "r.jsonl");
  writeFileSync(receiptsPath, costs.map((cost_usd, i) => JSON.stringify({ id: `r${i}`, ts: NOW, agent_id: "a1", cost_usd })).join("\n") + "\n");
  let enrollmentPath;
  if (enrollment) {
    enrollmentPath = join(dir, "enrollment.json");
    writeFileSync(enrollmentPath, JSON.stringify({ url: "https://fleet.example.test", token: "t", agentId: "a1", syncedIds: [], ...enrollment }));
  }
  return { dir, receiptsPath, enrollmentPath, killFile: join(dir, "KILL") };
}
const snapshot = (dir) => readdirSync(dir).map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}:${readFileSync(join(dir, f), "utf8")}`).join("|");
const tool = (options, name, args) => JSON.parse(handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, options).result.content[0].text);
const policy = { agents: { a1: { day: 100 } } };

test("kill file present gives verdict killed, ahead of budget verdicts", () => {
  const s = setup();
  writeFileSync(s.killFile, "stop now\n");
  const r = tool({ ...s, caps: { run: 100 } }, "budget_status");
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "killed");
  assert.equal(r.kill.kill_file, s.killFile);
  assert.equal(r.kill.note, "stop now");
  const a = tool({ ...s, policy }, "agent_budget_status", { agent_id: "a1" });
  assert.equal(a.verdict, "killed");
  assert.equal(a.agent_id, "a1");
});

test("cached fleet kill or revoked credentials give killed", () => {
  for (const extra of [{ policy: { version: 1, caps: {}, killed: true } }, { policy: { version: 1, caps: {} }, revoked: true }]) {
    const s = setup({ enrollment: extra });
    assert.equal(guardedBudgetStatus({ ...s, caps: {} }).verdict, "killed");
  }
});

test("fleet day cap tighter than the local one gives budget_exceeded", () => {
  const s = setup({ costs: [3], enrollment: { policy: { version: 1, caps: { day: 2 } } } });
  const r = tool({ ...s, caps: { day: 10 } }, "budget_status");
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "budget_exceeded");
  assert.equal(r.hit.cap, 2);
  const ok = setup({ costs: [1], enrollment: { policy: { version: 1, caps: { day: 2 } } } });
  assert.equal(guardedBudgetStatus({ ...ok, caps: { day: 10 } }).ok, true);
});

test("cached fleet per-agent spend over the fleet cap gives budget_exceeded (agent check first)", () => {
  const s = setup({ costs: [0.5], enrollment: { syncedIds: ["r0"], policy: { version: 1, caps: { day: 5 } }, agentSpend: { spent: { day: 6, month: 6 }, unknown: 0, as_of: NOW } } });
  const r = guardedAgentStatus({ ...s, policy, agent_id: "a1" });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "budget_exceeded");
  assert.equal(r.hit.fleet, true);
});

test("team cap gives a team: scope; unsettled team spend is accounting_unavailable", () => {
  const team = { name: "ops", caps: { day: 4 }, spent: { day: 4.5, month: 4.5 }, unknown: 0, as_of: NOW };
  const s = setup({ enrollment: { syncedIds: ["r0"], policy: { version: 1, caps: {} }, team } });
  const r = tool({ ...s, caps: {} }, "budget_status");
  assert.equal(r.verdict, "budget_exceeded");
  assert.equal(r.scope, "team:ops:day");
  const a = guardedAgentStatus({ ...s, policy, agent_id: "a1" });
  assert.equal(a.scope, "team:ops:day");
  const u = setup({ enrollment: { syncedIds: ["r0"], policy: { version: 1, caps: {} }, team: { ...team, spent: { day: 0, month: 0 }, unknown: 1 } } });
  const ur = guardedBudgetStatus({ ...u, caps: {} });
  assert.equal(ur.ok, false);
  assert.equal(ur.verdict, "accounting_unavailable");
});

test("no enrollment and no kill file: output byte-identical to the plain check", () => {
  const s = setup();
  const now = () => new Date(NOW);
  const opts = { receiptsPath: s.receiptsPath, caps: { run: 1 }, now };
  assert.equal(JSON.stringify(guardedBudgetStatus({ ...opts, killFile: s.killFile })), JSON.stringify(checkBudget(opts)));
  assert.equal(JSON.stringify(tool({ ...opts, killFile: s.killFile }, "budget_status")), JSON.stringify(checkBudget(opts)));
});

test("read-only: no file written; tools/list unchanged", () => {
  const s = setup({ enrollment: { policy: { version: 1, caps: { day: 2 } }, team: { name: "ops", caps: { day: 1 }, spent: { day: 2, month: 2 }, unknown: 0, as_of: NOW } } });
  const before = snapshot(s.dir);
  tool({ ...s, caps: {} }, "budget_status");
  guardedAgentStatus({ ...s, policy, agent_id: "a1" });
  assert.equal(snapshot(s.dir), before);
  const list = (o) => JSON.stringify(handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, o));
  assert.equal(list({ ...s }), list({}));
});

test("regression: agent-status CLI accepts --kill-file and --enrollment", () => {
  const s = setup({ enrollment: { policy: { version: 1, caps: { day: 0.1 } } } });
  const policyPath = join(s.dir, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  const run = (...extra) => spawnSync(process.execPath, ["src/cli.js", "agent-status", "--receipts", s.receiptsPath, "--policy", policyPath, "--agent", "a1", ...extra], { encoding: "utf8" });
  assert.equal(run("--kill-file", s.killFile).status, 0);
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(s.killFile, "");
  const killed = run("--kill-file", s.killFile);
  assert.equal(killed.status, 1);
  assert.equal(JSON.parse(killed.stdout).verdict, "killed");
  const mcp = spawnSync(process.execPath, ["src/cli.js", "mcp", "--receipts", s.receiptsPath, "--kill-file", s.killFile, "--enrollment", s.enrollmentPath],
    { input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "budget_status" } }) + "\n", encoding: "utf8" });
  assert.equal(JSON.parse(JSON.parse(mcp.stdout).result.content[0].text).verdict, "killed");
});
