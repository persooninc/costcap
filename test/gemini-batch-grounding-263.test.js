// #263: batch settle applies the #260 billed_as grounding rule (per query after Dec 1) at each instant.
import test from "node:test";
import assert from "node:assert/strict";
import { foldBatchResults } from "../src/batch.js";
import "./support/pinned-clock.js";

const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 };
const line = (model, queries) => JSON.stringify({ key: "k", response: {
  candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP",
    ...(queries && { groundingMetadata: { webSearchQueries: queries, groundingChunks: [{ web: { uri: "https://a", title: "t" } }] } }) }],
  usageMetadata, modelVersion: model } });
const fold = (model, queries, createdAt, settledAt) => foldBatchResults("gemini", line(model, queries), null, { model, createdAt, settledAt });
const share = (model, q, a, b) => Number((fold(model, q, a, b).cost_usd - fold(model, null, a, b).cost_usd).toFixed(6));
const NOV = "2026-11-30T12:00:00Z", DEC = "2026-12-02T12:00:00Z";

test("#263 AC2: gemini-2.5-pro / 2.5-flash batch grounding per query after Dec 1, per prompt before", () => {
  for (const m of ["gemini-2.5-pro", "gemini-2.5-flash"]) {
    assert.equal(share(m, ["a", "b", "c"], DEC, DEC), 0.042, m);
    assert.equal(share(m, ["a", "b", "c"], NOV, NOV), 0.035, m);
    assert.ok(fold(m, ["a", "b", "c"], DEC, DEC).ok);
  }
});

test("#263 AC3: created Nov 30, settled Dec 2 keeps the higher total of both instants", () => {
  const m = "gemini-2.5-pro", q = ["a", "b", "c"];
  const both = fold(m, q, NOV, DEC).cost_usd;
  assert.equal(both, Math.max(fold(m, q, NOV, NOV).cost_usd, fold(m, q, DEC, DEC).cost_usd));
  assert.equal(fold(m, q, DEC, NOV).cost_usd, both);
});

test("#263 AC4: no billed_as entry unchanged (per query); no groundingMetadata has no grounding cost", () => {
  assert.equal(share("gemini-3.8-flash", ["a", "b"], DEC, DEC), 0.028);
  assert.equal(share("gemini-3.8-flash", ["a", "b"], NOV, NOV), 0.028);
  const plain = fold("gemini-2.5-pro", null, DEC, DEC);
  assert.ok(plain.ok && plain.cost_usd > 0 && plain.cost_usd < 0.01);
});
