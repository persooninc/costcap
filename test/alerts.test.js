import test from "node:test";
import assert from "node:assert/strict";
import { ALERT_KINDS, auditEntry, dedupeAlerts, evaluateAlerts, projectMonthSpend } from "../src/hosted/alerts.js";

const state = (over = {}) => ({ agentId: "a1", caps: {}, spend: {}, blockedReasons: [], ...over });
const kinds = (alerts) => alerts.map((a) => a.kind);

test("alert kinds are the documented set", () => {
  assert.deepEqual(ALERT_KINDS, ["cap_approaching", "cap_hit", "loop_detected", "agent_silent", "cap_projected"]);
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

// Issue #109: month burn-rate projection.
const mid = Date.parse("2026-11-16T00:00:00.000Z"); // 15 of 30 days elapsed

test("projectMonthSpend is linear over the UTC month", () => {
  assert.equal(projectMonthSpend(5, mid), 10);
  assert.equal(projectMonthSpend(5, Date.parse("2026-11-01T12:00:00.000Z")), null);
  assert.equal(projectMonthSpend(1, Date.parse("2026-11-01T12:00:00.000Z"), { minElapsedMs: 0 }), 60);
  assert.equal(projectMonthSpend(undefined, mid), null);
  assert.equal(projectMonthSpend(NaN, mid), null);
  assert.equal(projectMonthSpend(5, undefined), null);
  assert.equal(projectMonthSpend(3, Date.parse("2026-12-31T00:00:00.000Z")).toFixed(6), "3.100000");
});

test("cap_projected fires when the burn rate reaches the month cap", () => {
  const at = (spent, over = {}) => evaluateAlerts(state({ caps: { month: 20 }, spend: { month: spent }, nowMs: mid, ...over }));
  assert.deepEqual(at(9), []);
  const [alert] = at(10);
  assert.deepEqual(alert, { kind: "cap_projected", scope: "month", key: "cap_projected:a1:month", cap: 20, spent: 10, projected: 20, lowerBound: false });
  assert.equal(at(10, { unknown: { month: 2 } })[0].lowerBound, true);
  assert.deepEqual(kinds(at(16)), ["cap_approaching"]);
  assert.deepEqual(kinds(at(20)), ["cap_hit"]);
  assert.deepEqual(kinds(at(10, { nowMs: Date.parse("2026-11-01T06:00:00.000Z") })), []);
  assert.deepEqual(kinds(evaluateAlerts(state({ caps: { month: "20" }, spend: { month: 19 }, nowMs: mid }))), []);
  assert.deepEqual(kinds(evaluateAlerts(state({ caps: { month: 20 }, spend: {}, nowMs: mid }))), []);
  assert.deepEqual(kinds(evaluateAlerts(state({ caps: { month: 20 }, spend: { month: 2 }, nowMs: Date.parse("2026-11-01T06:00:00.000Z") }), { minProjectionMs: 0 })), ["cap_projected"]);
});

test("#134 per-agent silent threshold: default 6h, override, 0 = off", async () => {
  const { evaluateAlerts, silentAfterMsFor } = await import("../src/hosted/alerts.js");
  const { validatePolicy } = await import("../src/hosted/policy.js");
  const H = 3600_000, base = { agentId: "a", caps: {}, lastSeenMs: 0 };
  assert.equal(silentAfterMsFor({}), 6 * H);
  assert.equal(silentAfterMsFor({ silentAfterHours: null }), 6 * H);
  assert.equal(silentAfterMsFor({ silentAfterHours: 24 }), 24 * H);
  assert.equal(silentAfterMsFor({ silentAfterHours: 0 }), Infinity);
  const silent = (nowMs, policy) => evaluateAlerts({ ...base, nowMs }, { silentAfterMs: silentAfterMsFor(policy) }).some((a) => a.kind === "agent_silent");
  assert.equal(silent(7 * H, {}), true);
  assert.equal(silent(7 * H, { silentAfterHours: 24 }), false);
  assert.equal(silent(24 * H + 1, { silentAfterHours: 24 }), true);
  assert.equal(silent(10_000 * H, { silentAfterHours: 0 }), false);
  for (const ok of [undefined, null, 0, 0.5, 24, 720]) assert.deepEqual(validatePolicy({ version: 1, caps: {}, silentAfterHours: ok }), [], String(ok));
  for (const bad of [-1, 721, "6", NaN, Infinity, true]) assert.equal(validatePolicy({ version: 1, caps: {}, silentAfterHours: bad }).length, 1, String(bad));
});

// Issue #143: occurrence lifecycle helpers.
import { alertOccurrences, activeOccurrence, fireAlert, resolveAlert, filterAlerts, alertStatus } from "../src/hosted/alerts.js";
test("occurrence lifecycle: fire, resolve, re-fire keeps history; legacy records keep fired_at null", () => {
  const alerts = { legacy: { kind: "cap_hit", key: "k-old", active: false } };
  const t0 = Date.parse("2026-11-15T00:00:00Z"), t1 = Date.parse("2026-11-16T00:00:00Z");
  const a = fireAlert(alerts, { kind: "cap_hit", key: "k" }, { orgId: "o" }, { nowMs: t0, id: "one" });
  assert.equal(a.fired_at, "2026-11-15T00:00:00.000Z");
  assert.equal(a.resolved_at, null);
  assert.deepEqual(activeOccurrence(alerts, "k")[0], "one");
  resolveAlert(alerts.one, t1);
  resolveAlert(alerts.one, t1 + 5); // idempotent
  assert.equal(alerts.one.resolved_at, "2026-11-16T00:00:00.000Z");
  assert.equal(activeOccurrence(alerts, "k"), null);
  fireAlert(alerts, { kind: "cap_hit", key: "k" }, { orgId: "o" }, { nowMs: t1, id: "two" });
  const list = alertOccurrences(alerts);
  assert.equal(list.length, 3);
  const legacy = list.find((x) => x.id === "legacy");
  assert.equal(legacy.fired_at, null);
  assert.equal(alertStatus(legacy), "resolved");
  assert.deepEqual(filterAlerts(list).map((x) => x.id), ["two", "one", "legacy"]);
  assert.deepEqual(filterAlerts(list, { status: "active" }).map((x) => x.id), ["two"]);
  alerts.two.acknowledged_at = "2026-11-16T01:00:00.000Z";
  assert.deepEqual(filterAlerts(alertOccurrences(alerts), { status: "acknowledged" }).map((x) => x.id), ["two"]);
  assert.deepEqual(filterAlerts(list, { since: t1 }).map((x) => x.id), ["two"]);
  assert.deepEqual(filterAlerts(list, { until: t0 }).map((x) => x.id), ["one"]);
});
