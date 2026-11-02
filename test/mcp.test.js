import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { handleMcp } from "../src/mcp.js";

function ledger(rows) {
  const path = join(mkdtempSync(join(tmpdir(), "cc-mcp-")), "r.jsonl");
  writeFileSync(path, rows.map((cost_usd) => JSON.stringify({ ts: new Date().toISOString(), cost_usd })).join("\n"));
  return path;
}
const call = (method, params, options = {}) => handleMcp({ jsonrpc: "2.0", id: 7, method, params }, options);

test("requests that are not JSON-RPC 2.0 are invalid", () => {
  const code = -32600;
  assert.equal(handleMcp({ id: 1, method: "ping" }, {}).error.code, code);
  assert.equal(handleMcp({ jsonrpc: "1.0", id: 1, method: "ping" }, {}).error.code, code);
  assert.equal(handleMcp({ jsonrpc: "2.0", id: 1, method: 5 }, {}).error.code, code);
  assert.equal(handleMcp({ jsonrpc: "2.0" }, {}).id, null);
});

test("notifications get no reply and replies echo the request id", () => {
  assert.equal(handleMcp({ jsonrpc: "2.0", method: "ping" }, {}), null);
  assert.deepEqual(call("ping"), { jsonrpc: "2.0", id: 7, result: {} });
  assert.equal(handleMcp({ jsonrpc: "2.0", id: 0, method: "ping" }, {}).id, 0);
});

test("the server exposes one read-only tool that takes no input", () => {
  const { tools } = call("tools/list").result;
  assert.deepEqual(tools.map((t) => t.name), ["budget_status"]);
  assert.deepEqual(tools[0].inputSchema, { type: "object", properties: {}, additionalProperties: false });
  assert.match(call("initialize").result.instructions, /Not a billing guarantee/);
});

test("unknown methods and tools are not found", () => {
  assert.equal(call("resources/list").error.code, -32601);
  assert.equal(call("tools/call", { name: "set_cap" }).error.code, -32601);
  assert.equal(call("tools/call").error.code, -32601);
});

test("budget_status reports over-cap and unknown cost as not ok", () => {
  const status = (rows, cap) => {
    const reply = call("tools/call", { name: "budget_status" }, { receiptsPath: ledger(rows), caps: { run: cap } }).result;
    assert.equal(reply.isError, false);
    return JSON.parse(reply.content[0].text);
  };
  assert.equal(status([0.5], 1).ok, true);
  assert.equal(status([1], 1).ok, false);
  const unknown = status([0.1, null], 1);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.unknown_cost_counted_as_zero, false);
});

test("missing evidence is a tool error, not a pass", () => {
  const reply = call("tools/call", { name: "budget_status" }, { receiptsPath: join(tmpdir(), "cc-mcp-missing.jsonl") }).result;
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /No receipts/);
});

test("stdio server answers line by line and exits at end of input", () => {
  const input = ['{"jsonrpc":"2.0","method":"ping"}', '{"jsonrpc":"2.0","id":1,"method":"ping"}', '{"jsonrpc":"2.0","id":2,"method":"nope"}'].join("\n") + "\n";
  const result = spawnSync(process.execPath, ["src/cli.js", "mcp", "--receipts", ledger([0.1]), "--cap", "1"], { input, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0);
  const replies = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((r) => r.id), [1, 2]);
  assert.equal(replies[1].error.code, -32601);
});
