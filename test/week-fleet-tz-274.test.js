// Issue #274: an enrolled wrapper enforces the fleet caps.week on the org
// budget-period clock (Monday 00:00 in that timezone), while a local --week-cap
// stays a UTC ISO week. Unit (engine), check --enrollment and a spawned wrap.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCapEngine } from "../src/cap.js";
import { guardedBudgetStatus } from "../src/check.js";
import { enroll } from "../src/hosted/client.js";
import { weekLabel, utcWeekLabel } from "../src/period.js";

const LA = { timezone: "America/Los_Angeles", monthStartDay: 1 };
const TOKYO = { timezone: "Asia/Tokyo", monthStartDay: 1 };
const at = (iso) => () => new Date(iso);
const tmp = () => mkdtempSync(path.join(tmpdir(), "cc-wk274-"));
const MON_03Z = "2026-11-16T03:00:00Z"; // Sunday 19:00 PST: previous LA week, current UTC week
const MON_EVE_PST = "2026-11-17T04:00:00Z"; // Monday 20:00 PST
const MON_09_PST = "2026-11-16T17:00:00Z";

test("AC1 engine: $1 on Sunday PST is last LA week; Monday evening PST passes, no week spend", () => {
  const cap = createCapEngine({ history: [{ ts: MON_03Z, cost_usd: 1 }], now: at(MON_EVE_PST), fleetWeek: { cap: 1, budgetPeriod: LA } });
  assert.equal(cap.check(), null);
  assert.equal(cap.spend().week, 0);
  assert.deepEqual(cap.remaining(), { week: 1 });
  assert.equal(cap.limits().week, 1);
});

test("AC2 engine: $1 on Monday 09:00 PST is this LA week; refused on scope week", () => {
  const cap = createCapEngine({ history: [{ ts: MON_09_PST, cost_usd: 1 }], now: at(MON_EVE_PST), fleetWeek: { cap: 1, budgetPeriod: LA } });
  assert.deepEqual(cap.check(), { scope: "week", cap: 1, spent: 1 });
});

test("AC4 engine: local UTC --week-cap and fleet LA week cap each on their own clock", () => {
  // $1 counts in the UTC week (local cap 1 hits) but not the LA week (fleet cap 1).
  const both = createCapEngine({ caps: { week: 1 }, history: [{ ts: MON_03Z, cost_usd: 1 }], now: at(MON_EVE_PST), fleetWeek: { cap: 1, budgetPeriod: LA } });
  assert.deepEqual(both.check(), { scope: "week", cap: 1, spent: 1 });
  assert.equal(both.spend().week, 1);
  // Local loose, fleet tight: $2 at Monday 00:30 PST counts in both weeks; the fleet cap binds.
  const fleetOnly = createCapEngine({ caps: { week: 5 }, history: [{ ts: "2026-11-23T08:30:00Z", cost_usd: 2 }], now: at("2026-11-23T09:00:00Z"), fleetWeek: { cap: 2, budgetPeriod: LA } });
  assert.deepEqual(fleetOnly.check(), { scope: "week", cap: 2, spent: 2 });
  assert.equal(fleetOnly.limits().week, 2, "the binding clock is reported");
  assert.deepEqual(fleetOnly.remaining(), { week: 0 });
  // No fleet week: unchanged #264 UTC behaviour.
  assert.deepEqual(createCapEngine({ caps: { week: 1 }, history: [{ ts: MON_03Z, cost_usd: 1 }], now: at(MON_EVE_PST) }).check(), { scope: "week", cap: 1, spent: 1 });
  assert.equal(weekLabel(Date.parse(MON_03Z), "UTC"), utcWeekLabel(Date.parse(MON_03Z)));
});

test("AC5 engine: Asia/Tokyo previous-week spend is not counted on Monday 01:00 JST", () => {
  // Sunday 23:30 JST = Sunday 14:30Z (previous UTC week too); then Monday 00:30 JST = Sunday 15:30Z.
  const history = [{ ts: "2026-11-22T14:30:00Z", cost_usd: 1 }];
  const mon01Jst = at("2026-11-22T16:00:00Z");
  const cap = createCapEngine({ history, now: mon01Jst, fleetWeek: { cap: 1, budgetPeriod: TOKYO } });
  assert.equal(cap.check(), null);
  assert.equal(cap.spend().week, 0);
  // Spend after Monday 00:00 JST (still Sunday in UTC) is the new Tokyo week and counts.
  cap.record({ ts: "2026-11-22T15:30:00Z", cost_usd: 1 });
  assert.deepEqual(cap.check(), { scope: "week", cap: 1, spent: 1 });
});

test("engine: setFleetWeek rebuckets on a timezone change, clears and validates", () => {
  const cap = createCapEngine({ history: [{ ts: MON_03Z, cost_usd: 1 }], now: at(MON_EVE_PST) });
  cap.setFleetWeek({ cap: 1, budgetPeriod: null });
  assert.equal(cap.check().scope, "week", "UTC org: Monday 03:00Z is this week");
  cap.setFleetWeek({ cap: 1, budgetPeriod: LA });
  assert.equal(cap.check(), null);
  cap.record({ ts: MON_09_PST, cost_usd: 1 });
  assert.equal(cap.check().scope, "week");
  cap.setFleetWeek(null);
  assert.equal(cap.check(), null);
  assert.equal("week" in cap.limits(), false);
  assert.throws(() => cap.setFleetWeek({ cap: 0 }), /Invalid fleet week cap/);
  assert.throws(() => createCapEngine({ fleetWeek: { cap: -1 } }), /Invalid fleet week cap/);
});

// Stub hosted server: fleet caps.week 1, org timezone LA, no synced spend.
async function stubFleet(t, budgetPeriod = LA) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader("content-type", "application/json");
    const policy = { version: 1, caps: { week: 1 }, killed: false };
    if (req.url === "/v1/enroll") res.end(JSON.stringify({ agentId: "a", token: "agent-token", policy }));
    else if (req.url === "/v1/policy") res.end(JSON.stringify({ ...policy, budget_period: budgetPeriod, agent_spend: { spent: { week: 0 }, unknown: 0, pending_batches: 0, as_of: new Date().toISOString() } }));
    else res.end(JSON.stringify({ acceptedIds: [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dir = tmp();
  const enrollmentPath = path.join(dir, "enrollment.json");
  await enroll({ url: `http://127.0.0.1:${server.address().port}`, token: "e", name: "x", path: enrollmentPath });
  const data = JSON.parse(readFileSync(enrollmentPath, "utf8"));
  writeFileSync(enrollmentPath, JSON.stringify({ ...data, budgetPeriod }));
  return { dir, enrollmentPath };
}

test("AC3 check --enrollment agrees with wrap: AC1 ok, AC2 hit.scope week", async (t) => {
  const { dir, enrollmentPath } = await stubFleet(t);
  const receiptsPath = path.join(dir, "r.jsonl");
  const run = (ts) => {
    writeFileSync(receiptsPath, JSON.stringify({ id: "seed", ts, provider: "openai", path: "/chat/completions", cost_usd: 1 }) + "\n");
    return guardedBudgetStatus({ receiptsPath, enrollmentPath, killFile: path.join(dir, "KILL"), now: at(MON_EVE_PST) });
  };
  const ok = run(MON_03Z);
  assert.equal(ok.ok, true, JSON.stringify(ok.hit));
  assert.equal(ok.spend.week, 0);
  assert.deepEqual(ok.warnings.filter((w) => w.scope === "week"), []);
  const hit = run(MON_09_PST);
  assert.equal(hit.ok, false);
  assert.equal(hit.hit.scope, "week");
  // Local --week-cap on top stays UTC: the Sunday-PST $1 is in this UTC week.
  writeFileSync(receiptsPath, JSON.stringify({ id: "seed", run_id: "r1", ts: MON_03Z, provider: "openai", path: "/chat/completions", cost_usd: 1 }) + "\n");
  const local = guardedBudgetStatus({ receiptsPath, enrollmentPath, killFile: path.join(dir, "KILL"), caps: { week: 1 }, now: at(MON_EVE_PST) });
  assert.equal(local.hit.scope, "week");
  // Run-scoped check carries the fleet week too.
  const runChk = guardedBudgetStatus({ receiptsPath, enrollmentPath, killFile: path.join(dir, "KILL"), runId: "r1", now: at(MON_EVE_PST) });
  assert.equal(runChk.ok, true, JSON.stringify(runChk.hit));
  assert.equal(runChk.week.cap, 1);
  assert.match(runChk.week.scope, /org budget-period timezone/);
  writeFileSync(receiptsPath, JSON.stringify({ id: "seed", run_id: "r1", ts: MON_09_PST, provider: "openai", path: "/chat/completions", cost_usd: 1 }) + "\n");
  const runHit = guardedBudgetStatus({ receiptsPath, enrollmentPath, killFile: path.join(dir, "KILL"), runId: "r1", caps: { week: 5 }, now: at(MON_EVE_PST) });
  assert.equal(runHit.hit.scope, "week");
  assert.match(runHit.week.scope, /org budget-period timezone/);
});

// e2e wrap on the real clock: pick an org timezone and receipt instant so the org
// week and UTC week disagree right now, then assert wrap follows the org clock.
function scenario(nowMs) {
  const d = new Date(nowMs);
  const mon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (nowMs - mon >= 2 * 3600_000) {
    // UTC-1: the org week starts Monday 01:00Z; a receipt at Monday 00:00:30Z is last org week.
    return { budgetPeriod: { timezone: "Etc/GMT+1", monthStartDay: 1 }, ts: mon + 30_000, status: 200, hits: 1 };
  }
  // First 2 h of the UTC week: UTC+1 org week started Sunday 23:00Z; Sunday 23:30Z is this org week.
  return { budgetPeriod: { timezone: "Etc/GMT-1", monthStartDay: 1 }, ts: mon - 30 * 60_000, status: 429, hits: 0 };
}

test("scenario picker covers both sides of the UTC Monday", () => {
  assert.equal(scenario(Date.parse("2026-11-18T12:00:00Z")).status, 200);
  assert.equal(scenario(Date.parse("2026-11-16T00:30:00Z")).status, 429);
});

test("AC1/AC2 e2e: spawned wrap --enrollment enforces fleet caps.week on the org clock", async (t) => {
  const sc = scenario(Date.now());
  const { dir, enrollmentPath } = await stubFleet(t, sc.budgetPeriod);
  let hits = 0;
  const up = http.createServer((q, res) => { hits += 1; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 10 } })); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => up.close());
  const receipts = path.join(dir, "r.jsonl");
  writeFileSync(receipts, JSON.stringify({ id: "seed", ts: new Date(sc.ts).toISOString(), provider: "openai", path: "/chat/completions", cost_usd: 1 }) + "\n");
  const script = `const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions",{method:"POST",body:JSON.stringify({model:"gpt-4o-mini"})});
    console.log(JSON.stringify({ status: r.status, body: await r.json() }));`;
  const { out, err } = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--enrollment", enrollmentPath, "--receipts", receipts, "--kill-file", path.join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.address().port}` } });
    let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
    c.on("exit", () => resolve({ out: o, err: e }));
  });
  const line = out.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, err);
  const r = JSON.parse(line);
  assert.equal(r.status, sc.status, err);
  assert.equal(hits, sc.hits);
  if (sc.status === 429) { assert.equal(r.body.error.type, "budget_exceeded"); assert.equal(r.body.error.scope, "week"); }
  else {
    assert.doesNotMatch(err, /week spend/);
    const ledger = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledger.some((x) => x.event === "cap_warning" && x.scope === "week"), false);
  }
});
