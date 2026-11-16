// Issue #146: enrolled receipt sync drains the whole backlog in batches of <=100.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient, loadEnrollment } from "../src/hosted/client.js";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

// Real hosted server behind a counting front that can fail chosen receipt POSTs.
async function stack(t) {
  let code;
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-drain-store-")), "store.json");
  const service = createHostedServer({ storePath, origin: "http://localhost", secureCookies: false, stripeEnv: {}, verifyChallenge: async (v) => v === "ok", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {} });
  const backPort = await listen(service.server);
  const state = { posts: 0, sizes: [], failOn: new Set(), statuses: [] };
  const front = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    if (req.url === "/v1/receipts" && req.method === "POST") {
      state.posts++;
      state.sizes.push(JSON.parse(body).receipts.length);
      if (state.failOn.has(state.posts)) { res.writeHead(503, { "content-type": "application/json" }).end("{}"); return; }
    }
    const r = await fetch(`http://127.0.0.1:${backPort}${req.url}`, { method: req.method, headers: { ...req.headers, host: undefined, connection: "close" }, body: req.method === "GET" ? undefined : body });
    if (req.url === "/v1/receipts") state.statuses.push(r.status);
    res.writeHead(r.status, { "content-type": "application/json", ...(r.headers.get("set-cookie") ? { "set-cookie": r.headers.get("set-cookie") } : {}) }).end(await r.text());
  });
  const port = await listen(front);
  t.after(() => { for (const s of [front, service.server]) { s.closeAllConnections(); s.close(); } });
  const url = `http://127.0.0.1:${port}`;
  const req = async (p, body, cookie) => {
    const r = await fetch(`${url}${p}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const c = await req("/auth/request", { email: "drain@example.invalid", turnstileToken: "ok" });
  const owner = await req("/auth/verify", { challengeId: c.body.challengeId, code });
  const token = (await req("/v1/enrollment-tokens", { caps: { day: 10000 } }, owner.cookie)).body.token;
  const dir = mkdtempSync(join(tmpdir(), "cc-drain-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "receipts.jsonl");
  await enroll({ url, token, name: "drain-bot", path });
  const writeReceipts = (n, cost = 0.01) => {
    const ts = new Date().toISOString();
    writeFileSync(receiptsPath, Array.from({ length: n }, (_, i) => JSON.stringify({ id: `r-${i}`, ts, cost_usd: cost })).join("\n") + "\n");
  };
  return { state, path, receiptsPath, dir, writeReceipts };
}

test("AC2+AC5: 350 unsynced receipts drain in exactly 4 POSTs and agent_spend covers the whole backlog", async (t) => {
  const s = await stack(t);
  s.writeReceipts(350);
  const client = createFleetClient({ path: s.path, receiptsPath: s.receiptsPath });
  assert.equal((await client.sync()).online, true);
  assert.equal(s.state.posts, 4);
  assert.deepEqual(s.state.sizes, [100, 100, 100, 50]);
  assert.equal(new Set(loadEnrollment(s.path).syncedIds).size, 350);
  assert.ok(Math.abs(client.agentSpend().spent.day - 3.5) < 1e-9, JSON.stringify(client.agentSpend()));
  await client.sync(); // nothing left: no more receipt POSTs
  assert.equal(s.state.posts, 4);
});

test("AC3: batch 3 of 4 fails; batches 1-2 stay acknowledged and the next sync resumes with no duplicates or 409", async (t) => {
  const s = await stack(t);
  s.writeReceipts(350);
  s.state.failOn.add(3);
  const client = createFleetClient({ path: s.path, receiptsPath: s.receiptsPath });
  const first = await client.sync();
  assert.equal(first.online, false);
  assert.equal(loadEnrollment(s.path).syncedIds.length, 200);
  const second = await client.sync();
  assert.equal(second.online, true);
  assert.deepEqual(s.state.sizes, [100, 100, 100, 100, 50]);
  assert.ok(s.state.statuses.every((c) => c === 200), String(s.state.statuses));
  assert.equal(new Set(loadEnrollment(s.path).syncedIds).size, 350);
  assert.ok(Math.abs(client.agentSpend().spent.day - 3.5) < 1e-9);
});

test("drain is bounded by a per-sync batch ceiling and resumes on the next sync", async (t) => {
  const s = await stack(t);
  s.writeReceipts(250);
  const client = createFleetClient({ path: s.path, receiptsPath: s.receiptsPath, maxBatches: 2 });
  await client.sync();
  assert.equal(loadEnrollment(s.path).syncedIds.length, 200);
  await client.sync();
  assert.equal(loadEnrollment(s.path).syncedIds.length, 250);
  const zeroBudget = createFleetClient({ path: s.path, receiptsPath: s.receiptsPath, syncBudgetMs: 0 });
  s.writeReceipts(260); // r-250..r-259 new
  await zeroBudget.sync();
  assert.equal(loadEnrollment(s.path).syncedIds.length, 250, "zero time budget uploads nothing");
});

test("sync({ wait: true }) waits for an in-flight sync instead of skipping", async (t) => {
  const s = await stack(t);
  s.writeReceipts(120);
  const client = createFleetClient({ path: s.path, receiptsPath: s.receiptsPath });
  const a = client.sync();
  assert.deepEqual(await client.sync(), { skipped: true });
  const b = await client.sync({ wait: true });
  await a;
  assert.equal(b.online, true);
  assert.equal(loadEnrollment(s.path).syncedIds.length, 120);
});

test("AC4 e2e: costcap wrap ending with >100 unsynced receipts uploads all of them before exit", async (t) => {
  const s = await stack(t);
  s.writeReceipts(250);
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "wrap", "--enrollment", s.path, "--receipts", s.receiptsPath, "--kill-file", join(s.dir, "KILL"), "--", process.execPath, "-e", "0"]);
    let err = ""; child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, err }));
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(new Set(loadEnrollment(s.path).syncedIds).size, 250);
  assert.ok(s.state.sizes.every((n) => n <= 100));
});
