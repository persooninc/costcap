import { evaluateAlerts, dedupeAlerts, auditEntry, ALERT_KINDS } from "./alerts.js";
import { strict as assert } from "assert";

describe("alerts", () => {
  describe("ALERT_KINDS", () => {
    it("should contain the correct alert kinds", () => {
      assert.deepStrictEqual(ALERT_KINDS, ["cap_approaching", "cap_hit", "loop_detected", "agent_silent"]);
    });
  });

  describe("evaluateAlerts", () => {
    it("should return empty array when no caps are defined", () => {
      const state = {
        agentId: "agent1",
        caps: {},
        spend: {},
        blockedReasons: [],
        lastSeenMs: 1000,
        nowMs: 2000
      };
      
      const alerts = evaluateAlerts(state);
      assert.deepStrictEqual(alerts, []);
    });

    it("should detect cap_hit alerts", () => {
      const state = {
        agentId: "agent1",
        caps: { run: 100, day: 500 },
        spend: { run: 120, day: 400 },
        blockedReasons: [],
        lastSeenMs: 1000,
        nowMs: 2000
      };
      
      const alerts = evaluateAlerts(state);
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, "cap_hit");
      assert.strictEqual(alerts[0].scope, "run");
    });

    it("should detect cap_approaching alerts", () => {
      const state = {
        agentId: "agent1",
        caps: { run: 100 },
        spend: { run: 85 },
        blockedReasons: [],
        lastSeenMs: 1000,
        nowMs: 2000
      };
      
      const alerts = evaluateAlerts(state);
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, "cap_approaching");
      assert.strictEqual(alerts[0].scope, "run");
    });

    it("should detect loop_detected alerts", () => {
      const state = {
        agentId: "agent1",
        caps: { run: 100 },
        spend: { run: 50 },
        blockedReasons: ["spiral_detected", "cost_velocity"],
        lastSeenMs: 1000,
        nowMs: 2000
      };
      
      const alerts = evaluateAlerts(state);
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, "loop_detected");
      assert.strictEqual(alerts[0].reason, "spiral_detected");
    });

    it("should detect agent_silent alerts", () => {
      const state = {
        agentId: "agent1",
        caps: { run: 100 },
        spend: { run: 50 },
        blockedReasons: [],
        lastSeenMs: 1000,
        nowMs: 25000 // 25 seconds later, more than 6 hours
      };
      
      const alerts = evaluateAlerts(state);
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, "agent_silent");
    });

    it("should handle budget_exceeded blocks correctly", () => {
      const state = {
        agentId: "agent1",
        caps: { run: 100 },
        spend: { run: 50 },
        blockedReasons: ["budget_exceeded:run"],
        lastSeenMs: 1000,
        nowMs: 2000
      };
      
      const alerts = evaluateAlerts(state);
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, "cap_hit");
      assert.strictEqual(alerts[0].scope, "run");
    });

    it("should not duplicate cap_hit alerts when both budget_exceeded and cap_hit exist", () => {
      const state = {
        agentId: "agent1",
        caps: { run: 100 },
        spend: { run: 120 },
        blockedReasons: ["budget_exceeded:run"],
        lastSeenMs: 1000,
        nowMs: 2000
      };
      
      const alerts = evaluateAlerts(state);
      // Should only have one alert (the cap_hit), not two (cap_hit + budget_exceeded)
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, "cap_hit");
    });
  });

  describe("dedupeAlerts", () => {
    it("should return fire alerts that are not in the active set", () => {
      const alerts = [
        { kind: "cap_hit", scope: "run", key: "cap_hit:agent1:run" },
        { kind: "cap_approaching", scope: "day", key: "cap_approaching:agent1:day" }
      ];
      
      const active = new Set(["cap_hit:agent1:run"]);
      const result = dedupeAlerts(alerts, active);
      
      assert.deepStrictEqual(result.fire, [{ kind: "cap_approaching", scope: "day", key: "cap_approaching:agent1:day" }]);
      assert.deepStrictEqual(result.active, new Set(["cap_hit:agent1:run", "cap_approaching:agent1:day"]));
    });

    it("should return all alerts when active set is empty", () => {
      const alerts = [
        { kind: "cap_hit", scope: "run", key: "cap_hit:agent1:run" },
        { kind: "cap_approaching", scope: "day", key: "cap_approaching:agent1:day" }
      ];
      
      const result = dedupeAlerts(alerts, new Set());
      
      assert.deepStrictEqual(result.fire, alerts);
      assert.deepStrictEqual(result.active, new Set(["cap_hit:agent1:run", "cap_approaching:agent1:day"]));
    });
  });

  describe("auditEntry", () => {
    it("should create a valid audit entry", () => {
      const entry = auditEntry({
        orgId: "org123",
        actor: "user456",
        action: "alert_fired",
        target: "agent789",
        detail: { alert: "cap_hit" }
      });
      
      assert.ok(entry.ts);
      assert.strictEqual(entry.org_id, "org123");
      assert.strictEqual(entry.actor, "user456");
      assert.strictEqual(entry.action, "alert_fired");
      assert.strictEqual(entry.target, "agent789");
      assert.deepStrictEqual(entry.detail, { alert: "cap_hit" });
    });

    it("should throw an error when required fields are missing", () => {
      assert.throws(() => {
        auditEntry({
          orgId: "org123",
          actor: "user456"
          // missing action
        });
      }, /audit entry needs orgId, actor and action/);
    });
  });
});
