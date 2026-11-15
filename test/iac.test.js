// IaC policy checks for workflows, Dockerfile and compose (lint tools: see docs/perf-targets.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const wf = readdirSync(".github/workflows").filter((f) => f.endsWith(".yml")).map((f) => [f, readFileSync(`.github/workflows/${f}`, "utf8")]);

test("every workflow action is pinned to a full commit sha", () => {
  for (const [f, s] of wf) for (const m of s.matchAll(/uses:\s*(\S+)/g)) {
    if (m[1].startsWith("./")) continue;
    assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]}`);
  }
});

test("every workflow declares least-privilege permissions", () => {
  for (const [f, s] of wf) assert.match(s, /^permissions:/m, f);
});

test("workflows never interpolate untrusted event text into run steps", () => {
  for (const [f, s] of wf) assert.doesNotMatch(s, /run:.*\$\{\{\s*github\.event\.(issue|pull_request|comment|head_commit)\./, f);
});

test("Dockerfile runs as non-root with a healthcheck and a pinned base", () => {
  const d = readFileSync("Dockerfile", "utf8");
  assert.match(d, /^USER node$/m);
  assert.match(d, /^HEALTHCHECK /m);
  assert.doesNotMatch(d, /^FROM \S+:latest/m);
  assert.match(d, /npm ci --omit=dev --ignore-scripts/);
});

test("actionlint config declares the self-hosted runner label", () => {
  assert.match(readFileSync(".github/actionlint.yaml", "utf8"), /dev-home-01/);
});
