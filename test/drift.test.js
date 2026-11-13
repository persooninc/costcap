import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { behindSince, driftDecision, readProdSha } from "../scripts/drift-check.mjs";

const A = "a".repeat(40), B = "b".repeat(40);
const now = Date.parse("2026-11-13T12:00:00Z");

test("drift job is red when prod sha differs from main for more than 24h", () => {
  assert.deepEqual(driftDecision({ prodSha: A, mainSha: A, nowMs: now }), { ok: true, state: "current", hoursBehind: 0 });
  const fresh = driftDecision({ prodSha: A, mainSha: B, behindSinceMs: now - 2 * 3600_000, nowMs: now });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.state, "behind-within-grace");
  const stale = driftDecision({ prodSha: A, mainSha: B, behindSinceMs: now - 25 * 3600_000, nowMs: now });
  assert.equal(stale.ok, false);
  assert.equal(stale.state, "drift");
  assert.equal(driftDecision({ prodSha: null, mainSha: B, nowMs: now }).ok, false);
  assert.equal(driftDecision({ prodSha: A, mainSha: B, behindSinceMs: null, nowMs: now }).state, "unknown-prod-sha");
  assert.throws(() => driftDecision({ prodSha: A, mainSha: "main", nowMs: now }));
});

test("behind-since uses the oldest main commit prod lacks", () => {
  const calls = [];
  const git = (args) => { calls.push(args[0]); return args[0] === "log" ? "1700000000\n1700003600\n" : ""; };
  assert.equal(behindSince(A, B, git), 1700000000 * 1000);
  assert.deepEqual(calls, ["merge-base", "log"]);
  assert.equal(behindSince(A, B, (args) => { if (args[0] === "merge-base") throw new Error("not ancestor"); return ""; }), null);
});

test("prod sha readback fails closed and the workflow is read-only", async () => {
  assert.equal(await readProdSha("https://x.invalid", async () => new Response(JSON.stringify({ sha: A }), { status: 200 })), A);
  assert.equal(await readProdSha("https://x.invalid", async () => new Response("no", { status: 503 })), null);
  assert.equal(await readProdSha("https://x.invalid", async () => { throw new Error("down"); }), null);
  const wf = readFileSync(new URL("../.github/workflows/drift.yml", import.meta.url), "utf8");
  assert.match(wf, /schedule:/);
  assert.match(wf, /contents: read/);
  assert.doesNotMatch(wf, /secrets\./);
  const deploy = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.match(deploy, /workflow_run:\n\s+workflows: \[verify\]/);
  assert.match(deploy, /workflow_run\.conclusion == 'success'/);
  assert.match(deploy, /COSTCAP_EXPECT_SHA: \$\{\{ env\.DEPLOY_SHA \}\}/);
});
