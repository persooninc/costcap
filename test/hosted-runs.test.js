// Issue #159: hosted per-run drill-down (grouping, settled handling, paging, retention, auth).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { summarizeRuns, pageRuns, parseRunsQuery, runReceipts, RUNS_MAX_LIMIT } from "../src/hosted/runs.js";
import { receiptsCsv, parseReceiptsQuery } from "../src/hosted/receipts-csv.js";

const T = (min) => new Date(Date.UTC(2026, 10, 16, 0, min)).toISOString();
const fixtureReceipts = () => [
  { receipt: { id: "a1", ts: T(1), run_id: "run-a", model: "gpt-4o", cost_usd: 0.1234561 } },
  { receipt: { id: "a2", ts: T(2), run_id: "run-a", model: "claude-sonnet-4", cost_usd: 0.2 } },
  { receipt: { id: "b1", ts: T(3), run_id: "run-b", model: "gpt-4o", cost_usd: 1 } },
  { receipt: { id: "b2", ts: T(4), run_id: "run-b", model: "gpt-4o", cost_usd: null } },
  { receipt: { id: "c1", ts: T(5), run_id: "run-c", model: "gpt-4o", cost_usd: 0.5 } },
  { receipt: { id: "c2", ts: T(6), run_id: "run-c", model: "o3", cost_usd: 0, blocked: true, outcome: "blocked_model" } },
];

test("unit: summarizeRuns groups exact calls, usd (6 dp), unknown, blocked and models; unknown never $0", () => {
  const runs = summarizeRuns(fixtureReceipts());
  assert.deepEqual(runs.map((r) => r.run_id), ["run-c", "run-b", "run-a"]);
  const [c, b, a] = runs;
  assert.equal(a.calls, 2); assert.equal(a.usd_known, 0.323456); assert.equal(a.cost_complete, true);
  assert.deepEqual(a.models, [{ model: "claude-sonnet-4", calls: 1, usd_known: 0.2 }, { model: "gpt-4o", calls: 1, usd_known: 0.123456 }]);
  assert.equal(b.usd_known, 1); assert.equal(b.unknown_count, 1); assert.equal(b.cost_complete, false);
  assert.deepEqual(b.models, [{ model: "gpt-4o", calls: 2, usd_known: 1 }]);
  assert.equal(c.blocked_count, 1); assert.equal(c.unknown_count, 0); assert.equal(c.first_ts, T(5)); assert.equal(c.last_ts, T(6));
  // missing run_id and bad ts
  const odd = summarizeRuns([{ receipt: { id: "x", ts: T(1), cost_usd: 1 } }, { receipt: { id: "y", ts: "nope" } }, null]);
  assert.deepEqual(odd.map((r) => [r.run_id, r.calls, r.models[0].model]), [["(none)", 1, "unknown"]]);
});

test("unit: a settled unknown counts at its settled value and unknown_count drops", () => {
  const items = fixtureReceipts();
  items[3].settlement = { cost_usd: 2.5, source: "provider_invoice" };
  const b = summarizeRuns(items).find((r) => r.run_id === "run-b");
  assert.equal(b.usd_known, 3.5); assert.equal(b.unknown_count, 0); assert.equal(b.cost_complete, true);
  const rows = runReceipts(items, "run-b");
  assert.deepEqual(rows.map((r) => [r.receipt_id, r.usd_known, r.settled_cost_usd, r.unknown]), [["b1", 1, null, false], ["b2", 2.5, 2.5, false]]);
});

test("unit: paging walks 120 runs newest first exactly once; retention and since exclude old runs", () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ receipt: { id: `r${i}`, ts: new Date(Date.UTC(2026, 9, 1) + (i % 7 === 0 ? 0 : i) * 60_000).toISOString(), run_id: `run-${String(i).padStart(3, "0")}`, cost_usd: 0.01 } }));
  const seen = []; let cursor; let pages = 0;
  do {
    const page = pageRuns(items, { limit: 25, cursor: cursor && parseRunsQuery(new URLSearchParams({ cursor })).cursor });
    seen.push(...page.runs); cursor = page.next_cursor; pages += 1;
  } while (cursor);
  assert.equal(pages, 5);
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen.map((r) => r.run_id)).size, 120);
  for (let i = 1; i < seen.length; i++) assert.ok(Date.parse(seen[i - 1].last_ts) >= Date.parse(seen[i].last_ts));
  const cutoff = Date.UTC(2026, 9, 1) + 100 * 60_000;
  const kept = pageRuns(items, { limit: 100, cutoff }).runs;
  assert.ok(kept.length > 0 && kept.every((r) => Date.parse(r.first_ts) >= cutoff));
  assert.deepEqual(pageRuns(items, { since: cutoff, limit: 100 }).runs, kept);
  assert.deepEqual(runReceipts(items, "run-001", { cutoff }), []);
});

test("unit: parseRunsQuery validates limit, since, cursor", () => {
  assert.equal(parseRunsQuery(new URLSearchParams()).limit, 20);
  assert.equal(parseRunsQuery(new URLSearchParams("limit=9999")).limit, RUNS_MAX_LIMIT);
  assert.equal(parseRunsQuery(new URLSearchParams("since=1000")).since, 1000);
  assert.equal(parseRunsQuery(new URLSearchParams("since=2026-11-01T00:00:00Z")).since, Date.parse("2026-11-01T00:00:00Z"));
  for (const q of ["limit=0", "limit=x", "since=nope", "cursor=%%%", `cursor=${Buffer.from("[1,2]").toString("base64url")}`]) {
    assert.throws(() => parseRunsQuery(new URLSearchParams(q)), (e) => e.status === 400, q);
  }
});

test("unit: receipts CSV has run_id after receipt_id and filters by run_id", () => {
  const rows = [{ ts: T(1), agent_id: "a", receipt_id: "1", run_id: "r1" }, { ts: T(2), agent_id: "a", receipt_id: "2", run_id: "r2" }];
  const { body, count } = receiptsCsv(rows, { runId: "r2" });
  assert.equal(count, 1);
  assert.equal(body.split("\n")[0], "ts,agent_id,receipt_id,run_id,model,cost_usd,cost_source,settled_cost_usd,settle_source,reason,scope,outcome,tags");
  assert.match(body.split("\n")[1], /^.*,a,2,r2,/);
  const range = () => ({});
  assert.deepEqual(parseReceiptsQuery(new URLSearchParams("run_id=r1"), new Set(), range), { runId: "r1" });
  assert.throws(() => parseReceiptsQuery(new URLSearchParams("run_id="), new Set(), range), (e) => e.status === 400);
  assert.throws(() => parseReceiptsQuery(new URLSearchParams(`run_id=${"x".repeat(201)}`), new Set(), range), (e) => e.status === 400);
});

async function fixture(t, extra = {}) {
  let code;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-runs-")), "store.json");
  const service = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, ...extra });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => { const c = await request("/auth/request", { email, turnstileToken: "x" }); return (await request("/auth/verify", { challengeId: c.body.challengeId, code })).cookie; };
  const enroll = async (owner, name) => { const tok = (await request("/v1/enrollment-tokens", { caps: { day: 50 } }, owner)).body.token; return (await request("/v1/enroll", { name }, null, tok)).body; };
  return { request, login, enroll };
}

test("server: GET /v1/agents/:id/runs, run detail, settle, CSV run_id and access rules", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("runs-owner@example.invalid");
  const agent = await f.enroll(owner, "runner");
  const other = await f.enroll(owner, "other");
  const now = Date.now();
  const receipts = fixtureReceipts().map(({ receipt }, i) => ({ ...receipt, ts: new Date(now - (10 - i) * 60_000).toISOString() }));
  assert.equal((await f.request("/v1/receipts", { receipts }, null, agent.token)).status, 200);

  const list = await f.request(`/v1/agents/${agent.agentId}/runs`, undefined, owner);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.runs.map((r) => [r.run_id, r.calls, r.usd_known, r.unknown_count, r.blocked_count, r.cost_complete]),
    [["run-c", 2, 0.5, 0, 1, true], ["run-b", 2, 1, 1, 0, false], ["run-a", 2, 0.323456, 0, 0, true]]);
  assert.equal(list.body.next_cursor, null);
  const paged = await f.request(`/v1/agents/${agent.agentId}/runs?limit=2`, undefined, owner);
  assert.equal(paged.body.runs.length, 2);
  const rest = await f.request(`/v1/agents/${agent.agentId}/runs?limit=2&cursor=${paged.body.next_cursor}`, undefined, owner);
  assert.deepEqual(rest.body.runs.map((r) => r.run_id), ["run-a"]);
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs?limit=0`, undefined, owner)).status, 400);

  const detail = await f.request(`/v1/agents/${agent.agentId}/runs/run-b`, undefined, owner);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.receipts.map((r) => [r.receipt_id, r.unknown]), [["b1", false], ["b2", true]]);
  assert.equal(detail.body.run.cost_complete, false);
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs/nope`, undefined, owner)).status, 404);

  assert.equal((await f.request("/v1/receipts/b2/settle", { agent_id: agent.agentId, cost_usd: 2.5, source: "provider_invoice", reason: "INV-9" }, owner)).status, 200);
  const settled = (await f.request(`/v1/agents/${agent.agentId}/runs`, undefined, owner)).body.runs.find((r) => r.run_id === "run-b");
  assert.equal(settled.usd_known, 3.5); assert.equal(settled.unknown_count, 0);

  const csv = await f.request(`/v1/receipts.csv?run_id=run-a`, undefined, owner);
  assert.equal(csv.status, 200);
  const lines = csv.body.trim().split("\n");
  assert.match(lines[0], /^ts,agent_id,receipt_id,run_id,model,/);
  assert.equal(lines.length, 3);
  assert.ok(lines.slice(1).every((l) => l.includes(",run-a,")));

  // access
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs`)).status, 401);
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs`, undefined, null, agent.token)).status, 200);
  assert.equal((await f.request(`/v1/agents/${other.agentId}/runs`, undefined, null, agent.token)).status, 404);
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs/run-a`, undefined, null, other.token)).status, 404);
  assert.equal((await f.request("/v1/invitations", { email: "runs-viewer@example.invalid", role: "viewer" }, owner)).status, 201);
  const viewer = await f.login("runs-viewer@example.invalid");
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs`, undefined, viewer)).status, 200);
  const stranger = await f.login("runs-stranger@example.invalid");
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs`, undefined, stranger)).status, 404);
  assert.equal((await f.request(`/v1/agents/missing/runs`, undefined, owner)).status, 404);
});
