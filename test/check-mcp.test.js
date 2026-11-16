import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkBudget } from "../src/check.js";
import { handleMcp } from "../src/mcp.js";
function ledger(costs) {
  const path = join(mkdtempSync(join(tmpdir(), "cc-check-")), "r.jsonl");
  writeFileSync(path, costs.map((cost_usd) => JSON.stringify({ ts: "2026-10-04T12:00:00Z", cost_usd })).join("\n"));
  return path;
}
test("CI budget checks fail closed for unknown, malformed or missing evidence", () => {
  assert.equal(checkBudget({ receiptsPath: ledger([0.1]), caps: { run: 1 } }).ok, true);
  assert.equal(checkBudget({ receiptsPath: ledger([0.1]), caps: { run: 0.1 } }).ok, false);
  const unknown = checkBudget({ receiptsPath: ledger([1.5, null]), caps: { run: 10 }, now: () => new Date("2026-10-04T18:00:00Z") });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.unknown_cost_count, 1);
  assert.equal(unknown.unknown_cost_counted_as_zero, false);
  assert.equal(unknown.total_usd, 1.5);
  assert.equal(unknown.spend.unknown, 1);
  assert.equal(unknown.spend.day, 1.5);
  assert.throws(() => checkBudget({ receiptsPath: ledger([]) }), /No receipts/);
  assert.throws(() => checkBudget({ receiptsPath: ledger([-1]) }), /Invalid/);
});
test("check command exits 0 under, 1 at cap, 2 for absent evidence", () => {
  const path = ledger([0.1]);
  const run = (cap) => spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", path, "--cap", cap]);
  assert.equal(run("1").status, 0);
  assert.equal(run("0.1").status, 1);
  assert.equal(run("bad").status, 2);
});
test("MCP supports initialize, tool listing and read-only budget status", () => {
  const options = { receiptsPath: ledger([0.1]), caps: { run: 1 } };
  const call = (method, params) => handleMcp({ jsonrpc: "2.0", id: 1, method, params }, options);
  assert.equal(call("initialize").result.serverInfo.name, "costcap");
  assert.equal(call("tools/list").result.tools[0].name, "budget_status");
  assert.equal(JSON.parse(call("tools/call", { name: "budget_status" }).result.content[0].text).ok, true);
  assert.equal(call("tools/call", { name: "kill" }).error.code, -32601);
  assert.equal(handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, options), null);
});
test("composite action runs the local check command", () => {
  const text = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(text, /src\/cli\.js/);
  assert.match(text, /check/);
  assert.match(text, /day-cap/);
  assert.match(text, /month-cap/);
});
test("MCP stdio handles malformed lines without crashing", () => {
  const path = ledger([0.1]);
  const result = spawnSync(process.execPath, ["src/cli.js", "mcp", "--receipts", path, "--cap", "1"], { input: 'bad\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n', encoding: "utf8" });
  assert.equal(result.status, 0);
  const replies = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies[0].error.code, -32700);
  assert.deepEqual(replies[1].result, {});
});

test("#144 host kill: mcp budget_status, agent-status and check return killed/host ahead of budget", () => {
  const d = mkdtempSync(join(tmpdir(), "cc-hostk-")), home = join(d, "home");
  const env = { ...process.env, COSTCAP_HOME: home };
  const receipts = ledger([0.1]);
  const policy = join(d, "policy.json");
  writeFileSync(policy, JSON.stringify({ agents: { a1: { day: 100 } } }));
  const run = (...a) => spawnSync(process.execPath, ["src/cli.js", ...a], { encoding: "utf8", env, input: a[0] === "mcp" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "budget_status" } }) + "\n" : undefined });
  // Not killed: check passes.
  assert.equal(run("check", "--receipts", receipts, "--cap", "1").status, 0);
  assert.equal(run("kill", "--host", "stop all", "--receipts", join(d, "ev.jsonl")).status, 0);
  const chk = run("check", "--receipts", receipts, "--cap", "1");
  assert.equal(chk.status, 1);
  const cj = JSON.parse(chk.stdout);
  assert.deepEqual([cj.verdict, cj.kill.kill_scope, cj.kill.kill_file], ["killed", "host", join(home, "KILL")]);
  const mcp = run("mcp", "--receipts", receipts, "--cap", "1", "--kill-file", join(d, "proj", "KILL"));
  const mj = JSON.parse(JSON.parse(mcp.stdout.trim().split("\n")[0]).result.content[0].text);
  assert.deepEqual([mj.verdict, mj.kill.kill_scope], ["killed", "host"]);
  const ag = run("agent-status", "--agent", "a1", "--policy", policy, "--receipts", receipts);
  const aj = JSON.parse(ag.stdout);
  assert.deepEqual([aj.verdict, aj.kill.kill_scope, aj.agent_id], ["killed", "host", "a1"]);
  run("resume", "--host", "--receipts", join(d, "ev.jsonl"));
  assert.equal(run("check", "--receipts", receipts, "--cap", "1").status, 0);
});
