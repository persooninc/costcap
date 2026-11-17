// Issue #291: --preflight checks lifetime total remainders (agent, team, org, tag, model).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createAgentBudgets } from "../src/agent-budget.js";
import { cachedAgentRemaining, cachedTeamRemaining } from "../src/hosted/teams.js";
import { cachedOrgRemaining, cachedOrgTotalRemaining } from "../src/hosted/org-budget.js";
import { cachedFleetTagTotalRemaining, cachedFleetTagTotalVerdict } from "../src/hosted/tag-caps.js";
import { cachedFleetModelTotalRemaining, cachedFleetModelTotalVerdict, withFleetModelCaps } from "../src/hosted/model-caps.js";
import { withFleetTagCaps } from "../src/tag-cap.js";
import { createModelCaps } from "../src/model-cap.js";
import { createFleetClient, saveEnrollment } from "../src/hosted/client.js";

const NOV = Date.parse("2026-11-16T12:00:00Z");
const SEP = "2026-09-10T12:00:00.000Z";
const COMPLETION = JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 10 } });
const BIG = JSON.stringify({ model: "gpt-4o", max_tokens: 300_000, messages: [{ role: "user", content: "hi" }] }); // ~$3 worst case

async function upstream(t, gate) {
  const up = { hits: 0 };
  await new Promise((res) => {
    up.server = http.createServer(async (q, s) => { up.hits += 1; q.resume(); if (gate) await gate; s.writeHead(200, { "content-type": "application/json" }).end(COMPLETION); });
    up.server.listen(0, "127.0.0.1", res);
  });
  t.after(() => up.server.close());
  return up;
}

async function proxy(t, opts, gate) {
  const up = await upstream(t, gate);
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.server.address().port}` }, onReceipt: (x) => receipts.push(x), preflight: true, ...opts });
  t.after(() => server.close());
  const call = (body = BIG, headers = {}) => fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", body, headers });
  return { up, call, receipts };
}

const fr = (o) => () => ({ agent: null, team: null, teamName: null, org: null, ...o });

// ---- AC1: --policy agent and team totals ----
test("AC1: --policy agent total $1 left refuses a $3 worst case (no Retry-After, $0 blocked receipt)", async (t) => {
  const agentBudgets = createAgentBudgets({ policy: { agents: { a1: { total: 10 } } }, history: [{ id: "h", ts: SEP, cost_usd: 9, agent_id: "a1" }] });
  const { up, call, receipts } = await proxy(t, { who: { agent_id: "a1" }, agentBudgets });
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), null);
  const b = await r.json();
  assert.deepEqual([b.error, b.reason, b.estimate, b.scope, b.remaining_usd, b.fleet], ["budget_exceeded", "preflight_estimate", true, "total", 1, undefined]);
  assert.match(b.message, /A total budget does not reset\./);
  assert.equal(up.hits, 0);
  assert.deepEqual([receipts.length, receipts[0].blocked, receipts[0].cost_usd, receipts[0].reason], [1, true, 0, "preflight_estimate"]);
});

test("AC1: --policy agent total $50 lets the call through", async (t) => {
  const agentBudgets = createAgentBudgets({ policy: { agents: { a1: { total: 50 } } }, history: [{ id: "h", ts: SEP, cost_usd: 9, agent_id: "a1" }] });
  const { up, call } = await proxy(t, { who: { agent_id: "a1" }, agentBudgets });
  assert.equal((await call()).status, 200);
  assert.equal(up.hits, 1);
});

test("AC1: --policy team total refuses a member's call", async (t) => {
  const agentBudgets = createAgentBudgets({ policy: { teams: { pilot: { total: 10, agents: ["a1", "a2"] } } }, history: [{ id: "h", ts: SEP, cost_usd: 9, agent_id: "a2" }] });
  const { up, call } = await proxy(t, { who: { agent_id: "a1" }, agentBudgets });
  const r = await call();
  assert.equal(r.status, 429);
  const b = await r.json();
  assert.deepEqual([b.reason, b.scope, b.remaining_usd], ["preflight_estimate", "total", 1]);
  assert.equal(up.hits, 0);
});

// ---- AC2/AC3: fleet agent, team, org totals ----
test("AC2 unit: cachedAgentRemaining/cachedTeamRemaining return a lifetime total", () => {
  const spend = { spent: { day: 0, week: 0, month: 0, total: 19 }, unknown: 0, as_of: SEP };
  assert.deepEqual(cachedAgentRemaining(spend, { total: 20 }, [], NOV), { day: null, month: null, total: 1 });
  assert.equal(cachedAgentRemaining(spend, { total: 20 }, [{ id: "p", ts: SEP, cost_usd: 0.4 }], NOV).total, 0.6);
  assert.equal(cachedAgentRemaining(spend, { total: 60 }, [], NOV).total, 41);
  assert.equal(cachedAgentRemaining(spend, { total: 5 }, [], NOV).total, 0);
  // No total cap: unchanged shape (no total key).
  assert.deepEqual(cachedAgentRemaining(spend, { day: 5, month: 50 }, [], NOV), { day: 5, month: 50 });
  const team = { name: "ops", caps: { total: 20 }, spent: { day: 0, month: 0, total: 19 }, unknown: 0, as_of: SEP };
  assert.equal(cachedTeamRemaining(team, [], NOV).total, 1);
});

test("AC3 unit: cachedOrgTotalRemaining counts every unsynced receipt", () => {
  const t = { cap: 500, spend_usd: 499, unknown_count: 0, as_of: SEP };
  assert.equal(cachedOrgTotalRemaining(t, []), 1);
  assert.equal(cachedOrgTotalRemaining(t, [{ id: "p", ts: SEP, cost_usd: 0.25 }, { id: "b", ts: SEP, cost_usd: 9, blocked: true }]), 0.75);
  assert.equal(cachedOrgTotalRemaining(null, []), null);
  assert.equal(cachedOrgTotalRemaining({ ...t, spend_usd: 600 }, []), 0);
  assert.equal(cachedOrgRemaining(null, [], NOV), null);
});

for (const [kind, o, scope, extra] of [
  ["fleet agent", { agent: { day: null, month: null, total: 1 } }, "total", {}],
  ["hosted team", { team: { day: null, month: null, total: 1 }, teamName: "ops" }, "team:ops:total", { team: "ops" }],
  ["org", { org: { total: 1 } }, "org:total", { org: true }],
]) {
  test(`AC2/AC3 proxy: ${kind} total $1 refuses a $3 worst case`, async (t) => {
    const { up, call } = await proxy(t, { fleetRemaining: fr(o) });
    const r = await call();
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), null);
    const b = await r.json();
    assert.deepEqual([b.error, b.reason, b.fleet, b.scope, b.remaining_usd], ["budget_exceeded", "preflight_estimate", true, scope, 1]);
    assert.match(b.message, /does not reset/);
    for (const [k, v] of Object.entries(extra)) assert.equal(b[k], v);
    assert.equal(up.hits, 0);
  });
}

test("AC3 proxy: an org day cap hit first keeps its own scope; room passes", async (t) => {
  const { call } = await proxy(t, { fleetRemaining: fr({ org: { day: 0.5, month: null, total: 1 } }) });
  assert.equal((await (await call()).json()).scope, "org:day");
  const ok = await proxy(t, { fleetRemaining: fr({ agent: { day: null, month: null, total: 41 } }) });
  assert.equal((await ok.call()).status, 200);
});

// ---- AC2/AC3/AC4 through the fleet client (cached enrollment, offline) ----
function client(data, pending = []) {
  const dir = mkdtempSync(join(tmpdir(), "cc-291-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "receipts.jsonl");
  saveEnrollment(path, { url: "http://127.0.0.1:9", token: "t", agentId: "a", syncedIds: [], ...data });
  appendFileSync(receiptsPath, pending.map((r) => JSON.stringify(r) + "\n").join(""));
  return createFleetClient({ path, receiptsPath });
}

test("AC2 client: preflightRemaining reads total caps, unsynced receipts and raise_total", () => {
  const agentSpend = { spent: { day: 0, week: 0, month: 0, total: 19 }, unknown: 0, as_of: SEP };
  const base = { policy: { version: 1, caps: { total: 20 }, killed: false }, agentSpend };
  assert.equal(client(base).preflightRemaining(NOV).agent.total, 1);
  assert.equal(client(base, [{ id: "u", ts: SEP, cost_usd: 0.4 }]).preflightRemaining(NOV).agent.total, 0.6);
  const raised = { ...base, policy: { ...base.policy, raise: { total: [{ amount_usd: 40, expires_at: "2026-12-01T00:00:00Z", request_id: "r" }] } } };
  assert.equal(client(raised).preflightRemaining(NOV).agent.total, 41);
  const team = { name: "ops", agents: ["a"], caps: { total: 20 }, spent: { day: 0, month: 0, total: 19 }, unknown: 0, as_of: SEP };
  const tr = client({ policy: { version: 1, caps: {}, killed: false }, team }).preflightRemaining(NOV);
  assert.deepEqual([tr.team.total, tr.teamName], [1, "ops"]);
  // Org total only (no org window budget).
  const orgTotal = { cap: 500, spend_usd: 499, unknown_count: 0, as_of: SEP };
  assert.deepEqual(client({ policy: { version: 1, caps: {}, killed: false }, orgTotal }).preflightRemaining(NOV).org, { total: 1 });
  // No total caps: byte-identical output to before #291.
  const plain = client({ policy: { version: 1, caps: { day: 5 }, killed: false }, agentSpend: { spent: { day: 1, month: 1 }, unknown: 0, as_of: new Date(NOV).toISOString() } }).preflightRemaining(NOV);
  assert.deepEqual(plain, { agent: { day: 4, month: null }, team: null, teamName: null, org: null });
  assert.equal(client({ policy: { version: 1, caps: {}, killed: false } }).preflightRemaining(NOV), null);
});

const TAG_TOTAL = { truncated: false, as_of: SEP, rules: [{ key: "customer", scope: "total", usd: 500 }], spend: { customer: { acme: { total: 499, unknown: 0 }, bad: { total: 1, unknown: 2 } } } };
const MODEL_SPEND = { spent: { day: 0, month: 0 }, unknown: 0, as_of: SEP, models: { "gpt-4o": { day: 0, month: 0, total: 19, unknown_total: 0 }, "gpt-x": { day: 0, month: 0, total: 1, unknown_total: 3 } } };
const MODEL_TOTAL = [{ model: "gpt-4o", scope: "total", usd: 20 }, { model: "gpt-x", scope: "total", usd: 20 }];

test("AC4 unit: tag and model total remainders; unknown cost is left out (verdict refuses)", () => {
  assert.deepEqual(cachedFleetTagTotalRemaining(TAG_TOTAL, { customer: "acme" }, []), [{ tag_key: "customer", tag_value: "acme", scope: "total", cap_usd: 500, remaining_usd: 1, fleet: true }]);
  assert.equal(cachedFleetTagTotalRemaining(TAG_TOTAL, { customer: "globex" }, [])[0].remaining_usd, 500);
  assert.deepEqual(cachedFleetTagTotalRemaining(TAG_TOTAL, { customer: "bad" }, []), []);
  assert.equal(cachedFleetTagTotalVerdict(TAG_TOTAL, { customer: "bad" }, []).verdict, "accounting_unavailable");
  assert.deepEqual(cachedFleetTagTotalRemaining(null, {}, []), []);
  assert.equal(cachedFleetTagTotalRemaining(TAG_TOTAL, { customer: "acme" }, [{ id: "p", ts: SEP, cost_usd: 0.5, tags: { customer: "acme" } }])[0].remaining_usd, 0.5);
  const trunc = { ...TAG_TOTAL, truncated: true };
  assert.equal(cachedFleetTagTotalRemaining(trunc, { customer: "zzz" }, [])[0].remaining_usd, 1); // truncated-list floor
  assert.deepEqual(cachedFleetModelTotalRemaining(MODEL_SPEND, MODEL_TOTAL, ["gpt-4o"], []), [{ model: "gpt-4o", rule_model: "gpt-4o", scope: "total", cap_usd: 20, remaining_usd: 1, fleet: true }]);
  assert.deepEqual(cachedFleetModelTotalRemaining(MODEL_SPEND, MODEL_TOTAL, ["gpt-x", "o3"], []), []);
  assert.equal(cachedFleetModelTotalVerdict(MODEL_SPEND, MODEL_TOTAL, ["gpt-x"], []).verdict, "accounting_unavailable");
  assert.deepEqual(cachedFleetModelTotalRemaining(null, MODEL_TOTAL, ["gpt-4o"], []), []);
  assert.deepEqual(cachedFleetModelTotalRemaining(MODEL_SPEND, [], ["gpt-4o"], []), []);
});

test("AC4 client: tagRemaining/modelRemaining include total entries", () => {
  const c = client({ policy: { version: 1, caps: {}, killed: false }, agentSpend: MODEL_SPEND, tagCapsTotal: TAG_TOTAL, modelCapsTotal: MODEL_TOTAL });
  assert.deepEqual(c.tagRemaining({ customer: "acme" }, [], NOV).map((x) => [x.scope, x.remaining_usd]), [["total", 1]]);
  assert.deepEqual(c.modelRemaining(["gpt-4o"], NOV).map((x) => [x.scope, x.remaining_usd]), [["total", 1]]);
  assert.deepEqual(client({ policy: { version: 1, caps: {}, killed: false } }).tagRemaining({ customer: "acme" }), []);
});

test("AC4 proxy: acme tag total refuses; globex passes; model total refuses gpt-4o", async (t) => {
  const c = client({ policy: { version: 1, caps: {}, killed: false }, agentSpend: MODEL_SPEND, tagCapsTotal: TAG_TOTAL, modelCapsTotal: MODEL_TOTAL });
  const tagCaps = withFleetTagCaps(null, c, []);
  const { up, call } = await proxy(t, { tagCaps });
  const r = await call(BIG, { "x-costcap-tag": "customer=acme" });
  assert.equal(r.status, 429);
  const b = await r.json();
  assert.deepEqual([b.error, b.reason, b.scope, b.tag_value, b.remaining_usd], ["tag_budget_exceeded", "preflight_estimate", "total", "acme", 1]);
  assert.match(b.message, /does not reset/);
  assert.equal(up.hits, 0);
  assert.equal((await call(BIG, { "x-costcap-tag": "customer=globex" })).status, 200);
  const mc = withFleetModelCaps(createModelCaps({ rules: [] }), createModelCaps({ rules: [] }), c);
  const m = await proxy(t, { modelCaps: mc });
  const mr = await m.call();
  assert.equal(mr.status, 429);
  const mb = await mr.json();
  assert.deepEqual([mb.error, mb.reason, mb.scope, mb.remaining_usd], ["model_budget_exceeded", "preflight_estimate", "total", 1]);
  assert.equal(m.up.hits, 0);
});

// ---- AC5: concurrency ----
test("AC5: --max-concurrent 2 reserves in-flight estimates against a total", async (t) => {
  for (const opts of [
    { fleetRemaining: fr({ agent: { day: null, month: null, total: 5 } }) },
    { who: { agent_id: "a1" }, agentBudgets: createAgentBudgets({ policy: { agents: { a1: { total: 5 } } } }) },
  ]) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { up, call } = await proxy(t, { maxConcurrent: 2, ...opts }, gate);
    const first = call();
    while (up.hits < 1) await new Promise((r) => setTimeout(r, 5));
    const second = await call();
    assert.equal(second.status, 429);
    assert.equal((await second.json()).scope, "total");
    release();
    assert.equal((await first).status, 200);
    assert.equal((await call()).status, 200); // settled at its real (tiny) cost
  }
});
