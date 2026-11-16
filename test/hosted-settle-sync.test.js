// Issue #162: a dashboard (admin) settlement of an unknown-cost receipt reaches the
// enrolled wrapper's local ledger on the next poll and unblocks the paused agent.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer, agentSettlements } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import { createCapEngine, loadSettledReceipts, loadEvents } from "../src/cap.js";
import { guardedBudgetStatus } from "../src/check.js";

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "cc-162-"));
  let code;
  const origin = "http://localhost";
  const service = createHostedServer({ storePath: join(dir, "store.json"), origin, secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [] });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const req = async (path, body, cookie) => {
    const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const c = await req("/auth/request", { email: "reg-162@example.invalid", turnstileToken: "x" });
  const owner = (await req("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  const agent = async (name) => {
    const enrollToken = (await req("/v1/enrollment-tokens", { caps: { day: 10, month: 50 } }, owner)).body.token;
    const path = join(dir, `${name}.json`), receiptsPath = join(dir, `${name}.jsonl`);
    const { agentId } = await enroll({ url: base, token: enrollToken, name, path });
    return { agentId, path, receiptsPath };
  };
  return { req, owner, agent };
}

const hostedLines = (p) => loadEvents(p).filter((e) => e.source === "hosted_settle");

test("regression #162: admin settle reaches the wrapper ledger once and unblocks it", async (t) => {
  const { req, owner, agent } = await setup(t);
  const a = await agent("a");
  const ts = new Date().toISOString();
  const original = JSON.stringify({ id: "unk-1", ts, cost_usd: null, reason: "usage_unavailable" });
  appendFileSync(a.receiptsPath, original + "\n");
  let settledCalls = [];
  const client = createFleetClient({ path: a.path, receiptsPath: a.receiptsPath, onSettle: (r) => settledCalls.push(r) });
  assert.equal((await client.sync()).online, true);
  const cap = createCapEngine({ caps: { day: 10 }, history: loadSettledReceipts(a.receiptsPath) });
  assert.equal(cap.check().reason, "unreconciled_receipt");
  const before = guardedBudgetStatus({ receiptsPath: a.receiptsPath, enrollmentPath: a.path, caps: { day: 10 } });
  assert.equal(before.ok, false);

  const s = await req("/v1/receipts/unk-1/settle", { cost_usd: 0.75, source: "provider_invoice", reason: "provider invoice" }, owner);
  assert.equal(s.status, 200);
  // Policy response carries this agent's settlement with the audit id.
  const audit = (await req("/v1/evidence.json", undefined, owner)).body.audit.find((e) => e.action === "receipt.settle");
  assert.ok(audit.detail.audit_id);

  assert.equal((await client.sync()).online, true);
  const lines = hostedLines(a.receiptsPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].receipt_id, "unk-1");
  assert.equal(lines[0].cost_usd, 0.75);
  assert.equal(lines[0].settle_source, "provider_invoice");
  assert.equal(lines[0].audit_id, audit.detail.audit_id);
  // Original receipt line untouched.
  assert.equal(readFileSync(a.receiptsPath, "utf8").split("\n")[0], original);
  assert.equal(settledCalls.length, 1);
  assert.ok(cap.settle(settledCalls[0]));
  assert.equal(cap.check(), null);
  assert.equal(cap.spend().day, 0.75);
  // A fresh wrap's history is no longer blocked; cost counts toward original day.
  const fresh = createCapEngine({ caps: { day: 10 }, history: loadSettledReceipts(a.receiptsPath) });
  assert.equal(fresh.check(), null);
  assert.equal(fresh.spend().day, 0.75);
  // Local agent-status and hosted budget agree.
  const after = guardedBudgetStatus({ receiptsPath: a.receiptsPath, enrollmentPath: a.path, caps: { day: 10 } });
  assert.equal(after.ok, true);
  const hosted = (await req(`/v1/agents/${a.agentId}/budget`, undefined, owner)).body;
  assert.equal(hosted.verdict, after.ok ? "ok" : after.verdict);

  // Idempotent: repeat polls add nothing.
  await client.sync(); await client.sync();
  assert.equal(hostedLines(a.receiptsPath).length, 1);
  assert.equal(settledCalls.length, 1);
});

test("#162: other agents' settlements, known costs and locally settled receipts are ignored", async (t) => {
  const { req, owner, agent } = await setup(t);
  const a = await agent("a"), b = await agent("b");
  const ts = new Date().toISOString();
  appendFileSync(a.receiptsPath, JSON.stringify({ id: "known-1", ts, cost_usd: 0.1 }) + "\n" + JSON.stringify({ id: "loc-1", ts, cost_usd: null }) + "\n");
  appendFileSync(b.receiptsPath, JSON.stringify({ id: "b-1", ts, cost_usd: null }) + "\n");
  const ca = createFleetClient({ path: a.path, receiptsPath: a.receiptsPath });
  const cb = createFleetClient({ path: b.path, receiptsPath: b.receiptsPath });
  await ca.sync(); await cb.sync();
  // Locally settled first, then admin settles a different cost on the hosted copy.
  appendFileSync(a.receiptsPath, JSON.stringify({ event: "reconciliation", source: "provider", receipt_id: "loc-1", cost_usd: 0.2 }) + "\n");
  assert.equal((await req("/v1/receipts/b-1/settle", { cost_usd: 5, source: "provider_invoice", reason: "r" }, owner)).status, 200);
  // A known-cost receipt cannot be settled hosted-side.
  assert.equal((await req("/v1/receipts/known-1/settle", { cost_usd: 9, source: "provider_invoice", reason: "r" }, owner)).status, 409);
  await ca.sync();
  assert.equal(hostedLines(a.receiptsPath).length, 0);
  const settled = loadSettledReceipts(a.receiptsPath);
  assert.equal(settled.find((r) => r.id === "known-1").cost_usd, 0.1);
  assert.equal(settled.find((r) => r.id === "loc-1").cost_usd, 0.2);
  // b gets only its own.
  await cb.sync();
  assert.deepEqual(hostedLines(b.receiptsPath).map((e) => e.receipt_id), ["b-1"]);
});

test("#162: client ignores forged settlements for unknown ids, known costs and bad values", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-162u-"));
  const receiptsPath = join(dir, "r.jsonl"), path = join(dir, "e.json");
  const ts = new Date().toISOString();
  appendFileSync(receiptsPath, JSON.stringify({ id: "n1", ts, cost_usd: null }) + "\n" + JSON.stringify({ id: "k1", ts, cost_usd: 1 }) + "\n");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:1", token: "t", agentId: "x", policy: { version: 1, caps: { day: 5 } }, syncedIds: ["n1", "k1"] }));
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  const settlements = [
    { receipt_id: "k1", settled_cost_usd: 9 }, { receipt_id: "other", settled_cost_usd: 1 },
    { receipt_id: "n1", settled_cost_usd: -1 }, { receipt_id: "n1", settled_cost_usd: "1" }, null,
    { receipt_id: "n1", settled_cost_usd: 0.5, settle_source: "provider_invoice", audit_id: "aud-1" },
    { receipt_id: "n1", settled_cost_usd: 0.9 },
  ];
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).endsWith("/v1/policy") ? { version: 1, caps: { day: 5 }, settlements } : { acceptedIds: [] }) });
  const client = createFleetClient({ path, receiptsPath });
  assert.equal((await client.sync()).online, true);
  assert.deepEqual(hostedLines(receiptsPath).map((e) => [e.receipt_id, e.cost_usd, e.audit_id]), [["n1", 0.5, "aud-1"]]);
  assert.equal(loadSettledReceipts(receiptsPath).find((r) => r.id === "k1").cost_usd, 1);
  // Non-array settlements are rejected as an invalid response.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ version: 1, caps: { day: 5 }, settlements: "x" }) });
  assert.equal((await client.sync()).online, false);
});

test("#162: cap.settle and agentSettlements unit", () => {
  const cap = createCapEngine({ caps: { day: 1 }, history: [{ ts: new Date().toISOString(), cost_usd: null }] });
  assert.equal(cap.settle({ cost_usd: -1 }), false);
  assert.equal(cap.settle(null), false);
  assert.equal(cap.settle({ cost_usd: 0.3 }), true);
  assert.equal(cap.settle({ cost_usd: 0.3 }), false);
  assert.equal(cap.check(), null);
  const s = { receipts: {
    a: { orgId: "o", agentId: "x", receipt: { id: "r1", cost_usd: null }, settlement: { cost_usd: 2, source: "provider_invoice", audit_id: "z" } },
    b: { orgId: "o", agentId: "y", receipt: { id: "r2", cost_usd: null }, settlement: { cost_usd: 3 } },
    c: { orgId: "o", agentId: "x", receipt: { id: "r3", cost_usd: null } },
    d: { orgId: "o", agentId: "x", receipt: { id: "r4", cost_usd: null }, settlement: { cost_usd: 4 } },
  } };
  assert.deepEqual(agentSettlements(s, { orgId: "o", id: "x" }), [
    { receipt_id: "r1", settled_cost_usd: 2, settle_source: "provider_invoice", audit_id: "z" },
    { receipt_id: "r4", settled_cost_usd: 4, settle_source: null, audit_id: null },
  ]);
  assert.deepEqual(agentSettlements({}, { orgId: "o", id: "x" }), []);
});
