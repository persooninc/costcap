// #196: OpenAI Responses background mode — pending on create, settled once on a terminal read; retrieves never bill.
import test from "node:test";
import assert from "node:assert/strict";
import { isResponsesCreate, responsesReadPath, requestsBackground, responseState, createResponsesStreamTracker } from "../src/background.js";
import { createCapEngine, isPendingBatch, loadSettledReceipts, applySettlements } from "../src/cap.js";
import { checkBudget } from "../src/check.js";
import { createAgentBudgets } from "../src/agent-budget.js";
import { createSettler } from "../src/settle.js";
import { CHAT, CREATE, CREATE_STREAM, EXPECTED, USAGE, ev, resp, setup } from "./support/background.js";
import { createVelocityBreaker } from "../src/velocity.js";

const capOf = (caps, history = []) => createCapEngine({ caps, history });
const real = (s) => s.lines().filter((l) => !l.event);
const settlements = (s) => s.lines().filter((l) => l.event === "reconciliation");

test("helpers: exact paths, background flag, state and stream tracker", () => {
  assert.equal(isResponsesCreate("POST", "/openai/v1/responses?x=1"), true);
  for (const [m, u] of [["GET", "/openai/v1/responses"], ["POST", "/openai/v1/responses/x"], ["POST", "/openai//v1/responses"], ["POST", undefined]]) assert.equal(isResponsesCreate(m, u), false);
  assert.deepEqual(responsesReadPath("GET", "/openai/v1/responses/resp_1?stream=true"), { kind: "retrieve", id: "resp_1" });
  assert.deepEqual(responsesReadPath("POST", "/openai/v1/responses/resp_1/cancel"), { kind: "cancel", id: "resp_1" });
  for (const [m, u] of [["GET", "/openai/v1/responses/input_tokens"], ["GET", "/openai/v1/responses/a%2F"], ["POST", "/openai/v1/responses/a"], ["GET", "/openai/v1/responses/a/cancel"], ["GET", null]])
    assert.equal(responsesReadPath(m, u), null, `${m} ${u}`);
  assert.equal(requestsBackground(CREATE), true);
  assert.equal(requestsBackground(Buffer.from(CHAT)), false);
  assert.equal(requestsBackground("nope"), false);
  assert.deepEqual(responseState('{"id":"resp_1","status":"queued"}'), { id: "resp_1", status: "queued" });
  assert.deepEqual(responseState('{"id":"../x","status":1}'), { id: null, status: null });
  assert.deepEqual(responseState("nope"), { id: null, status: null });
  const tr = createResponsesStreamTracker();
  tr.push(ev({ type: "response.created", response: resp("resp_s", "queued") }).slice(0, 20));
  tr.push(ev({ type: "response.created", response: resp("resp_s", "queued") }).slice(20) + "data: nope\n\n: comment\n\n");
  assert.equal(tr.id, "resp_s"); assert.equal(tr.terminal, null);
  tr.push(`data: ${JSON.stringify({ type: "response.cancelled", response: resp("resp_s", "cancelled") })}`);
  tr.end();
  assert.equal(tr.terminal, "cancelled");
});

test("AC1: a queued create is background_pending, the run continues, check fails with cost_complete false", async (t) => {
  const s = await setup(t, { cap: capOf({ run: 5 }) });
  const r = await s.call("POST", "/openai/v1/responses", CREATE);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), resp("resp_bg1", "queued"));
  const [p] = real(s);
  assert.deepEqual([p.reason, p.response_id, p.cost_usd], ["background_pending", "resp_bg1", null]);
  assert.equal(isPendingBatch(p), true);
  assert.equal((await s.call("POST", "/openai/v1/chat/completions", CHAT)).status, 200);
  assert.equal(typeof real(s)[1].cost_usd, "number");
  const c = checkBudget({ receiptsPath: s.receiptsPath, caps: { run: 5 } });
  assert.equal(c.ok, false); assert.equal(c.hit.reason, "background_pending"); assert.equal(c.cost_complete, false);
});

test("AC2: in_progress poll is $0, completed poll settles once at the create ts, later polls are $0", async (t) => {
  const s = await setup(t, { cap: capOf({ run: 5 }) });
  await s.call("POST", "/openai/v1/responses", CREATE);
  s.state.status = "in_progress";
  assert.equal((await s.call("GET", "/openai/v1/responses/resp_bg1")).status, 200);
  assert.equal(settlements(s).length, 0);
  assert.deepEqual([real(s)[1].cost_usd, real(s)[1].reason], [0, "non_billable_request"]);
  Object.assign(s.state, { status: "completed", usage: USAGE });
  const done = await s.call("GET", "/openai/v1/responses/resp_bg1");
  assert.equal((await done.json()).status, "completed");
  const [st] = settlements(s);
  assert.deepEqual([st.receipt_id, st.cost_usd, st.source, st.response_id], [real(s)[0].id, EXPECTED, "background_result", "resp_bg1"]);
  assert.equal(loadSettledReceipts(s.receiptsPath)[0].ts, real(s)[0].ts);
  assert.equal(checkBudget({ receiptsPath: s.receiptsPath, caps: { run: 5 } }).ok, true);
  await s.call("GET", "/openai/v1/responses/resp_bg1");
  assert.equal(settlements(s).length, 1);
  assert.deepEqual([real(s).at(-1).cost_usd, real(s).at(-1).reason], [0, "non_billable_request"]);
});

test("AC3: after a restart the first completed poll still settles exactly once", async (t) => {
  const s = await setup(t, { cap: () => capOf({ run: 5 }) });
  await s.call("POST", "/openai/v1/responses", CREATE);
  await s.restart();
  Object.assign(s.state, { status: "completed", usage: USAGE });
  await s.call("GET", "/openai/v1/responses/resp_bg1");
  await s.restart();
  await s.call("GET", "/openai/v1/responses/resp_bg1");
  assert.equal(settlements(s).length, 1);
  assert.equal(settlements(s)[0].cost_usd, EXPECTED);
});

test("AC3: a cut background stream is background_pending; a resumed stream settles it", async (t) => {
  const cap = capOf({ run: 5 });
  const s = await setup(t, { cap }, { status: "queued", usage: null, streamCreate: true });
  await s.call("POST", "/openai/v1/responses", CREATE_STREAM).then((r) => r.text()).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  const [p] = real(s);
  assert.deepEqual([p.reason, p.response_id], ["background_pending", "resp_bg1"]);
  assert.equal(cap.check(), null, "not latched");
  Object.assign(s.state, { status: "completed", usage: USAGE });
  const r = await s.call("GET", "/openai/v1/responses/resp_bg1?stream=true&starting_after=3");
  assert.match(await r.text(), /response\.completed/);
  assert.equal(settlements(s).length, 1);
  assert.equal(settlements(s)[0].cost_usd, EXPECTED);
  assert.equal(cap.spend().pending_batches, 0);
});

test("AC4: cancel with usage settles; failed with null usage is background_unpriced and pauses", async (t) => {
  const s = await setup(t, { cap: capOf({ run: 5 }) }, { status: "queued", usage: USAGE });
  await s.call("POST", "/openai/v1/responses", CREATE);
  assert.equal((await s.call("POST", "/openai/v1/responses/resp_bg1/cancel")).status, 200);
  assert.equal(settlements(s)[0].cost_usd, EXPECTED);

  const u = await setup(t, { cap: capOf({ run: 5 }) });
  await u.call("POST", "/openai/v1/responses", CREATE);
  Object.assign(u.state, { status: "failed", usage: null });
  assert.equal((await u.call("GET", "/openai/v1/responses/resp_bg1")).status, 200);
  assert.equal(u.lines().find((l) => l.event === "background_unpriced").response_id, "resp_bg1");
  assert.equal(loadSettledReceipts(u.receiptsPath)[0].reason, "background_unpriced");
  assert.equal((await u.call("POST", "/openai/v1/chat/completions", CHAT)).status, 429);
  const c = checkBudget({ receiptsPath: u.receiptsPath, caps: { run: 5 } });
  assert.equal(c.ok, false); assert.equal(c.hit.reason, "unreconciled_receipt");
});

test("AC5: retrieves with usage never create spend, even under a tiny cap", async (t) => {
  const s = await setup(t, { cap: capOf({ run: 0.001 }) }, { status: "completed", usage: USAGE });
  for (let i = 0; i < 3; i++) {
    assert.equal((await s.call("GET", "/openai/v1/responses/resp_other")).status, 200);
    assert.equal((await s.call("GET", "/openai/v1/chat/completions/chatcmpl_1")).status, 200);
  }
  assert.ok(real(s).every((r) => r.cost_usd === 0 && r.reason === "non_billable_request"));
  assert.equal((await s.call("POST", "/openai/v1/chat/completions", CHAT)).status, 200);
});

test("AC6: another run's background settles toward day only; agent budgets see it; hosted settle unblocks", async (t) => {
  const first = await setup(t, { who: { agent_id: "worker", run_id: "r1" } });
  await first.call("POST", "/openai/v1/responses", CREATE);
  const history = loadSettledReceipts(first.receiptsPath);
  const cap = createCapEngine({ caps: { day: 5 }, runId: "r2", history });
  const policy = { agents: { worker: { day: EXPECTED * 0.9 } } };
  const agentBudgets = createAgentBudgets({ policy, history });
  const s = await setup(t, { receiptsPath: first.receiptsPath, cap, agentBudgets, who: { agent_id: "worker", run_id: "r2" } }, { status: "completed", usage: USAGE });
  await s.call("GET", "/openai/v1/responses/resp_bg1");
  assert.equal(Number(cap.spend().day.toFixed(6)), EXPECTED);
  assert.equal(cap.spend().run, 0, "r1's background counts toward day only on run r2's engine");
  assert.equal(cap.spend().pending_batches, 0);
  assert.equal(agentBudgets.check({ agent_id: "worker", run_id: "r1" })?.reason, "budget_exceeded");

  // Hosted dashboard settle of a background_pending receipt (#176 path).
  const c2 = createCapEngine({ caps: { day: 5 }, history: [{ id: "b1", ts: new Date().toISOString(), reason: "background_pending", cost_usd: null, run_id: "x" }] });
  assert.equal(c2.spend().pending_batches, 1);
  const settle = createSettler({ cap: () => c2, agentBudgets: () => null, proxySettle: () => null });
  assert.equal(settle({ receipt_id: "b1", settled_cost_usd: 0.5 }, { id: "b1", ts: new Date().toISOString(), reason: "background_pending", run_id: "x" }), true);
  assert.deepEqual([c2.spend().pending_batches, c2.spend().day, c2.check()], [0, 0.5, null]);
});

test("applySettlements: an unpriced event never overrides a real settlement", () => {
  const lines = [{ id: "a", ts: "2026-01-01T00:00:00Z", reason: "background_pending", cost_usd: null },
    { event: "reconciliation", receipt_id: "a", cost_usd: 1 }, { event: "background_unpriced", receipt_id: "a" }];
  assert.equal(applySettlements(lines)[0].cost_usd, 1);
  assert.equal(applySettlements([lines[0], lines[2]])[0].reason, "background_unpriced");
});

// #201: velocity breaker vs background settles from another run / the same run.
async function velocityRun(t, settleRunId) {
  let clock = 1_000_000;
  const velocity = createVelocityBreaker({ bucketMs: 1000, baselineBuckets: 5, multiple: 3, minSpendUsd: 0.5, now: () => clock });
  const first = await setup(t, { who: { agent_id: "worker", run_id: settleRunId } });
  await first.call("POST", "/openai/v1/responses", CREATE);
  const history = loadSettledReceipts(first.receiptsPath);
  const cap = createCapEngine({ caps: { day: 5 }, runId: "r2", history });
  const big = { input_tokens: 4_000_000, output_tokens: 0, total_tokens: 4_000_000 };
  const s = await setup(t, { receiptsPath: first.receiptsPath, cap, velocity, spiral: null, who: { agent_id: "worker", run_id: "r2" } }, { status: "completed", usage: big });
  for (let i = 0; i < 5; i++) {
    assert.equal((await s.call("POST", "/openai/v1/chat/completions", CHAT)).status, 200);
    clock += 1000;
  }
  assert.equal((await s.call("GET", "/openai/v1/responses/resp_bg1")).status, 200);
  const next = await s.call("POST", "/openai/v1/chat/completions", CHAT);
  return { s, cap, next };
}

test("#201: another run's background settle never trips this run's velocity breaker", async (t) => {
  const { s, cap, next } = await velocityRun(t, "r1");
  assert.equal(next.status, 200, await next.clone().text());
  assert.ok(cap.spend().run < 0.001);
  assert.ok(cap.spend().day >= 0.6);
  assert.ok(!s.lines().some((r) => r.blocked && r.reason === "cost_velocity"));
});

test("#201: a same-run background settle of the same cost still trips the breaker", async (t) => {
  const { s, next } = await velocityRun(t, "r2");
  assert.equal(next.status, 429);
  assert.equal((await next.json()).reason, "cost_velocity");
  assert.ok(s.lines().some((r) => r.blocked && r.reason === "cost_velocity"));
});
