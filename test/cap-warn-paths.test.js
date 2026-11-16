// #181: soft cap warnings fire after settlements, shared-ledger siblings and fleet cap changes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapWarner } from "../src/cap-warn.js";
import { createCapEngine } from "../src/cap.js";
import { createSettler } from "../src/settle.js";
import { createMeteringProxy } from "../src/proxy.js";
import { openSharedLedger } from "../src/ledger-lock.js";

const NOW = new Date();
const DAY = NOW.toISOString().slice(0, 10);
const tmp = () => join(mkdtempSync(join(tmpdir(), "cc-181-")), "r.jsonl");
const events = (f) => { try { return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter((e) => e.event === "cap_warning"); } catch { return []; } };

function rig({ caps = { day: 10 }, history = [], fractions = [0.8], priorEvents = [] } = {}) {
  const receiptsPath = tmp();
  const cap = createCapEngine({ caps, history, runId: "run1" });
  const capWarner = createCapWarner({ fractions, events: priorEvents, runId: "run1" });
  const lines = [];
  const server = createMeteringProxy({ receiptsPath, cap, capWarner, onWarning: (l) => lines.push(l) });
  const settle = createSettler({ cap: () => cap, agentBudgets: () => undefined, proxySettle: () => (r) => server.settle(r) });
  return { receiptsPath, cap, capWarner, server, settle, lines };
}

test("(a) a settlement crossing 80% of the day cap emits one cap_warning; a later own receipt does not emit a second", () => {
  const ts = NOW.toISOString();
  const r = rig({ history: [{ id: "k", ts, cost_usd: 5 }, { id: "u", ts, cost_usd: null }] });
  r.server.checkWarnings();
  assert.equal(events(r.receiptsPath).length, 0);
  assert.equal(r.settle({ receipt_id: "u", settled_cost_usd: 3.5 }, { id: "u", ts, cost_usd: null }), true);
  r.server.checkWarnings();
  const ev = events(r.receiptsPath);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].scope, ev[0].fraction, ev[0].spent_usd, ev[0].period, ev[0].lower_bound], ["day", 0.8, 8.5, DAY, false]);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /day spend \$8\.5000 is 80% of \$10 cap/);
  assert.deepEqual(r.capWarner.emitted.map((e) => e.scope), ["day"]);
  // Own receipt afterwards: same path recordSpend uses.
  r.cap.record({ ts, cost_usd: 0.5 });
  r.server.checkWarnings();
  assert.equal(events(r.receiptsPath).length, 1);
});

test("lower_bound is set when unknown receipts remain after the change", () => {
  const ts = NOW.toISOString();
  const r = rig({ history: [{ id: "u1", ts, cost_usd: null }, { id: "u2", ts, cost_usd: null }] });
  r.settle({ receipt_id: "u1", settled_cost_usd: 9 }, { id: "u1", ts, cost_usd: null });
  r.server.checkWarnings();
  assert.equal(events(r.receiptsPath)[0].lower_bound, true);
});

test("(c) a fleet updateCaps that drops the cap below 125% of spend emits one", () => {
  const ts = NOW.toISOString();
  const r = rig({ caps: { day: 20 }, history: [{ id: "k", ts, cost_usd: 9 }] });
  r.server.checkWarnings();
  assert.equal(events(r.receiptsPath).length, 0);
  r.cap.updateCaps({ day: 10 });
  r.server.checkWarnings();
  r.server.checkWarnings();
  const ev = events(r.receiptsPath);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].cap, 10);
});

test("--warn-at off emits nothing on any path", () => {
  const ts = NOW.toISOString();
  const r = rig({ fractions: [], history: [{ id: "k", ts, cost_usd: 9.5 }] });
  r.cap.updateCaps({ day: 5 });
  r.server.checkWarnings();
  assert.equal(events(r.receiptsPath).length, 0);
  assert.equal(r.lines.length, 0);
});

test("prior cap_warning for the period (incl. a sibling's, via note) is not repeated", () => {
  const ts = NOW.toISOString();
  const prior = { event: "cap_warning", scope: "day", fraction: 0.8, period: DAY };
  const a = rig({ history: [{ id: "k", ts, cost_usd: 9 }], priorEvents: [prior] });
  a.server.checkWarnings();
  assert.equal(events(a.receiptsPath).length, 0);
  const b = rig({ history: [{ id: "k", ts, cost_usd: 9 }] });
  b.capWarner.note(prior);
  b.server.checkWarnings();
  assert.equal(events(b.receiptsPath).length, 0);
});

test("(b) shared ledger: sibling receipts and sibling cap_warning events reach the callbacks", () => {
  const path = tmp();
  writeFileSync(path, "");
  const ts = NOW.toISOString();
  const seenReceipts = [], seenEvents = [];
  const h = openSharedLedger(path, { onExternal: (r) => seenReceipts.push(r), onExternalEvent: (e) => seenEvents.push(e) });
  try {
    h.history();
    appendFileSync(path, JSON.stringify({ id: "sib", ts, cost_usd: 8.5 }) + "\n");
    h.withLock(() => {});
    assert.deepEqual(seenReceipts.map((r) => r.id), ["sib"]);
    assert.equal(seenEvents.length, 0);
    appendFileSync(path, JSON.stringify({ event: "cap_warning", scope: "day", fraction: 0.8, period: DAY, ts }) + "\n");
    h.withLock(() => {});
    assert.equal(seenEvents.length, 1);
  } finally { h.close(); }
});

test("(b) shared ledger end to end: sibling receipt crossing the line warns once unless the sibling already warned", () => {
  for (const siblingWarned of [false, true]) {
    const path = tmp();
    writeFileSync(path, "");
    const ts = NOW.toISOString();
    let cap, capWarner, server;
    const h = openSharedLedger(path, {
      onExternal: (r) => { cap.record(r, { external: true }); queueMicrotask(() => server.checkWarnings()); },
      onExternalEvent: (e) => capWarner.note(e),
    });
    try {
      cap = createCapEngine({ caps: { day: 10 }, history: h.history(), runId: "run1" });
      capWarner = createCapWarner({ fractions: [0.8], runId: "run1" });
      server = createMeteringProxy({ receiptsPath: path, cap, capWarner, sharedLedger: h, onWarning: () => {} });
      appendFileSync(path, JSON.stringify({ id: "sib", ts, cost_usd: 8.5 }) + "\n");
      if (siblingWarned) appendFileSync(path, JSON.stringify({ event: "cap_warning", scope: "day", fraction: 0.8, period: DAY, ts }) + "\n");
      h.withLock(() => {});
      server.checkWarnings();
      assert.equal(events(path).length, 1, `siblingWarned=${siblingWarned}`);
      assert.equal(capWarner.emitted.length, siblingWarned ? 0 : 1);
    } finally { h.close(); }
  }
});
