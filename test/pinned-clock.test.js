// #237 regression: suites that price gemini-2.5-pro/2.5-flash/3.8-flash without `at`
// must not flip on 2026-12-01 or 2027-01-01. The pinned clock holds them (and their
// spawned children) at a pre-change instant, while explicit `at` still selects dated rows.
import "./support/pinned-clock.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PINNED_AT } from "./support/pinned-clock.js";
import { costForUsage } from "../src/pricing.js";

const usage = { input_tokens: 100_000, output_tokens: 0 };

test("#237 pinned clock: Date starts at PINNED_AT and keeps ticking", async () => {
  const a = Date.now();
  assert.ok(Math.abs(a - Date.parse(PINNED_AT)) < 60 * 60 * 1000);
  assert.ok(Math.abs(new Date().getTime() - a) < 1000);
  assert.equal(new Date("2027-01-02").toISOString(), "2027-01-02T00:00:00.000Z");
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(Date.now() > a);
});

test("#237 undated calls price at the pinned instant; explicit at selects the dated rows", () => {
  assert.equal(costForUsage("gemini-2.5-pro", usage).cost_usd, 0.125);
  assert.equal(costForUsage("gemini-2.5-flash", usage).cost_usd, 0.03);
  assert.equal(costForUsage("gemini-3.8-flash", usage).cost_usd, 0.075);
  assert.equal(costForUsage("gemini-2.5-pro", usage, { at: "2026-12-02T00:00:00Z" }).cost_usd, 0.075);
  assert.equal(costForUsage("gemini-3.8-flash", usage, { at: "2027-01-02T00:00:00Z" }).cost_usd, 0.15);
});

test("#237 spawned children inherit the pinned clock via NODE_OPTIONS", () => {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(Date.now()))"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Math.abs(Number(r.stdout) - Date.parse(PINNED_AT)) < 60 * 60 * 1000);
  // Same timeline as the parent: a child started later never reads an earlier instant.
  const before = Date.now();
  const r2 = spawnSync(process.execPath, ["-e", "process.stdout.write(String(Date.now()))"], { encoding: "utf8" });
  assert.ok(Number(r2.stdout) >= before);
});
