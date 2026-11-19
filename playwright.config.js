import { defineConfig } from "@playwright/test";

// CI runs on a shared self-hosted runner whose load can sit near 65. With 8 workers the
// first wave cold-starts 8 browsers and app servers at once, and CPU-starved specs ran out of
// the 30 s default (run 44471161743: alerts, anomaly, billing). In CI: fewer workers and a
// longer per-test budget. Retries stay at 0, so a real failure still fails.
export const CI_WORKERS = 4;
export const CI_TEST_TIMEOUT_MS = 60_000;
const ci = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: ci,
  retries: 0,
  ...(ci ? { workers: CI_WORKERS, timeout: CI_TEST_TIMEOUT_MS } : {}),
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
