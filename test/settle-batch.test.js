// #176: hosted/shared settle of a batch_pending receipt counts its cost once and
// never clears a different receipt's unknown; fleet and shared paths share one helper.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapEngine } from "../src/cap.js";
import { createAgentBudgets } from "../src/agent-budget.js";
import { createSettler } from "../src/settle.js";
import { startMeteringProxy } from "../src/proxy.js";
import { mockUpstream } from "./support/batch.js";

const ts = new Date().toISOString();
const batch = { id: "r1", ts, cost_usd: null, reason: "batch_pending", batch_id: "msgbatch_01", agent_id: "a1", run_id: "run" };
const unknown = { id: "r2", ts, cost_usd: null, reason: "usage_unavailable", agent_id: "a1", run_id: "run" };

// AC5: the fleet entry point (settled receipt) and the shared-ledger entry point
// (settlement, receipt) behave identically.
const entries = {
  fleet: (settle, r, cost) => settle({ ...r, cost_usd: cost }),
  shared: (settle, r, cost) => settle({ event: "reconciliation", receipt_id: r.id, cost_usd: cost }, r),
};

for (const [name, call] of Object.entries(entries)) {
  test(`${name}: settled batch counts toward day cap without touching unknown (AC1)`, () => {
    const cap = createCapEngine({ caps: { day: 1 }, history: [batch] });
    const settle = createSettler({ cap: () => cap, agentBudgets: () => null, proxySettle: () => null });
    assert.equal(cap.check(), null);
    assert.equal(call(settle, batch, 5), true);
    const hit = cap.check();
    assert.equal(hit.scope, "day");
    assert.equal(hit.spent, 5);
    assert.equal(call(settle, batch, 5), false, "repeat settle is a no-op");
    assert.equal(cap.check().spent, 5);
  });

  test(`${name}: settling a batch leaves another receipt's unknown in place (AC2)`, () => {
    const cap = createCapEngine({ caps: { day: 100 }, history: [batch, unknown] });
    const settle = createSettler({ cap: () => cap, agentBudgets: () => null, proxySettle: () => null });
    assert.equal(cap.check().reason, "unreconciled_receipt");
    call(settle, batch, 5);
    assert.equal(cap.check().reason, "unreconciled_receipt");
    call(settle, unknown, 1);
    assert.equal(cap.check(), null);
  });

  test(`${name}: agent budget counts the settled batch once and proxy is told (AC4)`, () => {
    const cap = createCapEngine({ caps: {}, history: [batch] });
    const budgets = createAgentBudgets({ policy: { default: { run: 100 } }, history: [batch] });
    const told = [];
    const settle = createSettler({ cap: () => cap, agentBudgets: () => budgets, proxySettle: () => (r) => told.push(r) });
    call(settle, batch, 5);
    call(settle, batch, 5);
    assert.equal(budgets.spend({ agent_id: "a1", run_id: "run" }).run, 5);
    assert.deepEqual(told, [{ receipt_id: "r1", batch_id: "msgbatch_01" }]);
  });
}

test("invalid settlements are ignored", () => {
  const settle = createSettler({ cap: () => null, agentBudgets: () => null, proxySettle: () => null });
  for (const s of [null, { id: 1, cost_usd: 1 }, { id: "x", cost_usd: -1 }, { id: "x", cost_usd: NaN }, { id: "x" }]) assert.equal(settle(s), false);
});

test("proxy: after a hosted settle of batch B, a results read records nothing again (AC3)", async (t) => {
  const up = http.createServer(mockUpstream());
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-settle-")), "r.jsonl");
  const spent = [];
  const cap = createCapEngine({ caps: {}, history: [] });
  const recordingCap = { ...cap, record: (r, o) => { spent.push(r); return cap.record(r, o); } };
  const { server, port } = await startMeteringProxy({ upstreams: { anthropic: base }, receiptsPath, cap: recordingCap });
  t.after(() => { up.closeAllConnections(); up.close(); server.closeAllConnections(); server.close(); });
  const SONNET = { model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
  const body = JSON.stringify({ requests: ["a", "b"].map((custom_id) => ({ custom_id, params: SONNET })) });
  assert.equal((await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages/batches`, { method: "POST", body })).status, 200);
  const lines = () => readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const pend = lines()[0];
  // Hosted settle arrives with only the receipt id (no batch_id): still resolved.
  server.settle({ receipt_id: pend.id });
  const before = spent.filter((r) => r.cost_usd > 0).length;
  await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages/batches/msgbatch_01/results`);
  assert.equal(lines().filter((l) => l.event === "reconciliation").length, 0);
  assert.equal(spent.filter((r) => r.cost_usd > 0).length, before);
});
