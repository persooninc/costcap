// #183: enrolled fleet/team cached caps follow the pending-batch rule: a batch
// create does not freeze the agent, the results read is allowed and settles it,
// and the settled cost counts toward the fleet/team cap.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createFleetClient } from "../src/hosted/client.js";
import { agentSpendPolicy, cachedAgentVerdict, cachedTeamVerdict, teamVerdict } from "../src/hosted/teams.js";
import { hostedAgentVerdict } from "../src/hosted/agent-verdict.js";
import { ANTHROPIC_EXPECTED, mockUpstream } from "./support/batch.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const SONNET = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
const ABATCH = JSON.stringify({ requests: ["a", "b", "c"].map((custom_id) => ({ custom_id, params: JSON.parse(SONNET) })) });
const pendingBatch = { id: "pb", ts: "2026-11-15T10:00:00Z", cost_usd: null, reason: "batch_pending", batch_id: "msgbatch_01" };

test("unit: cached verdicts skip pending batches; a non-batch unknown still refuses", () => {
  const spend = { spent: { day: 0, month: 0 }, unknown: 0, as_of: new Date(NOW).toISOString() };
  const team = { name: "ops", caps: { day: 10 }, spent: { day: 0, month: 0 }, unknown: 0, as_of: new Date(NOW).toISOString() };
  assert.equal(cachedAgentVerdict(spend, { day: 10 }, [pendingBatch], NOW), null);
  assert.equal(cachedTeamVerdict(team, [pendingBatch], NOW), null);
  // Settled (settled-aware load): counts its cost.
  const settled = { ...pendingBatch, cost_usd: 10 };
  assert.equal(cachedAgentVerdict(spend, { day: 10 }, [settled], NOW).verdict, "budget_exceeded");
  assert.equal(cachedTeamVerdict(team, [settled], NOW).verdict, "budget_exceeded");
  // AC4: 5xx / cut stream unknown is still accounting_unavailable.
  const cut = { id: "x", ts: "2026-11-15T10:00:00Z", cost_usd: null, reason: "upstream_error" };
  assert.equal(cachedAgentVerdict(spend, { day: 10 }, [pendingBatch, cut], NOW).verdict, "accounting_unavailable");
  assert.equal(cachedTeamVerdict(team, [cut], NOW).verdict, "accounting_unavailable");
});

test("unit: server-side spend shows a synced pending batch as pending, not unknown", () => {
  const p = agentSpendPolicy([pendingBatch, { id: "k", ts: "2026-11-15T09:00:00Z", cost_usd: 0.5 }], NOW);
  assert.deepEqual(p, { spent: { day: 0.5, month: 0.5 }, unknown: 0, pending_batches: 1, as_of: new Date(NOW).toISOString() });
  assert.equal(agentSpendPolicy([{ ...pendingBatch, cost_usd: 2 }], NOW).spent.day, 2);
  assert.equal(agentSpendPolicy([{ id: "n", ts: pendingBatch.ts, cost_usd: null }], NOW).unknown, 1);
  const tv = teamVerdict({ team: { name: "ops", agents: ["a"], day: 10 }, receiptsByAgent: { a: [pendingBatch] }, nowMs: NOW });
  assert.equal(tv.verdict, "ok");
  assert.equal(tv.spend.unknown_count, 0);
  assert.equal(tv.spend.pending_batch_count, 1);
  assert.equal(tv.spend.cost_complete, false);
  const hv = hostedAgentVerdict({ agent: { id: "a", policy: { caps: { day: 10 } } }, receipts: [pendingBatch], nowMs: NOW, team: tv });
  assert.equal(hv.verdict, "ok");
});

async function setup(t, policy) {
  const fleet = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/policy") res.end(JSON.stringify(policy));
      else if (req.url === "/v1/receipts") res.end(JSON.stringify({ acceptedIds: [] }));
      else { res.statusCode = 404; res.end("{}"); }
    });
  });
  const fleetPort = await listen(fleet);
  const up = http.createServer((req, res) => { req.resume(); req.on("end", () => mockUpstream()(req, res)); });
  const base = `http://127.0.0.1:${await listen(up)}`;
  const dir = mkdtempSync(join(tmpdir(), "cc-fleet-batch-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "r.jsonl");
  writeFileSync(path, JSON.stringify({ url: `http://127.0.0.1:${fleetPort}`, token: "t", agentId: "agent-1", policy: { version: 1, caps: { day: 100 }, killed: false }, syncedIds: [] }), { mode: 0o600 });
  writeFileSync(receiptsPath, "");
  const client = createFleetClient({ path, receiptsPath });
  assert.equal((await client.sync()).online, true);
  // Same wiring as `costcap wrap --enrollment` (src/cli.js).
  const p = await startMeteringProxy({ upstreams: { anthropic: base, openai: base }, receiptsPath, who: { agent_id: "agent-1", run_id: "r1" }, teamCheck: () => client.agentCheck() ?? client.teamCheck() });
  t.after(() => { for (const s of [fleet, up, p.server]) { s.closeAllConnections(); s.close(); } });
  return { client, call: (method, p2, body) => fetch(`http://127.0.0.1:${p.port}${p2}`, { method, body }) };
}

async function flow(t, policy, check) {
  const s = await setup(t, policy);
  assert.equal((await s.call("POST", "/anthropic/v1/messages/batches", ABATCH)).status, 200);
  assert.equal(check(s.client), null, "pending batch is not unknown");
  assert.equal((await s.call("POST", "/anthropic/v1/messages", SONNET)).status, 200);
  assert.equal((await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results")).status, 200);
  // The settled batch cost now counts toward the cap: the next call is refused.
  const hit = check(s.client);
  assert.equal(hit?.verdict, "budget_exceeded");
  assert.ok(hit.spent_usd >= 0.5 + ANTHROPIC_EXPECTED);
  const r = await s.call("POST", "/anthropic/v1/messages", SONNET);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, "budget_exceeded");
}

test("wrapper: enrolled agent fleet day cap: batch create, then messages and results read are allowed and settle", async (t) => {
  const asOf = new Date().toISOString();
  await flow(t, { version: 2, caps: { day: 0.5 + ANTHROPIC_EXPECTED }, killed: false, agent_spend: { spent: { day: 0.5, month: 0.5 }, unknown: 0, as_of: asOf } },
    (c) => c.agentCheck());
});

test("wrapper: enrolled hosted-team cap: same flow through cachedTeamVerdict", async (t) => {
  const asOf = new Date().toISOString();
  await flow(t, { version: 2, caps: { day: 100 }, killed: false, team: { name: "ops", caps: { day: 0.5 + ANTHROPIC_EXPECTED }, spent: { day: 0.5, month: 0.5 }, unknown: 0, as_of: asOf } },
    (c) => c.teamCheck());
});
