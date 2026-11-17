// Issue #280: an enrolled wrapper enforces the fleet caps.day and caps.month on the
// org budget-period clock (org timezone day, monthStartDay month), as #274 does for
// week, while local --day-cap/--month-cap stay UTC. Unit (engine + warner), check
// --enrollment and a spawned wrap.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCapEngine } from "../src/cap.js";
import { createCapWarner, warningLine } from "../src/cap-warn.js";
import { guardedBudgetStatus } from "../src/check.js";
import { enroll } from "../src/hosted/client.js";

const LA = { timezone: "America/Los_Angeles", monthStartDay: 1 };
const MID = { timezone: "UTC", monthStartDay: 15 };
const at = (iso) => () => new Date(iso);
const tmp = () => mkdtempSync(path.join(tmpdir(), "cc-dm280-"));
const MON_17_PST = "2026-11-17T01:00:00Z"; // Monday 17:00 PST (Tuesday in UTC)
const TUE_01_PST = "2026-11-17T09:00:00Z"; // Tuesday 01:00 PST
const TUE_10_PST = "2026-11-17T18:00:00Z";
const NOV10 = "2026-11-10T12:00:00Z", NOV15 = "2026-11-15T12:00:00Z", NOV16 = "2026-11-16T12:00:00Z";

test("AC1 engine: LA day: Monday 17:00 PST spend does not count on Tuesday 01:00 PST", () => {
  const cap = createCapEngine({ history: [{ ts: MON_17_PST, cost_usd: 1 }], now: at(TUE_01_PST), fleetPeriod: { caps: { day: 1 }, budgetPeriod: LA } });
  assert.equal(cap.check(), null);
  assert.equal(cap.spend().day, 0);
  assert.deepEqual(cap.remaining(), { day: 1 });
  cap.record({ ts: TUE_01_PST, cost_usd: 1 });
  assert.deepEqual(cap.check(), { scope: "day", cap: 1, spent: 1 });
  const later = createCapEngine({ history: [{ ts: MON_17_PST, cost_usd: 1 }, { ts: TUE_01_PST, cost_usd: 1 }], now: at(TUE_10_PST), fleetPeriod: { caps: { day: 1 }, budgetPeriod: LA } });
  assert.equal(later.check().scope, "day");
});

test("AC2 engine: monthStartDay 15: Nov 10 spend is last period on Nov 16, Nov 15 spend is this one", () => {
  const prev = createCapEngine({ history: [{ ts: NOV10, cost_usd: 1 }], now: at(NOV16), fleetPeriod: { caps: { month: 1 }, budgetPeriod: MID } });
  assert.equal(prev.check(), null);
  assert.equal(prev.spend().month, 0);
  const cur = createCapEngine({ history: [{ ts: NOV15, cost_usd: 1 }], now: at(NOV16), fleetPeriod: { caps: { month: 1 }, budgetPeriod: MID } });
  assert.deepEqual(cur.check(), { scope: "month", cap: 1, spent: 1 });
  assert.equal(cur.fleetWindow("month").label, "2026-11-15..2026-12-14 org");
});

test("AC3 engine: local UTC day/month caps and fleet org caps each on their own clock", () => {
  // $1 on Nov 10 is in the UTC month (local cap hits) but the previous org period.
  const both = createCapEngine({ caps: { month: 1 }, history: [{ ts: NOV10, cost_usd: 1 }], now: at(NOV16), fleetPeriod: { caps: { month: 1 }, budgetPeriod: MID } });
  assert.deepEqual(both.check(), { scope: "month", cap: 1, spent: 1 });
  assert.equal(both.fleetWindow("month"), null, "the binding clock is UTC");
  // Local loose, fleet tight: the fleet cap binds and is reported.
  const tight = createCapEngine({ caps: { day: 5 }, history: [{ ts: TUE_01_PST, cost_usd: 2 }], now: at(TUE_10_PST), fleetPeriod: { caps: { day: 2 }, budgetPeriod: LA } });
  assert.deepEqual(tight.check(), { scope: "day", cap: 2, spent: 2 });
  assert.equal(tight.limits().day, 2);
  assert.equal(tight.fleetWindow("day").label, "2026-11-17 org America/Los_Angeles");
  // Local day cap in UTC: Monday 17:00 PST is the same UTC day as Tuesday 01:00 PST.
  const local = createCapEngine({ caps: { day: 1 }, history: [{ ts: MON_17_PST, cost_usd: 1 }], now: at(TUE_01_PST), fleetPeriod: { caps: { day: 1 }, budgetPeriod: LA } });
  assert.equal(local.check().scope, "day");
  // setFleetWeek keeps fleet day/month; setFleetPeriod rebuckets on a budget-period change.
  const e = createCapEngine({ history: [{ ts: NOV15, cost_usd: 1 }], now: at(NOV16), fleetPeriod: { caps: { month: 1 }, budgetPeriod: MID } });
  e.setFleetWeek({ cap: 5, budgetPeriod: MID });
  assert.equal(e.check().scope, "month");
  e.setFleetPeriod({ caps: { month: 1 }, budgetPeriod: { timezone: "UTC", monthStartDay: 16 } });
  assert.equal(e.check(), null);
  assert.throws(() => e.setFleetPeriod({ caps: { day: 0 } }), /Invalid fleet day cap/);
  assert.equal(e.fleetWindow("hour"), null);
});

test("AC4 warner labels the fleet window with the org period, not UTC", () => {
  const cap = createCapEngine({ history: [], now: at(NOV16), fleetPeriod: { caps: { month: 1 }, budgetPeriod: MID } });
  const w = createCapWarner({ fractions: [0.5], now: at(NOV16), periodFor: (s, d) => cap.fleetWindow(s, d.getTime()) });
  const [ev] = w.observe({ caps: { month: 1 }, before: { month: 0 }, after: { month: 0.6 } });
  assert.equal(ev.period, "2026-11");
  assert.equal(ev.window, "2026-11-15..2026-12-14 org");
  assert.match(warningLine(ev), /\(2026-11-15\.\.2026-12-14 org\)$/);
  const utc = createCapWarner({ fractions: [0.5], now: at(NOV16) }).observe({ caps: { month: 1 }, before: { month: 0 }, after: { month: 0.6 } })[0];
  assert.match(warningLine(utc), /\(2026-11 UTC\)$/);
});

async function stubFleet(t, caps, budgetPeriod) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader("content-type", "application/json");
    const policy = { version: 1, caps, killed: false };
    if (req.url === "/v1/enroll") res.end(JSON.stringify({ agentId: "a", token: "agent-token", policy }));
    else if (req.url === "/v1/policy") res.end(JSON.stringify({ ...policy, budget_period: budgetPeriod, agent_spend: { spent: {}, unknown: 0, pending_batches: 0, as_of: new Date().toISOString() } }));
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

const seed = (file, ts, extra = {}) => writeFileSync(file, JSON.stringify({ id: "seed", ts, provider: "openai", path: "/chat/completions", cost_usd: 1, ...extra }) + "\n");

test("AC1/AC2 check --enrollment: fleet day and month on the org clock", async (t) => {
  const day = await stubFleet(t, { day: 1 }, LA);
  const r1 = path.join(day.dir, "r.jsonl");
  const chk = (fl, file, now, extra = {}) => guardedBudgetStatus({ receiptsPath: file, enrollmentPath: fl.enrollmentPath, killFile: path.join(fl.dir, "KILL"), now: at(now), ...extra });
  seed(r1, MON_17_PST);
  const ok = chk(day, r1, TUE_01_PST);
  assert.equal(ok.ok, true, JSON.stringify(ok.hit));
  assert.deepEqual(ok.warnings.filter((w) => w.scope === "day"), []);
  seed(r1, TUE_01_PST);
  assert.equal(chk(day, r1, TUE_10_PST).hit.scope, "day");

  const mon = await stubFleet(t, { month: 1 }, MID);
  const r2 = path.join(mon.dir, "r.jsonl");
  seed(r2, NOV10, { run_id: "r1" });
  assert.equal(chk(mon, r2, NOV16).ok, true);
  const runOk = chk(mon, r2, NOV16, { runId: "r1" });
  assert.equal(runOk.ok, true, JSON.stringify(runOk.hit));
  assert.equal(runOk.month.cap, 1);
  assert.match(runOk.month.scope, /2026-11-15\.\.2026-12-14 org/);
  // Local --month-cap stays UTC: Nov 10 is in the UTC month.
  assert.equal(chk(mon, r2, NOV16, { caps: { month: 1 } }).hit.scope, "month");
  seed(r2, NOV15, { run_id: "r1" });
  const hit = chk(mon, r2, NOV16);
  assert.equal(hit.ok, false);
  assert.equal(hit.hit.scope, "month");
  const w = hit.warnings.find((x) => x.scope === "month");
  assert.equal(w.window, "2026-11-15..2026-12-14 org");
  assert.equal(chk(mon, r2, NOV16, { runId: "r1" }).hit.scope, "month");
});

// e2e wrap on the real clock: an org timezone whose day differs from the UTC day right now.
function dayScenario(nowMs) {
  const mid = Math.floor(nowMs / 86_400_000) * 86_400_000;
  if (nowMs - mid >= 2 * 3600_000) return { budgetPeriod: { timezone: "Etc/GMT+1", monthStartDay: 1 }, ts: mid + 30_000, status: 200, hits: 1 };
  return { budgetPeriod: { timezone: "Etc/GMT-1", monthStartDay: 1 }, ts: mid - 30 * 60_000, status: 429, hits: 0 };
}
// Month: a UTC org whose monthStartDay is today (yesterday is last period), or 28 late in the month.
function monthScenario(nowMs) {
  const d = new Date(nowMs).getUTCDate();
  const ts = nowMs - 86_400_000;
  if (d >= 2 && d <= 28) return { budgetPeriod: { timezone: "UTC", monthStartDay: d }, ts, status: 200, hits: 1 };
  if (d === 1) return { budgetPeriod: { timezone: "UTC", monthStartDay: 1 }, ts, status: 200, hits: 1 };
  return { budgetPeriod: { timezone: "UTC", monthStartDay: 28 }, ts, status: 429, hits: 0 };
}

test("scenario pickers cover both outcomes", () => {
  assert.equal(dayScenario(Date.parse("2026-11-18T12:00:00Z")).status, 200);
  assert.equal(dayScenario(Date.parse("2026-11-18T00:30:00Z")).status, 429);
  assert.equal(monthScenario(Date.parse("2026-11-18T12:00:00Z")).status, 200);
  assert.equal(monthScenario(Date.parse("2026-11-01T12:00:00Z")).status, 200);
  assert.equal(monthScenario(Date.parse("2026-11-30T12:00:00Z")).status, 429);
});

for (const [scope, pick] of [["day", dayScenario], ["month", monthScenario]]) {
  test(`AC1/AC2 e2e: spawned wrap --enrollment enforces fleet caps.${scope} on the org clock`, async (t) => {
    const sc = pick(Date.now());
    const { dir, enrollmentPath } = await stubFleet(t, { [scope]: 1 }, sc.budgetPeriod);
    let hits = 0;
    const up = http.createServer((q, res) => { hits += 1; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 10 } })); });
    await new Promise((r) => up.listen(0, "127.0.0.1", r));
    t.after(() => up.close());
    const receipts = path.join(dir, "r.jsonl");
    seed(receipts, new Date(sc.ts).toISOString());
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
    if (sc.status === 429) { assert.equal(r.body.error.scope, scope); assert.doesNotMatch(err, new RegExp(`${scope} spend .*UTC\\)`)); }
    else {
      assert.doesNotMatch(err, new RegExp(`${scope} spend`));
      const ledger = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(ledger.some((x) => x.event === "cap_warning" && x.scope === scope), false);
    }
  });
}
