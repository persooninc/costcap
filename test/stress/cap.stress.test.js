// Stress suite: capacity and latency targets live in docs/perf-targets.md.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapEngine, loadReceipts } from "../../src/cap.js";
import { lockLedger } from "../../src/ledger-lock.js";

const NOW = new Date("2026-11-15T12:00:00Z");
const history = (n) => Array.from({ length: n }, (_, i) => ({ ts: new Date(NOW - (i % 60) * 864e5).toISOString(), cost_usd: 0.0001 }));
const ms = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };

test("cap engine: 10k-receipt history, 2k check+record cycles under 2000 ms", () => {
  const cap = createCapEngine({ caps: { month: 1e6 }, history: history(10_000), now: () => NOW });
  const elapsed = ms(() => { for (let i = 0; i < 2000; i++) { assert.equal(cap.check(), null); cap.record({ ts: NOW.toISOString(), cost_usd: 0.0001 }); } });
  assert.ok(elapsed < 2000, `took ${elapsed.toFixed(0)} ms`);
});

test("cap engine: hard stop never overshoots by more than one call under sustained load", () => {
  const cap = createCapEngine({ caps: { run: 1 }, now: () => NOW });
  let forwarded = 0;
  for (let i = 0; i < 100_000; i++) { if (cap.check()) break; cap.record({ cost_usd: 0.0003 }); forwarded++; }
  assert.ok(cap.check());
  assert.ok(cap.spend().run < 1 + 0.0003 + 1e-9);
  assert.equal(forwarded, Math.ceil(1 / 0.0003));
});

test("ledger: 100k-line ledger with events loads under 4000 ms and excludes events", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cc-stress-")), "ledger.jsonl");
  const lines = history(100_000).map((r, i) => JSON.stringify(i % 1000 === 0 ? { event: "kill", ts: r.ts } : r));
  writeFileSync(path, lines.join("\n") + "\n");
  let receipts;
  const elapsed = ms(() => { receipts = loadReceipts(path); });
  assert.equal(receipts.length, 99_900);
  assert.ok(elapsed < 4000, `took ${elapsed.toFixed(0)} ms`);
});

test("ledger lock: 1000 acquire/release cycles stay exclusive and under 5000 ms", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cc-stress-")), "ledger");
  const elapsed = ms(() => { for (let i = 0; i < 1000; i++) { const release = lockLedger(path); assert.throws(() => lockLedger(path), /locked/); release(); } });
  assert.ok(elapsed < 5000, `took ${elapsed.toFixed(0)} ms`);
});
