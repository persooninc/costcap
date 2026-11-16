// Issue #193: --preflight compares the worst-case estimate with per-tag caps and
// with --policy agent/team remainders, not only the wrapper run/hour/day/month caps.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTagCaps, tagBudgetExceededBody, UNTAGGED } from "../src/tag-cap.js";
import { createAgentBudgets } from "../src/agent-budget.js";
import { createCapEngine } from "../src/cap.js";
import { startMeteringProxy } from "../src/proxy.js";

const T0 = Date.parse("2026-11-16T12:00:00Z");
const now = () => new Date(T0);
const ago = (min) => new Date(T0 - min * 60_000).toISOString();
const rec = (cost, tags, extra = {}) => ({ id: `r${Math.random()}`, ts: ago(5), cost_usd: cost, ...(tags ? { tags } : {}), ...extra });
const COMPLETION = JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 10 } });
// gpt-4o output is $10/M: 300k max_tokens is a ~$3 worst case.
const BIG = JSON.stringify({ model: "gpt-4o", max_tokens: 300_000, messages: [{ role: "user", content: "hi" }] });

async function upstream(t) {
  const up = { hits: 0 };
  await new Promise((res) => {
    up.server = http.createServer((q, s) => { up.hits += 1; q.resume(); q.on("end", () => s.writeHead(200, { "content-type": "application/json" }).end(COMPLETION)); });
    up.server.listen(0, "127.0.0.1", res);
  });
  t.after(() => up.server.close());
  up.base = `http://127.0.0.1:${up.server.address().port}`;
  return up;
}

async function proxy(t, up, opts) {
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.base }, onReceipt: (x) => receipts.push(x), preflight: true, ...opts });
  t.after(() => server.close());
  const call = (tag) => fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", headers: tag ? { "x-costcap-tag": tag } : {}, body: BIG });
  return { call, receipts };
}

test("engine: remaining() and preflight() per matching rule, (untagged) included", () => {
  const tc = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 5 }], history: [rec(4.9, { customer: "acme" }), rec(6, null)], now });
  assert.deepEqual(tc.remaining({ customer: "acme" }), [{ tag_key: "customer", tag_value: "acme", scope: "day", cap_usd: 5, remaining_usd: 0.1 }]);
  assert.equal(tc.remaining(null)[0].remaining_usd, 0);
  assert.equal(tc.preflight({ customer: "globex" }, 3), null);
  const hit = tc.preflight({ customer: "acme" }, 3);
  assert.deepEqual([hit.reason, hit.estimate, hit.estimate_usd, hit.remaining_usd, hit.tag_value], ["preflight_estimate", true, 3, 0.1, "acme"]);
  assert.equal(tc.preflight({ env: "x" }, 0.01).tag_value, UNTAGGED);
  assert.match(tagBudgetExceededBody(hit).message, /preflight estimate/);
  assert.equal(tagBudgetExceededBody({ tag_key: "a", tag_value: "b", scope: "day", spend_usd: 1, cap_usd: 1 }).message.includes("preflight"), false);
});

test("proxy: acme at $4.90 + $3 worst case is refused before upstream, no latch (AC1)", async (t) => {
  const up = await upstream(t);
  const live = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 5 }], history: [{ id: "a", ts: new Date().toISOString(), cost_usd: 4.9, tags: { customer: "acme" } }] });
  const { call, receipts } = await proxy(t, up, { tagCaps: live });
  const r = await call("customer=acme");
  assert.equal(r.status, 429);
  const body = await r.json();
  assert.equal(body.error, "tag_budget_exceeded");
  assert.equal(body.reason, "preflight_estimate");
  assert.equal(body.estimate, true);
  assert.ok(body.estimate_usd > 3 && body.estimate_usd < 3.01);
  assert.deepEqual([body.remaining_usd, body.tag_key, body.tag_value, body.scope], [0.1, "customer", "acme", "day"]);
  assert.equal(up.hits, 0);
  const blocked = receipts.find((x) => x.blocked);
  assert.deepEqual([blocked.reason, blocked.cost_usd, blocked.tags.customer], ["preflight_estimate", 0, "acme"]);
  // No latch: another customer goes through on the same proxy.
  assert.equal((await call("customer=globex")).status, 200);
  assert.equal(up.hits, 1);
});

test("proxy: acme at $1.90 + $3 fits and is forwarded with estimate fields (AC3)", async (t) => {
  const up = await upstream(t);
  const live = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 5 }], history: [{ id: "a", ts: new Date().toISOString(), cost_usd: 1.9, tags: { customer: "acme" } }] });
  const { call, receipts } = await proxy(t, up, { tagCaps: live, cap: createCapEngine({ caps: { day: 100 } }) });
  assert.equal((await call("customer=acme")).status, 200);
  assert.equal(up.hits, 1);
  const ok = receipts.find((x) => !x.blocked);
  assert.ok(ok.output_tokens_est > 0);
});

test("proxy: an (untagged) request is checked against the (untagged) bucket", async (t) => {
  const up = await upstream(t);
  const live = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 5 }], history: [{ id: "a", ts: new Date().toISOString(), cost_usd: 4 }] });
  const { call } = await proxy(t, up, { tagCaps: live });
  const r = await call();
  assert.equal(r.status, 429);
  const body = await r.json();
  assert.deepEqual([body.tag_value, body.reason], [UNTAGGED, "preflight_estimate"]);
  assert.equal((await call("customer=fresh")).status, 200);
});

test("proxy: a --policy agent day cap refuses an estimate over its remainder (AC2)", async (t) => {
  const up = await upstream(t);
  const who = { agent_id: "a1", run_id: "r1" };
  const history = [{ id: "h", ts: new Date().toISOString(), cost_usd: 4.9, agent_id: "a1", run_id: "r0", provider: "openai", path: "/v1/chat/completions" }];
  const agentBudgets = createAgentBudgets({ policy: { agents: { a1: { day: 5 } } }, history });
  const { call, receipts } = await proxy(t, up, { who, agentBudgets });
  const r = await call();
  assert.equal(r.status, 429);
  const body = await r.json();
  assert.deepEqual([body.error, body.reason, body.estimate, body.scope, body.remaining_usd, body.agent_id], ["budget_exceeded", "preflight_estimate", true, "day", 0.1, "a1"]);
  assert.equal(up.hits, 0);
  assert.equal(receipts.find((x) => x.blocked).reason, "preflight_estimate");
});

test("proxy: a team budget remainder is honoured; a roomy policy forwards (AC2, AC3)", async (t) => {
  const up = await upstream(t);
  const history = [{ id: "h", ts: new Date().toISOString(), cost_usd: 8, agent_id: "a2", run_id: "r0", provider: "openai", path: "/v1/chat/completions" }];
  const policy = { agents: { a1: { day: 100 }, a2: { day: 100 } }, teams: { core: { agents: ["a1", "a2"], day: 10 } } };
  const { call } = await proxy(t, up, { who: { agent_id: "a1", run_id: "r1" }, agentBudgets: createAgentBudgets({ policy, history }) });
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal((await r.json()).remaining_usd, 2);
  const roomy = createAgentBudgets({ policy: { agents: { a1: { day: 100 } } } });
  const p2 = await proxy(t, up, { who: { agent_id: "a1", run_id: "r1" }, agentBudgets: roomy });
  assert.equal((await p2.call()).status, 200);
});

test("without --preflight the tag/agent remainders are not compared with an estimate (AC4)", async (t) => {
  const up = await upstream(t);
  const live = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 5 }], history: [{ id: "a", ts: new Date().toISOString(), cost_usd: 4.9, tags: { customer: "acme" } }] });
  const { call } = await proxy(t, up, { tagCaps: live, preflight: false });
  assert.equal((await call("customer=acme")).status, 200);
});
