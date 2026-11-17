// Issue #249: wrap --max-concurrent N. Admission stays serialized (FIFO, full verdict);
// up to N admitted calls are forwarded at once. Fake upstreams count peak in-flight calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createVelocityBreaker } from "../src/velocity.js";
import { createRateLimiter } from "../src/rate-limit.js";
import { estimateWorstCase, checkEstimate } from "../src/preflight.js";
import { costForUsage } from "../src/pricing.js";
import { parseWrapArgs } from "../src/cli.js";
import { assertAgentPolicy, isMaxConcurrent } from "../src/agent-budget.js";
import { resolvePolicy, validatePolicy } from "../src/hosted/policy.js";
import { buildRunSummary, rollupLine } from "../src/run-summary.js";
import { createHostedServer } from "../src/hosted/server.js";
import { enroll, createFleetClient } from "../src/hosted/client.js";
import "./support/pinned-clock.js";

const tmp = (p = "cc-249-") => mkdtempSync(join(tmpdir(), p));
const readReceipts = (f) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

// Counting upstream: `delay(i)` ms per request, `body(i, req)` JSON response.
async function upstream(t, { delay = () => 300, body = () => ({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 } }) } = {}) {
  const st = { hits: 0, inFlight: 0, peak: 0 };
  const s = http.createServer((q, res) => {
    let b = ""; q.on("data", (d) => (b += d));
    q.on("end", () => {
      const i = st.hits++;
      st.inFlight++; st.peak = Math.max(st.peak, st.inFlight);
      setTimeout(() => { st.inFlight--; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body(i, b))); }, delay(i));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => { s.closeAllConnections(); s.close(); });
  st.url = `http://127.0.0.1:${s.address().port}`;
  return st;
}

async function proxy(t, up, opts = {}) {
  const receiptsPath = join(tmp(), "r.jsonl");
  const p = await startMeteringProxy({ receiptsPath, upstreams: { openai: up.url }, ...opts });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); });
  let seq = 0; // unique bodies: identical repeats would trip the spiral detector
  const call = async (payload = { model: "gpt-4o-mini", n: seq++ }) => {
    const r = await fetch(`http://127.0.0.1:${p.port}/openai/v1/chat/completions`, { method: "POST", body: JSON.stringify(payload) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* stream */ }
    return { status: r.status, json };
  };
  return { call, receiptsPath, server: p.server };
}

const errOf = (r) => (typeof r.json?.error === "string" ? r.json.error : r.json?.error?.type ?? r.json?.error?.reason);

test("AC1: default serializes; --max-concurrent 4 runs 4 at once; 2 queues 6 without refusing", async (t) => {
  const a = await upstream(t);
  const pa = await proxy(t, a);
  let t0 = Date.now();
  const ra = await Promise.all(Array.from({ length: 4 }, () => pa.call()));
  assert.ok(Date.now() - t0 >= 1200 - 20, "serialized total");
  assert.equal(a.peak, 1);
  assert.deepEqual(ra.map((r) => r.status), [200, 200, 200, 200]);

  const b = await upstream(t);
  const pb = await proxy(t, b, { maxConcurrent: 4 });
  t0 = Date.now();
  const rb = await Promise.all(Array.from({ length: 4 }, () => pb.call()));
  assert.ok(Date.now() - t0 < 900, `took ${Date.now() - t0} ms`);
  assert.equal(b.peak, 4);
  assert.deepEqual(rb.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal(readReceipts(pb.receiptsPath).length, 4);
  assert.equal(pb.server.inFlight(), 0);

  const c = await upstream(t);
  const pc = await proxy(t, c, { maxConcurrent: 2 });
  const rc = await Promise.all(Array.from({ length: 6 }, () => pc.call()));
  assert.equal(c.peak, 2);
  assert.ok(rc.every((r) => r.status === 200));
});

test("AC2: run-cap overshoot is at most N in-flight calls; later calls are budget_exceeded; NDJSON ids unique", async (t) => {
  // gpt-4o-mini input is $0.15/M: 266,667 prompt tokens ~ $0.04 per call.
  const usage = { prompt_tokens: 266_667, completion_tokens: 0 };
  const per = costForUsage("gpt-4o-mini", { input_tokens: usage.prompt_tokens, output_tokens: 0 }).cost_usd;
  const up = await upstream(t, { delay: () => 100, body: () => ({ model: "gpt-4o-mini", usage }) });
  const p = await proxy(t, up, { maxConcurrent: 4, cap: createCapEngine({ caps: { run: 0.10 } }) });
  const rs = await Promise.all(Array.from({ length: 20 }, () => p.call()));
  const receipts = readReceipts(p.receiptsPath);
  assert.equal(receipts.length, 20);
  assert.equal(new Set(receipts.map((r) => r.id)).size, 20);
  const spent = receipts.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  assert.ok(spent <= 0.10 + 4 * per + 1e-9, `spent ${spent}`);
  assert.ok(up.peak <= 4);
  const firstRefused = rs.findIndex((r) => r.status === 429);
  assert.ok(firstRefused > 0);
  assert.ok(rs.slice(firstRefused).every((r) => r.status === 429 && r.json.error.type === "budget_exceeded"));
});

test("AC3: in-flight calls count toward --max-steps; RPM reservation is unchanged", async (t) => {
  const a = await upstream(t, { delay: () => 150 });
  const pa = await proxy(t, a, { maxConcurrent: 4, velocity: createVelocityBreaker({ maxSteps: 5 }) });
  const ra = await Promise.all(Array.from({ length: 10 }, () => pa.call()));
  assert.equal(a.hits, 5);
  assert.equal(ra.filter((r) => r.status === 200).length, 5);
  assert.ok(ra.filter((r) => r.status === 429).every((r) => r.json.error === "breaker_open" && r.json.reason === "step_budget"));

  const b = await upstream(t, { delay: () => 150 });
  const pb = await proxy(t, b, { maxConcurrent: 8, rateLimit: createRateLimiter({ rpm: 3 }) });
  const rb = await Promise.all(Array.from({ length: 10 }, () => pb.call()));
  assert.equal(b.hits, 3);
  assert.equal(rb.filter((r) => r.status === 429).length, 7);
});

test("AC3: --preflight subtracts in-flight worst cases before admitting the next call", async (t) => {
  const payload = { model: "gpt-4o-mini", max_tokens: 1000 };
  const est = estimateWorstCase("openai", JSON.stringify(payload), "/v1/chat/completions").estimate_usd;
  const up = await upstream(t, { delay: () => 300 });
  const p = await proxy(t, up, { maxConcurrent: 3, preflight: true, cap: createCapEngine({ caps: { run: est * 2.5 } }) });
  const rs = await Promise.all(Array.from({ length: 3 }, () => p.call(payload)));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 429]);
  assert.equal(rs[2].json.error.reason, "preflight_estimate");
  assert.equal(up.hits, 2);
  // The same call fits once nothing is in flight.
  assert.equal((await p.call(payload)).status, 200);
});

test("checkEstimate: reserved dollars shrink every remaining scope", () => {
  const cap = createCapEngine({ caps: { run: 1, day: 5 } });
  const est = { ok: true, estimate_usd: 0.6, model: "m" };
  assert.equal(checkEstimate(cap, est), null);
  const hit = checkEstimate(cap, est, undefined, 0.5);
  assert.equal(hit.reason, "preflight_estimate");
  assert.equal(hit.scope, "run");
  assert.equal(hit.remaining_usd.run, 0.5);
  assert.equal(hit.remaining_usd.day, 4.5);
});

test("AC4: a usage_unavailable in-flight call latches; calls already in flight finish and are recorded", async (t) => {
  const up = await upstream(t, { delay: (i) => (i === 0 ? 50 : 300), body: (i) => (i === 0 ? {} : { model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 } }) });
  const p = await proxy(t, up, { maxConcurrent: 3 });
  const first = Array.from({ length: 3 }, () => p.call());
  assert.equal((await first[0]).status, 200);
  const next = await p.call();
  assert.equal(next.status, 429);
  assert.equal(next.json.error, "accounting_unavailable");
  const rest = await Promise.all(first.slice(1));
  assert.deepEqual(rest.map((r) => r.status), [200, 200]);
  const receipts = readReceipts(p.receiptsPath);
  assert.equal(receipts.filter((r) => !r.blocked).length, 3);
  assert.equal(receipts.filter((r) => r.reason === "usage_unavailable").length, 1);
  assert.equal(up.hits, 3);
});

test("AC4: the kill file stops new admissions while in-flight calls complete", async (t) => {
  let killed = null;
  const up = await upstream(t, { delay: () => 200 });
  const p = await proxy(t, up, { maxConcurrent: 3, killCheck: () => killed });
  const inflight = Array.from({ length: 3 }, () => p.call());
  await new Promise((r) => setTimeout(r, 80));
  killed = { reason: "killed", note: "test" };
  const after = await p.call();
  assert.equal(after.status, 429);
  assert.equal(after.json.error, "killed");
  assert.deepEqual((await Promise.all(inflight)).map((r) => r.status), [200, 200, 200]);
  assert.equal(readReceipts(p.receiptsPath).filter((r) => !r.blocked).length, 3);
});

test("a getter lowers concurrency live (fleet sync)", async (t) => {
  let n = 4;
  const up = await upstream(t, { delay: () => 100 });
  const p = await proxy(t, up, { maxConcurrent: () => n });
  await Promise.all(Array.from({ length: 4 }, () => p.call()));
  assert.equal(up.peak, 4);
  n = 2; up.peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => p.call()));
  assert.equal(up.peak, 2);
});

test("velocity: in-flight calls count toward maxSteps without latching early", () => {
  const v = createVelocityBreaker({ maxSteps: 3 });
  v.record(0);
  assert.equal(v.check(1), null);
  const hit = v.check(2);
  assert.equal(hit.reason, "step_budget");
  assert.equal(hit.in_flight, 2);
  // Not latched: once in-flight calls settle without a step, admission resumes.
  assert.equal(v.check(0), null);
  v.record(0); v.record(0);
  assert.equal(v.check(0).reason, "step_budget");
  assert.equal(v.check(0).in_flight, undefined);
});

test("AC5: --max-concurrent validation (flag, policy file, fleet policy)", () => {
  assert.equal(parseWrapArgs(["--max-concurrent", "8", "--", "x"]).maxConcurrent, 8);
  assert.equal(parseWrapArgs(["--", "x"]).maxConcurrent, undefined);
  for (const bad of ["0", "65", "1.5", "abc", "-1", ""]) assert.throws(() => parseWrapArgs(["--max-concurrent", bad, "--", "x"]), /--max-concurrent must be an integer from 1 to 64/);
  assert.ok(isMaxConcurrent(1) && isMaxConcurrent(64) && !isMaxConcurrent(65) && !isMaxConcurrent("4"));
  assert.throws(() => assertAgentPolicy({ agents: { a: { maxConcurrent: -1 } } }), /Invalid a maxConcurrent/);
  assert.throws(() => assertAgentPolicy({ default: { maxConcurrent: 1.5 } }), /Invalid default maxConcurrent/);
  assertAgentPolicy({ default: { maxConcurrent: 6 } });
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, maxConcurrent: "4" }), ["maxConcurrent must be an integer from 1 to 64"]);
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, maxConcurrent: 65 }), ["maxConcurrent must be an integer from 1 to 64"]);
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, maxConcurrent: 2 }), []);
  assert.equal(resolvePolicy({ local: { maxConcurrent: 8 }, lastKnown: { version: 1, caps: {}, maxConcurrent: 2 } }).maxConcurrent, 2);
  assert.equal(resolvePolicy({ local: { maxConcurrent: 3 }, lastKnown: { version: 1, caps: {}, maxConcurrent: 6 } }).maxConcurrent, 3);
  assert.equal(resolvePolicy({ lastKnown: { version: 1, caps: {} } }).maxConcurrent, undefined);
  assert.throws(() => resolvePolicy({ local: { maxConcurrent: 0 } }), /Invalid local maxConcurrent/);
});

test("run summary shows max_concurrent only when parallel forwarding was on", () => {
  const base = { run_id: "r", started_at: "a", ended_at: "b" };
  assert.equal("max_concurrent" in buildRunSummary(base), false);
  assert.doesNotMatch(rollupLine(buildRunSummary(base)), /max_concurrent/);
  const s = buildRunSummary({ ...base, maxConcurrent: 4 });
  assert.equal(s.max_concurrent, 4);
  assert.match(rollupLine(s), /max_concurrent=4/);
});

// ---- integration: real `costcap wrap` processes ----
function runWrap(args, script, env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...args, "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, ...env } });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => resolve({ code, out, err }));
  });
}
const parallelScript = (n) => `
  const u = process.env.OPENAI_BASE_URL + "/chat/completions";
  const rs = await Promise.all(Array.from({ length: ${n} }, (_, i) => fetch(u, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", i }) }).then(async (r) => r.status === 200 ? 200 : (await r.json()).error?.type ?? r.status)));
  console.log(JSON.stringify(rs));`;

test("wrap --max-concurrent 4: real spawn runs 4 in flight and records max_concurrent in the run summary", { timeout: 60_000 }, async (t) => {
  const up = await upstream(t, { delay: () => 300 });
  const dir = tmp();
  const receipts = join(dir, "r.jsonl");
  const r = await runWrap(["--max-concurrent", "4", "--receipts", receipts], parallelScript(4), { COSTCAP_TEST_OPENAI_UPSTREAM: up.url });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), [200, 200, 200, 200]);
  assert.equal(up.peak, 4);
  assert.match(r.err, /max_concurrent=4/);
  const summary = JSON.parse(readFileSync(join(dir, "runs", `${readReceipts(receipts)[0].run_id}.json`), "utf8"));
  assert.equal(summary.max_concurrent, 4);
});

test("wrap rejects invalid --max-concurrent and policy maxConcurrent with exit 2 before spawning", { timeout: 60_000 }, async () => {
  const dir = tmp();
  const marker = join(dir, "spawned");
  const script = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`;
  for (const bad of ["0", "65", "1.5", "abc"]) {
    const r = await runWrap(["--max-concurrent", bad, "--receipts", join(dir, "r.jsonl")], script);
    assert.equal(r.code, 2, `${bad}: ${r.err}`);
    assert.match(r.err, /--max-concurrent must be an integer from 1 to 64/);
  }
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({ agents: { a: { maxConcurrent: -1 } } }));
  const r = await runWrap(["--policy", policy, "--agent", "a", "--receipts", join(dir, "r.jsonl")], script);
  assert.equal(r.code, 2, r.err);
  assert.throws(() => readFileSync(marker));
});

test("AC6: two wrappers on one --shared-ledger at --max-concurrent 2 stay within cap + 4 calls", { timeout: 120_000 }, async (t) => {
  const usage = { prompt_tokens: 100_000, completion_tokens: 0 };
  const per = costForUsage("gpt-4o-mini", { input_tokens: usage.prompt_tokens, output_tokens: 0 }).cost_usd;
  const up = await upstream(t, { delay: () => 60, body: () => ({ model: "gpt-4o-mini", usage }) });
  const path = join(tmp(), "shared.jsonl");
  const DAY = 0.2;
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    let n = 0; const one = () => fetch(u, { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", n: n++, w: process.pid }) }).then(async (r) => r.status === 200 ? 200 : (await r.json()).error?.type);
    const out = [];
    for (let k = 0; k < 15; k++) out.push(...await Promise.all([one(), one(), one()]));
    console.log(JSON.stringify(out));`;
  const runs = await Promise.all([0, 1].map(() => runWrap(["--shared-ledger", "--max-concurrent", "2", "--day-cap", String(DAY), "--receipts", path], script, { COSTCAP_TEST_OPENAI_UPSTREAM: up.url })));
  for (const r of runs) {
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).at(-1), "budget_exceeded");
  }
  const receipts = readReceipts(path);
  const spent = receipts.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  assert.ok(spent >= DAY, `spent ${spent}`);
  assert.ok(spent <= DAY + 4 * per + 1e-9, `spent ${spent} > cap + 4 x ${per}`);
});

// ---- hosted API + fleet precedence ----
async function hosted(t) {
  const dir = tmp("cc-249-h-");
  let code;
  const origin = "http://localhost";
  const service = createHostedServer({ storePath: join(dir, "store.json"), origin, secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [] });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  const stop = () => { service.server.closeAllConnections(); service.server.close(); };
  t.after(stop);
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const req = async (path, body, cookie) => {
    const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const c = await req("/auth/request", { email: "reg-249@example.invalid", turnstileToken: "x" });
  const owner = (await req("/auth/verify", { challengeId: c.body.challengeId, code })).cookie;
  const token = (await req("/v1/enrollment-tokens", { caps: { day: 100 } }, owner)).body.token;
  const enrollPath = join(dir, "enrollment.json");
  const { agentId } = await enroll({ url: base, token, name: "par", path: enrollPath });
  return { dir, req, owner, agentId, enrollPath, stop };
}

test("AC5: hosted maxConcurrent: API validation, dashboard save keeps it, audit, fleet ceiling (online and offline)", { timeout: 120_000 }, async (t) => {
  const h = await hosted(t);
  const policyUrl = `/v1/agents/${h.agentId}/policy`;
  const bad = await h.req(policyUrl, { maxConcurrent: "4" }, h.owner);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /maxConcurrent must be an integer from 1 to 64/);
  assert.equal((await h.req(policyUrl, { maxConcurrent: 2 }, h.owner)).body.maxConcurrent, 2);
  // A dashboard caps save (no maxConcurrent field) keeps the API-set value.
  const saved = await h.req(policyUrl, { caps: { day: 50 }, maxSteps: null }, h.owner);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.maxConcurrent, 2);
  assert.equal(saved.body.caps.day, 50);
  const fleetView = await h.req("/v1/fleet", undefined, h.owner);
  const changes = fleetView.body.audit.filter((a) => a.action === "policy.change" && a.target === h.agentId);
  assert.ok(changes.some((a) => a.detail.policy.maxConcurrent === 2 && a.detail.previous.maxConcurrent === undefined));
  assert.ok(changes.some((a) => a.detail.previous.maxConcurrent === 2));

  // Fleet client resolves the ceiling; flag 8 and --policy 6 still enforce 2.
  const fleet = createFleetClient({ path: h.enrollPath, receiptsPath: join(h.dir, "fc.jsonl") });
  await fleet.sync();
  assert.equal(fleet.policy().maxConcurrent, 2);
  const policy = join(h.dir, "policy.json");
  writeFileSync(policy, JSON.stringify({ agents: { [h.agentId]: { maxConcurrent: 6 } } }));
  const up = await upstream(t, { delay: () => 250 });
  const args = (enrollment) => ["--max-concurrent", "8", "--policy", policy, "--agent", h.agentId, "--enrollment", enrollment, "--receipts", join(h.dir, `${Math.random()}.jsonl`)];
  const online = await runWrap(args(h.enrollPath), parallelScript(6), { COSTCAP_TEST_OPENAI_UPSTREAM: up.url });
  assert.equal(online.code, 0, online.err);
  assert.equal(up.peak, 2);
  // Offline: the cached fleet value still applies.
  const offlineCopy = join(h.dir, "offline.json");
  copyFileSync(h.enrollPath, offlineCopy);
  h.stop();
  up.peak = 0;
  const offline = await runWrap(args(offlineCopy), parallelScript(6), { COSTCAP_TEST_OPENAI_UPSTREAM: up.url });
  assert.equal(offline.code, 0, offline.err);
  assert.match(offline.err, /fleet offline/);
  assert.equal(up.peak, 2);
});

test("--policy maxConcurrent alone sets concurrency (min with flag)", { timeout: 60_000 }, async (t) => {
  const dir = tmp();
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({ default: { maxConcurrent: 3 } }));
  const up = await upstream(t, { delay: () => 250 });
  const r = await runWrap(["--policy", policy, "--agent", "a", "--receipts", join(dir, "r.jsonl")], parallelScript(6), { COSTCAP_TEST_OPENAI_UPSTREAM: up.url });
  assert.equal(r.code, 0, r.err);
  assert.equal(up.peak, 3);
});
