import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Regression: the kill-file scenario raced the 500 ms child-stop watcher on slow
// CI runners (exit 143 on main at 03649c7, 68fc808, cb270b3). A 1 ms poll forces that race.
test("regression: runaway smoke is deterministic even with a 1 ms kill poll", () => {
  const r = spawnSync(process.execPath, ["scripts/runaway-smoke.mjs"], { env: { ...process.env, COSTCAP_KILL_POLL_MS: "1" }, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const kill = JSON.parse(r.stdout).results.find((s) => s.scenario === "kill-file");
  assert.equal(kill.upstreamCalls, 0);
  assert.equal(kill.blockedReason, "killed");
});
