// Issue #125: hosted settlement of unknown-cost receipts (audited, never $0).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer, costedReceipt, settleInput, spendSummary } from "../src/hosted/server.js";
import { buildEvidence } from "../src/hosted/evidence.js";

async function fixture(t) {
  let code; const invites = [];
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-settle-")), "store.json");
  const origin = "http://localhost";
  let service;
  const start = async () => {
    service = createHostedServer({ storePath, origin, secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async (d) => { invites.push(d); }, deliverAlert: async () => [{ status: "accepted" }] });
    service.server.keepAliveTimeout = 60_000;
    await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  };
  await start();
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth, originValue = origin) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(originValue ? { origin: originValue } : {}), "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    return (await request("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  };
  const restart = async () => { service.server.closeAllConnections(); await new Promise((r) => service.server.close(r)); await start(); };
  return { request, login, restart, service: () => service };
}

async function seeded(t) {
  const f = await fixture(t);
  const owner = await f.login("settle-owner@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 5, month: 20 } }, owner)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "meter" }, null, token)).body;
  const ts = new Date().toISOString();
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "known", ts, cost_usd: 1, model: "m" },
    { id: "unk", ts, cost_usd: null, model: "m" },
  ] }, null, agent.token)).status, 200);
  assert.equal((await f.request("/v1/teams", { name: "core", agents: [agent.agentId], day: 5 }, owner)).status, 200);
  return { f, owner, agent };
}
const good = { cost_usd: 2.5, source: "provider_invoice", reason: "Invoice INV-1 line 3" };

test("unit: settleInput validates cost, source and reason", () => {
  assert.deepEqual(settleInput({ ...good, reason: "  r  " }), { cost_usd: 2.5, source: "provider_invoice", reason: "r", agentId: undefined });
  for (const bad of [{ ...good, cost_usd: -1 }, { ...good, cost_usd: "1" }, { ...good, cost_usd: Infinity }, { ...good, cost_usd: null },
    { ...good, source: "guess" }, { ...good, reason: "" }, { ...good, reason: " " }, { ...good, reason: "x".repeat(501) }, { ...good, agent_id: 5 }, undefined]) {
    assert.throws(() => settleInput(bad), (e) => e.status === 400);
  }
  assert.equal(settleInput({ ...good, cost_usd: 0 }).cost_usd, 0);
});

test("unit: costedReceipt uses settlement only for null-cost receipts; spend and evidence follow", () => {
  const ts = "2026-11-15T01:00:00.000Z";
  const open = { agentId: "a", receipt: { id: "u1", ts, cost_usd: null } };
  const settled = { agentId: "a", receipt: { id: "u2", ts, cost_usd: null }, settlement: { cost_usd: 3, at: ts, by: "u", source: "manual_evidence", reason: "r" } };
  const known = { agentId: "a", receipt: { id: "k", ts, cost_usd: 1 }, settlement: { cost_usd: 9 } };
  assert.equal(costedReceipt(open).cost_usd, null);
  assert.equal(costedReceipt(settled).cost_usd, 3);
  assert.equal(settled.receipt.cost_usd, null, "stored receipt is never rewritten");
  assert.equal(costedReceipt(known).cost_usd, 1);
  const nowMs = Date.parse(ts);
  const spend = spendSummary([open, settled, known], nowMs);
  assert.deepEqual(spend.day, { usd: 4, unknown: 1 });
  const ev = (rs) => buildEvidence({ orgId: "o", nowMs, spendFor: (x) => spendSummary(x, nowMs), agents: [{ id: "a" }], receipts: rs });
  const partial = ev([open, settled]);
  assert.equal(partial.totals.unknown_cost_receipts, 1);
  assert.equal(partial.totals.cost_complete, false);
  assert.equal(partial.agents[0].spend.day.cost_complete, false);
  const row = partial.receipts.find((r) => r.receipt_id === "u2");
  assert.equal(row.cost_usd, null);
  assert.equal(row.settled_cost_usd, 3);
  assert.equal(row.settle_source, "manual_evidence");
  const full = ev([settled, known]);
  assert.equal(full.totals.cost_complete, true);
  assert.equal(full.totals.unknown_cost_receipts, 0);
  assert.equal(full.agents[0].spend.day.cost_complete, true);
});

test("AC1/2: settle auth, CSRF, validation and conflicts change no state", async (t) => {
  const { f, owner, agent } = await seeded(t);
  const other = await f.login("settle-other@example.invalid");
  assert.equal((await f.request("/v1/invitations", { email: "settle-viewer@example.invalid", role: "viewer" }, owner)).status, 201);
  const viewer = await f.login("settle-viewer@example.invalid");
  const snapshot = () => f.service().server && f.request("/v1/evidence.json", undefined, owner).then((r) => JSON.stringify(r.body.receipts));
  const before = await snapshot();
  assert.equal((await f.request("/v1/receipts/unk/settle", good, viewer)).status, 403);
  assert.equal((await f.request("/v1/receipts/unk/settle", good, other)).status, 404);
  assert.equal((await f.request("/v1/receipts/unk/settle", good, owner, null, "https://evil.example")).status, 403);
  assert.equal((await f.request("/v1/receipts/unk/settle", good, owner, null, null)).status, 403);
  assert.equal((await f.request("/v1/receipts/unk/settle", good)).status, 401);
  assert.equal((await f.request("/v1/receipts/unk/settle", good, null, agent.token)).status, 401);
  assert.equal((await f.request("/v1/receipts/unk/settle", { ...good, source: "nope" }, owner)).status, 400);
  assert.equal((await f.request("/v1/receipts/unk/settle", { ...good, cost_usd: -0.01 }, owner)).status, 400);
  assert.equal((await f.request("/v1/receipts/missing/settle", good, owner)).status, 404);
  assert.equal((await f.request("/v1/receipts/unk/settle", { ...good, agent_id: "someone-else" }, owner)).status, 404);
  const known = await f.request("/v1/receipts/known/settle", good, owner);
  assert.equal(known.status, 409);
  assert.equal(known.body.code, "already_known");
  assert.equal(await snapshot(), before);
  const ok = await f.request("/v1/receipts/unk/settle", { ...good, agent_id: agent.agentId }, owner);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cost_usd, null);
  assert.equal(ok.body.settled_cost_usd, 2.5);
  assert.equal(ok.body.settle_source, "provider_invoice");
  const again = await f.request("/v1/receipts/unk/settle", { ...good, cost_usd: 1 }, owner);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "already_settled");
  const ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
  assert.equal(ev.receipts.find((r) => r.receipt_id === "unk").settled_cost_usd, 2.5);
  assert.equal(ev.audit.filter((e) => e.action === "receipt.settle").length, 1);
});

test("AC3-6: settlement is audited, unblocks verdicts, completes evidence and survives restart", async (t) => {
  const { f, owner, agent } = await seeded(t);
  const blocked = (await f.request(`/v1/agents/${agent.agentId}/budget`, undefined, owner)).body;
  assert.equal(blocked.verdict, "accounting_unavailable");
  assert.equal((await f.request("/v1/teams", undefined, owner)).body.teams[0].verdict, "accounting_unavailable");
  let ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
  assert.equal(ev.totals.cost_complete, false);
  assert.equal(ev.totals.unknown_cost_receipts, 1);

  assert.equal((await f.request("/v1/receipts/unk/settle", good, owner)).status, 200);
  const check = async () => {
    const fleet = (await f.request("/v1/fleet", undefined, owner)).body;
    const spend = fleet.agents[0].spend;
    assert.deepEqual([spend.day.usd, spend.day.unknown, spend.month.usd, spend.month.unknown], [3.5, 0, 3.5, 0]);
    const unk = fleet.receipts.find((r) => r.receipt.id === "unk");
    assert.equal(unk.receipt.cost_usd, null);
    assert.equal(unk.settlement.cost_usd, 2.5);
    const verdict = (await f.request(`/v1/agents/${agent.agentId}/budget`, undefined, owner)).body;
    assert.equal(verdict.verdict, "ok");
    const team = (await f.request("/v1/teams", undefined, owner)).body.teams[0];
    assert.equal(team.verdict, "ok");
    assert.equal(team.spend.unknown_count, 0);
    assert.equal(team.spend.day_usd, 3.5);
    ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
    assert.equal(ev.totals.cost_complete, true);
    assert.equal(ev.totals.unknown_cost_receipts, 0);
    assert.equal(ev.agents[0].spend.day.cost_complete, true);
    const row = ev.receipts.find((r) => r.receipt_id === "unk");
    assert.deepEqual([row.cost_usd, row.settled_cost_usd, row.settle_source, row.settle_reason], [null, 2.5, "provider_invoice", "Invoice INV-1 line 3"]);
    assert.ok(row.settled_at && row.settled_by);
    const entry = ev.audit.find((e) => e.action === "receipt.settle");
    assert.equal(entry.target, "unk");
    assert.deepEqual(entry.detail, { event: "reconciliation", agent_id: agent.agentId, before: null, after: 2.5, source: "provider_invoice", reason: "Invoice INV-1 line 3" });
    const csv = (await f.request("/v1/receipts.csv", undefined, owner)).body;
    assert.match(csv, /,unk,m,,2\.5,provider_invoice,/);
  };
  await check();
  await f.restart();
  await check();
});

test("AC4: a settled cost over the team cap moves the verdict to budget_exceeded and fires alerts", async (t) => {
  const { f, owner, agent } = await seeded(t);
  assert.equal((await f.request("/v1/receipts/unk/settle", { ...good, cost_usd: 6 }, owner)).status, 200);
  const verdict = (await f.request(`/v1/agents/${agent.agentId}/budget`, undefined, owner)).body;
  assert.equal(verdict.verdict, "budget_exceeded");
  assert.equal((await f.request("/v1/teams", undefined, owner)).body.teams[0].verdict, "budget_exceeded");
  await f.service().evaluateFleetAlerts();
  const alerts = (await f.request("/v1/fleet", undefined, owner)).body.alerts.filter((a) => a.active).map((a) => a.kind);
  assert.ok(alerts.some((k) => /100|cap|exceed/i.test(k)), JSON.stringify(alerts));
});

test("settle by id is ambiguous across two agents unless agent_id is given", async (t) => {
  const { f, owner, agent } = await seeded(t);
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 5 } }, owner)).body.token;
  const second = (await f.request("/v1/enroll", { name: "two" }, null, token)).body;
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "unk", ts: new Date().toISOString(), cost_usd: null }] }, null, second.token)).status, 200);
  assert.equal((await f.request("/v1/receipts/unk/settle", good, owner)).status, 409);
  assert.equal((await f.request("/v1/receipts/unk/settle", { ...good, agent_id: second.agentId }, owner)).status, 200);
  assert.equal((await f.request("/v1/receipts/unk/settle", { ...good, agent_id: agent.agentId }, owner)).status, 200);
});
