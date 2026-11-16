// Issue #168: hosted run-scope alerts (unit + hosted sweep regression).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRunAlerts, armWarnings, claimWarning, capPeriod } from "../src/hosted/alerts.js";
import { createHostedServer } from "../src/hosted/server.js";

const run = (id, usd, extra = {}) => ({ run_id: id, usd_known: usd, unknown_count: 0, calls: 1, ...extra });

test("evaluateRunAlerts: per-run keys, highest fraction, lower_bound, silence", () => {
  const out = evaluateRunAlerts({ agentId: "a", cap: 5, runs: [run("r1", 4.1), run("r2", 5), run("r3", 1), run("(none)", 9)] });
  assert.deepEqual(out.map((x) => x.key), ["cap_approaching:a:run:r1", "cap_hit:a:run:r2"]);
  assert.equal(out[0].run_id, "r1"); assert.equal(out[0].cap, 5); assert.equal(out[0].spent, 4.1); assert.equal(out[0].scope, "run"); assert.equal(out[0].lower_bound, false);
  const hi = evaluateRunAlerts({ agentId: "a", cap: 5, runs: [run("r1", 4.8)] }, { warnFractions: [0.5, 0.95] });
  assert.equal(hi[0].key, "cap_approaching:a:run:r1:p95"); assert.equal(hi[0].fraction, 0.95);
  const lb = evaluateRunAlerts({ agentId: "a", cap: 5, runs: [run("r1", 4.2, { unknown_count: 1, calls: 3 })] });
  assert.equal(lb[0].lower_bound, true); assert.equal(lb[0].unknown_count, 1);
  assert.deepEqual(evaluateRunAlerts({ agentId: "a", cap: 5, runs: [run("r1", 0, { unknown_count: 2, calls: 2 })] }), []);
  assert.deepEqual(evaluateRunAlerts({ agentId: "a", cap: 5, runs: [run("r1", 4.9)] }, { warnFractions: [] }), []);
  assert.equal(evaluateRunAlerts({ agentId: "a", cap: 5, runs: [run("r1", 6)] }, { warnFractions: [] })[0].kind, "cap_hit");
  assert.deepEqual(evaluateRunAlerts({ agentId: "a", cap: null, runs: [run("r1", 99)] }), []);
  const blocked = evaluateRunAlerts({ agentId: "a", cap: null, runs: [run("r1", 1)], blockedRunIds: ["r1"] });
  assert.equal(blocked[0].key, "cap_hit:a:run:r1"); assert.equal(blocked[0].cap, null);
  assert.deepEqual(evaluateRunAlerts({ agentId: "a", cap: 5, runs: [{}, run("r1", NaN)] }), []);
});

test("run arming: once per run, re-arm on new run and raised cap", () => {
  assert.equal(capPeriod("run:r1", 0), "run:r1");
  const arm = {};
  const st = armWarnings(arm, { id: "a", scope: "run:r1", cap: 5, spent: 4.8, nowMs: 0 });
  assert.equal(claimWarning(st, { fraction: 0.95 }, [0.5, 0.95]), true);
  assert.equal(claimWarning(st, { fraction: 0.5 }, [0.5, 0.95]), false);
  const st2 = armWarnings(arm, { id: "a", scope: "run:r2", cap: 5, spent: 2.6, nowMs: 0 });
  assert.equal(claimWarning(st2, { fraction: 0.5 }, [0.5, 0.95]), true);
  const raised = armWarnings(arm, { id: "a", scope: "run:r1", cap: 10, spent: 4.8, nowMs: 0 });
  assert.deepEqual(raised.fired, []);
});

async function fixture(t, clock) {
  let code; const delivery = [];
  const origin = "http://127.0.0.1";
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-run-alerts-")), "data.json"), origin, secureCookies: false, now: () => clock.ms, stripeEnv: {}, verifyChallenge: async (v) => v === "test-pass", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async (a) => { delivery.push(a); return [{ status: "accepted" }]; } });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); return new Promise((r) => service.server.close(r)); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, bearer) => {
    const headers = { origin }; if (body) headers["content-type"] = "application/json"; if (cookie) headers.cookie = cookie; if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(base + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get("set-cookie")?.split(";")[0] };
  };
  const ch = await request("/auth/request", { email: "run-owner@example.invalid", turnstileToken: "test-pass" });
  const v = await request("/auth/verify", { email: "run-owner@example.invalid", code, challengeId: ch.body?.challengeId });
  const cookie = v.cookie;
  const enroll = async (policy, extraPolicy) => {
    const token = (await request("/v1/enrollment-tokens", policy, cookie)).body.token;
    const agent = (await request("/v1/enroll", { name: "runner" + Math.random() }, null, token)).body;
    if (extraPolicy) assert.equal((await request(`/v1/agents/${agent.agentId}/policy`, extraPolicy, cookie)).status, 200);
    return agent;
  };
  let n = 0;
  const sync = async (agent, items) => assert.equal((await request("/v1/receipts", { receipts: items.map((x) => ({ id: `rc${n++}`, ts: new Date(clock.ms).toISOString(), model: "m", ...x })) }, null, agent.token)).status, 200);
  return { request, cookie, enroll, sync, delivery, sweep: () => service.evaluateFleetAlerts() };
}

test("hosted sweep: run cap warns once, hits once, dedupes the block, resolves", async (t) => {
  const clock = { ms: Date.parse("2026-11-16T10:00:00Z") };
  const f = await fixture(t, clock);
  const a = await f.enroll({ caps: { run: 5 } });
  const id = a.agentId;
  await f.sync(a, [{ run_id: "r1", cost_usd: 3.9 }]); await f.sweep();
  assert.equal(f.delivery.length, 0);
  await f.sync(a, [{ run_id: "r1", cost_usd: 0.2 }]); await f.sweep();
  assert.equal(f.delivery.length, 1);
  assert.equal(f.delivery[0].key, `cap_approaching:${id}:run:r1`); assert.equal(f.delivery[0].run_id, "r1"); assert.equal(f.delivery[0].cap, 5); assert.equal(f.delivery[0].spent, 4.1);
  await f.sync(a, [{ run_id: "r1", cost_usd: 0.4 }]); await f.sweep();
  assert.equal(f.delivery.length, 1);
  // second run while r1 is active
  await f.sync(a, [{ run_id: "r2", cost_usd: 4.2 }]); await f.sweep();
  assert.equal(f.delivery.at(-1).key, `cap_approaching:${id}:run:r2`);
  await f.sync(a, [{ run_id: "r1", cost_usd: 0.5 }]); await f.sweep();
  assert.equal(f.delivery.at(-1).key, `cap_hit:${id}:run:r1`);
  const count = f.delivery.length;
  await f.sync(a, [{ run_id: "r1", cost_usd: 0, blocked: true, reason: "budget_exceeded", scope: "run" }]); await f.sweep();
  assert.equal(f.delivery.length, count);
  await f.sync(a, [{ cost_usd: 0, blocked: true, reason: "budget_exceeded", scope: "run" }]); await f.sweep();
  assert.equal(f.delivery.at(-1).key, `cap_hit:${id}:run`);
  const doc = (await f.request("/v1/evidence.json", undefined, f.cookie)).body;
  assert.ok(doc.alerts.some((x) => x.run_id === "r1" && x.key === `cap_hit:${id}:run:r1`));
  clock.ms += 2 * 3600_000; await f.sweep();
  const after = (await f.request("/v1/evidence.json", undefined, f.cookie)).body;
  assert.equal(after.alerts.filter((x) => x.run_id && x.active).length, 0);
});

test("hosted sweep: explicit fractions, unknown cost, no cap, no run_id", async (t) => {
  const clock = { ms: Date.parse("2026-11-16T10:00:00Z") };
  const f = await fixture(t, clock);
  const a = await f.enroll({ caps: { run: 5 } }, { caps: { run: 5 }, warnFractions: [0.5, 0.95] });
  await f.sync(a, [{ run_id: "x", cost_usd: 2 }]); await f.sweep();
  assert.equal(f.delivery.length, 0);
  await f.sync(a, [{ run_id: "x", cost_usd: 2.8 }]); await f.sweep();
  assert.deepEqual(f.delivery.map((d) => d.fraction), [0.95]);
  await f.sweep(); assert.equal(f.delivery.length, 1);
  const b = await f.enroll({ caps: { run: 5 } });
  await f.sync(b, [{ run_id: "u", cost_usd: 4.2 }, { run_id: "u", cost_usd: null }, { run_id: "z", cost_usd: null }, { cost_usd: 9 }]); await f.sweep();
  const forB = f.delivery.filter((d) => d.agentId === b.agentId);
  assert.equal(forB.length, 1); assert.equal(forB[0].run_id, "u"); assert.equal(forB[0].lower_bound, true);
  const c = await f.enroll({ caps: { day: 100 } });
  await f.sync(c, [{ run_id: "q", cost_usd: 50 }]); await f.sweep();
  assert.equal(f.delivery.filter((d) => d.agentId === c.agentId).length, 0);
});
