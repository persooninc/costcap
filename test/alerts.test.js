import test from "node:test";
import assert from "node:assert/strict";
import { ALERT_KINDS, auditEntry, dedupeAlerts, evaluateAlerts } from "../src/hosted/alerts.js";

const state = (over = {}) => ({ agentId: "a1", caps: {}, spend: {}, blockedReasons: [], ...over });
const kinds = (alerts) => alerts.map((a) => a.kind);

test("alert kinds are the documented set", () => {
  assert.deepEqual(ALERT_KINDS, ["cap_approaching", "cap_hit", "loop_detected", "agent_silent"]);
});

test("no caps and no activity raise nothing", () => {
  assert.deepEqual(evaluateAlerts(state()), []);
});

test("cap_approaching starts at the fraction and cap_hit at the cap", () => {
  const at = (spent) => kinds(evaluateAlerts(state({ caps: { day: 10 }, spend: { day: spent } })));
  assert.deepEqual(at(7.99), []);
  assert.deepEqual(at(8), ["cap_approaching"]);
  assert.deepEqual(at(10), ["cap_hit"]);
  assert.deepEqual(kinds(evaluateAlerts(state({ caps: { day: 10 }, spend: { day: 5 } }), { approachFraction: 0.5 })), ["cap_approaching"]);
});

test("each scope gets its own key and malformed numbers are ignored", () => {
  const alerts = evaluateAlerts(state({ caps: { run: 1, day: 1, month: "1" }, spend: { run: 1, day: "bad", month: 9 } }));
  assert.deepEqual(alerts, [{ kind: "cap_hit", scope: "run", key: "cap_hit:a1:run", cap: 1, spent: 1 }]);
});

test("loop reason is stable: spiral, then velocity, then step budget", () => {
  const reason = (blockedReasons) => evaluateAlerts(state({ blockedReasons })).find((a) => a.kind === "loop_detected")?.reason;
  assert.equal(reason(["step_budget", "cost_velocity", "spiral_detected"]), "spiral_detected");
  assert.equal(reason(["step_budget", "cost_velocity"]), "cost_velocity");
  assert.equal(reason(["step_budget"]), "step_budget");
});

test("accounting gaps and ordinary blocks are not loops", () => {
  assert.deepEqual(evaluateAlerts(state({ blockedReasons: ["killed", "accounting_unavailable", "budget_exceeded"] })), []);
});

test("a recorded budget block pages its scope once, even with no spend figure", () => {
  assert.deepEqual(evaluateAlerts(state({ blockedReasons: ["budget_exceeded:run"] })), [
    { kind: "cap_hit", scope: "run", key: "cap_hit:a1:run", cap: null, spent: null },
  ]);
  const both = evaluateAlerts(state({ caps: { run: 1 }, spend: { run: 2 }, blockedReasons: ["budget_exceeded:run"] }));
  assert.deepEqual(kinds(both), ["cap_hit"]);
});

test("agent_silent fires only past the threshold and only when last seen is known", () => {
  const silent = (lastSeenMs, nowMs, options) => kinds(evaluateAlerts(state({ lastSeenMs, nowMs }), options));
  assert.deepEqual(silent(0, 6 * 3600_000), []);
  assert.deepEqual(silent(0, 6 * 3600_000 + 1), ["agent_silent"]);
  assert.deepEqual(silent(0, 100, { silentAfterMs: 50 }), ["agent_silent"]);
  assert.deepEqual(silent(null, 1e12), []);
});

test("dedupe fires a key once, then re-arms after it clears", () => {
  const alert = { key: "k" };
  const first = dedupeAlerts([alert]);
  assert.deepEqual(first.fire, [alert]);
  const held = dedupeAlerts([alert], first.active);
  assert.deepEqual(held.fire, []);
  const cleared = dedupeAlerts([], held.active);
  assert.equal(cleared.active.size, 0);
  assert.deepEqual(dedupeAlerts([alert], cleared.active).fire, [alert]);
});

test("audit entries need org, actor and action", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.deepEqual(auditEntry({ orgId: "o", actor: "u", action: "kill", now }), { ts: now.toISOString(), org_id: "o", actor: "u", action: "kill", target: null, detail: {} });
  for (const missing of ["orgId", "actor", "action"]) {
    assert.throws(() => auditEntry({ orgId: "o", actor: "u", action: "kill", [missing]: "" }), /audit entry needs/);
  }
});
