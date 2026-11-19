// Red main 2026-11-19 (run 44471161743): three e2e specs hit the 30 s default while 8 workers
// cold-started together on the loaded shared runner. CI now uses fewer workers and 60 s.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

function load(ci) {
  const env = { ...process.env };
  delete env.CI;
  if (ci) env.CI = "true";
  const script = 'const m = await import("./playwright.config.js"); const c = m.default; console.log(JSON.stringify({ workers: c.workers ?? null, timeout: c.timeout ?? null, retries: c.retries, forbidOnly: c.forbidOnly }));';
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("CI e2e: 4 workers, 60 s per test, no retries, test.only forbidden", () => {
  assert.deepEqual(load(true), { workers: 4, timeout: 60_000, retries: 0, forbidOnly: true });
});

test("local e2e keeps the Playwright defaults (no worker or timeout override)", () => {
  assert.deepEqual(load(false), { workers: null, timeout: null, retries: 0, forbidOnly: false });
});
