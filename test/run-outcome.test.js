// Issue #225: run outcomes and wasted spend (unit + hosted server + client degradation).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { deriveOutcome, stopReasonFor, parseRunEnd, parseOutcomeOverride, upsertRunEnd, runOutcomeFields, costPerSuccess, outcomeSummary, STOP_REASONS } from "../src/hosted/run-outcome.js";
import { spendBreakdown, spendCsv, OUTCOME_BUCKETS } from "../src/hosted/spend.js";
import { buildRunSummary, runEndRecord, runsCommand, writeRunSummary } from "../src/run-summary.js";
import { createHostedServer } from "../src/hosted/server.js";
import { createFleetClient, saveEnrollment } from "../src/hosted/client.js";

const end = (over = {}) => ({ run_id: "r1", started_at: "2026-11-16T00:00:00.000Z", ended_at: "2026-11-16T00:01:00.000Z", exit_code: 0, stop_reason: "exited", calls: 2, usd_known: 0.5, unknown_count: 0, ...over });

test("unit: outcome derivation for every stop_reason, signals and missing records", () => {
  assert.equal(deriveOutcome(end()), "success");
  assert.equal(deriveOutcome(end({ exit_code: 3 })), "failure");
  for (const r of STOP_REASONS.filter((x) => x !== "exited")) assert.equal(deriveOutcome(end({ stop_reason: r, exit_code: 0 })), "killed", r);
  assert.equal(deriveOutcome(end({ stop_reason: "signal:SIGTERM", exit_code: null })), "killed");
  assert.equal(deriveOutcome(null), "unknown");
  assert.equal(deriveOutcome(end({ stop_reason: "bogus" })), "unknown");
  assert.equal(deriveOutcome(end({ exit_code: null })), "unknown");
  // override precedence: wins over any derivation; invalid override ignored
  assert.equal(deriveOutcome(end({ stop_reason: "cap_hit" }), { outcome: "success" }), "success");
  assert.equal(deriveOutcome(null, { outcome: "failure" }), "failure");
  assert.equal(deriveOutcome(end(), { outcome: "killed" }), "success");
});

test("unit: wrap stop reasons map to the issue's vocabulary", () => {
  assert.equal(stopReasonFor(), "exited");
  assert.equal(stopReasonFor({ killed: true }), "kill_switch");
  assert.equal(stopReasonFor({ reason: "killed" }), "kill_switch");
  assert.equal(stopReasonFor({ reason: "budget_exceeded" }), "cap_hit");
  assert.equal(stopReasonFor({ reason: "breaker_open" }), "spiral");
  assert.equal(stopReasonFor({ reason: "spiral_detected" }), "spiral");
  assert.equal(stopReasonFor({ reason: "tag_budget_exceeded" }), "cap_hit");
  assert.equal(stopReasonFor({ reason: "cost_velocity" }), "velocity");
  assert.equal(stopReasonFor({ reason: "step_budget" }), "step_budget");
  assert.equal(stopReasonFor({ signal: "SIGINT" }), "signal:SIGINT");
  assert.equal(stopReasonFor({ signal: "bad sig" }), "exited");
});

test("unit: parse run-end and override validate input", () => {
  assert.deepEqual(parseRunEnd(end({ usd_known: 0.12345678 })).usd_known, 0.123457);
  assert.equal(parseRunEnd(end({ usd_known: null, exit_code: null })).usd_known, null);
  for (const bad of [null, end({ run_id: "" }), end({ stop_reason: "x" }), end({ exit_code: -1 }), end({ exit_code: 1.5 }), end({ usd_known: -1 }), end({ calls: -1 }), end({ unknown_count: "1" }), end({ started_at: "nope" }), end({ ended_at: "2025-01-01T00:00:00Z" })]) {
    assert.throws(() => parseRunEnd(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(parseOutcomeOverride({ outcome: "failure", note: "  flaky  " }), { outcome: "failure", note: "flaky" });
  assert.deepEqual(parseOutcomeOverride({ outcome: "success" }), { outcome: "success", note: null });
  for (const bad of [null, { outcome: "killed" }, { outcome: "success", note: 5 }, { outcome: "success", note: "x".repeat(501) }]) assert.throws(() => parseOutcomeOverride(bad), (e) => e.status === 400);
});

test("unit: upsert is idempotent by (agent, run); a different record is 409", () => {
  const map = {};
  assert.deepEqual(upsertRunEnd(map, { orgId: "o", agentId: "a" }, end(), "t"), { key: "a:r1", duplicate: false });
  assert.deepEqual(upsertRunEnd(map, { orgId: "o", agentId: "a" }, end(), "t2"), { key: "a:r1", duplicate: true });
  assert.equal(map["a:r1"].received_at, "t");
  assert.throws(() => upsertRunEnd(map, { orgId: "o", agentId: "a" }, end({ exit_code: 1 }), "t"), (e) => e.status === 409);
  assert.equal(upsertRunEnd(map, { orgId: "o", agentId: "b" }, end(), "t").duplicate, false);
  assert.deepEqual(runOutcomeFields(null), { ended_at: null, exit_code: null, stop_reason: null, outcome: "unknown", outcome_override: null });
  assert.equal(runOutcomeFields(map["a:r1"]).outcome, "success");
});

test("unit: cost per success rounding and the — / ≥ rules", () => {
  assert.deepEqual(costPerSuccess(1, 0, false), { usd: null, lower_bound: false, label: "—" });
  assert.deepEqual(costPerSuccess(1, 3, false), { usd: 0.333333, lower_bound: false, label: "$0.3333" });
  assert.equal(costPerSuccess(5, 2, true).label, "≥$2.50");
});

const items = () => [
  { agentId: "a", receipt: { id: "1", ts: "2026-11-10T00:00:00Z", run_id: "ok", cost_usd: 1 } },
  { agentId: "a", receipt: { id: "2", ts: "2026-11-10T00:01:00Z", run_id: "ok", cost_usd: 0.5 } },
  { agentId: "a", receipt: { id: "3", ts: "2026-11-10T00:02:00Z", run_id: "bad", cost_usd: 2 } },
  { agentId: "a", receipt: { id: "4", ts: "2026-11-10T00:03:00Z", run_id: "capped", cost_usd: 0.5 } },
  { agentId: "a", receipt: { id: "5", ts: "2026-11-10T00:04:00Z", run_id: "capped", cost_usd: null } },
  { agentId: "a", receipt: { id: "6", ts: "2026-11-10T00:05:00Z", run_id: "lost", cost_usd: 1 } },
  { agentId: "a", receipt: { id: "7", ts: "2026-11-10T00:06:00Z", cost_usd: 1 } },
];
const outcomes = { "a:ok": "success", "a:bad": "failure", "a:capped": "killed" };
const outcomeOf = (agent, run) => outcomes[`${agent}:${run}`] ?? "unknown";

test("unit: group_by=outcome splits spend, totals match ungrouped, unknown is a lower bound never $0", () => {
  const g = spendBreakdown(items(), { groupBy: "outcome", outcomeOf });
  assert.deepEqual(g.buckets.map((b) => b.key), OUTCOME_BUCKETS);
  const by = Object.fromEntries(g.buckets.map((b) => [b.key, b]));
  assert.deepEqual([by.success.usd_known, by.success.runs, by.success.lower_bound], [1.5, 1, false]);
  assert.deepEqual([by.failure.usd_known, by.failure.runs], [2, 1]);
  assert.deepEqual([by.killed.usd_known, by.killed.unknown_count, by.killed.lower_bound, by.killed.cost_complete], [0.5, 1, true, false]);
  assert.deepEqual([by.unknown.usd_known, by.unknown.runs], [2, 1]);
  const flat = spendBreakdown(items(), { groupBy: "day" });
  assert.deepEqual(g.total, flat.total);
  assert.equal(g.buckets.reduce((n, b) => n + b.usd_known, 0), flat.total.usd_known);
  // empty input still lists all four buckets at $0
  assert.deepEqual(spendBreakdown([], { groupBy: "outcome" }).buckets.map((b) => [b.key, b.calls]), OUTCOME_BUCKETS.map((k) => [k, 0]));
  const csv = spendCsv(items(), { groupBy: "outcome", outcomeOf, period: "month" }).body.trim().split("\n");
  assert.ok(csv.includes("period,group_by,key,label,usd_known,calls,unknown_count,cost_complete,blocked_count,runs,lower_bound"));
  assert.ok(csv.includes("2026-11,outcome,killed,killed,0.5,2,1,false,0,1,true"));
  assert.ok(csv.includes("2026-11,outcome,success,success,1.5,2,0,true,0,1,false"));
  // other group_by values keep the original columns (regression)
  assert.ok(spendCsv(items(), { groupBy: "agent", period: "month" }).body.includes("period,group_by,key,label,usd_known,calls,unknown_count,cost_complete,blocked_count\n"));
});

test("unit: agent-card outcome summary", () => {
  const o = outcomeSummary(items(), outcomeOf);
  assert.equal(o.wasted_usd, 2.5); assert.equal(o.wasted_lower_bound, true);
  assert.equal(o.total_usd, 6); assert.equal(o.wasted_share, 41.7);
  assert.equal(o.success_runs, 1); assert.equal(o.cost_per_success.label, "$1.50");
  const none = outcomeSummary([], outcomeOf);
  assert.equal(none.cost_per_success.label, "—"); assert.equal(none.wasted_share, 0);
});

test("unit: run summary carries stop_reason/outcome; runs prints outcome; run-end record", () => {
  const base = { run_id: "x", started_at: "2026-11-16T00:00:00Z", ended_at: "2026-11-16T00:00:05Z" };
  assert.deepEqual([buildRunSummary({ ...base, exit_code: 0 }).stop_reason, buildRunSummary({ ...base, exit_code: 0 }).outcome], ["exited", "success"]);
  assert.equal(buildRunSummary({ ...base, exit_code: 3 }).outcome, "failure");
  const capped = buildRunSummary({ ...base, exit_code: 0, receipts: [{ id: "1", cost_usd: 0.4, model: "m" }, { id: "2", blocked: true, reason: "budget_exceeded", scope: "run" }] });
  assert.deepEqual([capped.stop_reason, capped.outcome], ["cap_hit", "killed"]);
  assert.equal(buildRunSummary({ ...base, exit_code: 143, killed: true }).stop_reason, "kill_switch");
  assert.equal(buildRunSummary({ ...base, exit_code: 1, signal: "SIGINT" }).stop_reason, "signal:SIGINT");
  const rec = runEndRecord(capped);
  assert.deepEqual(rec, { run_id: "x", started_at: base.started_at, ended_at: base.ended_at, exit_code: 0, stop_reason: "cap_hit", calls: 2, usd_known: 0.4, unknown_count: 0 });
  assert.doesNotThrow(() => parseRunEnd(rec));
  const unk = runEndRecord(buildRunSummary({ ...base, exit_code: 999, receipts: [{ id: "1", cost_usd: null, model: "m" }, { id: "2", cost_usd: 0.2, model: "n" }] }));
  assert.deepEqual([unk.exit_code, unk.usd_known, unk.unknown_count], [null, 0.2, 1]);
  const dir = mkdtempSync(join(tmpdir(), "cc-outcome-"));
  const receipts = join(dir, "receipts.jsonl");
  writeRunSummary(receipts, capped);
  const legacy = { ...buildRunSummary({ ...base, run_id: "old", exit_code: 0 }) }; delete legacy.outcome; delete legacy.stop_reason;
  writeRunSummary(receipts, legacy);
  const lines = []; runsCommand(["--receipts", receipts], { log: (l) => lines.push(l), warn: () => {} });
  assert.ok(lines.some((l) => l.includes(" x ") && l.includes("outcome=killed")));
  assert.ok(lines.some((l) => l.includes(" old ") && l.includes("outcome=unknown")));
});

async function fixture(t, extra = {}) {
  const codes = {};
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-outcome-srv-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, ...extra });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => { const c = await request("/auth/request", { email, turnstileToken: "x" }); return (await request("/auth/verify", { challengeId: c.body.challengeId, code: codes[email] })).cookie; };
  const enroll = async (owner, name) => { const tok = (await request("/v1/enrollment-tokens", { caps: { day: 50 } }, owner)).body.token; return (await request("/v1/enroll", { name }, null, tok)).body; };
  return { service, base, request, login, enroll };
}

async function serverFlow(t, extra = {}) {
  const f = await fixture(t, extra);
  const owner = await f.login("outcome-owner@example.invalid");
  const agent = await f.enroll(owner, "worker");
  const other = await f.enroll(owner, "other");
  const ts = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const receipts = [
    { id: "s1", ts: ts(9), run_id: "run-ok", cost_usd: 1, model: "m" },
    { id: "f1", ts: ts(8), run_id: "run-fail", cost_usd: 2, model: "m" },
    { id: "k1", ts: ts(7), run_id: "run-cap", cost_usd: 0.5, model: "m" },
    { id: "k2", ts: ts(6), run_id: "run-cap", cost_usd: null, model: "m" },
    { id: "u1", ts: ts(5), run_id: "run-lost", cost_usd: 0.25, model: "m" },
  ];
  assert.equal((await f.request("/v1/receipts", { receipts }, null, agent.token)).status, 200);
  const before = (await f.request(`/v1/agents/${agent.agentId}/runs`, undefined, owner)).body;
  const spendBefore = (await f.request("/v1/spend?group_by=day", undefined, owner)).body;

  // AC1
  const okEnd = end({ run_id: "run-ok", started_at: ts(10), ended_at: ts(4) });
  const r1 = await f.request("/v1/runs/end", okEnd, null, agent.token);
  assert.equal(r1.status, 200); assert.equal(r1.body.duplicate, false); assert.equal(r1.body.outcome, "success");
  assert.equal((await f.request("/v1/runs/end", end({ run_id: "run-fail", exit_code: 3, started_at: ts(10), ended_at: ts(4) }), null, agent.token)).body.outcome, "failure");
  assert.equal((await f.request("/v1/runs/end", end({ run_id: "run-cap", stop_reason: "cap_hit", started_at: ts(10), ended_at: ts(4) }), null, agent.token)).body.outcome, "killed");
  const detail = (await f.request(`/v1/agents/${agent.agentId}/runs/run-ok`, undefined, owner)).body.run;
  assert.deepEqual([detail.exit_code, detail.stop_reason, detail.outcome, detail.ended_at], [0, "exited", "success", okEnd.ended_at]);
  // AC2: idempotent, unknown without record, bad input, conflicting record
  const dup = await f.request("/v1/runs/end", okEnd, null, agent.token);
  assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true);
  assert.equal((await f.request("/v1/runs/end", { ...okEnd, exit_code: 9 }, null, agent.token)).status, 409);
  assert.equal((await f.request("/v1/runs/end", { ...okEnd, stop_reason: "nope" }, null, agent.token)).status, 400);
  assert.equal((await f.request("/v1/runs/end", okEnd, owner)).status, 401);
  const list = (await f.request(`/v1/agents/${agent.agentId}/runs`, undefined, owner)).body;
  assert.equal(list.runs.find((r) => r.run_id === "run-lost").outcome, "unknown");
  // AC6 regression: every pre-existing field keeps its value
  for (const run of before.runs) {
    const now = list.runs.find((r) => r.run_id === run.run_id);
    for (const [k, v] of Object.entries(run)) if (!["ended_at", "exit_code", "stop_reason", "outcome", "outcome_override"].includes(k)) assert.deepEqual(now[k], v, `${run.run_id}.${k}`);
  }
  assert.deepEqual((await f.request("/v1/spend?group_by=day", undefined, owner)).body, spendBefore);

  // AC3
  const g = (await f.request("/v1/spend?group_by=outcome", undefined, owner)).body;
  const by = Object.fromEntries(g.buckets.map((b) => [b.key, b]));
  assert.deepEqual([by.success.usd_known, by.failure.usd_known, by.killed.usd_known, by.unknown.usd_known], [1, 2, 0.5, 0.25]);
  assert.deepEqual([by.killed.lower_bound, by.killed.unknown_count, by.success.runs], [true, 1, 1]);
  assert.deepEqual(g.total, spendBefore.total);
  const csv = (await f.request("/v1/spend.csv?group_by=outcome", undefined, owner)).body;
  assert.match(csv, /,outcome,killed,killed,0\.5,2,1,false,0,1,true/);
  assert.match(csv, /,outcome,failure,failure,2,1,0,true,0,1,false/);

  // AC4: override with the agent's own token; other agent 403; other org 404; audited
  const ov = await f.request(`/v1/agents/${agent.agentId}/runs/run-ok/outcome`, { outcome: "failure", note: "bad output" }, null, agent.token);
  assert.equal(ov.status, 200); assert.equal(ov.body.outcome, "failure");
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs/run-ok`, undefined, owner)).body.run.outcome, "failure");
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs/run-ok/outcome`, { outcome: "failure" }, null, other.token)).status, 403);
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs/run-ok/outcome`, { outcome: "nope" }, owner)).status, 400);
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs/missing/outcome`, { outcome: "success" }, owner)).status, 404);
  // a member may mark a run with no run-end record
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs/run-lost/outcome`, { outcome: "success" }, owner)).body.outcome, "success");
  const stranger = await f.login("outcome-stranger@example.invalid");
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs/run-ok/outcome`, { outcome: "success" }, stranger)).status, 404);
  const strangerSpend = (await f.request("/v1/spend?group_by=outcome", undefined, stranger)).body;
  assert.equal(strangerSpend.total.calls, 0);
  assert.equal((await f.request("/v1/invitations", { email: "outcome-viewer@example.invalid", role: "viewer" }, owner)).status, 201);
  const viewer = await f.login("outcome-viewer@example.invalid");
  assert.equal((await f.request(`/v1/agents/${agent.agentId}/runs/run-ok/outcome`, { outcome: "success" }, viewer)).status, 403);
  const fleet = (await f.request("/v1/fleet", undefined, owner)).body;
  const rows = fleet.audit.filter((e) => e.action === "run.outcome");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((e) => e.detail.run_id === "run-ok").detail, { run_id: "run-ok", before: "success", after: "failure", note: "bad output" });
  // agent card figures: failure now 1+2=3 (run-ok overridden), killed 0.5 (lower bound), success run-lost 0.25
  const card = fleet.agents.find((a) => a.id === agent.agentId).outcomes;
  assert.deepEqual([card.wasted_usd, card.wasted_lower_bound, card.success_runs, card.cost_per_success.label], [3.5, true, 1, "$0.2500"]);
  return f;
}

test("server (memory store): run-end sync, outcomes, spend by outcome, override, isolation, regression", async (t) => {
  await serverFlow(t);
});

test("server (fake Postgres): run-end and override rows carry the org id for RLS", async (t) => {
  const { openPostgresStore } = await import("../src/hosted/store-postgres.js");
  const upserts = [];
  const pool = { async connect() { return {
    async query(sql, params) {
      if (/^SELECT kind, id, body/.test(sql)) return { rows: [] };
      if (/INSERT INTO store_records/.test(sql)) params[0].forEach((k, i) => upserts.push({ kind: k, id: params[1][i], org: params[2] }));
      return { rows: [] };
    },
    release() {},
  }; } };
  const store = await openPostgresStore({ pool, log: () => {} });
  await serverFlow(t, { store, storePath: undefined });
  await store.flush();
  const runRows = upserts.filter((u) => u.kind === "runEnds");
  assert.ok(runRows.length >= 3);
  const orgs = new Set(runRows.map((u) => u.org));
  assert.equal(orgs.size, 1); assert.ok([...orgs][0]);
});

test("client: run-end retries after an old server 404s, and receipt sync still succeeds", async (t) => {
  let routeExists = false; const got = [];
  const srv = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => {
      const send = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url === "/v1/receipts") return send(200, { acceptedIds: JSON.parse(raw).receipts.map((r) => r.id) });
      if (req.url === "/v1/policy") return send(200, { version: 1, caps: {} });
      if (req.url === "/v1/runs/end") { if (!routeExists) return send(404, { error: "Route not found" }); got.push(JSON.parse(raw)); return send(200, { duplicate: false }); }
      send(404, { error: "Route not found" });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-outcome-cli-"));
  const path = join(dir, "enroll.json"), receiptsPath = join(dir, "receipts.jsonl");
  writeFileSync(receiptsPath, JSON.stringify({ id: "x1", ts: new Date().toISOString(), cost_usd: 0.1, run_id: "r1" }) + "\n");
  saveEnrollment(path, { url: `http://127.0.0.1:${srv.address().port}`, token: "t", agentId: "a", policy: { version: 1, caps: {} }, syncedIds: [] });
  const fleet = createFleetClient({ path, receiptsPath });
  fleet.queueRunEnd(end());
  const first = await fleet.sync();
  assert.equal(first.online, true);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).syncedIds, ["x1"]);
  assert.equal(fleet.pendingRunEnds().length, 1);
  routeExists = true;
  assert.equal((await fleet.sync()).online, true);
  assert.equal(fleet.pendingRunEnds().length, 0);
  assert.deepEqual(got, [end()]);
  await fleet.sync();
  assert.equal(got.length, 1);
});

test("AC1: enrolled wrap syncs run-ends (exit 0 → success, exit 3 → failure, run cap → killed)", async (t) => {
  const http = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { enroll } = await import("../src/hosted/client.js");
  const up = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 100000, completion_tokens: 100000 } }))); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => up.close());
  const f = await fixture(t);
  const owner = await f.login("outcome-wrap@example.invalid");
  const tok = (await f.request("/v1/enrollment-tokens", { caps: {} }, owner)).body.token;
  const dir = mkdtempSync(join(tmpdir(), "cc-outcome-wrap-"));
  const enrollment = join(dir, "enrollment.json");
  const { agentId } = await enroll({ url: f.base, token: tok, name: "wrapped", path: enrollment });
  const run = (runId, script, extra = []) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "wrap", ...extra, "--run-id", runId, "--enrollment", enrollment, "--receipts", join(dir, "r.jsonl"), "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.address().port}` } });
    let err = ""; child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, err }));
  });
  const call = `const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: "{}" }); await r.text();`;
  assert.equal((await run("run-zero", `${call} process.exit(0)`)).code, 0);
  assert.equal((await run("run-three", `${call} process.exit(3)`)).code, 3);
  await run("run-capped", `for (let i = 0; i < 4; i++) { ${call} }`, ["--cap", "0.000001"]);
  const get = async (id) => (await f.request(`/v1/agents/${agentId}/runs/${id}`, undefined, owner)).body.run;
  const zero = await get("run-zero");
  assert.deepEqual([zero.exit_code, zero.stop_reason, zero.outcome, typeof zero.ended_at], [0, "exited", "success", "string"]);
  assert.equal((await get("run-three")).outcome, "failure");
  const capped = await get("run-capped");
  assert.deepEqual([capped.stop_reason, capped.outcome], ["cap_hit", "killed"]);
});

test("unit: spiral- and tag-cap-blocked runs are killed even when the child exits 0", () => {
  for (const [reason, stop] of [["spiral_detected", "spiral"], ["tag_budget_exceeded", "cap_hit"]]) {
    const sum = buildRunSummary({ run_id: "r", started_at: "2026-11-16T00:00:00Z", ended_at: "2026-11-16T00:01:00Z", exit_code: 0,
      receipts: [{ ts: "2026-11-16T00:00:30Z", run_id: "r", blocked: true, reason, cost_usd: 0 }] });
    assert.equal(sum.stop_reason, stop);
    assert.equal(sum.outcome, "killed");
  }
});

test("unit: an override set before the run ends keeps the later run-end", () => {
  const map = { "a1:r1": { orgId: "o", agentId: "a1", run_end: null, received_at: null, override: { outcome: "failure", note: null } } };
  const re = parseRunEnd({ run_id: "r1", started_at: "2026-11-16T00:00:00Z", ended_at: "2026-11-16T00:01:00Z", exit_code: 0, stop_reason: "exited", calls: 1, usd_known: 0.1, unknown_count: 0 });
  assert.deepEqual(upsertRunEnd(map, { orgId: "o", agentId: "a1" }, re, "2026-11-16T00:02:00Z"), { key: "a1:r1", duplicate: false });
  const f = runOutcomeFields(map["a1:r1"]);
  assert.deepEqual([f.exit_code, f.stop_reason, f.ended_at, f.outcome], [0, "exited", "2026-11-16T00:01:00Z", "failure"]);
  assert.equal(upsertRunEnd(map, { orgId: "o", agentId: "a1" }, re, "x").duplicate, true);
});
