// #182: proxy batch_results settle counts toward --cap run only for this wrapper's own batch.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createCapWarner } from "../src/cap-warn.js";
import { ANTHROPIC_EXPECTED, mockUpstream } from "./support/batch.js";

const SONNET = { model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
const ABATCH = JSON.stringify({ requests: ["a", "b", "c"].map((custom_id) => ({ custom_id, params: SONNET })) });

async function setup(t, { runId, seed = [], run }) {
  const up = http.createServer(mockUpstream());
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-182-")), "r.jsonl");
  writeFileSync(receiptsPath, seed.map((l) => JSON.stringify(l) + "\n").join(""));
  const cap = createCapEngine({ caps: { run, day: 1000, month: 1000 }, history: seed, runId });
  const capWarner = createCapWarner({ fractions: [0.5], events: [], runId, agentId: null });
  const warnings = [];
  const p = await startMeteringProxy({ upstreams: { anthropic: base }, receiptsPath, cap, who: { run_id: runId }, capWarner, onWarning: (l) => warnings.push(l) });
  t.after(() => { up.closeAllConnections(); up.close(); p.server.closeAllConnections(); p.server.close(); });
  return {
    cap, warnings,
    call: (method, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body }),
    lines: () => readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)),
  };
}

test("another run's batch_pending settled by a new wrapper counts toward day/month, not run", async (t) => {
  const ts = new Date().toISOString();
  const seed = [{ id: "p1", ts, run_id: "R1", provider: "anthropic", model: "claude-sonnet-4-6", cost_usd: null, reason: "batch_pending", batch_id: "msgbatch_01" }];
  const run = ANTHROPIC_EXPECTED / 2; // the batch alone would blow the run cap
  const s = await setup(t, { runId: "R2", seed, run });
  assert.equal((await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results")).status, 200);
  const spend = s.cap.spend();
  assert.equal(spend.run, 0);
  assert.ok(Math.abs(spend.day - ANTHROPIC_EXPECTED) < 1e-9);
  assert.ok(Math.abs(spend.month - ANTHROPIC_EXPECTED) < 1e-9);
  assert.equal(s.lines().filter((l) => l.event === "reconciliation").length, 1);
  // Next call is allowed: no run-scope 429.
  assert.equal((await s.call("POST", "/anthropic/v1/messages", JSON.stringify(SONNET))).status, 200);
  assert.equal(s.lines().some((l) => l.event === "cap_warning" && l.scope === "run"), false);
  assert.equal(s.warnings.some((w) => /run/.test(w)), false);
});

test("a batch created and resolved in the same wrapper still counts toward run (#160)", async (t) => {
  const s = await setup(t, { runId: "R1", run: 1000 });
  assert.equal((await s.call("POST", "/anthropic/v1/messages/batches", ABATCH)).status, 200);
  await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results");
  assert.ok(Math.abs(s.cap.spend().run - ANTHROPIC_EXPECTED) < 1e-9);
});

test("after a restart, the wrapper's own batch read back from the ledger still counts toward run", async (t) => {
  const ts = new Date().toISOString();
  const seed = [{ id: "p1", ts, run_id: "R1", provider: "anthropic", model: "claude-sonnet-4-6", cost_usd: null, reason: "batch_pending", batch_id: "msgbatch_01" }];
  const s = await setup(t, { runId: "R1", seed, run: 1000 });
  await s.call("GET", "/anthropic/v1/messages/batches/msgbatch_01/results");
  assert.ok(Math.abs(s.cap.spend().run - ANTHROPIC_EXPECTED) < 1e-9);
});
