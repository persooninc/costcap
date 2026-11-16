import test from "node:test";
import assert from "node:assert/strict";
import { receiptsCsv, RECEIPT_CSV_LIMIT } from "../src/hosted/receipts-csv.js";

test("receipt csv quotes formulas and keeps an empty cost empty", () => {
  const { body, truncated, count } = receiptsCsv([
    { ts: "2026-10-13T00:00:00.000Z", agent_id: "a", receipt_id: "1", model: "=cmd()", cost_usd: "", reason: "+sum", scope: "day" },
    { ts: "2026-10-12T00:00:00.000Z", agent_id: "a", receipt_id: "0", model: "gpt", cost_usd: 1.5, cost_source: "provider", reason: "", scope: "" },
  ]);
  assert.equal(truncated, false);
  assert.equal(count, 2);
  const lines = body.trim().split("\n");
  assert.equal(lines[0], "ts,agent_id,receipt_id,run_id,model,cost_usd,cost_source,settled_cost_usd,settle_source,reason,scope,outcome");
  assert.equal(lines[1], "2026-10-12T00:00:00.000Z,a,0,,gpt,1.5,provider,,,,,");
  assert.equal(lines[2], "2026-10-13T00:00:00.000Z,a,1,,'=cmd(),,,,,'+sum,day,");
});

test("receipt csv keeps only the newest rows past the limit", () => {
  const rows = ["a", "b", "c", "d"].map((id, i) => ({
    ts: `2026-01-0${i + 1}T00:00:00.000Z`,
    agent_id: "agent",
    receipt_id: id,
    model: "m",
    cost_usd: 0,
    reason: "",
    scope: "",
  }));
  const { truncated, count, body } = receiptsCsv(rows, { limit: 2 });
  assert.equal(truncated, true);
  assert.equal(count, 2);
  assert.match(body, /,c,,m,/);
  assert.match(body, /,d,,m,/);
  assert.doesNotMatch(body, /,a,,m,/);
  assert.equal(RECEIPT_CSV_LIMIT, 5000);
});

test("#149: filters apply before the limit and truncation is stated in-band", async () => {
  const { parseReceiptsQuery } = await import("../src/hosted/receipts-csv.js");
  const { parseAuditRange } = await import("../src/hosted/audit-log.js");
  const rows = ["a", "b", "c", "d"].map((id, i) => ({ ts: `2026-01-0${i + 1}T00:00:00.000Z`, agent_id: i % 2 ? "x" : "y", receipt_id: id, model: "m", cost_usd: 0 }));
  const scoped = receiptsCsv(rows, { limit: 2, since: Date.parse("2026-01-02T00:00:00Z"), until: Date.parse("2026-01-03T23:59:59Z") });
  assert.equal(scoped.truncated, false);
  assert.equal(scoped.total, 2);
  assert.match(scoped.body, /^ts,agent_id/);
  assert.match(scoped.body, /,b,,m,/);
  assert.match(scoped.body, /,c,,m,/);
  const byAgent = receiptsCsv(rows, { agentId: "x" });
  assert.deepEqual([byAgent.count, byAgent.total], [2, 2]);
  assert.doesNotMatch(byAgent.body, /,y,/);
  const cut = receiptsCsv(rows, { limit: 3 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.total, 4);
  assert.equal(cut.body.split("\n")[0], "# truncated: showing newest 3 of 4 receipts; narrow with since/until");
  const p = (q, ids = new Set(["x"])) => parseReceiptsQuery(new URLSearchParams(q), ids, parseAuditRange);
  assert.deepEqual(p("agent_id=x&since=2026-01-01"), { agentId: "x", since: Date.parse("2026-01-01") });
  for (const q of ["since=nope", "until=", "since=2026-02-01&until=2026-01-01", "agent_id=other"]) assert.throws(() => p(q), (e) => e.status === 400, q);
});

test("#153 receipt csv carries the blocked_model outcome", () => {
  const { body } = receiptsCsv([{ ts: "2026-11-16T00:00:00.000Z", agent_id: "a", receipt_id: "bm1", model: "gpt-4o", cost_usd: 0, reason: "model_not_allowed", outcome: "blocked_model" }]);
  assert.equal(body.trim().split("\n")[1], "2026-11-16T00:00:00.000Z,a,bm1,,gpt-4o,0,,,,model_not_allowed,,blocked_model");
});
