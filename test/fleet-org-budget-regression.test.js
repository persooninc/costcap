// Issue #240 regression: an org-wide day budget enforced by real wrappers
// (metering proxy + fleet client) through the real local hosted server, with
// fake upstreams at $0.40/call. Covers AC2, AC3 and AC4.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import { startMeteringProxy } from "../src/proxy.js";

// gpt-4o: 160k input tokens at $2.50/M = $0.40 per call.
const COMPLETION = JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 160_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } });

async function hosted(t) {
  const dir = mkdtempSync(join(tmpdir(), "cc-240-"));
  let code;
  const origin = "http://localhost";
  const service = createHostedServer({ storePath: join(dir, "store.json"), origin, secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [] });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const req = async (path, body, cookie, method) => {
    const r = await fetch(base + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => {
    const c = await req("/auth/request", { email, turnstileToken: "x" });
    return (await req("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  };
  const agent = async (owner, name, { caps = {} } = {}) => {
    const token = (await req("/v1/enrollment-tokens", { caps }, owner)).body.token;
    const path = join(dir, `${name}.json`), receiptsPath = join(dir, `${name}.jsonl`);
    await enroll({ url: base, token, name, path });
    const fleet = createFleetClient({ path, receiptsPath });
    let hits = 0;
    const up = http.createServer((q, s) => { hits += 1; q.resume(); q.on("end", () => s.writeHead(200, { "content-type": "application/json" }).end(COMPLETION)); });
    await new Promise((r) => up.listen(0, "127.0.0.1", r));
    const { server, port } = await startMeteringProxy({ receiptsPath, upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, teamCheck: () => fleet.fleetCheck() });
    t.after(() => { server.close(); up.close(); });
    const call = async () => {
      const r = await fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o" }) });
      return { status: r.status, body: await r.json() };
    };
    const id = JSON.parse(readFileSync(path, "utf8")).agentId;
    return { id, fleet, call, hits: () => hits, receiptsPath };
  };
  return { req, login, agent };
}

test("regression #240 AC2: org day=1 refuses A, B and a later-enrolled C before the upstream", async (t) => {
  const h = await hosted(t);
  const owner = await h.login("org-240@example.invalid");
  assert.equal((await h.req("/v1/org-budget", { day: 1 }, owner, "PUT")).status, 200);
  const A = await h.agent(owner, "a"), B = await h.agent(owner, "b");
  assert.equal((await A.call()).status, 200);
  assert.equal((await A.call()).status, 200);
  assert.equal((await A.fleet.sync()).online, true);
  assert.equal((await B.call()).status, 200);
  assert.equal((await B.fleet.sync()).online, true);
  await A.fleet.sync();
  for (const ag of [A, B]) {
    const before = ag.hits();
    const r = await ag.call();
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "budget_exceeded");
    assert.equal(r.body.scope, "org:day");
    assert.equal(ag.hits(), before, "the upstream saw no request");
  }
  // C enrolled after the cap was set, in no team.
  const C = await h.agent(owner, "c");
  await C.fleet.sync();
  const before = C.hits();
  const r = await C.call();
  assert.equal(r.status, 429);
  assert.equal(r.body.scope, "org:day");
  assert.equal(C.hits(), before);
  // The hosted budget route, evidence and the card endpoint agree (AC6).
  const budget = (await h.req(`/v1/agents/${C.id}/budget`, undefined, owner)).body;
  const evidence = (await h.req("/v1/evidence.json", undefined, owner)).body;
  const card = (await h.req("/v1/org-budget", undefined, owner)).body;
  assert.equal(budget.scope, "org:day");
  assert.deepEqual(budget.org_budget.caps, { day: 1 });
  assert.equal(card.org_budget.spend.day_usd, 1.2);
  assert.equal(evidence.org_budget.spend.day_usd, 1.2);
  assert.equal(evidence.org_budget.verdict, card.org_budget.verdict);
  assert.equal(budget.org_budget.verdict, "budget_exceeded");
});

test("regression #240 AC3: agent and team caps report their own scope; other orgs never count; revoked spend still counts", async (t) => {
  const h = await hosted(t);
  const owner = await h.login("org-240b@example.invalid");
  const other = await h.login("org-240-other@example.invalid");
  assert.equal((await h.req("/v1/org-budget", { day: 1 }, owner, "PUT")).status, 200);
  // Another org spends a lot; it must not count here.
  const X = await h.agent(other, "x");
  for (let i = 0; i < 4; i++) await X.call();
  await X.fleet.sync();
  // Agent cap 0.4 hits first with its own scope.
  const A = await h.agent(owner, "a", { caps: { day: 0.4 } });
  await A.call();
  await A.fleet.sync();
  const ra = await A.call();
  assert.equal(ra.status, 429);
  assert.equal(ra.body.scope, "day");
  // Team cap 0.4 hits before the org cap.
  const B = await h.agent(owner, "b");
  assert.equal((await h.req("/v1/teams", { name: "ops", agents: [B.id], day: 0.4 }, owner)).status, 200);
  await B.call();
  await B.fleet.sync();
  const rb = await B.call();
  assert.equal(rb.status, 429);
  assert.equal(rb.body.scope, "team:ops:day");
  assert.equal((await h.req("/v1/org-budget", undefined, owner)).body.org_budget.spend.day_usd, 0.8);
  // Revoke A: its $0.40 still counts toward the org.
  assert.equal((await h.req(`/v1/agents/${A.id}/revoke`, {}, owner)).status, 200);
  const C = await h.agent(owner, "c");
  await C.fleet.sync();
  assert.equal((await C.call()).status, 200);
  await C.fleet.sync();
  const rc = await C.call();
  assert.equal(rc.status, 429);
  assert.equal(rc.body.scope, "org:day");
  // The other org has no org budget and is not refused by this one.
  assert.equal((await X.call()).status, 200);
});

test("regression #240 AC4: an unknown-cost receipt refuses as accounting_unavailable until settled", async (t) => {
  const h = await hosted(t);
  const owner = await h.login("org-240c@example.invalid");
  assert.equal((await h.req("/v1/org-budget", { month: 100 }, owner, "PUT")).status, 200);
  const A = await h.agent(owner, "a"), B = await h.agent(owner, "b");
  // A syncs a null-cost receipt directly.
  const { token, url: base } = JSON.parse(readFileSync(join(A.receiptsPath, "..", "a.json"), "utf8"));
  const ts = new Date().toISOString();
  assert.equal((await fetch(`${base}/v1/receipts`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ receipts: [{ id: "n1", ts, cost_usd: null }] }) })).status, 200);
  await B.fleet.sync();
  const refused = await B.call();
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "accounting_unavailable");
  assert.equal((await h.req("/v1/receipts/n1/settle", { cost_usd: 0.1, source: "manual_evidence", reason: "invoice line" }, owner)).status, 200);
  await B.fleet.sync();
  assert.equal((await B.call()).status, 200);
});
