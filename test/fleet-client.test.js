import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, statSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enroll, createFleetClient, loadEnrollment, serviceUrl, saveEnrollment, requestRaise } from "../src/hosted/client.js";

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "cc-fleet-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "receipts.jsonl");
  let version = 1, killed = false, status = 200, received = [], enrolls = 0;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/enroll") {
      assert.equal(req.headers.authorization, "Bearer enrollment-token");
      enrolls++;
      res.end(JSON.stringify({ agentId: "agent-1", token: "agent-token", policy: { version, caps: { run: 2 }, killed } }));
    } else {
      assert.equal(req.headers.authorization, "Bearer agent-token");
      if (status !== 200) { res.writeHead(status).end('{}'); return; }
      if (req.url === "/v1/policy") res.end(JSON.stringify({ version, caps: { run: 1 }, killed }));
      else {
        const receipts = JSON.parse(body).receipts;
        received.push(...receipts);
        res.end(JSON.stringify({ acceptedIds: receipts.map((r) => r.id) }));
      }
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  await enroll({ url, token: "enrollment-token", name: "test agent", path });
  return { path, receiptsPath, server, received, update: (v, k = false, s = 200) => { version = v; killed = k; status = s; }, enrolls };
}

test("enrollment requires secure origin, validates cache and keeps credentials private", async (t) => {
  assert.throws(() => serviceUrl("http://example.com"), /HTTPS/);
  assert.throws(() => serviceUrl("https://user:secret@example.com"), /credentials/);
  const f = await setup(t);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(loadEnrollment(f.path).agentId, "agent-1");
});

test("policy updates, cache, receipt acknowledgments and offline behavior", async (t) => {
  const f = await setup(t);
  appendFileSync(f.receiptsPath, JSON.stringify({ id: "r1", ts: new Date().toISOString(), cost_usd: 0.1 }) + "\n");
  let changed;
  const client = createFleetClient({ ...f, onPolicy: (p) => { changed = p; } });
  f.update(2, true);
  assert.equal((await client.sync()).online, true);
  assert.equal(client.policy().killed, true);
  assert.equal(changed.caps.run, 1);
  assert.equal(f.received.length, 1);
  await client.sync();
  assert.equal(f.received.length, 1);
  f.update(2, false); // same version must not resume
  await client.sync();
  assert.equal(client.policy().killed, true);
  f.server.closeAllConnections(); f.server.close();
  const offline = await client.sync();
  assert.equal(offline.online, false);
  assert.equal(client.policy().killed, true);
  const restarted = createFleetClient(f);
  assert.equal(restarted.policy().version, 2);
  assert.ok(!readFileSync(f.path, "utf8").includes("enrollment-token"));
});

test("revocation is not treated as harmless offline", async (t) => {
  const f = await setup(t);
  const client = createFleetClient(f);
  f.update(2, false, 403);
  const result = await client.sync();
  assert.equal(result.revoked, true);
  assert.equal(client.revoked(), true);
});

// Issue #129: local reconcile settlements reach the enrolled path.
async function settleFake(t, { settlementRoute = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cc-fleet-settle-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "receipts.jsonl");
  const settlements = [];
  const as_of = new Date().toISOString();
  const spend = { spent: { day: 0, month: 0 }, unknown: 0, as_of };
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/enroll") return res.end(JSON.stringify({ agentId: "agent-1", token: "agent-token", policy: { version: 1, caps: { day: 5 }, killed: false } }));
    if (req.url === "/v1/policy") return res.end(JSON.stringify({ version: 1, caps: { day: 5 }, killed: false, team: { name: "core", caps: { day: 5 }, spent: { day: 0, month: 0 }, unknown: 0, as_of }, agent_spend: spend }));
    if (req.url === "/v1/receipts") return res.end(JSON.stringify({ acceptedIds: JSON.parse(body).receipts.map((r) => r.id) }));
    if (req.url === "/v1/receipts/settlements" && settlementRoute) {
      const s = JSON.parse(body);
      settlements.push(s);
      if (s.receipt_id === "gone") { res.writeHead(404).end(JSON.stringify({ error: "Receipt not found" })); return; }
      if (s.receipt_id === "dupe") { res.writeHead(409).end(JSON.stringify({ error: "x", code: "already_settled" })); return; }
      return res.end(JSON.stringify({ receipt_id: s.receipt_id, duplicate: false }));
    }
    res.writeHead(404).end(JSON.stringify({ error: "Route not found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await enroll({ url: `http://127.0.0.1:${server.address().port}`, token: "enrollment-token", name: "a", path });
  return { path, receiptsPath, settlements };
}
const line = (o) => JSON.stringify(o) + "\n";

test("#129 AC1: teamCheck and agentCheck count a local settlement; unsettled unknowns still block", async (t) => {
  const f = await settleFake(t);
  const ts = new Date().toISOString();
  appendFileSync(f.receiptsPath, line({ id: "u1", ts, cost_usd: null }) + line({ id: "u2", ts, cost_usd: null }));
  const client = createFleetClient(f);
  await client.sync();
  // Make both receipts look unsynced so they count as pending locally.
  const data = JSON.parse(readFileSync(f.path, "utf8"));
  data.syncedIds = [];
  writeFileSync(f.path, JSON.stringify(data));
  const fresh = createFleetClient(f);
  assert.equal(fresh.teamCheck().verdict, "accounting_unavailable");
  assert.equal(fresh.agentCheck().verdict, "accounting_unavailable");
  appendFileSync(f.receiptsPath, line({ event: "reconciliation", receipt_id: "u1", cost_usd: 1, source: "provider_file", provider_sha256: "b".repeat(64), ts }));
  assert.equal(fresh.teamCheck().unknown_receipts, 1);
  appendFileSync(f.receiptsPath, line({ event: "reconciliation", receipt_id: "u2", cost_usd: 4.5, source: "provider_file", ts }));
  // Settled costs count toward the original day: 1 + 4.5 >= cap 5, so both checks move to budget_exceeded.
  assert.deepEqual([fresh.teamCheck().verdict, fresh.teamCheck().spent_usd], ["budget_exceeded", 5.5]);
  assert.deepEqual([fresh.agentCheck().verdict, fresh.agentCheck().spent_usd], ["budget_exceeded", 5.5]);
});

test("#129 AC2: sync uploads each settlement exactly once, only for synced null-cost receipts", async (t) => {
  const f = await settleFake(t);
  const ts = new Date().toISOString();
  appendFileSync(f.receiptsPath, line({ id: "u1", ts, cost_usd: null }) + line({ id: "known", ts, cost_usd: 1 }) + line({ id: "gone", ts, cost_usd: null }) + line({ id: "dupe", ts, cost_usd: null }));
  appendFileSync(f.receiptsPath, line({ event: "reconciliation", receipt_id: "u1", cost_usd: 2, provider_sha256: "c".repeat(64), ts }));
  appendFileSync(f.receiptsPath, line({ event: "reconciliation", receipt_id: "u1", cost_usd: 99, ts }));
  appendFileSync(f.receiptsPath, line({ event: "reconciliation", receipt_id: "known", cost_usd: 3, ts }));
  appendFileSync(f.receiptsPath, line({ event: "reconciliation", receipt_id: "gone", cost_usd: 1, ts }));
  appendFileSync(f.receiptsPath, line({ event: "reconciliation", receipt_id: "dupe", cost_usd: 1, ts }));
  appendFileSync(f.receiptsPath, line({ event: "reconciliation", receipt_id: "never-synced", cost_usd: 1, ts }));
  const client = createFleetClient(f);
  assert.equal((await client.sync()).online, true);
  assert.deepEqual(f.settlements.map((s) => s.receipt_id), ["u1", "gone", "dupe"]);
  assert.deepEqual(f.settlements[0], { receipt_id: "u1", cost_usd: 2, provider_sha256: "c".repeat(64), ts });
  assert.deepEqual(loadEnrollment(f.path).syncedSettlementIds.sort(), ["dupe", "u1"]);
  f.settlements.length = 0;
  await client.sync();
  // Only the still-missing receipt is retried; nothing already uploaded is sent again.
  assert.deepEqual(f.settlements.map((s) => s.receipt_id), ["gone"]);
});

test("#129 AC6: an older server without the settlement route does not fail receipt sync", async (t) => {
  const f = await settleFake(t, { settlementRoute: false });
  const ts = new Date().toISOString();
  appendFileSync(f.receiptsPath, line({ id: "u1", ts, cost_usd: null }) + line({ id: "u2", ts, cost_usd: null }));
  appendFileSync(f.receiptsPath, line({ event: "reconciliation", receipt_id: "u1", cost_usd: 2, ts }) + line({ event: "reconciliation", receipt_id: "u2", cost_usd: 2, ts }));
  const client = createFleetClient(f);
  const r = await client.sync();
  assert.equal(r.online, true);
  assert.equal(client.revoked(), false);
  assert.deepEqual(loadEnrollment(f.path).syncedIds.sort(), ["u1", "u2"]);
  assert.equal(loadEnrollment(f.path).syncedSettlementIds, undefined);
});

// #204: fleet tag caps are cached, enforced offline, refreshed and lifted by a newer poll.
test("#204 fleet tag caps: cached offline, merged with local rules, invalid payload rejected, removal lifts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-fleet-tags-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "receipts.jsonl");
  const now = new Date().toISOString();
  let tagCaps = { rules: [{ key: "customer", scope: "day", usd: 1 }], spend: { customer: { acme: { day: 0.9, month: 0.9, unknown: 0 } } }, truncated: false, as_of: now };
  let status = 200;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader("content-type", "application/json");
    if (status !== 200) { res.writeHead(status).end("{}"); return; }
    if (req.url === "/v1/enroll") res.end(JSON.stringify({ agentId: "a", token: "agent-token", policy: { version: 1, caps: {}, killed: false } }));
    else if (req.url === "/v1/policy") res.end(JSON.stringify({ version: 1, caps: {}, killed: false, tag_caps: tagCaps }));
    else res.end(JSON.stringify({ acceptedIds: [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await enroll({ url: `http://127.0.0.1:${server.address().port}`, token: "e", name: "x", path });
  const client = createFleetClient({ path, receiptsPath });
  assert.equal(client.tagCheck({ customer: "acme" }), null); // nothing cached yet
  assert.equal((await client.sync()).online, true);
  assert.equal(client.tagCheck({ customer: "acme" }), null);
  assert.equal(client.tagCheck({ customer: "acme" }, [{ key: "customer", scope: "day", cap: 0.5 }]).cap_usd, 0.5);
  appendFileSync(receiptsPath, JSON.stringify({ id: "p1", ts: now, cost_usd: 0.2, tags: { customer: "acme" } }) + "\n");
  assert.equal(client.tagCheck({ customer: "acme" }).spend_usd, 1.1);
  // Offline: the cached rules and spend keep enforcing, also after a restart.
  status = 503;
  assert.equal((await client.sync()).online, false);
  assert.equal(createFleetClient({ path, receiptsPath }).tagCheck({ customer: "acme" }).fleet, true);
  // An invalid payload is refused and the cache kept.
  status = 200;
  tagCaps = { rules: [{ key: "customer", scope: "hour", usd: 1 }], spend: {}, truncated: false, as_of: now };
  assert.equal((await client.sync()).online, false);
  assert.equal(client.tagCheck({ customer: "acme" }).fleet, true);
  tagCaps = null;
  assert.equal((await client.sync()).online, true);
  assert.equal(client.tagCaps(), null);
  assert.equal(client.tagCheck({ customer: "acme" }), null);
});

// Issue #208 regression: an offline wrapper on a cached raised policy refuses again
// after expires_at, with no fetch, and a local cap still tightens the raised cap.
test("regression #208: offline wrapper reverts to base caps when a cached raise expires", async (t) => {
  const f = await setup(t);
  const now = Date.now();
  const data = loadEnrollment(f.path);
  data.policy = { version: 5, caps: { day: 5 }, killed: false, raise: { day: { cap: 25, expires_at: new Date(now + 3600_000).toISOString(), request_id: "req-1" } } };
  data.agentSpend = { spent: { day: 6, month: 6 }, unknown: 0, as_of: new Date(now).toISOString() };
  saveEnrollment(f.path, data);
  f.server.closeAllConnections(); f.server.close(); // offline from here on
  const client = createFleetClient(f);
  assert.equal(client.policy(now).caps.day, 25);
  assert.equal(client.agentCheck(now), null);
  const later = now + 3600_000 + 1;
  assert.equal(client.policy(later).caps.day, 5);
  assert.equal(client.agentCheck(later).verdict, "budget_exceeded");
  assert.equal(client.agentCheck(later).cap_usd, 5);
  assert.equal((await client.sync()).online, false);
});

test("#208: requestRaise files a request with the enrollment token and maps errors", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-raise-"));
  const path = join(dir, "enrollment.json");
  let status = 201, seen;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 201 ? { id: "req-1", status: "pending", ...seen.body } : { error: "x" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  saveEnrollment(path, { url: `http://127.0.0.1:${server.address().port}`, token: "agent-token", agentId: "agent-1", policy: { version: 1, caps: { day: 5 }, killed: false }, syncedIds: [] });
  const r = await requestRaise({ path, scope: "day", amountUsd: 20, durationHours: 4, reason: "batch" });
  assert.equal(r.id, "req-1");
  assert.equal(seen.url, "/v1/agents/agent-1/cap-requests");
  assert.equal(seen.auth, "Bearer agent-token");
  assert.deepEqual(seen.body, { scope: "day", amount_usd: 20, duration_hours: 4, reason: "batch" });
  status = 409; await assert.rejects(requestRaise({ path, scope: "day", amountUsd: 20, durationHours: 4, reason: "b" }), /already pending/);
  status = 400; await assert.rejects(requestRaise({ path, scope: "day", amountUsd: 20, durationHours: 4, reason: "b" }), /request rejected/);
  status = 500; await assert.rejects(requestRaise({ path, scope: "day", amountUsd: 20, durationHours: 4, reason: "b" }), /HTTP 500/);
});

// Issue #209 AC5: the synced budget_period is cached and drives offline rollover.
test("#209 offline cachedTotals zero synced spend at the configured period rollover, not UTC", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-fleet-period-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "receipts.jsonl");
  let budgetPeriod = { timezone: "America/Los_Angeles", monthStartDay: 1 };
  const agentSpend = { spent: { day: 3, month: 3 }, unknown: 0, pending_batches: 0, as_of: "2026-11-16T04:00:00.000Z" };
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/enroll") res.end(JSON.stringify({ agentId: "a", token: "agent-token", policy: { version: 1, caps: { day: 3 }, killed: false } }));
    else if (req.url === "/v1/policy") res.end(JSON.stringify({ version: 1, caps: { day: 3 }, killed: false, agent_spend: agentSpend, budget_period: budgetPeriod }));
    else res.end(JSON.stringify({ acceptedIds: [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await enroll({ url: `http://127.0.0.1:${server.address().port}`, token: "e", name: "x", path });
  const client = createFleetClient({ path, receiptsPath });
  assert.equal((await client.sync()).online, true);
  assert.deepEqual(client.budgetPeriod(), budgetPeriod);
  // Offline after a restart: same LA day blocks, LA midnight (08:00Z) lifts.
  const cold = createFleetClient({ path, receiptsPath });
  assert.equal(cold.agentCheck(Date.parse("2026-11-16T07:30:00Z")).verdict, "budget_exceeded");
  assert.equal(cold.agentCheck(Date.parse("2026-11-16T08:30:00Z")), null);
  assert.equal(cold.preflightRemaining(Date.parse("2026-11-16T08:30:00Z")).agent.day, 3);
  // An invalid period is refused and the cache kept.
  budgetPeriod = { timezone: "Not/AZone" };
  assert.equal((await client.sync()).online, false);
  assert.deepEqual(client.budgetPeriod(), { timezone: "America/Los_Angeles", monthStartDay: 1 });
  // Removing it (older server: null) reverts to UTC windows.
  budgetPeriod = null;
  assert.equal((await client.sync()).online, true);
  assert.equal(client.budgetPeriod(), null);
  assert.equal(client.agentCheck(Date.parse("2026-11-16T08:30:00Z")).verdict, "budget_exceeded");
});
