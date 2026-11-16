// #179: proxy batch_results settles reach --policy agent and team budgets in-process.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createAgentBudgets } from "../src/agent-budget.js";
import { loadSettledReceipts } from "../src/cap.js";
import { ANTHROPIC_EXPECTED, GEMINI_EXPECTED, OPENAI_EXPECTED, mockUpstream } from "./support/batch.js";

const SONNET = { model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
const ABATCH = JSON.stringify({ requests: ["a", "b", "c"].map((custom_id) => ({ custom_id, params: SONNET })) });
const policyFor = (day) => ({ agents: { worker: { day }, mate: { day: 1000 } }, teams: { crew: { agents: ["worker", "mate"], day: 1000 } } });

async function setup(t, policy, upstreamOpts = {}) {
  const up = http.createServer((req, res) => { req.resume(); req.on("end", () => mockUpstream(upstreamOpts)(req, res)); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-batch-agent-")), "r.jsonl");
  const agentBudgets = createAgentBudgets({ policy });
  const p = await startMeteringProxy({ upstreams: { openai: base, anthropic: base, gemini: base }, receiptsPath, agentBudgets, who: { agent_id: "worker", run_id: "r1" } });
  t.after(() => { up.closeAllConnections(); up.close(); p.server.closeAllConnections(); p.server.close(); });
  return {
    receiptsPath, agentBudgets,
    call: (method, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body }),
    fresh: () => createAgentBudgets({ policy, history: loadSettledReceipts(receiptsPath) }),
  };
}

const round = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v.toFixed(6))]));

test("Anthropic batch_results counts against the agent day cap in-process and matches a fresh wrapper", async (t) => {
  const s = await setup(t, policyFor(ANTHROPIC_EXPECTED * 0.9));
  assert.equal((await s.call("POST", "/anthropic/v1/messages/batches", ABATCH)).status, 200);
  assert.equal((await s.call("POST", "/anthropic/v1/messages", JSON.stringify(SONNET))).status, 200);
  const before = s.agentBudgets.spend({ agent_id: "worker", run_id: "r1" }).day;
  assert.equal((await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results")).status, 200);
  const after = s.agentBudgets.spend({ agent_id: "worker", run_id: "r1" });
  assert.equal(Number((after.day - before).toFixed(6)), ANTHROPIC_EXPECTED, "counted at the batch ts");
  assert.equal(Number(after.run.toFixed(6)), Number((before + ANTHROPIC_EXPECTED).toFixed(6)));
  assert.equal(after.unknown, 0);
  // Teammate sees the batch in the team total.
  assert.ok(s.agentBudgets.teamSpend({ agent_id: "mate" }).day >= ANTHROPIC_EXPECTED);
  const refused = await s.call("POST", "/anthropic/v1/messages", JSON.stringify(SONNET));
  assert.equal(refused.status, 429);
  const body = await refused.json();
  assert.deepEqual([body.reason, body.scope], ["budget_exceeded", "day"]);
  // In-process verdicts match a wrapper restarted on the same ledger.
  const who = { agent_id: "worker", run_id: "r1" };
  assert.deepEqual(round(s.agentBudgets.spend(who)), round(s.fresh().spend(who)));
  assert.equal(s.fresh().check(who).reason, "budget_exceeded");
});

test("OpenAI output-file batch settle reaches the agent budget", async (t) => {
  const s = await setup(t, policyFor(1000));
  await s.call("POST", "/openai/v1/batches", JSON.stringify({ input_file_id: "file-in", endpoint: "/v1/chat/completions", completion_window: "24h" }));
  await s.call("GET", "/openai/v1/batches/batch_01");
  await s.call("GET", "/openai/v1/files/file-out/content");
  await s.call("GET", "/openai/v1/files/file-out/content");
  const who = { agent_id: "worker", run_id: "r1" };
  assert.equal(Number(s.agentBudgets.spend(who).day.toFixed(6)), OPENAI_EXPECTED);
  assert.deepEqual(round(s.agentBudgets.spend(who)), round(s.fresh().spend(who)));
});

test("batch_unpriced leaves the agent accounting unavailable", async (t) => {
  const bad = JSON.stringify({ custom_id: "x", result: { type: "succeeded", message: { model: "claude-made-up-9", usage: { input_tokens: 1, output_tokens: 1 } } } });
  const s = await setup(t, policyFor(1000), { anthropicResults: bad });
  await s.call("POST", "/anthropic/v1/messages/batches", ABATCH);
  await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results");
  const who = { agent_id: "worker", run_id: "r1" };
  assert.equal(s.agentBudgets.check(who).verdict, "accounting_unavailable");
  assert.equal(s.fresh().check(who).verdict, "accounting_unavailable");
});

test("#196: a pending background response is not an agent unknown", () => {
  const b = createAgentBudgets({ policy: policyFor(1), history: [{ id: "g", ts: new Date().toISOString(), agent_id: "worker", run_id: "r1", reason: "background_pending", cost_usd: null }] });
  assert.equal(b.spend({ agent_id: "worker", run_id: "r1" }).unknown, 0);
  assert.equal(b.check({ agent_id: "worker", run_id: "r1" }), null);
});

test("#230 Gemini inline batch settle reaches --policy agent budgets and matches a fresh wrapper", async (t) => {
  const s = await setup(t, policyFor(GEMINI_EXPECTED * 0.9));
  const body = JSON.stringify({ batch: { input_config: { requests: { requests: [{ request: { contents: [{ parts: [{ text: "hi" }] }] } }] } } } });
  assert.equal((await s.call("POST", "/gemini/v1beta/models/gemini-2.5-flash:batchGenerateContent", body)).status, 200);
  await s.call("GET", "/gemini/v1beta/batches/gb_01");
  const who = { agent_id: "worker", run_id: "r1" };
  assert.equal(Number(s.agentBudgets.spend(who).day.toFixed(6)), GEMINI_EXPECTED);
  assert.deepEqual(round(s.agentBudgets.spend(who)), round(s.fresh().spend(who)));
  assert.equal(s.fresh().check(who).reason, "budget_exceeded");
});
