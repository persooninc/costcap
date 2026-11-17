// #263: batch settle applies #260's billed_as grounding rule (unit + rate of the billed_as model) per instant.
import test from "node:test";
import assert from "node:assert/strict";
import { foldBatchResults } from "../src/batch.js";
import "./support/pinned-clock.js";

const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 };
const line = (model, queries) => JSON.stringify({ key: "k1", response: {
  candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP",
    ...(queries && { groundingMetadata: { webSearchQueries: queries, groundingChunks: [{ web: { uri: "https://e.x", title: "t" } }] } }) }],
  usageMetadata, modelVersion: model } });
const fold = (model, queries, createdAt, settledAt) => foldBatchResults("gemini", line(model, queries), null, { model, createdAt, settledAt });
const share = (model, q, c, s) => {
  const g = fold(model, q, c, s), p = fold(model, null, c, s);
  assert.equal(g.ok, true); assert.equal(p.ok, true);
  return Number((g.cost_usd - p.cost_usd).toFixed(6));
};
const NOV30 = "2026-11-30T12:00:00Z", DEC2 = "2026-12-02T12:00:00Z";

test("#263 AC2: gemini-2.5-pro batch on Dec 2 bills grounding per query at the billed_as rate", () => {
  assert.equal(share("gemini-2.5-pro", ["a", "b", "c"], DEC2, DEC2), 0.042);
});

test("#263 AC2: gemini-2.5-pro batch on Nov 30 keeps 1 prompt x $0.035", () => {
  assert.equal(share("gemini-2.5-pro", ["a", "b", "c"], NOV30, NOV30), 0.035);
});

test("#263 AC2: gemini-2.5-flash follows gemini-3.5-flash-lite the same way", () => {
  assert.equal(share("gemini-2.5-flash", ["a", "b", "c"], DEC2, DEC2), 0.042);
  assert.equal(share("gemini-2.5-flash", ["a", "b", "c"], NOV30, NOV30), 0.035);
});

test("#263 AC3: created Nov 30, settled Dec 2 keeps the higher whole-line total", () => {
  const span = fold("gemini-2.5-pro", ["a", "b", "c"], NOV30, DEC2).cost_usd;
  const a = fold("gemini-2.5-pro", ["a", "b", "c"], NOV30, NOV30).cost_usd;
  const b = fold("gemini-2.5-pro", ["a", "b", "c"], DEC2, DEC2).cost_usd;
  assert.equal(span, Math.max(a, b));
  // Reverse order of instants gives the same answer.
  assert.equal(fold("gemini-2.5-pro", ["a", "b", "c"], DEC2, NOV30).cost_usd, span);
});

test("#263 AC4: a model with no billed_as stays per query; no groundingMetadata means no grounding cost", () => {
  assert.equal(share("gemini-3.8-flash", ["a", "b"], DEC2, DEC2), 0.028);
  const p = fold("gemini-2.5-pro", null, DEC2, DEC2);
  assert.equal(p.ok, true);
  assert.ok(p.cost_usd < 0.01);
});
