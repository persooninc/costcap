// Issue #244 regression: one agent enrolled on two hosts (H1, H2) shares a hosted
// modelCaps day cap through the real local hosted server. At e3248cf each host
// enforced the rule against its own ledger only, so H2 stayed under $5.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, appendFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import { startMeteringProxy } from "../src/proxy.js";
import { createModelCaps, withFleetModelCaps } from "../src/model-cap.js";

const OPUS = "claude-opus-4-8", HAIKU = "claude-haiku-4-5";

async function hosted(t) {
  const dir = mkdtempSync(join(tmpdir(), "cc-244-"));
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
  const c = await req("/auth/request", { email: "reg-244@example.invalid", turnstileToken: "x" });
  const owner = (await req("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  const token = (await req("/v1/enrollment-tokens", { caps: {} }, owner)).body.token;
  const h1Path = join(dir, "h1.json");
  const { agentId } = await enroll({ url: base, token, name: "opus-agent", path: h1Path });
  assert.equal((await req(`/v1/agents/${agentId}/policy`, { modelCaps: [{ model: OPUS, scope: "day", usd: 5 }] }, owner)).status, 200);
  // H2 runs the same agent identity with its own ledger and sync state.
  const h2Path = join(dir, "h2.json");
  copyFileSync(h1Path, h2Path);
  const up = http.createServer((q, s) => {
    let raw = ""; q.on("data", (d) => (raw += d));
    q.on("end", () => { const m = JSON.parse(raw || "{}").model; s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: m, usage: { prompt_tokens: 10, completion_tokens: 1 } })); });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => up.close());
  const host = async (name, path) => {
    const receiptsPath = join(dir, `${name}.jsonl`);
    const fleet = createFleetClient({ path, receiptsPath });
    const local = createModelCaps({ rules: [] });
    const { server, port } = await startMeteringProxy({ receiptsPath, upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, modelCaps: withFleetModelCaps(local, fleet) });
    t.after(() => server.close());
    const call = async (model) => {
      const r = await fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", body: JSON.stringify({ model }) });
      return { status: r.status, body: await r.json() };
    };
    const add = (row) => appendFileSync(receiptsPath, JSON.stringify({ ts: new Date().toISOString(), provider: "openai", ...row }) + "\n");
    return { fleet, call, add };
  };
  return { req, owner, H1: await host("h1", h1Path), H2: await host("h2", h2Path) };
}

test("regression #244 AC1: synced $3 from H1 + $2.10 unsynced on H2 refuses Opus on H2 (fleet: true); Haiku keeps going, not latched", async (t) => {
  const { H1, H2 } = await hosted(t);
  H1.add({ id: "h1-opus", model: OPUS, cost_usd: 3 });
  await H1.fleet.sync();
  await H2.fleet.sync(); // H2 learns the $3 snapshot
  H2.add({ id: "h2-opus", model: OPUS, cost_usd: 2.1 }); // not yet synced
  const r = await H2.call(OPUS);
  assert.equal(r.status, 429);
  assert.equal(r.body.fleet, true);
  assert.equal(r.body.spend_usd, 5.1);
  assert.equal(r.body.cap_usd, 5);
  assert.equal((await H2.call(HAIKU)).status, 200);
  assert.equal((await H2.call(HAIKU)).status, 200); // the run is not latched
  // Once H2 syncs, H1 is refused too.
  await H2.fleet.sync();
  await H1.fleet.sync();
  const h1 = await H1.call(OPUS);
  assert.equal(h1.status, 429);
  assert.equal(h1.body.spend_usd, 5.1);
});

test("regression #244 AC2: a synced unknown-cost Opus receipt blocks Opus only until settled in the dashboard; OpenRouter dotted id counts", async (t) => {
  const { req, owner, H1, H2 } = await hosted(t);
  H1.add({ id: "h1-unk", model: "anthropic/claude-opus-4.8", provider: "openrouter", cost_usd: null, reason: "usage_unavailable" });
  await H1.fleet.sync();
  await H2.fleet.sync();
  const r = await H2.call(OPUS);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "accounting_unavailable");
  assert.equal(r.body.model, OPUS);
  assert.equal((await H2.call(HAIKU)).status, 200);
  const settled = await req("/v1/receipts/h1-unk/settle", { cost_usd: 4.5, source: "provider_invoice", reason: "provider invoice" }, owner);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  await H2.fleet.sync();
  assert.deepEqual(H2.fleet.agentSpend().models[OPUS], { day: 4.5, month: 4.5, unknown: 0 });
  assert.equal((await H2.call(OPUS)).status, 200);
  H2.add({ id: "h2-more", model: OPUS, cost_usd: 0.5 });
  const over = await H2.call(OPUS);
  assert.equal(over.status, 429);
  assert.equal(over.body.error, "model_budget_exceeded");
});
