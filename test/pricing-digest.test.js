// #122: offline-verifiable pricing table (digest, receipts pin table_sha256, costcap pricing).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, tableDigest, verifyTableDigest, auditReceipts, digestPathFor } from "../src/pricing-digest.js";
import { TABLE_SHA256, TABLE_VERSION, lookupPrice, costForUsage, tableIntegrity, loadPricingTable } from "../src/pricing.js";
import { pricingCommand } from "../src/pricing-cli.js";
import { run as digestScript } from "../scripts/pricing-digest.mjs";

const tablePath = fileURLToPath(new URL("../src/pricing-table.json", import.meta.url));
const table = JSON.parse(readFileSync(tablePath, "utf8"));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function tempTable(mutate) {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-price-"));
  const p = path.join(dir, "pricing-table.json");
  copyFileSync(tablePath, p);
  copyFileSync(digestPathFor(tablePath), digestPathFor(p));
  if (mutate) { const t = JSON.parse(readFileSync(p, "utf8")); mutate(t); writeFileSync(p, JSON.stringify(t, null, 2)); }
  return { dir, p };
}

test("canonicalisation sorts keys recursively and ignores whitespace", () => {
  assert.equal(canonicalize({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: "x" } }), '{"a":{"c":"x","d":[2,{"y":0,"z":1}]},"b":1}');
  assert.equal(tableDigest({ a: 1, b: 2 }), tableDigest(JSON.parse('{ "b": 2,\n  "a": 1 }')));
  assert.notEqual(tableDigest({ a: 1 }), tableDigest({ a: 1.5 }));
  assert.match(tableDigest(table), /^[0-9a-f]{64}$/);
});

test("CI guard: the committed digest equals a fresh recompute of the shipped table", () => {
  const recorded = JSON.parse(readFileSync(digestPathFor(tablePath), "utf8"));
  assert.equal(recorded.sha256, tableDigest(table));
  assert.equal(recorded.version, table.version);
  assert.equal(digestScript(["--check"]).code, 0);
  assert.equal(tableIntegrity().ok, true);
  assert.equal(TABLE_SHA256, recorded.sha256);
});

test("verifyTableDigest passes, and fails on edited rate, missing sidecar, or stale version", () => {
  const rec = { version: table.version, sha256: tableDigest(table) };
  assert.equal(verifyTableDigest(table, rec).ok, true);
  const edited = structuredClone(table); edited.models["gpt-4o"].input = 0.01;
  assert.equal(verifyTableDigest(edited, rec).reason, "digest_mismatch");
  assert.equal(verifyTableDigest(table, null).reason, "digest_missing");
  assert.equal(verifyTableDigest(table, { ...rec, version: "old" }).reason, "version_mismatch");
});

test("digest script: --check fails on a changed table; regenerate needs a version bump", () => {
  const { p } = tempTable((t) => { t.models["gpt-4o"].output = 1; });
  assert.equal(digestScript(["--check"], p).code, 1);
  const refused = digestScript([], p);
  assert.equal(refused.code, 1);
  assert.match(refused.message, /bump "version"/);
  const t = JSON.parse(readFileSync(p, "utf8")); t.version = "2099-01-01"; writeFileSync(p, JSON.stringify(t));
  assert.equal(digestScript([], p).code, 0);
  assert.equal(digestScript(["--check"], p).code, 0);
  assert.equal(digestScript([], p).message.includes("already up to date"), true);
});

test("every priced lookup carries table_sha256 equal to the verified digest", () => {
  assert.equal(lookupPrice("gpt-4o").table_sha256, TABLE_SHA256);
  const c = costForUsage("unknown-model", { input_tokens: 10 });
  assert.equal(c.table_sha256, TABLE_SHA256);
  assert.equal(c.table_version, TABLE_VERSION);
});

test("auditReceipts: matching, different (counted per digest), and pre-digest receipts as unknown", () => {
  const a = auditReceipts([
    { cost_usd: 1, table_version: "v", table_sha256: "aaa" },
    { cost_usd: 1, table_version: "v", table_sha256: "bbb" },
    { cost_usd: 1, table_version: "v", table_sha256: "bbb" },
    { cost_usd: 1, table_version: "old" },
    null,
    { type: "run_summary" },
  ], "aaa");
  assert.equal(a.total, 4);
  assert.equal(a.matching, 1);
  assert.equal(a.different, 2);
  assert.equal(a.unknown, 1);
  assert.deepEqual(a.by_digest, { bbb: 2 });
  assert.equal(a.ok, false);
  assert.equal(a.mismatched.find((m) => m.line === 4).status, "unknown");
  assert.equal(auditReceipts([{ cost_usd: 1, table_sha256: "aaa" }], "aaa").ok, true);
});

test("pricing verify exits 0 on the shipped table and 1 naming a tampered one", () => {
  const ok = spawnSync(process.execPath, [cli, "pricing", "verify"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, new RegExp(TABLE_SHA256));
  const { p } = tempTable((t) => { t.models["gpt-4o-mini"].input = 0.0001; });
  const bad = spawnSync(process.execPath, [cli, "pricing", "verify"], { encoding: "utf8", env: { ...process.env, COSTCAP_PRICING_TABLE: p } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /MISMATCH.*digest_mismatch/);
  assert.equal(pricingCommand(["verify"], { tablePath: p }).code, 1);
  assert.equal(loadPricingTable(p).verification.ok, false);
});

test("pricing verify --receipts lists different and unknown receipts with counts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rc-"));
  const file = path.join(dir, "r.jsonl");
  writeFileSync(file, [
    { cost_usd: 0.1, table_version: TABLE_VERSION, table_sha256: TABLE_SHA256 },
    { cost_usd: 0.1, table_version: "2026-01-01", table_sha256: "f".repeat(64) },
    { cost_usd: 0.1, table_version: "2025-12-01" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
  const r = pricingCommand(["verify", "--receipts", file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /3 priced, 1 matching, 1 different, 1 unknown/);
  assert.match(r.err, /line 3: unknown/);
  assert.match(r.err, new RegExp(`different digest ${"f".repeat(64)}: 1`));
  const j = JSON.parse(pricingCommand(["verify", "--receipts", file, "--json"]).out);
  assert.equal(j.ok, false);
  assert.equal(j.receipts.unknown, 1);
  writeFileSync(file, JSON.stringify({ cost_usd: 0.1, table_sha256: TABLE_SHA256 }) + "\n");
  assert.equal(pricingCommand(["verify", "--receipts", file]).code, 0);
});

test("pricing show prints rates, the fallback for unknown models, and the full table", () => {
  const known = pricingCommand(["show", "gpt-4o-mini"]);
  assert.match(known.out, /gpt-4o-mini: input \$0\.15, cached_input \$0\.075, cache_write n\/a, cache_write_1h n\/a, output \$0\.6/);
  const unk = pricingCommand(["show", "claude-x"]);
  assert.match(unk.out, /claude-x \(fallback/);
  assert.match(unk.out, new RegExp(`input \\$${table.fallback.input}`));
  const all = pricingCommand(["show"]);
  assert.match(all.out, /fallback \(fallback for unknown models\)/);
  assert.equal(pricingCommand(["bogus"]).code, 2);
  const viaCli = spawnSync(process.execPath, [cli, "pricing", "show", "claude-x"], { encoding: "utf8" });
  assert.equal(viaCli.status, 0);
  assert.match(viaCli.stdout, /fallback/);
});

test("lookups throw on a tampered table: never priced from", () => {
  const { p } = tempTable((t) => { t.fallback.input = 0; });
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { costForUsage } from ${JSON.stringify(new URL("../src/pricing.js", import.meta.url).href)}; try { costForUsage("x", {input_tokens:1}); console.log("priced"); } catch (e) { console.log("refused", e.message); }`],
    { encoding: "utf8", env: { ...process.env, COSTCAP_PRICING_TABLE: p } });
  assert.match(r.stdout, /^refused .*digest_mismatch/);
});

function fakeUpstream() {
  return new Promise((r) => {
    const s = http.createServer((q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 100, completion_tokens: 50 } })));
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
}

function runWrap(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, "wrap", ...args], { env: { ...process.env, ...env } });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => resolve({ code, out, err }));
  });
}

test("integration: a wrapped run against a fake upstream records table_sha256", async (t) => {
  const up = await fakeUpstream();
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-wrap-"));
  const receipts = path.join(dir, "r.jsonl");
  const script = `await fetch(process.env.OPENAI_BASE_URL + "/chat/completions",{method:"POST",body:"{}"});`;
  const res = await runWrap(["--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script], { COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` });
  assert.equal(res.code, 0, res.err);
  const priced = readFileSync(receipts, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.table_version);
  assert.equal(priced.length, 1);
  assert.equal(priced[0].table_sha256, TABLE_SHA256);
  assert.equal(pricingCommand(["verify", "--receipts", receipts]).code, 0);
});

test("regression: a tampered temp table makes the wrapper refuse to start", async () => {
  const { p, dir } = tempTable((t) => { t.models["gpt-4o-mini"].output = 0; });
  const marker = path.join(dir, "child-ran");
  const res = await runWrap(["--receipts", path.join(dir, "r.jsonl"), "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`], { COSTCAP_PRICING_TABLE: p });
  assert.equal(res.code, 2);
  assert.match(res.err, /pricing table .* failed verification \(digest_mismatch\)/);
  assert.throws(() => readFileSync(marker));
});

test("preflight estimates pin the verified table digest too", async () => {
  const { estimateWorstCase } = await import("../src/preflight.js");
  const e = estimateWorstCase("openai", JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 10 }), "/v1/chat/completions");
  assert.equal(e.ok, true);
  assert.equal(e.table_sha256, TABLE_SHA256);
});

test("#145 digest --check passes with embeddings rows and pricing show prints the embeddings rate", () => {
  const c = spawnSync(process.execPath, ["scripts/pricing-digest.mjs", "--check"], { encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  const s = spawnSync(process.execPath, ["src/cli.js", "pricing", "show", "text-embedding-3-small"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /text-embedding-3-small: input \$0\.02, .*output \$0/);
  assert.equal(TABLE_VERSION, "2026-11-16.29");
});

test("#155 table shape: premium fast / priority rate sets are complete and above standard", () => {
  const t = JSON.parse(readFileSync(new URL("../src/pricing-table.json", import.meta.url), "utf8"));
  const tiers = Object.entries(t.models).flatMap(([m, r]) => ["fast", "priority"].filter((k) => r[k]).map((k) => [m, r, r[k]]));
  assert.ok(tiers.length >= 4);
  for (const [m, std, p] of tiers) {
    for (const k of ["input", "cached_input", "output"]) { if (std.no_cache_rate && k === "cached_input") { assert.equal(p[k], undefined, m); continue; } assert.ok(Number.isFinite(p[k]) && p[k] > std[k], `${m} ${k}`); }
    for (const k of ["cache_write", "cache_write_1h"]) if (p[k] != null) assert.ok(p[k] > std[k], `${m} ${k}`);
  }
  assert.ok(t.sources.includes("https://platform.claude.com/docs/en/build-with-claude/fast-mode"));
});

test("#163: a table with modalities canonicalises, matches its digest, and a tampered modality rate fails verify", () => {
  const { table, verification } = loadPricingTable();
  assert.equal(verification.ok, true);
  assert.equal(table.models["gemini-2.5-flash"].modalities.audio.input, 1);
  const reordered = JSON.parse(JSON.stringify(table));
  reordered.models["gpt-image-1"] = { modalities: table.models["gpt-image-1"].modalities, ...table.models["gpt-image-1"] };
  assert.equal(tableDigest(reordered), verification.actual);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-163d-"));
  const tp = path.join(dir, "pricing-table.json");
  const tampered = JSON.parse(JSON.stringify(table));
  tampered.models["gemini-2.5-flash"].modalities.audio.input = 0.30;
  writeFileSync(tp, JSON.stringify(tampered));
  writeFileSync(digestPathFor(tp), JSON.stringify({ version: table.version, sha256: verification.actual }));
  const r = spawnSync(process.execPath, ["src/cli.js", "pricing", "verify"], { encoding: "utf8", env: { ...process.env, COSTCAP_PRICING_TABLE: tp } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MISMATCH/);
});

test("#188 the bumped table declares the regional endpoint premium with a source", () => {
  assert.equal(table.regional_endpoint.multiplier, 1.1);
  for (const m of table.regional_endpoint.models) assert.ok(Object.hasOwn(table.models, m), m);
  assert.ok(table.sources.some((s) => /Regional and multi-region endpoint pricing/.test(s)));
});

test("#194 pricing show lists gpt-realtime audio rates and snapshots resolve", () => {
  const s = spawnSync(process.execPath, ["src/cli.js", "pricing", "show", "gpt-realtime-2025-08-28"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /\(audio\): input \$32, cached_input \$0\.4, output \$64/);
  assert.match(s.stdout, /\(image\): input \$5, cached_input \$0\.5/);
});

test("#198 AC6: the committed digest covers audio unit rates; a tampered per_minute fails verification", () => {
  const t = JSON.parse(readFileSync(new URL("../src/pricing-table.json", import.meta.url), "utf8"));
  const recorded = JSON.parse(readFileSync(new URL("../src/pricing-table.sha256.json", import.meta.url), "utf8"));
  assert.equal(verifyTableDigest(t, recorded).ok, true);
  t.models["whisper-1"].per_minute = 0.0001;
  assert.deepEqual([verifyTableDigest(t, recorded).ok, verifyTableDigest(t, recorded).reason], [false, "digest_mismatch"]);
});

test("#230 the bumped table declares batch.gemini 0.5 with a source, and the digest covers it", () => {
  assert.equal(table.batch.gemini, 0.5);
  assert.ok(table.sources.some((s) => s.includes("ai.google.dev/gemini-api/docs/batch-mode")));
  assert.equal(JSON.parse(readFileSync(digestPathFor(tablePath), "utf8")).sha256, tableDigest(table));
  const { p } = tempTable((t) => { t.batch.gemini = 0.4; });
  assert.equal(verifyTableDigest(JSON.parse(readFileSync(p, "utf8")), JSON.parse(readFileSync(digestPathFor(p), "utf8"))).ok, false);
});

test("#276 pricing show gpt-realtime-2 prints the audio rates; digest --check passes", () => {
  const c = spawnSync(process.execPath, ["scripts/pricing-digest.mjs", "--check"], { encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  const s = spawnSync(process.execPath, ["src/cli.js", "pricing", "show", "gpt-realtime-2"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /audio/);
  assert.match(s.stdout, /\$64/);
});
