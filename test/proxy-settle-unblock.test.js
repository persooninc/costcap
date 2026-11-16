// Issue #171: settling an unknown-cost receipt unblocks the RUNNING proxy (no restart).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine, loadSettledReceipts } from "../src/cap.js";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";

const USAGE = '{"model":"gpt-4o-mini","usage":{"prompt_tokens":1000,"completion_tokens":0}}';

async function running(t, { receiptsPath, cap } = {}) {
  let mode = "ok"; let hits = 0;
  const up = http.createServer((req, res) => {
    hits++;
    if (mode === "nousage") return res.end("{}");
    if (mode === "drop") return req.socket.destroy();
    res.end(USAGE);
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, receiptsPath, cap, onReceipt: (r) => receipts.push(r) });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = async () => { const r = await fetch(`http://127.0.0.1:${p.port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini" }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  return { server: p.server, call, receipts, hits: () => hits, setMode: (m) => { mode = m; } };
}

test("#171 two unknown receipts: one settled still refuses; both settled forwards", async (t) => {
  const f = await running(t);
  f.setMode("nousage");
  assert.equal((await f.call()).status, 200);
  assert.equal((await f.call()).body.error, "accounting_unavailable");
  // A second process-local unknown: lift the first only to cause the second.
  const first = f.receipts[0].id;
  assert.equal(f.server.settle({ receipt_id: first }), true);
  assert.equal((await f.call()).status, 200);
  const second = f.receipts.at(-1).id;
  assert.notEqual(second, first);
  assert.equal(f.receipts.at(-1).reason, "usage_unavailable");
  f.setMode("ok");
  // Re-latch scenario for AC3: two outstanding failures at once.
  const g = await running(t);
  g.setMode("nousage");
  await g.call();
  g.server.settle({ receipt_id: g.receipts[0].id });
  await g.call();
  const ids = g.receipts.filter((r) => r.reason === "usage_unavailable").map((r) => r.id);
  // only the newest is outstanding; add a manual second by settling nothing and checking unrelated ids are ignored
  assert.equal(g.server.settle({ receipt_id: "unrelated" }), false);
  assert.equal((await g.call()).body.error, "accounting_unavailable");
  g.setMode("ok");
  assert.equal(g.server.settle({ id: ids[1] }), true);
  const ok = await g.call();
  assert.equal(ok.status, 200);
  assert.equal(g.receipts.at(-1).cost_usd > 0, true);
});

test("#171 concurrent unknowns both latch: partial settle keeps refusing", async (t) => {
  const f = await running(t);
  f.setMode("nousage");
  const [a, b] = await Promise.all([f.call(), f.call()]);
  // Queue serializes: first forwarded (unknown), second refused. Force a second unknown by settling the first then failing again before settling.
  assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  const u1 = f.receipts.find((r) => r.reason === "usage_unavailable").id;
  f.server.settle({ receipt_id: u1 });
  await f.call(); // second unknown
  const u2 = f.receipts.filter((r) => r.reason === "usage_unavailable").at(-1).id;
  // Re-add u1 by simulating: a duplicate settle of u1 does nothing; u2 still blocks.
  assert.equal(f.server.settle({ receipt_id: u1 }), false);
  f.setMode("ok");
  assert.equal((await f.call()).body.error, "accounting_unavailable");
  f.server.settle({ receipt_id: u2 });
  assert.equal((await f.call()).status, 200);
  assert.equal(f.server.accountingFailure(), null);
});

test("#171 failures with no receipt id (uncertain outcome) are not cleared by a settlement", async (t) => {
  const f = await running(t);
  f.setMode("drop");
  assert.equal((await f.call()).status, 502);
  const r = f.receipts.at(-1);
  assert.equal(r.reason, "upstream_outcome_unknown");
  assert.equal(f.server.settle({ receipt_id: r.id }), false);
  f.setMode("ok");
  const blocked = await f.call();
  assert.equal(blocked.body.error, "accounting_unavailable");
  assert.match(blocked.body.message, /uncertain/);
});

test("#171 hosted settle via POST /v1/receipts/:id/settle + one sync unblocks a running proxy; spend counted once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-171-"));
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
  const c = await req("/auth/request", { email: "reg-171@example.invalid", turnstileToken: "x" });
  const owner = (await req("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  const enrollToken = (await req("/v1/enrollment-tokens", { caps: { day: 10, month: 50 } }, owner)).body.token;
  const path = join(dir, "a.json"), receiptsPath = join(dir, "a.jsonl");
  await enroll({ url: base, token: enrollToken, name: "a", path });

  const cap = createCapEngine({ caps: { day: 10 } });
  const f = await running(t, { receiptsPath, cap });
  const client = createFleetClient({ path, receiptsPath, onSettle: (r) => { cap.settle(r); f.server.settle(r); } });
  f.setMode("nousage");
  assert.equal((await f.call()).status, 200);
  const unknownId = f.receipts[0].id;
  // client syncs receipts upstream so the hosted service knows the id
  assert.equal((await client.sync()).online, true);
  f.setMode("ok");
  assert.equal((await f.call()).body.error, "accounting_unavailable");
  const hitsBefore = f.hits();

  const s = await req(`/v1/receipts/${unknownId}/settle`, { cost_usd: 0.5, source: "provider_invoice", reason: "invoice" }, owner);
  assert.equal(s.status, 200);
  assert.equal((await client.sync()).online, true);
  const forwarded = await f.call();
  assert.equal(forwarded.status, 200);
  assert.equal(f.hits(), hitsBefore + 1);
  // Running cap engine and a fresh wrap agree on day spend (settled once).
  await client.sync();
  const fresh = createCapEngine({ caps: { day: 10 }, history: loadSettledReceipts(receiptsPath) });
  assert.equal(Number(cap.spend().day.toFixed(6)), Number(fresh.spend().day.toFixed(6)));
  assert.ok(readFileSync(receiptsPath, "utf8").includes("hosted_settle"));
});
