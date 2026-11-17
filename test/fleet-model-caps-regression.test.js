// Issue #244 regression: one agent enrolled on two hosts (H1, H2) shares a hosted
// modelCaps day rule through the real local hosted server. Fake upstream echoes
// the requested model with 160k input tokens (gpt-4o: $0.40 per call).
// At e3248cf each host enforced the rule against its own ledger only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, appendFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import { startMeteringProxy } from "../src/proxy.js";
import { createModelCaps } from "../src/model-cap.js";
import { withFleetModelCaps, fleetModelRules } from "../src/hosted/model-caps.js";

async function hosted(t) {
  const dir = mkdtempSync(join(tmpdir(), "cc-244-"));
  let code;
  const origin = "http://localhost";
  const delivered = [];
  const service = createHostedServer({ storePath: join(dir, "store.json"), origin, secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async (a) => { delivered.push(a); return [{ channel: "email", status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const req = async (path, body, cookie, method) => {
    const r = await fetch(base + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const c = await req("/auth/request", { email: "reg-244@example.invalid", turnstileToken: "x" });
  const owner = (await req("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  const token = (await req("/v1/enrollment-tokens", { caps: { day: 100 } }, owner)).body.token;
  const enrollPath = join(dir, "h1.json");
  const { agentId } = await enroll({ url: base, token, name: "multi", path: enrollPath });
  copyFileSync(enrollPath, join(dir, "h2.json")); // same identity on a second host
  const setModelCaps = async (modelCaps) => assert.equal((await req(`/v1/agents/${agentId}/policy`, { caps: { day: 100 }, modelCaps }, owner)).status, 200);
  const host = async (name) => {
    const path = join(dir, `${name}.json`), receiptsPath = join(dir, `${name}.jsonl`);
    const fleet = createFleetClient({ path, receiptsPath });
    const up = http.createServer((q, s) => { let b = ""; q.on("data", (d) => { b += d; }); q.on("end", () => s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: JSON.parse(b).model, usage: { prompt_tokens: 160_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }))); });
    await new Promise((r) => up.listen(0, "127.0.0.1", r));
    // Same composition as `costcap wrap --enrollment` (src/cli.js).
    const local = createModelCaps({ rules: [] }), fallback = createModelCaps({ rules: [] });
    const modelCaps = withFleetModelCaps(local, fallback, fleet);
    const { server, port } = await startMeteringProxy({ receiptsPath, upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, modelCaps });
    t.after(() => { server.close(); up.close(); });
    const sync = async () => {
      const r = await fleet.sync();
      const hostedRules = fleet.policy().modelCaps ?? [];
      local.setRules(hostedRules.filter((x) => x.scope === "hour").map((x) => ({ model: x.model, scope: x.scope, cap: x.usd })));
      fallback.setRules(fleetModelRules(hostedRules).map((x) => ({ model: x.model, scope: x.scope, cap: x.usd })));
      return r;
    };
    const call = async (model) => {
      const r = await fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", body: JSON.stringify({ model }) });
      return { status: r.status, body: await r.json() };
    };
    return { fleet, call, sync, receiptsPath };
  };
  return { setModelCaps, host, agentId, req, owner, service, delivered };
}

test("regression #244 AC1: H1's synced spend counts on H2; other models keep working", async (t) => {
  const h = await hosted(t);
  await h.setModelCaps([{ model: "gpt-4o", scope: "day", usd: 1 }]);
  const H1 = await h.host("h1"), H2 = await h.host("h2");
  assert.equal((await H1.sync()).online, true);
  assert.equal((await H2.sync()).online, true);
  assert.equal((await H1.call("gpt-4o")).status, 200);
  assert.equal((await H1.call("gpt-4o")).status, 200);
  await H1.sync(); // $0.80 synced from H1
  assert.equal((await H2.call("gpt-4o")).status, 200); // H2 sees 0 synced before its sync
  await H2.sync();
  assert.equal(H2.fleet.agentSpend().models["gpt-4o"].day, 1.2);
  // H2 adds one unsynced local call, then is over: 0.8 synced from H1 + 0.4 synced H2 + 0.4 local.
  appendFileSync(H2.receiptsPath, JSON.stringify({ id: "local-extra", ts: new Date().toISOString(), model: "gpt-4o", cost_usd: 0.4 }) + "\n");
  const r = await H2.call("gpt-4o");
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "model_budget_exceeded");
  assert.equal(r.body.fleet, true);
  assert.equal(r.body.spend_usd, 1.6);
  assert.equal(r.body.cap_usd, 1);
  // Another model still goes upstream and the run is not latched.
  assert.equal((await H2.call("gpt-4o-mini")).status, 200);
  assert.equal((await H2.call("gpt-4o-mini")).status, 200);
  // H1 also refuses after its next sync.
  await H1.sync();
  assert.equal((await H1.call("gpt-4o")).status, 429);
});

test("regression #244 AC2: unknown Opus cost on one host refuses only that model fleet-wide", async (t) => {
  const h = await hosted(t);
  await h.setModelCaps([{ model: "gpt-4o", scope: "day", usd: 5 }]);
  const H1 = await h.host("h1"), H2 = await h.host("h2");
  appendFileSync(H1.receiptsPath, JSON.stringify({ id: "unk-1", ts: new Date().toISOString(), model: "gpt-4o", cost_usd: null, reason: "usage_unavailable" }) + "\n");
  await H1.sync();
  await H2.sync();
  const r = await H2.call("gpt-4o");
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "accounting_unavailable");
  assert.equal(r.body.fleet, true);
  assert.equal((await H2.call("gpt-4o-mini")).status, 200);
});

test("regression #244 AC4: alert worker fires cap_approaching then cap_hit per model and resolves on rule removal", async (t) => {
  const h = await hosted(t);
  await h.setModelCaps([{ model: "gpt-4o", scope: "day", usd: 1 }]);
  const H1 = await h.host("h1");
  await H1.sync();
  assert.equal((await H1.call("gpt-4o")).status, 200);
  assert.equal((await H1.call("gpt-4o")).status, 200);
  await H1.sync(); // $0.80 = 80%
  await h.service.evaluateFleetAlerts();
  const approach = h.delivered.filter((a) => a.kind === "cap_approaching" && a.model === "gpt-4o");
  assert.equal(approach.length, 1);
  assert.match(approach[0].key, /:model:gpt-4o:day/);
  assert.equal(approach[0].agentName, "multi");
  await h.service.evaluateFleetAlerts();
  assert.equal(h.delivered.filter((a) => a.kind === "cap_approaching" && a.model === "gpt-4o").length, 1, "not re-sent");
  assert.equal((await H1.call("gpt-4o")).status, 200);
  await H1.sync(); // $1.20
  await h.service.evaluateFleetAlerts();
  assert.equal(h.delivered.filter((a) => a.kind === "cap_hit" && a.model === "gpt-4o").length, 1);
  await h.setModelCaps(null);
  await h.service.evaluateFleetAlerts();
  const list = (await h.req("/v1/alerts?status=all", undefined, h.owner)).body;
  const model = (list.alerts ?? list).filter((a) => a.model === "gpt-4o");
  assert.ok(model.length >= 2);
  assert.ok(model.every((a) => !a.active), "removing the rule resolves model alerts");
});

// Issue #268 AC3: a hosted week rule (model_caps_week) is enforced fleet-wide.
test("regression #268: gpt-4o week=1 from H1 refuses gpt-4o on H2 with scope week; another model passes", async (t) => {
  const h = await hosted(t);
  await h.setModelCaps([{ model: "gpt-4o", scope: "week", usd: 1 }]);
  const H1 = await h.host("h1"), H2 = await h.host("h2");
  await H1.sync();
  assert.equal(H1.fleet.policy().modelCaps, undefined, "week rules never reach the legacy modelCaps field");
  for (let i = 0; i < 3; i++) assert.equal((await H1.call("gpt-4o")).status, 200);
  await H1.sync();
  await H2.sync();
  assert.equal(H2.fleet.agentSpend().models["gpt-4o"].week, 1.2);
  const r = await H2.call("gpt-4o");
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "model_budget_exceeded");
  assert.equal(r.body.scope, "week");
  assert.equal(r.body.fleet, true);
  assert.equal((await H2.call("gpt-4o-mini")).status, 200);
  // The agent card shows week spend for the rule.
  const row = (await h.req("/v1/fleet", undefined, h.owner)).body.agents.find((a) => a.id === h.agentId);
  assert.deepEqual(row.modelCapSpend, [{ model: "gpt-4o", scope: "week", usd: 1, spent: 1.2, unknown: 0 }]);
});
