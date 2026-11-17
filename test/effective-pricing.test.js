// #236: effective-dated prices. Gemini 4 Carbon/Argon double on 2026-12-01, 3.8/3.6 Flash on
// 2027-01-01, and gemini-2.5-pro / gemini-2.5-flash bill as 3.8 Flash / 3.5 Flash-Lite from 2026-12-01.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costForUsage, lookupPrice, isPricedModel, datedRow, validateSchedules, dayOf } from "../src/pricing.js";
import { tableDigest, verifyTableDigest } from "../src/pricing-digest.js";
import { costWithOverrides, effectivePrice } from "../src/price-overrides.js";
import { foldBatchResults } from "../src/batch.js";
import { preflightCheck, estimateBatch } from "../src/preflight.js";
import { createCapEngine } from "../src/cap.js";
import { pricingCommand } from "../src/pricing-cli.js";
import { startMeteringProxy } from "../src/proxy.js";
import { run as digestScript } from "../scripts/pricing-digest.mjs";

const M = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
// Below the 200K long-context threshold so gemini-2.5-pro prices at its standard row.
const PRO = { input_tokens: 100_000, output_tokens: 1_000_000 }; // Nov: 0.125 + 10 = 10.125; Dec (3.8 Flash): 0.075 + 3.75; Jan: 0.15 + 7.5
const cost = (m, u, at, o = {}) => costForUsage(m, u, { at, ...o });

test("AC1: Carbon / Argon double at 2026-12-01T00:00Z with rates_effective_from", () => {
  for (const m of ["gemini-4-carbon", "gemini-4-argon"]) {
    const nov = cost(m, M, "2026-11-30T23:59:59Z");
    const dec = cost(m, M, "2026-12-01T00:00:00Z");
    assert.equal(nov.cost_usd, 12);
    assert.equal(nov.fallback, false);
    assert.equal(nov.rates_effective_from, undefined);
    assert.equal(dec.cost_usd, 24);
    assert.equal(dec.rates_effective_from, "2026-12-01");
    assert.equal(dec.billed_as, undefined);
    assert.equal(cost(m, { cached_input_tokens: 1_000_000 }, "2026-12-01").cost_usd, 0.2);
  }
});

test("AC1: 3.8 Flash and 3.6 Flash double at 2027-01-01; Hydrogen and 3.5 Flash-Lite priced; refuse mode accepts all five", () => {
  for (const m of ["gemini-3.8-flash", "gemini-3.6-flash"]) {
    assert.equal(cost(m, M, "2026-12-31T23:59:59Z").cost_usd, 4.5);
    assert.equal(cost(m, M, "2027-01-01T00:00:00Z").cost_usd, 9);
  }
  assert.equal(cost("gemini-4-hydrogen", M, "2026-11-16").cost_usd, 9);
  assert.equal(cost("gemini-3.5-flash-lite", M, "2026-11-16").cost_usd, 2.8);
  for (const m of ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.6-flash", "gemini-3.5-flash-lite"]) {
    assert.equal(isPricedModel(m), true, m);
    assert.equal(cost(m, M, "2026-11-16").fallback, false, m);
  }
});

test("AC2: gemini-2.5-pro bills as 3.8 Flash from Dec 1, including 3.8 Flash's own Jan 1 change", () => {
  assert.equal(cost("gemini-2.5-pro", PRO, "2026-11-30T23:59:59Z").cost_usd, 10.125);
  const dec = cost("gemini-2.5-pro", PRO, "2026-12-01T00:00:00Z");
  assert.equal(dec.cost_usd, 3.825);
  assert.equal(dec.billed_as, "gemini-3.8-flash");
  assert.equal(dec.rates_effective_from, "2026-12-01");
  const jan = cost("gemini-2.5-pro", PRO, "2027-01-01T00:00:00Z");
  assert.equal(jan.cost_usd, 7.65);
  assert.equal(jan.rates_effective_from, "2027-01-01");
  // >200K prompt: long_context before the route, standard (no tier) after.
  const big = { input_tokens: 300_000, output_tokens: 1000 };
  const lc = cost("gemini-2.5-pro", big, "2026-11-30");
  assert.equal(lc.cost_usd, 0.765);
  assert.equal(lc.pricing_tier, "long_context");
  const routed = cost("gemini-2.5-pro", big, "2026-12-01");
  assert.equal(routed.cost_usd, 0.22875);
  assert.equal(routed.pricing_tier, "standard");
});

test("AC2: gemini-2.5-flash audio at $1.00 before Dec 1, $0.30 as 3.5 Flash-Lite after", () => {
  const audio = { input_tokens: 1_000_000, modality_tokens: { input: { audio: 1_000_000 } } };
  assert.equal(cost("gemini-2.5-flash", audio, "2026-11-30").cost_usd, 1);
  const dec = cost("gemini-2.5-flash", audio, "2026-12-01");
  assert.equal(dec.cost_usd, 0.3);
  assert.equal(dec.billed_as, "gemini-3.5-flash-lite");
});

test("AC2: Vertex (undated) keeps gemini-2.5-pro at its 2.5 rate after Dec 1", () => {
  assert.equal(cost("gemini-2.5-pro", PRO, "2026-12-01", { undated: true }).cost_usd, 10.125);
  const v = cost("gemini-2.5-pro", PRO, "2027-06-01", { undated: true });
  assert.equal(v.billed_as, undefined);
  assert.equal(v.rates_effective_from, undefined);
  assert.equal(lookupPrice("gemini-2.5-pro", "2027-06-01", { undated: true }).effective, undefined);
});

test("AC6: undated models add no receipt fields; lookups never leak the effective schedule", () => {
  const c = cost("gpt-4o-mini", M, "2027-06-01");
  assert.equal("rates_effective_from" in c, false);
  assert.equal("billed_as" in c, false);
  assert.equal(lookupPrice("gemini-4-carbon", "2026-11-16").effective, undefined);
  assert.equal(lookupPrice("made-up-9", "2026-12-01").fallback, true);
});

test("dayOf: default now, ms and ISO instants, invalid instant throws", () => {
  assert.match(dayOf(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dayOf(Date.parse("2026-12-01T00:00:00Z")), "2026-12-01");
  assert.equal(dayOf("2026-11-30T23:59:59.999Z"), "2026-11-30");
  assert.throws(() => dayOf("nope"), /invalid pricing instant/);
});

const base = () => ({ version: "t", models: { a: { input: 1, output: 2 }, b: { input: 3, output: 4 } }, fallback: { input: 9, output: 9 } });

test("validation: non-ISO, duplicate, unsorted, missing billed_as, cycle and empty entries are rejected", () => {
  assert.equal(validateSchedules(base()), null);
  const bad = [
    [{ a: { effective: [{ from: "2026-13-01", input: 2 }] } }, /not an ISO date/],
    [{ a: { effective: [{ from: "2026-12-01", input: 2 }, { from: "2026-12-01", input: 3 }] } }, /duplicate/],
    [{ a: { effective: [{ from: "2027-01-01", input: 2 }, { from: "2026-12-01", input: 3 }] } }, /ascending/],
    [{ a: { effective: [{ from: "2026-12-01", billed_as: "zzz" }] } }, /not a model/],
    [{ a: { effective: [{ from: "2026-12-01", billed_as: "b" }] }, b: { effective: [{ from: "2026-12-01", billed_as: "a" }] } }, /cycle/],
    [{ a: { effective: [{ from: "2026-12-01" }] } }, /neither rates nor billed_as/],
    [{ a: { effective: [] } }, /non-empty array/],
    [{ a: { effective: ["x"] } }, /must be objects/],
  ];
  for (const [patch, re] of bad) {
    const t = base();
    for (const [k, v] of Object.entries(patch)) t.models[k] = { ...t.models[k], ...v };
    assert.match(validateSchedules(t), re);
  }
  assert.equal(validateSchedules({}), null);
});

test("validation: an invalid schedule fails verify and the digest script even with a matching sidecar", () => {
  const t = base();
  t.models.a.effective = [{ from: "2027-01-01", input: 2 }, { from: "2026-12-01", input: 3 }];
  const v = verifyTableDigest(t, { version: "t", sha256: tableDigest(t) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /^schedule_invalid: .*ascending/);
  const dir = mkdtempSync(join(tmpdir(), "cc-236-"));
  const p = join(dir, "pricing-table.json");
  writeFileSync(p, JSON.stringify(t));
  writeFileSync(join(dir, "pricing-table.sha256.json"), JSON.stringify({ version: "t", sha256: tableDigest(t) }));
  for (const args of [[], ["--check"]]) {
    const r = digestScript(args, p);
    assert.equal(r.code, 1);
    assert.match(r.message, /schedule invalid/);
  }
  const cyc = base();
  cyc.models.a.effective = [{ from: "2026-12-01", billed_as: "b" }];
  cyc.models.b.effective = [{ from: "2026-12-01", billed_as: "a" }];
  writeFileSync(p, JSON.stringify(cyc));
  writeFileSync(join(dir, "pricing-table.sha256.json"), JSON.stringify({ version: "t", sha256: tableDigest(cyc) }));
  const r = pricingCommand(["verify"], { tablePath: p });
  assert.equal(r.code, 1);
  assert.match(r.err, /cycle/);
});

test("datedRow: rate entries inherit unlisted fields; a later rate entry stacks on a billed_as route", () => {
  const t = base();
  t.models.a.effective = [{ from: "2026-12-01", input: 5 }, { from: "2027-01-01", billed_as: "b" }, { from: "2027-02-01", output: 7 }];
  assert.deepEqual(datedRow(t, "a", "2026-12-15"), { row: { input: 5, output: 2 }, rates_effective_from: "2026-12-01", billed_as: null });
  assert.deepEqual(datedRow(t, "a", "2027-01-15"), { row: { input: 3, output: 4 }, rates_effective_from: "2027-01-01", billed_as: "b" });
  assert.deepEqual(datedRow(t, "a", "2027-02-15"), { row: { input: 3, output: 7 }, rates_effective_from: "2027-02-01", billed_as: "b" });
});

test("AC3: batch lines are priced at create and settle; the higher cost is kept", () => {
  const line = (model, p, o) => JSON.stringify({ response: { modelVersion: model, candidates: [{ content: { parts: [{ text: "x" }] } }],
    usageMetadata: { promptTokenCount: p, candidatesTokenCount: o, totalTokenCount: p + o } } });
  const at = { createdAt: "2026-11-30T12:00:00.000Z", settledAt: "2026-12-02T12:00:00.000Z" };
  const carbon = foldBatchResults("gemini", line("gemini-4-carbon", 1e6, 1e6), null, at);
  assert.equal(carbon.cost_usd, 12); // Dec $24 x 0.5 beats Nov $12 x 0.5
  const pro = foldBatchResults("gemini", line("gemini-2.5-pro", 100_000, 1e6), null, at);
  assert.equal(pro.cost_usd, 5.0625); // Nov $10.125 x 0.5 beats Dec (3.8 Flash) $3.825 x 0.5
  // Only one instant known: that one is used.
  assert.equal(foldBatchResults("gemini", line("gemini-4-carbon", 1e6, 1e6), null, { settledAt: "2026-11-30" }).cost_usd, 6);
  assert.equal(foldBatchResults("gemini", line("gemini-4-carbon", 1e6, 1e6), null, { createdAt: "2026-12-01" }).cost_usd, 12);
});

// ~1000 input tokens (4000 bytes) + maxOutputTokens 1000 on Carbon: $0.012 in Nov, $0.024 in Dec.
const carbonBody = () => {
  const shell = (s) => JSON.stringify({ contents: [{ parts: [{ text: s }] }], generationConfig: { maxOutputTokens: 1000 } });
  return shell("a".repeat(4000 - shell("").length));
};

test("AC4: preflight prices at the moment of the check", () => {
  const b = carbonBody();
  assert.equal(Buffer.byteLength(b), 4000);
  const path = "/v1beta/models/gemini-4-carbon:generateContent";
  const cap = () => createCapEngine({ caps: { day: 0.015 } });
  assert.equal(preflightCheck(cap(), "gemini", b, path, undefined, undefined, undefined, Date.parse("2026-11-30T12:00:00Z")), null);
  const refused = preflightCheck(cap(), "gemini", b, path, undefined, undefined, undefined, Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(refused.estimate_usd, 0.024);
  const batch = JSON.stringify({ batch: { input_config: { requests: { requests: [{ request: JSON.parse(b) }] } } } });
  const nov = estimateBatch("gemini", batch, undefined, "gemini-4-carbon", "2026-11-30");
  const dec = estimateBatch("gemini", batch, undefined, "gemini-4-carbon", "2026-12-01");
  assert.ok(dec.estimate_usd > nov.estimate_usd * 1.9, `${nov.estimate_usd} -> ${dec.estimate_usd}`);
});

test("AC4 e2e: the proxy refuses a Carbon call at Dec 1 rates before it is sent", async (t) => {
  let hits = 0;
  const up = http.createServer((req, res) => { req.resume(); req.on("end", () => { hits++; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })); }); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => { up.closeAllConnections(); up.close(); });
  for (const [at, status] of [["2026-11-30T12:00:00Z", 200], ["2026-12-01T00:00:00Z", 429]]) {
    const cap = createCapEngine({ caps: { day: 0.015 } });
    const p = await startMeteringProxy({ upstreams: { gemini: `http://127.0.0.1:${up.address().port}` }, cap, preflight: true, now: () => Date.parse(at) });
    const r = await fetch(`http://127.0.0.1:${p.port}/gemini/v1beta/models/gemini-4-carbon:generateContent`, { method: "POST", body: carbonBody() });
    assert.equal(r.status, status, at);
    await r.arrayBuffer();
    p.server.closeAllConnections(); p.server.close();
  }
  assert.equal(hits, 1);
});

test("AC3 e2e: a request received at 23:59:59 Nov 30 is priced at November rates though the response ends after midnight", async (t) => {
  const up = http.createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ modelVersion: "gemini-4-carbon", candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1e6, candidatesTokenCount: 1e6, totalTokenCount: 2e6 } }))); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receiptsPath = join(mkdtempSync(join(tmpdir(), "cc-236p-")), "r.jsonl");
  let calls = 0;
  const now = () => (calls++ === 0 ? Date.parse("2026-11-30T23:59:59Z") : Date.parse("2026-12-01T00:00:05Z"));
  const p = await startMeteringProxy({ upstreams: { gemini: `http://127.0.0.1:${up.address().port}` }, receiptsPath, now });
  t.after(() => { up.closeAllConnections(); up.close(); p.server.closeAllConnections(); p.server.close(); });
  const r = await fetch(`http://127.0.0.1:${p.port}/gemini/v1beta/models/gemini-4-carbon:generateContent`, { method: "POST", body: "{}" });
  assert.equal(r.status, 200);
  await r.arrayBuffer();
  const [rec] = readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rec.cost_usd, 12);
  assert.equal(rec.rates_effective_from, undefined);
  assert.ok(calls >= 2, "the clock moved past midnight before the receipt was written");
});

test("AC5: absolute overrides win at every date; a discount scales the dated rate", () => {
  const abs = { version: "p", sha256: "x".repeat(64), upstreams: { gemini: { "gemini-4-carbon": { input: 3, output: 9 } } } };
  for (const at of ["2026-11-30", "2026-12-01"]) assert.equal(costWithOverrides(abs, "gemini", "gemini-4-carbon", M, { at }).cost_usd, 12);
  const disc = { version: "p", sha256: "y".repeat(64), upstreams: { gemini: { "gemini-4-carbon": { discount: 0.1 } } } };
  assert.equal(costWithOverrides(disc, "gemini", "gemini-4-carbon", M, { at: "2026-11-30" }).cost_usd, 10.8);
  assert.equal(costWithOverrides(disc, "gemini", "gemini-4-carbon", M, { at: "2026-12-01" }).cost_usd, 21.6);
  assert.equal(effectivePrice(disc, "gemini", "gemini-4-carbon", "2026-12-01").input, 3.6);
  assert.equal(effectivePrice(null, "gemini", "gemini-4-carbon", "2026-12-01").input, 4);
});

test("AC5: pricing show lists scheduled changes and --at prints the row in effect", () => {
  const show = pricingCommand(["show", "gemini-4-carbon", "--at", "2026-11-16"]);
  assert.equal(show.code, 0);
  assert.match(show.out, /gemini-4-carbon: input \$2, cached_input \$0\.1, .*output \$10/);
  assert.match(show.out, /from 2026-12-01: input \$4, cached_input \$0\.2, .*output \$20/);
  const routed = pricingCommand(["show", "gemini-2.5-pro", "--at", "2027-01-01"]);
  assert.match(routed.out, /gemini-2\.5-pro \(billed as gemini-3\.8-flash\): input \$1\.5, cached_input \$0\.15, .*output \$7\.5/);
  assert.match(routed.out, /rates effective from 2027-01-01/);
  assert.match(pricingCommand(["show", "gemini-2.5-pro", "--at", "2026-11-16"]).out, /from 2026-12-01: billed as gemini-3\.8-flash/);
  assert.equal(pricingCommand(["show", "gemini-4-carbon", "--at", "Dec 1"]).code, 2);
  assert.equal(pricingCommand(["show", "gemini-4-carbon", "--at", "2026-02-31"]).code, 0); // Date rolls over; still a valid day string
  assert.equal(pricingCommand(["show", "gemini-4-carbon", "--at", "2026-99-99"]).code, 2);
  assert.match(pricingCommand(["show", "made-up-9", "--at", "2026-12-01"]).out, /fallback/);
});

test("#257 cache_storage is a dated component: billed_as rows inherit it, 3.8 Flash doubles on 2027-01-01", async () => {
  const { cacheStorageCost } = await import("../src/pricing.js");
  assert.equal(lookupPrice("gemini-2.5-pro", "2026-11-30").cache_storage, 4.5);
  assert.equal(lookupPrice("gemini-2.5-pro", "2026-12-02").cache_storage, 0.5);
  assert.equal(lookupPrice("gemini-2.5-flash", "2026-12-02").cache_storage, 1);
  assert.equal(lookupPrice("gemini-3.8-flash", "2027-01-01").cache_storage, 1);
  assert.equal(lookupPrice("gemini-3.6-flash", "2026-12-31").cache_storage, 0.5);
  assert.equal(lookupPrice("gemini-4-carbon", "2026-12-02").cache_storage, undefined);
  assert.equal(cacheStorageCost("gemini-2.5-pro", 100000, "2026-11-30T12:00:00Z", "2026-11-30T14:00:00Z").cost_usd, 0.9);
  assert.equal(cacheStorageCost("gemini-2.5-pro", 100000, "2026-12-02T12:00:00Z", "2026-12-02T14:00:00Z").cost_usd, 0.1);
  assert.equal(cacheStorageCost("gemini-3.8-flash", 1000000, "2026-12-31T23:00:00Z", "2027-01-01T01:00:00Z").cost_usd, 1.5);
  assert.equal(validateSchedules(JSON.parse(readFileSync(new URL("../src/pricing-table.json", import.meta.url), "utf8"))), null);
});

test("#270: dated Gemini TTS rows switch on 2027-01-01 (standard and priority)", () => {
  const U = { input_tokens: 1_000_000, output_tokens: 1_000_000, cached_input_tokens: 0, modality_tokens: { output: { text: 0, audio: 1_000_000 } } };
  assert.equal(costForUsage("gemini-3.8-flash-tts", U, { at: "2026-12-31T23:59:59Z" }).cost_usd, 9.5);
  assert.equal(costForUsage("gemini-3.8-flash-tts", U, { at: "2027-01-01T00:00:00Z" }).cost_usd, 19);
  assert.equal(costForUsage("gemini-3.8-flash-lite-tts", { ...U, service_tier: "priority" }, { at: "2027-01-01T00:00:00Z" }).cost_usd, 23.4);
  assert.equal(lookupPrice("gemini-2.5-pro-preview-tts", "2027-06-01T00:00:00Z").rates_effective_from, undefined);
});
