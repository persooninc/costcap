// Issue #127: enrolled wrappers enforce per-agent hosted day/month caps against
// the agent's fleet-wide synced spend, not just the local ledger.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import { agentSpendPolicy, validAgentSpend, cachedAgentVerdict, cachedTeamVerdict } from "../src/hosted/teams.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("unit: agentSpendPolicy sums known costs per UTC window, counts unknowns, skips blocked/other months", () => {
  const p = agentSpendPolicy([
    { id: "a", ts: "2026-11-15T01:00:00Z", cost_usd: 0.5 },
    { id: "b", ts: "2026-11-14T23:00:00Z", cost_usd: 0.25 },
    { id: "c", ts: "2026-10-31T23:00:00Z", cost_usd: 9 },
    { id: "d", ts: "2026-11-15T02:00:00Z", cost_usd: 7, blocked: true },
    { id: "e", ts: "2026-11-15T03:00:00Z", cost_usd: null },
    { id: "f", ts: "2026-10-01T03:00:00Z", cost_usd: null },
    { id: "g", ts: "bogus", cost_usd: 1 }, null,
  ], NOW);
  assert.deepEqual(p, { spent: { day: 0.5, week: 0.75, month: 0.75 }, unknown: 1, pending_batches: 0, as_of: "2026-11-15T12:00:00.000Z" });
  assert.equal(validAgentSpend(p), true);
});

test("unit: validAgentSpend refuses bad shapes, accepts absent", () => {
  assert.equal(validAgentSpend(null), true);
  assert.equal(validAgentSpend(undefined), true);
  for (const bad of ["x", { spent: { day: 0, month: 0 }, unknown: 0 }, { spent: { day: 0, month: 0 }, unknown: -1, as_of: "2026-11-15T00:00:00Z" },
    { spent: { day: -1, month: 0 }, unknown: 0, as_of: "2026-11-15T00:00:00Z" }, { spent: { day: 0 }, unknown: 0, as_of: "2026-11-15T00:00:00Z" }, { unknown: 0, as_of: "2026-11-15T00:00:00Z" }])
    assert.equal(validAgentSpend(bad), false, JSON.stringify(bad));
});

test("unit: cachedAgentVerdict — synced + pending, unknown, stale as_of, no caps", () => {
  const spend = { spent: { day: 1.2, month: 3 }, unknown: 0, as_of: "2026-11-15T08:00:00Z" };
  // AC2: synced spend alone exceeds the day cap.
  assert.deepEqual(cachedAgentVerdict(spend, { day: 1 }, [], NOW), { verdict: "budget_exceeded", reason: "budget_exceeded", scope: "day", cap_usd: 1, spent_usd: 1.2, fleet: true });
  // Pending local spend adds on top.
  assert.equal(cachedAgentVerdict(spend, { day: 1.5 }, [], NOW), null);
  assert.equal(cachedAgentVerdict(spend, { day: 1.5 }, [{ id: "p", ts: "2026-11-15T11:00:00Z", cost_usd: 0.3 }, { id: "q", ts: "2026-11-15T11:00:00Z", cost_usd: 5, blocked: true }, { id: "z", ts: "x", cost_usd: 5 }], NOW).spent_usd, 1.5);
  assert.equal(cachedAgentVerdict(spend, { month: 3 }, [], NOW).scope, "month");
  // AC4: unknown → accounting_unavailable, synced or pending.
  assert.equal(cachedAgentVerdict({ ...spend, unknown: 2 }, { day: 100 }, [], NOW).verdict, "accounting_unavailable");
  assert.equal(cachedAgentVerdict(spend, { day: 100 }, [{ id: "u", ts: "2026-11-15T11:00:00Z", cost_usd: null }], NOW).unknown_receipts, 1);
  // AC5: an earlier day counts 0 for the day window; earlier month 0 for both.
  const stale = { ...spend, as_of: "2026-11-14T23:00:00Z" };
  assert.equal(cachedAgentVerdict(stale, { day: 1 }, [], NOW), null);
  assert.equal(cachedAgentVerdict(stale, { month: 3 }, [], NOW).scope, "month");
  assert.equal(cachedAgentVerdict({ ...spend, as_of: "2026-10-31T23:00:00Z" }, { day: 1, month: 3 }, [], NOW), null);
  // No day/month cap, or no spend: nothing to enforce here.
  assert.equal(cachedAgentVerdict(spend, { run: 1 }, [], NOW), null);
  assert.equal(cachedAgentVerdict(null, { day: 1 }, [], NOW), null);
  // Team verdict unchanged by the shared helper (regression).
  assert.equal(cachedTeamVerdict({ name: "ops", caps: { day: 1 }, spent: { day: 1, month: 1 }, unknown: 0, as_of: "2026-11-15T08:00:00Z" }, [], NOW).scope, "team:ops:day");
});

// Fake fleet server: serves a mutable policy, accepts receipts.
async function fakeFleet(t, served) {
  const fleet = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/policy") res.end(JSON.stringify(served.policy));
      else if (req.url === "/v1/receipts") res.end(JSON.stringify({ acceptedIds: JSON.parse(text).receipts.map((r) => r.id).slice(0, served.accept ?? 100) }));
      else { res.statusCode = 404; res.end("{}"); }
    });
  });
  const port = await listen(fleet);
  t.after(() => fleet.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-agent-spend-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "r.jsonl");
  writeFileSync(path, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: "t", agentId: "agent-1", policy: { version: 1, caps: { day: 1 }, killed: false }, syncedIds: [] }), { mode: 0o600 });
  writeFileSync(receiptsPath, "");
  return { dir, path, receiptsPath };
}

test("fleet client: agentCheck merges synced + unsynced without double count; stale and unknown handled", async (t) => {
  const today = new Date().toISOString();
  const served = { policy: { version: 1, caps: { day: 1 }, killed: false, team: null, agent_spend: { spent: { day: 1.2, month: 1.2 }, unknown: 0, as_of: today } } };
  const { path, receiptsPath } = await fakeFleet(t, served);
  const client = createFleetClient({ path, receiptsPath });
  assert.equal(client.agentCheck(), null); // nothing cached yet
  assert.equal((await client.sync()).online, true);
  assert.deepEqual(client.agentSpend(), served.policy.agent_spend);
  assert.equal(client.agentCheck().verdict, "budget_exceeded"); // AC2 (empty local ledger)
  // AC3: four local receipts of 0.1; server syncs two, then reports them in agent_spend.
  served.policy.agent_spend = { spent: { day: 0.5, month: 0.5 }, unknown: 0, as_of: today };
  served.accept = 2;
  writeFileSync(receiptsPath, [1, 2, 3, 4].map((i) => JSON.stringify({ id: `l${i}`, ts: today, cost_usd: 0.1 })).join("\n") + "\n");
  await client.sync();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).syncedIds.length, 2);
  // 0.5 synced (includes l1,l2) + 0.2 unsynced (l3,l4) = 0.7 under a 1.00 cap.
  assert.equal(client.agentCheck(), null);
  assert.equal(cachedAgentVerdict(client.agentSpend(), { day: 0.7 }, [{ id: "l3", ts: today, cost_usd: 0.1 }, { id: "l4", ts: today, cost_usd: 0.1 }], Date.now()).spent_usd, 0.7);
  // AC4: unknown on the server side refuses.
  served.policy.agent_spend = { spent: { day: 0, month: 0 }, unknown: 1, as_of: today };
  await client.sync();
  assert.equal(client.agentCheck().verdict, "accounting_unavailable");
  // AC5: a stale as_of from yesterday counts 0 for the day.
  served.policy.agent_spend = { spent: { day: 5, month: 0 }, unknown: 0, as_of: new Date(Date.now() - 86_400_000 * 40).toISOString() };
  await client.sync();
  assert.equal(client.agentCheck(), null);
  // Invalid agent_spend is refused like any invalid policy.
  served.policy.agent_spend = { spent: { day: -1, month: 0 }, unknown: 0, as_of: today };
  assert.match((await client.sync()).error, /Invalid fleet policy/);
});

test("regression: a server without agent_spend keeps today's behaviour; cached policy can't loosen", async (t) => {
  const served = { policy: { version: 1, caps: { day: 100 }, killed: false } };
  const { path, receiptsPath } = await fakeFleet(t, served);
  const client = createFleetClient({ path, receiptsPath });
  assert.equal((await client.sync()).online, true);
  assert.equal(client.agentSpend(), null);
  assert.equal(client.agentCheck(), null);
  assert.equal(client.policy().caps.day, 1); // same version, looser caps ignored
});

async function hosted(t) {
  let code;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-agent-spend-hosted-")), "store.json");
  const service = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, stripeEnv: {}, verifyChallenge: async (v) => v === "ok", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {} });
  await listen(service.server);
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (p, body, cookie, auth) => {
    const r = await fetch(`${url}${p}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => { const c = await request("/auth/request", { email, turnstileToken: "ok" }); return request("/auth/verify", { challengeId: c.body.challengeId, code }); };
  const enrollToken = async (cookie, caps) => (await request("/v1/enrollment-tokens", { caps }, cookie)).body.token;
  return { url, request, login, enrollToken };
}

test("hosted: GET /v1/policy returns org-scoped agent_spend from synced receipts", async (t) => {
  const h = await hosted(t);
  const a = await h.login("spend-a@example.invalid");
  const b = await h.login("spend-b@example.invalid");
  const agentA = (await h.request("/v1/enroll", { name: "a-bot" }, null, await h.enrollToken(a.cookie, { day: 1 }))).body;
  const agentB = (await h.request("/v1/enroll", { name: "b-bot" }, null, await h.enrollToken(b.cookie, { day: 1 }))).body;
  const ts = new Date().toISOString();
  await h.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 0.7 }, { id: "r2", ts, cost_usd: 0.5 }, { id: "r3", ts, cost_usd: 3, blocked: true }] }, null, agentA.token);
  await h.request("/v1/receipts", { receipts: [{ id: "r1", ts, cost_usd: 50 }, { id: "rn", ts, cost_usd: null }] }, null, agentB.token);
  const pa = (await h.request("/v1/policy", undefined, null, agentA.token)).body;
  assert.deepEqual(pa.agent_spend.spent, { day: 1.2, week: 1.2, month: 1.2 });
  assert.equal(pa.agent_spend.unknown, 0);
  assert.ok(Number.isFinite(Date.parse(pa.agent_spend.as_of)));
  assert.equal(pa.team, null);
  const pb = (await h.request("/v1/policy", undefined, null, agentB.token)).body;
  assert.deepEqual(pb.agent_spend.spent, { day: 50, week: 50, month: 50 });
  assert.equal(pb.agent_spend.unknown, 1);
});

test("e2e: two hosts share one agent identity; the second is refused once the fleet day cap is spent", async (t) => {
  const h = await hosted(t);
  const owner = await h.login("spend-e2e@example.invalid");
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } })); });
  const upPort = await listen(up);
  t.after(() => up.close());
  const hostA = mkdtempSync(join(tmpdir(), "cc-hostA-")), hostB = mkdtempSync(join(tmpdir(), "cc-hostB-"));
  await enroll({ url: h.url, token: await h.enrollToken(owner.cookie, { day: 0.1 }), name: "shared-bot", path: join(hostA, "enrollment.json") });
  // Same identity on a second host / fresh CI runner: copy the credential, empty ledger.
  copyFileSync(join(hostA, "enrollment.json"), join(hostB, "enrollment.json"));
  const script = `const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: "{}" }); console.log(r.status, await r.text());`;
  const run = (dir) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "wrap", "--enrollment", join(dir, "enrollment.json"), "--receipts", join(dir, "r.jsonl"), "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}` } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, ""), err }));
  });
  const first = await run(hostA);
  assert.match(first.out, /^200 /, first.err);
  assert.equal(hits, 1);
  const second = await run(hostB);
  assert.match(second.out, /^429 /, second.err);
  const body = JSON.parse(second.out.slice(4).split("\n")[0]);
  assert.equal(body.error, "budget_exceeded");
  assert.equal(body.scope, "day");
  assert.equal(hits, 1, "upstream must never be called on host B");
});
