// #181: soft cap warnings fire when spend crosses a fraction via a settlement,
// a shared-ledger sibling receipt or a fleet cap change, not only own receipts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapEngine } from "../src/cap.js";
import { createCapWarner } from "../src/cap-warn.js";
import { createSettler } from "../src/settle.js";
import { openSharedLedger } from "../src/ledger-lock.js";
import { startMeteringProxy } from "../src/proxy.js";

const ts = () => new Date().toISOString();
const day = () => new Date().toISOString().slice(0, 10);

// Mirrors cli.js wiring: a proxy holding cap + capWarner, checkWarnings after each path.
async function wrapper(t, { caps = { day: 10 }, history = [], fractions = [0.8], events = [] } = {}) {
  const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-181-")), "r.jsonl");
  writeFileSync(receiptsPath, "");
  const cap = createCapEngine({ caps, history, runId: "run-1" });
  const capWarner = createCapWarner({ fractions, events, runId: "run-1" });
  const stderr = [];
  const { server } = await startMeteringProxy({ receiptsPath, cap, capWarner, onWarning: (l) => stderr.push(l), upstreams: { openai: "http://127.0.0.1:9" } });
  t.after(() => server.close());
  const settler = createSettler({ cap: () => cap, agentBudgets: () => undefined, proxySettle: () => (r) => server.settle(r) });
  const settle = (s, r) => { const ok = settler(s, r); if (ok) server.checkWarnings(); return ok; };
  const warnings = () => readFileSync(receiptsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter((e) => e.event === "cap_warning");
  return { cap, capWarner, server, settle, stderr, warnings, receiptsPath };
}

test("(a) a settlement crossing 80% of the day cap emits exactly one cap_warning; a later own-receipt check does not repeat it", async (t) => {
  const w = await wrapper(t, { history: [{ id: "k", ts: ts(), cost_usd: 5 }, { id: "u1", ts: ts(), cost_usd: null }] });
  assert.equal(w.settle({ receipt_id: "u1", settled_cost_usd: 3.5 }, { id: "u1", ts: ts(), cost_usd: null }), true);
  const evs = w.warnings();
  assert.equal(evs.length, 1);
  assert.deepEqual({ scope: evs[0].scope, fraction: evs[0].fraction, cap: evs[0].cap, spent_usd: evs[0].spent_usd, period: evs[0].period, lower_bound: evs[0].lower_bound }, { scope: "day", fraction: 0.8, cap: 10, spent_usd: 8.5, period: day(), lower_bound: false });
  assert.equal(w.stderr.length, 1);
  assert.match(w.stderr[0], /day spend \$8\.5000 is 80% of \$10 cap/);
  assert.equal(w.capWarner.emitted.length, 1);
  // Own receipt after the line was passed: observe() and another check emit nothing.
  const before = w.cap.spend();
  w.cap.record({ ts: ts(), cost_usd: 0.5 });
  assert.deepEqual(w.capWarner.observe({ caps: w.cap.limits(), before, after: w.cap.spend() }), []);
  w.server.checkWarnings();
  assert.equal(w.warnings().length, 1);
});

test("lower_bound is set when unknown spend remains after the change", async (t) => {
  const w = await wrapper(t, { history: [{ id: "k", ts: ts(), cost_usd: 5 }, { id: "u1", ts: ts(), cost_usd: null }, { id: "u2", ts: ts(), cost_usd: null }] });
  w.settle({ receipt_id: "u1", settled_cost_usd: 3.5 }, { id: "u1", ts: ts(), cost_usd: null });
  assert.equal(w.warnings()[0].lower_bound, true);
  assert.match(w.stderr[0], /\(lower bound\)/);
});

test("(c) a fleet updateCaps dropping the cap below 125% of spend emits one warning", async (t) => {
  const w = await wrapper(t, { caps: { day: 20 }, history: [{ id: "k", ts: ts(), cost_usd: 9 }] });
  w.server.checkWarnings();
  assert.equal(w.warnings().length, 0);
  w.cap.updateCaps({ day: 10 }); // 9 >= 8
  w.server.checkWarnings();
  w.server.checkWarnings();
  const evs = w.warnings();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].cap, 10);
  assert.equal(evs[0].spent_usd, 9);
});

test("--warn-at off emits nothing on any path", async (t) => {
  const w = await wrapper(t, { fractions: [], history: [{ id: "k", ts: ts(), cost_usd: 5 }, { id: "u1", ts: ts(), cost_usd: null }] });
  w.settle({ receipt_id: "u1", settled_cost_usd: 4 }, { id: "u1", ts: ts(), cost_usd: null });
  w.cap.updateCaps({ day: 5 });
  w.server.checkWarnings();
  assert.equal(w.warnings().length, 0);
  assert.equal(w.stderr.length, 0);
});

test("a prior cap_warning for the period (from the ledger) suppresses the check", async (t) => {
  const w = await wrapper(t, { events: [{ event: "cap_warning", scope: "day", fraction: 0.8, period: day() }], history: [{ id: "k", ts: ts(), cost_usd: 9 }] });
  w.server.checkWarnings();
  assert.equal(w.warnings().length, 0);
});

test("(b) shared ledger: a sibling receipt crossing the line emits one warning, unless the sibling's cap_warning is in the ledger", async (t) => {
  for (const siblingWarned of [false, true]) {
    const path = join(mkdtempSync(join(tmpdir(), "cc-181s-")), "r.jsonl");
    appendFileSync(path, JSON.stringify({ id: "k", ts: ts(), cost_usd: 5 }) + "\n");
    let cap, capWarner, server;
    const shared = openSharedLedger(path, {
      onExternal: (r) => { cap.record(r, { external: true }); server.checkWarnings(); },
      onExternalWarning: (e) => capWarner.note(e),
    });
    t.after(() => shared.close());
    cap = createCapEngine({ caps: { day: 10 }, history: shared.history(), runId: "mine" });
    capWarner = createCapWarner({ fractions: [0.8], runId: "mine" });
    const stderr = [];
    ({ server } = await startMeteringProxy({ receiptsPath: path, cap, capWarner, sharedLedger: shared, onWarning: (l) => stderr.push(l), upstreams: { openai: "http://127.0.0.1:9" } }));
    t.after(() => server.close());
    appendFileSync(path, JSON.stringify({ id: "s1", ts: ts(), cost_usd: 3.5, run_id: "sib" }) + "\n");
    if (siblingWarned) appendFileSync(path, JSON.stringify({ event: "cap_warning", scope: "day", fraction: 0.8, cap: 10, spent_usd: 8.5, period: day(), run_id: "sib" }) + "\n");
    shared.withLock(() => {});
    const evs = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.event === "cap_warning");
    assert.equal(evs.length, 1, `siblingWarned=${siblingWarned}`);
    assert.equal(evs[0].run_id, siblingWarned ? "sib" : "mine");
    assert.equal(stderr.length, siblingWarned ? 0 : 1);
    assert.equal(cap.spend().day, 8.5);
  }
});
