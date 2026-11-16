// Issue #195: --preflight compares the worst-case estimate with the enrolled fleet
// agent caps and the hosted team budget (fleet-wide synced spend + unsynced receipts).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createFleetClient } from "../src/hosted/client.js";
import { cachedAgentRemaining, cachedTeamRemaining } from "../src/hosted/teams.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const TODAY = "2026-11-15T08:00:00Z";
const COMPLETION = JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 10 } });
// gpt-4o output is $10/M: 300k max_tokens is a ~$3 worst case.
const BIG = JSON.stringify({ model: "gpt-4o", max_tokens: 300_000, messages: [{ role: "user", content: "hi" }] });
const SMALL = JSON.stringify({ model: "gpt-4o", max_tokens: 1000, messages: [{ role: "user", content: "hi" }] });

test("unit: cachedAgentRemaining synced-only, unsynced-only, past day, no cap", () => {
  const spend = (day, month = day, as_of = TODAY) => ({ spent: { day, month }, unknown: 0, as_of });
  assert.deepEqual(cachedAgentRemaining(spend(9.5), { day: 10 }, [], NOW), { day: 0.5, month: null });
  assert.deepEqual(cachedAgentRemaining(spend(0), { day: 10, month: 20 }, [{ id: "a", ts: TODAY, cost_usd: 2 }, { id: "b", ts: TODAY, cost_usd: 1, blocked: true }], NOW), { day: 8, month: 18 });
  // Synced spend from yesterday counts 0 in today's window but still in the month.
  assert.deepEqual(cachedAgentRemaining(spend(9.5, 9.5, "2026-11-14T23:00:00Z"), { day: 10, month: 12 }, [], NOW), { day: 10, month: 2.5 });
  assert.equal(cachedAgentRemaining(spend(1), {}, [], NOW), null);
  assert.equal(cachedAgentRemaining(null, { day: 1 }, [], NOW), null);
  assert.deepEqual(cachedAgentRemaining(spend(12), { day: 10 }, [], NOW), { day: 0, month: null });
});

test("unit: cachedTeamRemaining synced + unsynced, past day, no cap", () => {
  const team = (caps, day, as_of = TODAY) => ({ name: "ops", caps, spent: { day, month: day }, unknown: 0, as_of });
  assert.deepEqual(cachedTeamRemaining(team({ day: 50 }, 49), [{ id: "x", ts: TODAY, cost_usd: 0.5 }], NOW), { day: 0.5, month: null });
  assert.deepEqual(cachedTeamRemaining(team({ day: 50 }, 49, "2026-11-14T08:00:00Z"), [], NOW), { day: 50, month: null });
  assert.equal(cachedTeamRemaining(team({}, 49), [], NOW), null);
  assert.equal(cachedTeamRemaining(null, [], NOW), null);
});

test("fleet client: preflightRemaining from the cached enrollment, minus unsynced receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-pf-fleet-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "r.jsonl");
  const today = new Date().toISOString();
  writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:9", token: "t", agentId: "a1", policy: { version: 1, caps: { day: 10 }, killed: false }, syncedIds: ["s1"],
    agentSpend: { spent: { day: 9, month: 9 }, unknown: 0, as_of: today },
    team: { name: "ops", caps: { day: 50 }, spent: { day: 40, month: 40 }, unknown: 0, as_of: today } }), { mode: 0o600 });
  writeFileSync(receiptsPath, [JSON.stringify({ id: "s1", ts: today, cost_usd: 5 }), JSON.stringify({ id: "u1", ts: today, cost_usd: 0.5 })].join("\n") + "\n");
  const r = createFleetClient({ path, receiptsPath }).preflightRemaining();
  assert.deepEqual(r, { agent: { day: 0.5, month: null }, team: { day: 9.5, month: null }, teamName: "ops", org: null });
  const bare = join(dir, "bare.json");
  writeFileSync(bare, JSON.stringify({ url: "http://127.0.0.1:9", token: "t", agentId: "a1", policy: { version: 1, caps: {}, killed: false }, syncedIds: [] }), { mode: 0o600 });
  assert.equal(createFleetClient({ path: bare, receiptsPath }).preflightRemaining(), null);
});

async function setup(t, opts) {
  const up = { hits: 0 };
  await new Promise((res) => {
    up.server = http.createServer((q, s) => { up.hits += 1; q.resume(); q.on("end", () => s.writeHead(200, { "content-type": "application/json" }).end(COMPLETION)); });
    up.server.listen(0, "127.0.0.1", res);
  });
  t.after(() => up.server.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.server.address().port}` }, onReceipt: (x) => receipts.push(x), ...opts });
  t.after(() => server.close());
  const call = (body = BIG) => fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", body });
  return { up, call, receipts };
}

test("proxy: fleet agent day remainder $0.50, $3 worst case refused before upstream (AC1)", async (t) => {
  const { up, call, receipts } = await setup(t, { preflight: true, fleetRemaining: () => ({ agent: { day: 0.5, month: null }, team: null, teamName: null }) });
  const r = await call();
  assert.equal(r.status, 429);
  const b = await r.json();
  assert.deepEqual([b.error, b.reason, b.estimate, b.fleet, b.scope, b.remaining_usd], ["budget_exceeded", "preflight_estimate", true, true, "day", 0.5]);
  assert.ok(b.estimate_usd > 3 && b.estimate_usd < 3.01);
  assert.match(b.message, /fleet agent remaining day/);
  assert.equal(up.hits, 0);
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].blocked, receipts[0].cost_usd], [true, 0]);
});

test("proxy: hosted team remainder refuses with team scope (AC2)", async (t) => {
  const { up, call } = await setup(t, { preflight: true, fleetRemaining: () => ({ agent: { day: 100, month: null }, team: { day: null, month: 1 }, teamName: "ops" }) });
  const r = await call();
  const b = await r.json();
  assert.deepEqual([r.status, b.reason, b.fleet, b.team, b.scope, b.remaining_usd], [429, "preflight_estimate", true, "ops", "team:ops:month", 1]);
  assert.match(b.message, /team "ops"/);
  assert.equal(up.hits, 0);
});

test("proxy: estimate fits every remainder → forwarded with estimate fields (AC4)", async (t) => {
  const { up, call, receipts } = await setup(t, { preflight: true, fleetRemaining: () => ({ agent: { day: 5, month: 5 }, team: { day: 5, month: null }, teamName: "ops" }) });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(up.hits, 1);
  assert.equal(receipts[0].blocked, false);
  assert.ok(receipts[0].output_tokens_est > 0);
});

test("proxy: without --preflight the fleet remainders are not consulted (AC5)", async (t) => {
  let asked = 0;
  const { up, call } = await setup(t, { preflight: false, fleetRemaining: () => { asked += 1; return { agent: { day: 0, month: null }, team: null, teamName: null }; } });
  assert.equal((await call(SMALL)).status, 200);
  assert.equal(asked, 0);
  assert.equal(up.hits, 1);
});
