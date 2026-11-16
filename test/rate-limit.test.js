// #192: RPM/TPM rate limits (unit, proxy integration, policy, alerts, run summary, CLI spawn).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRateLimiter, minLimit, usageTokens, rateLimitedBody } from "../src/rate-limit.js";
import { startMeteringProxy } from "../src/proxy.js";
import { createVelocityBreaker } from "../src/velocity.js";
import { createSpiralDetector } from "../src/spiral.js";
import { createCapEngine } from "../src/cap.js";
import { createResponseCache } from "../src/response-cache.js";
import { assertAgentPolicy, createAgentBudgets } from "../src/agent-budget.js";
import { validatePolicy, resolvePolicy } from "../src/hosted/policy.js";
import { evaluateAlerts, evaluateRunAlerts } from "../src/hosted/alerts.js";
import { buildRunSummary } from "../src/run-summary.js";
import { parseWrapArgs } from "../src/cli.js";

const clock = (start = 0) => { const c = { t: start, now: () => c.t }; return c; };

test("rpm: rolling eviction, exact 60 s boundary and retry_after_s", () => {
  const c = clock();
  const rl = createRateLimiter({ rpm: 3, now: c.now });
  for (const t of [0, 10_000, 20_000]) { c.t = t; assert.equal(rl.check(), null); rl.admit(); }
  c.t = 30_000;
  assert.deepEqual(rl.check(), { limit: "rpm", limit_value: 3, observed: 3, retry_after_s: 30 });
  c.t = 59_999;
  assert.equal(rl.check().retry_after_s, 1);
  c.t = 60_000; // the t=0 admission ages out at exactly 60 s
  assert.equal(rl.check(), null);
  rl.admit();
  c.t = 60_001;
  assert.equal(rl.check().observed, 3);
});

test("tpm: tokens counted at completion; retry when enough ages out", () => {
  const c = clock();
  const rl = createRateLimiter({ tpm: 1000, now: c.now });
  assert.equal(rl.check(), null); rl.admit(); rl.record(600);
  c.t = 5_000;
  assert.equal(rl.check(), null); rl.admit(); rl.record(600);
  c.t = 10_000;
  assert.deepEqual(rl.check(), { limit: "tpm", limit_value: 1000, observed: 1200, retry_after_s: 50 });
  rl.record(0);
  c.t = 60_000;
  assert.equal(rl.check(), null);
});

test("limits are dynamic; helpers", () => {
  const rl = createRateLimiter();
  rl.admit(); rl.admit();
  assert.equal(rl.check(), null);
  rl.setLimits({ rpm: 2 });
  assert.equal(rl.check().limit, "rpm");
  assert.deepEqual(rl.limits(), { rpm: 2, tpm: null });
  rl.setLimits();
  assert.equal(rl.check(), null);
  assert.equal(minLimit(null, 8, undefined, 4), 4);
  assert.equal(minLimit(null, undefined), null);
  assert.equal(usageTokens({ input_tokens: 400, output_tokens: 200, cached_input_tokens: 10, cache_write_input_tokens: 5, cache_write_1h_input_tokens: 1, unpriceable: NaN }), 616);
  assert.equal(usageTokens(null), 0);
  const body = rateLimitedBody({ limit: "tpm", limit_value: 10, observed: 12, retry_after_s: 3 });
  assert.equal(body.error.type, "rate_limited");
  assert.match(body.error.message, /tokens per minute/);
});

function upstream(handler) {
  return new Promise((resolve) => {
    let hits = 0;
    const s = http.createServer((req, res) => { req.resume(); req.on("end", () => { hits++; handler(req, res, hits); }); });
    s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port, hits: () => hits }));
  });
}
const OK = (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 400, completion_tokens: 200 } }));

async function proxy(t, up, opts) {
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.port}` }, onReceipt: (r) => receipts.push(r), ...opts });
  t.after(() => server.close());
  const call = (body = { model: "gpt-4o-mini", messages: [] }) => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-test" }, body: JSON.stringify(body) });
  return { receipts, call };
}

test("AC1: --rpm 3 with injected clock refuses the 4th call with 429 + Retry-After and a $0 receipt", async (t) => {
  const up = await upstream((req, res) => OK(res));
  t.after(() => up.s.close());
  const c = clock();
  const { receipts, call } = await proxy(t, up, { rateLimit: createRateLimiter({ rpm: 3, now: c.now }) });
  for (const at of [0, 10_000, 20_000]) { c.t = at; assert.equal((await call()).status, 200); }
  c.t = 30_000;
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "30");
  const b = await r.json();
  assert.deepEqual({ ...b.error, message: undefined }, { type: "rate_limited", source: "costcap", limit: "rpm", limit_value: 3, observed: 3, window_s: 60, retry_after_s: 30, message: undefined });
  assert.equal(up.hits(), 3);
  const blocked = receipts.at(-1);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "rate_limited");
  assert.equal(blocked.cost_usd, 0);
  assert.equal(blocked.limit, "rpm");
  assert.equal(blocked.retry_after_s, 30);
  c.t = 60_001;
  assert.equal((await call()).status, 200);
  assert.equal(up.hits(), 4);
});

test("AC2: 10 concurrent requests, rpm 3 -> exactly 3 forwarded; upstream 429 uses a slot", async (t) => {
  const up = await upstream((req, res, n) => n === 1
    ? res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "slow down", type: "rate_limit" } }))
    : OK(res));
  t.after(() => up.s.close());
  const { call } = await proxy(t, up, { rateLimit: createRateLimiter({ rpm: 3 }) });
  const statuses = (await Promise.all(Array.from({ length: 10 }, () => call()))).map((r) => r.status);
  assert.equal(up.hits(), 3);
  assert.equal(statuses.filter((s) => s === 429).length, 8); // 7 refused + the provider's own 429
});

test("AC2: a --cap refusal and a cache hit use no slot", async (t) => {
  const up = await upstream((req, res) => OK(res));
  t.after(() => up.s.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-rl-"));
  const rl = createRateLimiter({ rpm: 2 });
  const cache = createResponseCache({ dir: join(dir, "cache"), ttlMs: 3_600_000 });
  const { call, receipts } = await proxy(t, up, { rateLimit: rl, cache });
  const cached = { model: "gpt-4o-mini", messages: [], temperature: 0 };
  assert.equal((await call(cached)).status, 200);
  const hit = await call(cached);
  assert.equal(hit.status, 200);
  assert.equal(receipts.at(-1).cache, "hit");
  const other = { model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] };
  assert.equal((await call(other)).status, 200); // the hit left the second slot free
  assert.equal((await call({ ...other, n: 1 })).status, 429);
  assert.equal(up.hits(), 2);

  const rl2 = createRateLimiter({ rpm: 1 });
  const cap = createCapEngine({ caps: { run: 0.000001 }, history: [], runId: "r" });
  cap.record({ cost_usd: 1, ts: new Date().toISOString(), run_id: "r" });
  const p2 = await proxy(t, up, { rateLimit: rl2, cap });
  assert.equal((await p2.call()).status, 429);
  assert.equal(p2.receipts.at(-1).reason, "budget_exceeded");
  assert.equal(rl2.check(), null);
});

test("AC3: tpm 1000 at 600 tokens/call refuses call 3 with observed 1200", async (t) => {
  const up = await upstream((req, res) => OK(res));
  t.after(() => up.s.close());
  const c = clock();
  const { call } = await proxy(t, up, { rateLimit: createRateLimiter({ tpm: 1000, now: c.now }) });
  assert.equal((await call()).status, 200);
  c.t = 1_000;
  assert.equal((await call()).status, 200);
  c.t = 2_000;
  const r = await call();
  assert.equal(r.status, 429);
  const b = await r.json();
  assert.equal(b.error.limit, "tpm");
  assert.equal(b.error.observed, 1200);
  assert.equal(b.error.retry_after_s, 58);
  c.t = 60_000;
  assert.equal((await call()).status, 200);
});

test("AC5: refusals take no step and leave velocity/spiral state alone", async (t) => {
  const up = await upstream((req, res) => OK(res));
  t.after(() => up.s.close());
  const velocity = createVelocityBreaker({ maxSteps: 5 });
  const rl = createRateLimiter({ rpm: 1 });
  rl.admit();
  const { call, receipts } = await proxy(t, up, { rateLimit: rl, velocity, spiral: createSpiralDetector() });
  for (let i = 0; i < 20; i++) assert.equal((await call()).status, 429);
  assert.equal(velocity.check(), null);
  assert.equal(up.hits(), 0);
  const s = buildRunSummary({ run_id: "r", started_at: "x", ended_at: "y", receipts });
  assert.equal(s.blocked_calls, 20);
  assert.equal(s.stopped_by ?? null, null);
  rl.setLimits({});
  for (let i = 0; i < 5; i++) assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429); // step budget only counts the 5 forwarded calls
  assert.equal(receipts.at(-1).reason, "step_budget");
});

test("AC5: synced rate_limited receipts raise no loop_detected or cap_hit", () => {
  const alerts = evaluateAlerts({ agentId: "a", caps: { day: 10 }, spend: { day: 0 }, blockedReasons: ["rate_limited", "rate_limited"], lastSeenMs: 0, nowMs: 0 });
  assert.deepEqual(alerts.filter((a) => a.kind === "loop_detected" || a.kind === "cap_hit"), []);
  assert.deepEqual(evaluateRunAlerts({ agentId: "a", cap: null, runs: [], blockedRunIds: [] }), []);
});

test("AC4: policy keys, validation and min-merge precedence", () => {
  assertAgentPolicy({ default: { rpm: 10 }, agents: { a: { rpm: 5, tpm: 100 } } });
  for (const bad of [{ default: { rpm: -1 } }, { default: { rpms: 3 } }, { agents: { a: { tpm: 1.5 } } }, { default: { rpm: "5" } }]) assert.throws(() => assertAgentPolicy(bad));
  const budgets = createAgentBudgets({ policy: { default: { rpm: 10, day: 1 }, agents: { a: { rpm: 5, day: 1 } } } });
  const own = budgets.limitsFor("a");
  assert.equal(minLimit(8, own.rpm, 4), 4);
  assert.deepEqual(validatePolicy({ version: 1, rpm: 4, tpm: 1000 }), []);
  assert.ok(validatePolicy({ version: 1, rpm: "5" }).length);
  assert.ok(validatePolicy({ version: 1, tpm: 0 }).length);
  // A fleet rpm can be tightened locally, never loosened; the cached (offline) value applies.
  assert.equal(resolvePolicy({ local: { rpm: 10 }, lastKnown: { version: 1, rpm: 4 } }).rpm, 4);
  assert.equal(resolvePolicy({ local: { rpm: 2 }, lastKnown: { version: 1, rpm: 4 } }).rpm, 2);
  assert.equal(resolvePolicy({ local: {}, lastKnown: { version: 1, tpm: 9 } }).tpm, 9);
  assert.equal("rpm" in resolvePolicy({ local: {}, lastKnown: { version: 1 } }), false);
  assert.throws(() => resolvePolicy({ local: { rpm: 0 } }), /Invalid local rpm/);
});

test("AC4: wrap flag parsing and exit 2 before spawning", () => {
  assert.equal(parseWrapArgs(["--rpm", "60", "--tpm", "200000", "--", "x"]).rpm, 60);
  for (const [f, v] of [["--rpm", "0"], ["--rpm", "1.5"], ["--tpm", "abc"], ["--rpm", "-3"]]) {
    assert.throws(() => parseWrapArgs([f, v, "--", "x"]), /positive integer/);
  }
  const dir = mkdtempSync(join(tmpdir(), "cc-rl-"));
  const marker = join(dir, "spawned");
  const r = spawnSync(process.execPath, ["src/cli.js", "wrap", "--rpm", "0", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`], { encoding: "utf8" });
  assert.equal(r.status, 2);
  const pol = join(dir, "p.json");
  writeFileSync(pol, JSON.stringify({ default: { rpms: 3 } }));
  const r2 = spawnSync(process.execPath, ["src/cli.js", "wrap", "--agent", "a", "--policy", pol, "--receipts", join(dir, "r.jsonl"), "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`], { encoding: "utf8" });
  assert.equal(r2.status, 2);
  assert.throws(() => readFileSync(marker));
});

test("wrap --rpm 2 (and a tighter --policy rpm) spawn against a mock upstream", async (t) => {
  const up = await upstream((req, res) => OK(res));
  t.after(() => up.s.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-rl-"));
  const pol = join(dir, "p.json");
  writeFileSync(pol, JSON.stringify({ default: { rpm: 10 }, agents: { a: { rpm: 2 } } }));
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const out = [];
    for (let n = 0; n < 3; n++) { const r = await fetch(u,{method:"POST",body:JSON.stringify({n})}); out.push(r.status); if (r.status===429) { const b = await r.json(); out.push(b.error.type, b.error.limit, r.headers.get("retry-after") !== null); } }
    console.log(out.join(" "));`;
  const run = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...args, "--receipts", join(dir, `${args.length}.jsonl`), "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "").trim() }));
  });
  assert.deepEqual(await run(["--rpm", "2"]), { code: 0, out: "200 200 429 rate_limited rpm true" });
  assert.deepEqual(await run(["--rpm", "8", "--agent", "a", "--policy", pol]), { code: 0, out: "200 200 429 rate_limited rpm true" });
});
