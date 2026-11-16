// CC-9 (#117): opt-in pre-flight worst-case estimate.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateWorstCase, preflightCheck, requestedOutputTokens, DEFAULT_MAX_OUTPUT } from "../src/preflight.js";
import { createCapEngine } from "../src/cap.js";
import { startMeteringProxy } from "../src/proxy.js";
import { parseWrapArgs } from "../src/cli.js";

const body = (o) => JSON.stringify(o);

test("estimator: OpenAI shape uses max_tokens and bytes/4", () => {
  const b = body({ model: "gpt-4o-mini", max_tokens: 1000, messages: [{ role: "user", content: "hi" }] });
  const e = estimateWorstCase("openai", b);
  assert.equal(e.ok, true);
  assert.equal(e.input_tokens, Math.ceil(Buffer.byteLength(b) / 4));
  assert.equal(e.output_tokens, 1000);
  assert.equal(e.estimate_usd, Number(((e.input_tokens * 0.15 + 1000 * 0.6) / 1e6).toFixed(6)));
  assert.equal(estimateWorstCase("openai", body({ model: "gpt-4o", max_completion_tokens: 7 })).output_tokens, 7);
});

test("estimator: Anthropic shape, and default when max_tokens absent", () => {
  assert.equal(estimateWorstCase("anthropic", body({ model: "claude-sonnet-4-6", max_tokens: 50 })).output_tokens, 50);
  const d = estimateWorstCase("anthropic", Buffer.from(body({ model: "claude-sonnet-4-6" })));
  assert.equal(d.output_tokens, DEFAULT_MAX_OUTPUT.anthropic);
  assert.equal(d.output_defaulted, true);
});

test("estimator: Gemini shape reads model from path and generationConfig.maxOutputTokens", () => {
  const e = estimateWorstCase("gemini", body({ generationConfig: { maxOutputTokens: 200 } }), "/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(e.model, "gemini-2.5-flash");
  assert.equal(e.output_tokens, 200);
  assert.equal(estimateWorstCase("gemini", body({}), "/v1beta/models/gemini-2.5-pro:generateContent").output_tokens, DEFAULT_MAX_OUTPUT.gemini);
});

test("estimator: OpenRouter shape, no max_tokens", () => {
  const e = estimateWorstCase("openrouter", body({ model: "google/gemini-2.5-flash" }));
  assert.equal(e.ok, true);
  assert.equal(e.output_tokens, DEFAULT_MAX_OUTPUT.openrouter);
});

test("estimator: unknown or missing model is unpriced, never $0", () => {
  assert.deepEqual(estimateWorstCase("openai", body({ model: "made-up-9" })), { ok: false, reason: "preflight_unpriced", model: "made-up-9" });
  assert.equal(estimateWorstCase("openai", "not json").model, "unknown");
  assert.equal(estimateWorstCase("openai", undefined).ok, false);
  assert.equal(requestedOutputTokens("other", {}).tokens, 65_536);
  assert.equal(requestedOutputTokens("openai", { max_tokens: -1 }).defaulted, true);
});

test("preflightCheck and cap.remaining", () => {
  const cap = createCapEngine({ caps: { day: 1 } });
  assert.deepEqual(cap.remaining(), { day: 1 });
  assert.equal(preflightCheck(cap, "openai", body({ model: "gpt-4o-mini", max_tokens: 10 })), null);
  const hit = preflightCheck(cap, "openai", body({ model: "gpt-4o", max_tokens: 1_000_000 }));
  assert.equal(hit.reason, "preflight_estimate");
  assert.equal(hit.scope, "day");
  assert.equal(preflightCheck(undefined, "openai", body({ model: "gpt-4o", max_tokens: 10 })), null);
  assert.equal(preflightCheck(cap, "openai", body({ model: "nope" })).reason, "preflight_unpriced");
});

async function harness({ preflight, caps = { day: 0.05 } }) {
  let hits = 0;
  const up = http.createServer((req, res) => { hits++; res.writeHead(200, { "content-type": "application/json" }).end(body({ model: "gpt-4o-mini", usage: { prompt_tokens: 100, completion_tokens: 100 } })); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "cc-pf-"));
  const receipts = join(dir, "r.jsonl");
  const cap = createCapEngine({ caps });
  const { server } = await startMeteringProxy({ receiptsPath: receipts, cap, preflight, upstreams: { openai: `http://127.0.0.1:${up.address().port}` } });
  const call = (b) => fetch(`http://127.0.0.1:${server.address().port}/openai/v1/chat/completions`, { method: "POST", body: b });
  const ledger = () => readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse);
  return { call, ledger, cap, hits: () => hits, close: () => { server.close(); up.close(); } };
}

const big = body({ model: "gpt-4o", max_tokens: 100_000 }); // worst case ≈ $1 > $0.05

test("preflight off: oversize call is forwarded exactly as before (regression)", async () => {
  const h = await harness({ preflight: false });
  const r = await h.call(big);
  assert.equal(r.status, 200);
  assert.equal(h.hits(), 1);
  const [rec] = h.ledger();
  assert.equal(rec.blocked, false);
  assert.equal("estimate" in rec, false);
  h.close();
});

test("preflight on: oversize call refused before upstream, receipt labelled estimate, spend excludes it", async () => {
  const h = await harness({ preflight: true });
  const r = await h.call(big);
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.equal(j.error.type, "budget_exceeded");
  assert.equal(j.error.reason, "preflight_estimate");
  assert.equal(j.error.estimate, true);
  assert.ok(j.error.estimate_usd > 0.05);
  assert.equal(j.error.remaining_usd.day, 0.05);
  assert.equal(h.hits(), 0);
  const [rec] = h.ledger();
  assert.equal(rec.blocked, true);
  assert.equal(rec.estimate, true);
  assert.equal(rec.scope, "day");
  assert.equal(rec.cost_usd, 0);
  assert.ok(rec.estimate_usd > 0.05);
  assert.equal(h.cap.spend().day, 0);
  h.close();
});

test("preflight on: a call that fits is forwarded and metered at real cost", async () => {
  const h = await harness({ preflight: true });
  const r = await h.call(body({ model: "gpt-4o-mini", max_tokens: 100 }));
  assert.equal(r.status, 200);
  assert.equal(h.hits(), 1);
  const [rec] = h.ledger();
  assert.equal(rec.cost_usd, Number(((100 * 0.15 + 100 * 0.6) / 1e6).toFixed(6)));
  assert.equal(h.cap.spend().day, rec.cost_usd);
  h.close();
});

test("preflight on: unpriced model refused as preflight_unpriced, never forwarded", async () => {
  const h = await harness({ preflight: true });
  const r = await h.call(body({ model: "mystery-model", max_tokens: 1 }));
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.type, "preflight_unpriced");
  assert.equal(h.hits(), 0);
  assert.equal(h.ledger()[0].reason, "preflight_unpriced");
  h.close();
});

test("parseWrapArgs reads --preflight", () => {
  assert.equal(parseWrapArgs(["--preflight", "--", "x"]).preflight, true);
  assert.equal(parseWrapArgs(["--", "x"]).preflight, undefined);
});

test("e2e: costcap wrap --preflight refuses an oversize call against a fake upstream", async (t) => {
  let hits = 0;
  const up = http.createServer((q, res) => { hits++; res.writeHead(200, { "content-type": "application/json" }).end(body({ model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => up.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-pf-e2e-"));
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const a = await fetch(u,{method:"POST",body:JSON.stringify({model:"gpt-4o",max_tokens:100000})});
    const b = await fetch(u,{method:"POST",body:JSON.stringify({model:"gpt-4o-mini",max_tokens:10})});
    console.log(a.status, b.status);`;
  for (const [args, env, expected, expectedHits] of [
    [["--preflight"], {}, "429 200", 1],
    [[], { COSTCAP_PREFLIGHT: "1" }, "429 200", 2],
    [[], {}, "200 200", 4],
  ]) {
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, ["src/cli.js", "wrap", "--day-cap", "0.05", ...args, "--receipts", join(dir, `r${expectedHits}.jsonl`), "--", process.execPath, "--input-type=module", "-e", script],
        { env: { ...process.env, COSTCAP_PREFLIGHT: "", ...env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.address().port}` } });
      let o = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", () => {});
      c.on("exit", () => resolve(o));
    });
    assert.equal(out.replace(/\x1b\[[0-9;]*m/g, "").trim(), expected);
    assert.equal(hits, expectedHits);
  }
});

// #128: completion-count output multiplier.
test("multiplier: OpenAI n multiplies output tokens and price", () => {
  const e = estimateWorstCase("openai", body({ model: "gpt-4o-mini", n: 4, max_tokens: 1000 }));
  assert.equal(e.output_tokens, 4000);
  assert.equal(e.output_multiplier, 4);
  assert.equal(e.estimate_usd, Number(((e.input_tokens * 0.15 + 4000 * 0.6) / 1e6).toFixed(6)));
});

test("multiplier: Gemini candidateCount in both casings", () => {
  for (const cfg of [{ generationConfig: { candidateCount: 3, maxOutputTokens: 500 } }, { generation_config: { candidate_count: 3, max_output_tokens: 500 } }]) {
    const e = estimateWorstCase("gemini", body(cfg), "/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal(e.ok, true);
    assert.equal(e.output_tokens, 1500);
    assert.equal(e.output_multiplier, 3);
  }
});

test("multiplier: legacy best_of wins over n", () => {
  const e = estimateWorstCase("openai", body({ model: "gpt-4o-mini", best_of: 5, n: 2, max_tokens: 10 }));
  assert.equal(e.output_multiplier, 5);
  assert.equal(e.output_tokens, 50);
});

test("multiplier: missing n is byte-identical to before; invalid n defaults to 1 and is flagged; absurd n is clamped", () => {
  const e = estimateWorstCase("openai", body({ model: "gpt-4o-mini", max_tokens: 1000 }));
  assert.equal(e.output_tokens, 1000);
  assert.equal(e.output_multiplier, 1);
  assert.equal("output_multiplier_defaulted" in e, false);
  assert.equal(e.estimate_usd, Number(((e.input_tokens * 0.15 + 1000 * 0.6) / 1e6).toFixed(6)));
  for (const n of [1.5, 0, -2, "4", null, true]) {
    const d = estimateWorstCase("openai", body({ model: "gpt-4o-mini", n, max_tokens: 10 }));
    assert.equal(d.output_multiplier, 1, `n=${n}`);
    assert.equal(d.output_multiplier_defaulted, n === null ? undefined : true, `n=${n}`);
  }
  const c = estimateWorstCase("openai", body({ model: "gpt-4o-mini", n: 1000, max_tokens: 10 }));
  assert.equal(c.output_multiplier, 128);
  assert.equal(c.output_multiplier_clamped, true);
  const g = estimateWorstCase("gemini", body({ generationConfig: { candidateCount: 50, maxOutputTokens: 10 } }), "/models/gemini-2.5-flash:x");
  assert.equal(g.output_multiplier, 8);
  assert.equal(estimateWorstCase("anthropic", body({ model: "claude-sonnet-4-5", n: 9, max_tokens: 10 })).output_multiplier ?? 1, 1);
});

test("proxy e2e: fits at n=1, refused at n=8 before upstream; allowed receipt records multiplied estimate", async () => {
  // gpt-4o output $10/M: 1000 tokens ≈ $0.01 fits $0.05; ×8 = 8000 ≈ $0.08 does not.
  const h = await harness({ preflight: true, caps: { day: 0.05 } });
  const one = await h.call(body({ model: "gpt-4o", max_tokens: 1000 }));
  assert.equal(one.status, 200);
  assert.equal(h.hits(), 1);
  const eight = await h.call(body({ model: "gpt-4o", max_tokens: 1000, n: 8 }));
  assert.equal(eight.status, 429);
  assert.equal((await eight.json()).error.reason, "preflight_estimate");
  assert.equal(h.hits(), 1);
  const two = await h.call(body({ model: "gpt-4o-mini", max_tokens: 100, n: 2 }));
  assert.equal(two.status, 200);
  const [a, b, c] = h.ledger();
  assert.equal(a.output_tokens_est, 1000);
  assert.equal(a.output_multiplier, 1);
  assert.equal(b.blocked, true);
  assert.equal(b.output_tokens_est, 8000);
  assert.equal(b.output_multiplier, 8);
  assert.equal(c.output_tokens_est, 200);
  assert.equal(c.output_multiplier, 2);
  h.close();
});

test("#145 preflight on OpenAI embeddings estimates input only; unpriced embeddings model is refused", () => {
  const b = body({ model: "text-embedding-3-small", input: "hello world" });
  const e = estimateWorstCase("openai", b, "/v1/embeddings");
  assert.equal(e.ok, true);
  assert.equal(e.output_tokens, 0);
  assert.equal(e.estimate_usd, Number((Math.ceil(Buffer.byteLength(b) / 4) * 0.02 / 1e6).toFixed(6)));
  assert.equal(preflightCheck({ remaining: () => ({ run: 0.001 }) }, "openai", b, "/v1/embeddings?x=1"), null);
  assert.equal(estimateWorstCase("openai", body({ model: "gpt-4o-mini" }), "/v1/chat/completions").output_tokens, DEFAULT_MAX_OUTPUT.openai);
  assert.equal(preflightCheck(null, "openai", body({ model: "text-embedding-foo" }), "/v1/embeddings").reason, "preflight_unpriced");
});

// #167: worst case is the max over OpenRouter fallback candidates.
test("estimator: OpenRouter models fallbacks budget at the priciest candidate", () => {
  const cheap = estimateWorstCase("openrouter", body({ model: "openai/gpt-4o-mini", max_tokens: 20_000 }));
  const both = estimateWorstCase("openrouter", body({ model: "openai/gpt-4o-mini", models: ["openai/gpt-4o"], max_tokens: 20_000 }));
  assert.equal(both.ok, true);
  assert.equal(both.model, "openai/gpt-4o");
  assert.deepEqual(both.candidate_models, ["openai/gpt-4o-mini", "openai/gpt-4o"]);
  assert.ok(both.estimate_usd > cheap.estimate_usd);
  assert.equal(estimateWorstCase("openrouter", body({ models: ["openai/gpt-4o-mini", "nope/x"] })).reason, "preflight_unpriced");
  assert.equal(estimateWorstCase("openrouter", body({ models: ["openai/gpt-4o-mini"] })).model, "openai/gpt-4o-mini");
  assert.equal(estimateWorstCase("openai", body({ model: "gpt-4o-mini", models: ["gpt-4o"] })).model, "gpt-4o-mini");
  const cap = createCapEngine({ caps: { day: 0.05 } });
  assert.equal(preflightCheck(cap, "openrouter", body({ model: "openai/gpt-4o-mini", max_tokens: 20_000 })), null);
  assert.equal(preflightCheck(cap, "openrouter", body({ model: "openai/gpt-4o-mini", models: ["openai/gpt-4o"], max_tokens: 20_000 })).reason, "preflight_estimate");
});

test("#186: estimateWorstCase with a user price resolver never reads the shipped table", async () => {
  const { estimateWorstCase } = await import("../src/preflight.js");
  const priceFor = (m) => (m === "llama" ? { model: m, input: 1, output: 1, fallback: false } : null);
  const ok = estimateWorstCase("u/groq", JSON.stringify({ model: "llama", max_tokens: 10 }), "/v1/chat/completions", priceFor);
  assert.equal(ok.ok, true);
  assert.equal(ok.cost_source, "user_prices");
  assert.equal(ok.table_sha256, undefined);
  assert.equal(estimateWorstCase("u/groq", JSON.stringify({ model: "gpt-4o" }), "/v1/chat/completions", priceFor).reason, "preflight_unpriced");
});
