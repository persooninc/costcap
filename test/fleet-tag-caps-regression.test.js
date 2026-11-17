// Issue #204 regression: two enrolled agents in one org share a fleet tag cap
// (customer:day=1) through the real local hosted server, fake upstreams at $0.40/call.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import { startMeteringProxy } from "../src/proxy.js";
import { createTagCaps, withFleetTagCaps } from "../src/tag-cap.js";

// gpt-4o: 160k input tokens at $2.50/M = $0.40 per call.
const COMPLETION = JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 160_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } });

async function hosted(t) {
  const dir = mkdtempSync(join(tmpdir(), "cc-204-"));
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
  const c = await req("/auth/request", { email: "reg-204@example.invalid", turnstileToken: "x" });
  const owner = (await req("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  const setRules = async (tagCaps) => assert.equal((await req("/v1/tag-caps", { tagCaps }, owner, "PUT")).status, 200);
  const agent = async (name, { localRules = [] } = {}) => {
    const token = (await req("/v1/enrollment-tokens", { caps: { day: 100 } }, owner)).body.token;
    const path = join(dir, `${name}.json`), receiptsPath = join(dir, `${name}.jsonl`);
    await enroll({ url: base, token, name, path });
    const fleet = createFleetClient({ path, receiptsPath });
    const up = http.createServer((q, s) => { q.resume(); q.on("end", () => s.writeHead(200, { "content-type": "application/json" }).end(COMPLETION)); });
    await new Promise((r) => up.listen(0, "127.0.0.1", r));
    const local = localRules.length ? createTagCaps({ rules: localRules }) : null;
    const { server, port } = await startMeteringProxy({ receiptsPath, upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, tagCaps: withFleetTagCaps(local, fleet, localRules) });
    t.after(() => { server.close(); up.close(); });
    const call = async (tag) => {
      const r = await fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", headers: { "x-costcap-tag": tag }, body: JSON.stringify({ model: "gpt-4o" }) });
      return { status: r.status, body: await r.json() };
    };
    return { fleet, call, receiptsPath };
  };
  return { setRules, agent };
}

test("regression #204 AC2: fleet customer:day=1 across agents A and B", async (t) => {
  const h = await hosted(t);
  await h.setRules([{ key: "customer", scope: "day", usd: 1 }]);
  const A = await h.agent("a"), B = await h.agent("b");
  assert.equal((await A.fleet.sync()).online, true);
  assert.equal((await B.fleet.sync()).online, true);
  assert.equal((await A.call("customer=acme")).status, 200);
  assert.equal((await A.call("customer=acme")).status, 200);
  await A.fleet.sync();
  await B.fleet.sync();
  assert.equal((await B.call("customer=acme")).status, 200); // 0.8 synced < 1
  await B.fleet.sync();
  await A.fleet.sync();
  for (const ag of [A, B]) {
    const r = await ag.call("customer=acme");
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "tag_budget_exceeded");
    assert.equal(r.body.fleet, true);
    assert.equal(r.body.spend_usd, 1.2);
    assert.equal(r.body.cap_usd, 1);
  }
  assert.equal((await A.call("customer=globex")).status, 200);
  assert.equal((await B.call("customer=globex")).status, 200);
});

test("regression #204 AC3: a local --tag-cap tighter than the fleet rule wins", async (t) => {
  const h = await hosted(t);
  await h.setRules([{ key: "customer", scope: "day", usd: 1 }]);
  const A = await h.agent("a", { localRules: [{ key: "customer", scope: "day", cap: 0.5 }] });
  await A.fleet.sync();
  assert.equal((await A.call("customer=acme")).status, 200);
  assert.equal((await A.call("customer=acme")).status, 200); // 0.4 < 0.5
  const r = await A.call("customer=acme");
  assert.equal(r.status, 429);
  assert.equal(r.body.cap_usd, 0.5);
  // Synced elsewhere, the fleet rule is still tightened to 0.5 by the local rule.
  assert.equal(A.fleet.tagCheck({ customer: "acme" }, [{ key: "customer", scope: "day", cap: 0.5 }]).cap_usd, 0.5);
  // A looser local rule never loosens the fleet one: $0.8 is under the fleet $1, then one more call hits it.
  assert.equal(A.fleet.tagCheck({ customer: "acme" }, [{ key: "customer", scope: "day", cap: 5 }]), null);
  appendFileSync(A.receiptsPath, JSON.stringify({ id: "extra", ts: new Date().toISOString(), cost_usd: 0.4, tags: { customer: "acme" } }) + "\n");
  assert.equal(A.fleet.tagCheck({ customer: "acme" }, [{ key: "customer", scope: "day", cap: 5 }]).cap_usd, 1);
});

test("regression #204 AC4/AC5: offline cache, rule removal and unknown-cost values", async (t) => {
  const h = await hosted(t);
  await h.setRules([{ key: "customer", scope: "day", usd: 1 }]);
  const A = await h.agent("a"), B = await h.agent("b");
  const ts = new Date().toISOString();
  appendFileSync(B.receiptsPath, JSON.stringify({ id: "unk-acme", ts, cost_usd: null, reason: "usage_unavailable", tags: { customer: "acme" } }) + "\n");
  await B.fleet.sync();
  await A.fleet.sync();
  const unk = await A.call("customer=acme");
  assert.equal(unk.status, 429);
  assert.equal(unk.body.error, "accounting_unavailable");
  assert.equal(unk.body.tag_value, "acme");
  assert.equal((await A.call("customer=globex")).status, 200);
  await h.setRules([]);
  await A.fleet.sync();
  assert.equal(A.fleet.tagCaps(), null);
  assert.equal((await A.call("customer=acme")).status, 200);
});

// Issue #268: a fleet week rule travels in tag_caps_v2 and refuses with scope week.
test("regression #268: fleet customer:week=1 refuses acme on B, globex passes", async (t) => {
  const h = await hosted(t);
  await h.setRules([{ key: "customer", scope: "week", usd: 1 }, { key: "customer", scope: "month", usd: 50 }]);
  const A = await h.agent("a"), B = await h.agent("b");
  await A.fleet.sync();
  assert.equal(A.fleet.tagCaps().rules.length, 2, "the new client reads tag_caps_v2");
  for (let i = 0; i < 3; i++) assert.equal((await A.call("customer=acme")).status, 200);
  await A.fleet.sync();
  await B.fleet.sync();
  const r = await B.call("customer=acme");
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "tag_budget_exceeded");
  assert.equal(r.body.scope, "week");
  assert.equal(r.body.fleet, true);
  assert.equal(r.body.spend_usd, 1.2);
  assert.equal((await B.call("customer=globex")).status, 200);
});
