// #226: settled batches are attributed per model in bill-check.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { foldBatchResults } from "../src/batch.js";
import { applySettlements, settledByModel } from "../src/cap.js";
import { billCheck, parseOpenAICosts, parseAnthropicCostReport } from "../src/bill-check.js";
import { applyReconciliation } from "../src/reconcile.js";

const D = "2026-10-30";
const T = `${D}T10:00:00Z`;
const day = Date.parse(`${D}T00:00:00Z`) / 1000;
const oaExport = (items) => ({ data: [{ start_time: day, end_time: day + 86400, results: items.map(([line_item, value]) => ({ line_item, amount: { value, currency: "usd" } })) }] });

test("repro: $2 receipt + $5 OpenAI batch settled with by_model matches a $7 gpt-4.1 bill", () => {
  const lines = [
    { id: "r1", ts: T, provider: "openai", model: "gpt-4.1", cost_usd: 2 },
    { id: "b1", ts: T, provider: "openai", model: "unknown", reason: "batch_pending", batch_id: "batch_1", cost_usd: null },
    { event: "reconciliation", receipt_id: "b1", cost_usd: 5, source: "batch_results", by_model: { "gpt-4.1-2025-04-14": 5 } },
  ];
  const billed = parseOpenAICosts(oaExport([["gpt-4.1, input", 7]]));
  const r = billCheck({ receipts: applySettlements(lines), billed, provider: "openai" });
  assert.equal(r.verdict, "match");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].model, "gpt-4.1");
  assert.equal(r.rows[0].status, "match");
});

test("old ledger without by_model still parses and stays under unknown", () => {
  const lines = [
    { id: "b1", ts: T, provider: "openai", model: "unknown", reason: "batch_pending", cost_usd: null },
    { event: "reconciliation", receipt_id: "b1", cost_usd: 5, source: "batch_results" },
  ];
  const rec = applySettlements(lines);
  assert.equal(rec[0].settled.by_model, undefined);
  const r = billCheck({ receipts: rec, billed: [], provider: "openai" });
  assert.deepEqual(r.rows.map((x) => [x.model, x.status]), [["unknown", "metered_only"]]);
});

test("settledByModel rejects malformed or inconsistent splits", () => {
  for (const by_model of [undefined, null, [], {}, { a: -1 }, { a: "1" }, { a: Infinity }, { "": 5 }, { a: 4 }])
    assert.equal(settledByModel({ cost_usd: 5, by_model }), null, JSON.stringify(by_model));
  assert.deepEqual(settledByModel({ cost_usd: 5, by_model: { a: 2, b: 3 } }), { a: 2, b: 3 });
});

const amsg = (model, input, output) => JSON.stringify({ custom_id: model, result: { type: "succeeded", message: { model, usage: { input_tokens: input, output_tokens: output } } } });

test("Anthropic mixed-model batch splits across both model rows (cost report parser)", () => {
  const text = [amsg("claude-sonnet-4-5-20250929", 1_000_000, 0), amsg("claude-haiku-4-5", 1_000_000, 0), JSON.stringify({ result: { type: "errored" } })].join("\n");
  const f = foldBatchResults("anthropic", text);
  assert.equal(f.ok, true);
  assert.deepEqual(Object.keys(f.by_model).sort(), ["claude-haiku-4-5", "claude-sonnet-4-5-20250929"]);
  const sum = Object.values(f.by_model).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - f.cost_usd) < 1e-9);
  const lines = [
    { id: "b1", ts: T, provider: "anthropic", model: "claude-sonnet-4-5", reason: "batch_pending", cost_usd: null },
    { event: "reconciliation", receipt_id: "b1", cost_usd: f.cost_usd, source: "batch_results", by_model: f.by_model },
  ];
  const doc = { data: [{ starting_at: `${D}T00:00:00Z`, ending_at: `${D}T23:59:59Z`, results: [
    { model: "claude-sonnet-4-5-20250929", amount: String(f.by_model["claude-sonnet-4-5-20250929"] * 100), currency: "USD" },
    { model: "claude-haiku-4-5", amount: String(f.by_model["claude-haiku-4-5"] * 100), currency: "USD" },
  ] }] };
  const billed = parseAnthropicCostReport(doc);
  const r = billCheck({ receipts: applySettlements(lines), billed, provider: "anthropic" });
  assert.deepEqual(r.rows.map((x) => [x.model, x.status]).sort(), [["claude-haiku-4-5", "match"], ["claude-sonnet-4-5", "match"]]);
  assert.equal(r.verdict, "match");
});

test("OpenAI fold records per-model cost; total unchanged", () => {
  const line = (model) => JSON.stringify({ response: { status_code: 200, body: { model, usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } } } });
  const f = foldBatchResults("openai", [line("gpt-4.1"), line("gpt-4.1-mini"), line("gpt-4.1")].join("\n"));
  assert.equal(f.ok, true);
  assert.deepEqual(Object.keys(f.by_model).sort(), ["gpt-4.1", "gpt-4.1-mini"]);
  assert.ok(Math.abs(Object.values(f.by_model).reduce((a, b) => a + b, 0) - f.cost_usd) < 1e-9);
});

test("reconcile --apply passes a valid charge by_model through, drops an invalid one", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc226-"));
  const rp = join(dir, "r.jsonl"), pp = join(dir, "p.jsonl");
  writeFileSync(rp, [{ id: "b1", ts: T, provider: "openai", model: "unknown", cost_usd: null }, { id: "b2", ts: T, provider: "openai", model: "unknown", cost_usd: null }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(pp, [{ id: "b1", cost_usd: 5, by_model: { "gpt-4.1": 3, "gpt-4.1-mini": 2 } }, { id: "b2", cost_usd: 1, by_model: { "gpt-4.1": 9 } }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  applyReconciliation({ receiptsPath: rp, providerPath: pp });
  const ev = readFileSync(rp, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event);
  assert.deepEqual(ev[0].by_model, { "gpt-4.1": 3, "gpt-4.1-mini": 2 });
  assert.equal(ev[1].by_model, undefined);
  assert.equal(ev[0].cost_usd, 5);
});
