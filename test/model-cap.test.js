// #238: per-model spend caps (wrap/check --model-cap MODEL:SCOPE=USD, hosted modelCaps).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelCap, parseModelCaps, normalizeModel, createModelCaps, modelCapsError, mergeModelCapRules, modelBudgetExceededBody } from "../src/model-cap.js";
import { startMeteringProxy } from "../src/proxy.js";
import { createSettler } from "../src/settle.js";
import { createCapEngine } from "../src/cap.js";
import { createDowngrader } from "../src/downgrade.js";
import { parseWrapArgs } from "../src/cli.js";
import { checkOutputs, formatSummary } from "../src/github-output.js";
import { validatePolicy, resolvePolicy } from "../src/hosted/policy.js";

const T0 = Date.parse("2026-11-16T12:00:00Z");
const at = (ms) => () => new Date(ms);
const ago = (min, base = T0) => new Date(base - min * 60_000).toISOString();
const OPUS = "claude-opus-4-8";
const rule = (scope, cap, model = OPUS) => ({ model, scope, cap });

// 30k input ($5/M = $0.15) + 10k output ($25/M = $0.25) = $0.40 per Opus call.
async function upstream(t) {
  const up = { hits: [] };
  up.server = http.createServer((q, s) => {
    let raw = ""; q.on("data", (d) => (raw += d));
    q.on("end", () => {
      const b = JSON.parse(raw || "{}");
      up.hits.push(b);
      const model = b.model ?? b.models?.[0] ?? "unknown";
      s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model, usage: { prompt_tokens: 30_000, completion_tokens: 10_000, prompt_tokens_details: { cached_tokens: 0 } } }));
    });
  });
  await new Promise((res) => up.server.listen(0, "127.0.0.1", res));
  t.after(() => up.server.close());
  up.url = `http://127.0.0.1:${up.server.address().port}`;
  return up;
}
const call = (port, body, provider = "openai") => fetch(`http://127.0.0.1:${port}/${provider}/${provider === "openai" ? "" : "api/"}v1/chat/completions`.replace("/openai/v1", "/openai"), { method: "POST", body: JSON.stringify(typeof body === "string" ? { model: body, max_tokens: 100 } : body) });

test("parse: MODEL:SCOPE=USD split on the last colon; every invalid form names the rule (AC5)", () => {
  assert.deepEqual(parseModelCap("claude-opus-4-8:day=1"), { model: OPUS, scope: "day", cap: 1 });
  assert.deepEqual(parseModelCap("anthropic.claude-opus-4-8-v1:0:hour=2.5"), { model: "anthropic.claude-opus-4-8-v1:0", scope: "hour", cap: 2.5 });
  for (const bad of ["opus:run=1", ":day=1", "opus:day=0", "opus:day=-1", "opus:day=abc", "opus:day=", "x=y", "nocolon", "opus:day=Infinity", " bad:day=1"]) {
    assert.throws(() => parseModelCap(bad), (e) => e.code === "invalid_model_cap" && /MODEL:SCOPE=USD/.test(e.message), bad);
  }
  assert.throws(() => parseModelCaps(["opus:day=1", "opus:day=2"]), /duplicate --model-cap opus:day/);
  assert.throws(() => parseModelCaps([`${OPUS}:day=1`, `${OPUS}-20260101:day=2`]), /duplicate/);
  assert.equal(parseModelCaps(["opus:day=1", "opus:hour=2"]).length, 2);
  assert.equal(parseWrapArgs(["--model-cap", `${OPUS}:day=1`, "--model-cap", "claude-haiku-4-5:month=3", "--", "true"]).modelCaps.length, 2);
  assert.equal(parseWrapArgs(["--", "true"]).modelCaps, undefined);
});

test("wrap exits 2 before spawning on each invalid --model-cap (AC5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-modelcap-bad-"));
  const marker = join(dir, "spawned");
  for (const args of [["opus:run=1"], [":day=1"], ["opus:day=0"], ["opus:day=1", "opus:day=2"], ["x=y"]]) {
    const p = spawnSync(process.execPath, ["src/cli.js", "wrap", ...args.flatMap((a) => ["--model-cap", a]), "--receipts", join(dir, "r.jsonl"), "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)},"x")`], { encoding: "utf8" });
    assert.equal(p.status, 2, args.join(" "));
    assert.match(p.stderr, /--model-cap/);
  }
  assert.throws(() => readFileSync(marker));
});

test("normalize: snapshots, OpenRouter prefix, Bedrock and Vertex ids share one bucket; unknown ids are exact", () => {
  for (const id of [OPUS, `${OPUS}-20260101`, `anthropic/${OPUS}`, `anthropic.${OPUS}-v1:0`, `us.anthropic.${OPUS}-v1:0`, `${OPUS}@20260101`]) assert.equal(normalizeModel(id), OPUS, id);
  assert.equal(normalizeModel("my-local-model"), "my-local-model");
  assert.equal(normalizeModel("vendor/unknown-x"), "vendor/unknown-x");
  assert.equal(normalizeModel(""), null);
  assert.equal(normalizeModel(undefined), null);
});

test("engine: per-model day/month buckets, matching and UTC rollover (AC1)", () => {
  const history = [0.4, 0.4, 0.4].map((c, i) => ({ id: `o${i}`, ts: ago(i + 1), model: OPUS, cost_usd: c }))
    .concat([{ id: "h", ts: ago(1), model: "claude-haiku-4-5", cost_usd: 5 }, { id: "y", ts: "2026-11-15T23:59:00Z", model: OPUS, cost_usd: 9 }]);
  const mc = createModelCaps({ rules: [rule("day", 1)], history, now: at(T0) });
  assert.deepEqual(mc.check([OPUS]), { model: OPUS, rule_model: OPUS, scope: "day", spend_usd: 1.2, cap_usd: 1 });
  assert.equal(mc.check(["claude-haiku-4-5"]), null);
  assert.equal(mc.check([`${OPUS}-20260101`]).model, `${OPUS}-20260101`);
  assert.equal(mc.check([`anthropic/${OPUS}`]).spend_usd, 1.2);
  assert.equal(mc.check(["claude-haiku-4-5", `anthropic/${OPUS}`]).model, `anthropic/${OPUS}`);
  assert.deepEqual(mc.over(), [{ model: OPUS, scope: "day", spend_usd: 1.2, cap_usd: 1, verdict: "model_budget_exceeded" }]);
  assert.equal(createModelCaps({ rules: [rule("month", 10)], history, now: at(T0) }).check([OPUS]).spend_usd, 10.2);
  assert.equal(createModelCaps({ rules: [rule("day", 1)], history, now: at(Date.parse("2026-11-17T00:00:00Z")) }).check([OPUS]), null);
  assert.equal(createModelCaps({ rules: [rule("month", 1)], history, now: at(Date.parse("2026-12-01T00:00:00Z")) }).check([OPUS]), null);
  const rem = mc.remaining([OPUS, "claude-haiku-4-5"]);
  assert.deepEqual(rem, [{ model: OPUS, scope: "day", cap_usd: 1, remaining_usd: 0 }]);
  assert.deepEqual(createModelCaps().over(), []);
  mc.setRules([]);
  assert.equal(mc.check([OPUS]), null);
  mc.setRules([rule("day", 2)]);
  assert.equal(mc.check([OPUS]), null);
  assert.equal(mc.rules()[0].cap, 2);
});

test("engine: hour window and retry_after_s roll under a fixed clock (AC2)", () => {
  let now = T0;
  const mc = createModelCaps({ rules: [rule("hour", 1)], now: () => new Date(now) });
  mc.record({ id: "a", ts: ago(50), model: OPUS, cost_usd: 0.6 });
  mc.record({ id: "c", ts: ago(10), model: OPUS, cost_usd: 0.3 });
  mc.record({ id: "b", ts: ago(30), model: OPUS, cost_usd: 0.3 });
  const hit = mc.check([OPUS]);
  assert.equal(hit.spend_usd, 1.2);
  assert.equal(hit.retry_after_s, 600);
  now = T0 + 600_000;
  assert.equal(mc.check([OPUS]), null);
  now = T0 + 7_200_000;
  assert.deepEqual(mc.remaining([OPUS])[0].remaining_usd, 1);
});

test("engine: unknown cost refuses only that model; pending batch is a lower bound; settle once (AC3)", () => {
  const mc = createModelCaps({ rules: [rule("day", 1), rule("day", 5, "claude-haiku-4-5")], history: [{ id: "x", ts: ago(1), model: OPUS, cost_usd: 0.4 }], now: at(T0) });
  mc.record({ id: "u1", ts: ago(2), model: OPUS, cost_usd: null });
  mc.record({ id: "b1", ts: ago(2), model: "claude-haiku-4-5", cost_usd: null, reason: "batch_pending" });
  mc.record(null);
  mc.record({ id: "z", ts: ago(1), model: OPUS, cost_usd: "bad" });
  assert.equal(mc.check([OPUS]).verdict, "accounting_unavailable");
  assert.equal(mc.check(["claude-haiku-4-5"]), null);
  assert.equal(mc.check(["gpt-4o-mini"]), null);
  assert.equal(mc.settle("u1", 0.8), true);
  assert.equal(mc.settle("u1", 0.8), false);
  assert.equal(mc.settle("nope", 1), false);
  assert.equal(mc.settle("b1", -1), false);
  assert.equal(mc.settle("", 1), false);
  assert.equal(mc.check([OPUS]).spend_usd, 1.2);
  assert.equal(mc.settle("b1", 5), true);
  assert.equal(mc.check(["claude-haiku-4-5"]).spend_usd, 5);
});

test("settler: a live settlement reaches the model cap with no restart (AC3)", () => {
  const mc = createModelCaps({ rules: [rule("day", 1)], history: [{ id: "x", ts: new Date().toISOString(), model: OPUS, cost_usd: 0.4 }] });
  mc.record({ id: "n1", ts: new Date().toISOString(), model: OPUS, cost_usd: null });
  const cap = createCapEngine({ caps: {}, history: [] });
  const settle = createSettler({ cap: () => cap, agentBudgets: () => null, proxySettle: () => null, modelCaps: () => mc });
  assert.equal(settle({ receipt_id: "n1", cost_usd: 0.8 }), true);
  assert.equal(mc.check([OPUS]).spend_usd, 1.2);
});

test("proxy: fourth Opus call refused, Haiku and other models pass, snapshot and OpenRouter ids refused (AC1)", async (t) => {
  const up = await upstream(t);
  const receipts = [];
  const modelCaps = createModelCaps({ rules: [rule("day", 1)] });
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url, openrouter: up.url }, onReceipt: (x) => receipts.push(x), modelCaps });
  t.after(() => server.close());
  for (let i = 0; i < 3; i++) assert.equal((await call(port, OPUS)).status, 200);
  const refused = await call(port, OPUS);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), null);
  const body = await refused.json();
  assert.equal(body.error, "model_budget_exceeded");
  assert.deepEqual([body.model, body.scope, body.spend_usd, body.cap_usd], [OPUS, "day", 1.2, 1]);
  assert.equal(body.rule_model, undefined);
  assert.equal(up.hits.length, 3);
  assert.equal((await call(port, "claude-haiku-4-5")).status, 200);
  assert.equal((await call(port, `${OPUS}-20260101`)).status, 429);
  assert.equal((await call(port, `anthropic/${OPUS}`, "openrouter")).status, 429);
  const blocked = receipts.filter((x) => x.blocked);
  assert.equal(blocked.length, 3);
  assert.ok(blocked.every((x) => x.reason === "model_budget_exceeded" && x.cost_usd === 0));
  assert.equal(up.hits.length, 4);
});

test("proxy: OpenRouter fallback array names the capped model; preflight checks headroom (AC4)", async (t) => {
  const up = await upstream(t);
  const modelCaps = createModelCaps({ rules: [rule("day", 1)], history: [{ id: "x", ts: new Date().toISOString(), model: OPUS, cost_usd: 1 }] });
  const { server, port } = await startMeteringProxy({ upstreams: { openrouter: up.url }, modelCaps });
  t.after(() => server.close());
  const r = await call(port, { model: "openai/gpt-4o-mini", models: ["openai/gpt-4o-mini", `anthropic/${OPUS}`] }, "openrouter");
  assert.equal(r.status, 429);
  assert.equal((await r.json()).model, `anthropic/${OPUS}`);
  assert.equal(up.hits.length, 0);

  const mc2 = createModelCaps({ rules: [rule("day", 1)], history: [{ id: "y", ts: new Date().toISOString(), model: OPUS, cost_usd: 0.9 }] });
  const cap = createCapEngine({ caps: { day: 1000 }, history: [] });
  const { server: s2, port: p2 } = await startMeteringProxy({ upstreams: { openai: up.url }, modelCaps: mc2, cap, preflight: true });
  t.after(() => s2.close());
  const big = await call(p2, { model: OPUS, max_tokens: 100_000, messages: [{ role: "user", content: "hi" }] });
  assert.equal(big.status, 429);
  const b = await big.json();
  assert.equal(b.error, "model_budget_exceeded");
  assert.equal(b.reason, "preflight_estimate");
  assert.equal(b.remaining_usd, 0.1);
  const small = await call(p2, { model: OPUS, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  assert.equal(small.status, 200);
});

test("proxy: hour scope sends Retry-After; an unknown-cost Opus receipt blocks Opus only (AC2, AC3)", async (t) => {
  const up = await upstream(t);
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url }, modelCaps: createModelCaps({ rules: [rule("hour", 0.3)] }) });
  t.after(() => server.close());
  assert.equal((await call(port, OPUS)).status, 200);
  const res = await call(port, OPUS);
  assert.equal(res.status, 429);
  const b = await res.json();
  assert.ok(b.retry_after_s > 3500 && b.retry_after_s <= 3600);
  assert.equal(res.headers.get("retry-after"), String(b.retry_after_s));

  const mc = createModelCaps({ rules: [rule("day", 1)], history: [{ id: "n", ts: new Date().toISOString(), model: OPUS, cost_usd: null }] });
  const { server: s2, port: p2 } = await startMeteringProxy({ upstreams: { openai: up.url }, modelCaps: mc });
  t.after(() => s2.close());
  const u = await call(p2, OPUS);
  assert.equal(u.status, 429);
  assert.equal((await u.json()).error, "accounting_unavailable");
  assert.equal((await call(p2, "claude-haiku-4-5")).status, 200);
  mc.settle("n", 0.8);
  assert.equal((await call(p2, OPUS)).status, 200);
  assert.equal((await call(p2, OPUS)).status, 429);
});

test("proxy: a #207 downgrade counts against the model it is sent as (AC3)", async (t) => {
  const up = await upstream(t);
  const SONNET = "claude-sonnet-4-6";
  const mc = createModelCaps({ rules: [rule("day", 0.01, SONNET), rule("day", 100)], history: [{ id: "s", ts: new Date().toISOString(), model: SONNET, cost_usd: 0.02 }] });
  const downgrader = createDowngrader({ config: () => ({ at: 0.5, map: { [OPUS]: SONNET } }), usage: () => [{ scope: "day", label: "day", spent: 9, cap: 10, fraction: 0.9 }], lowerBound: () => false, runId: "r" });
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url }, modelCaps: mc, downgrader, onWarning: () => {} });
  t.after(() => server.close());
  const r = await call(port, OPUS);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).model, SONNET);
  assert.equal(up.hits.length, 0);
});

test("body: message text for refusals and preflight", () => {
  assert.match(modelBudgetExceededBody({ model: OPUS, scope: "day", spend_usd: 1.2, cap_usd: 1, rule_model: OPUS }).message, /reached its day cap of \$1/);
  assert.match(modelBudgetExceededBody({ reason: "preflight_estimate", model: OPUS, scope: "day", estimate_usd: 2, remaining_usd: 0.1 }).message, /preflight estimate/);
});

function ledgerFile(rows) {
  const dir = mkdtempSync(join(tmpdir(), "cc-modelcap-check-"));
  const p = join(dir, "r.jsonl");
  writeFileSync(p, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { dir, p };
}

test("check --model-cap: lists the over model, exits 1, GitHub output and summary (AC6)", () => {
  const now = new Date().toISOString();
  const { dir, p } = ledgerFile([0.4, 0.4, 0.4].map((c, i) => ({ id: `o${i}`, ts: now, model: OPUS, provider: "anthropic", cost_usd: c })).concat([{ id: "h", ts: now, model: "claude-haiku-4-5", provider: "anthropic", cost_usd: 3 }]));
  const out = join(dir, "out"), sum = join(dir, "sum");
  const res = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", p, "--model-cap", `${OPUS}:day=1`, "--github-output"], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum } });
  assert.equal(res.status, 1, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.deepEqual(j.model_caps, [{ model: OPUS, scope: "day", spend_usd: 1.2, cap_usd: 1, verdict: "model_budget_exceeded" }]);
  assert.equal(j.hit.reason, "model_budget_exceeded");
  assert.match(readFileSync(out, "utf8"), new RegExp(`model-caps<<.*\\n${OPUS}:day:1.2/1\\n`));
  assert.match(readFileSync(sum, "utf8"), new RegExp(`\\| model-caps \\| ${OPUS}:day:1.2/1 \\|`));
  const ok = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", p, "--model-cap", `${OPUS}:day=5`], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).model_caps, []);
  const both = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", p, "--tag-cap", "customer:day=1", "--model-cap", `${OPUS}:day=1`], { encoding: "utf8" });
  assert.equal(both.status, 1);
  assert.equal(JSON.parse(both.stdout).model_caps.length, 1);
  const outs = checkOutputs({ ok: true, model_caps: [] }, {});
  assert.equal(outs["model-caps"], "");
  assert.match(formatSummary(outs), /\| model-caps \| none \|/);
  assert.equal(checkOutputs({ ok: true }, {})["model-caps"], undefined);
});

test("hosted policy: modelCaps validation, merge (lower cap wins) and resolvePolicy pass-through (AC7)", () => {
  assert.equal(modelCapsError([{ model: OPUS, scope: "day", usd: 1 }]), null);
  for (const bad of [[], "x", [{ model: OPUS, scope: "run", usd: 1 }], [{ model: OPUS, scope: "day", usd: 0 }], [{ model: "", scope: "day", usd: 1 }], [{ model: OPUS, scope: "day", usd: 1, x: 1 }], [null], [{ model: OPUS, scope: "day", usd: 1 }, { model: `${OPUS}-20260101`, scope: "day", usd: 2 }], Array.from({ length: 21 }, (_, i) => ({ model: `m${i}`, scope: "day", usd: 1 }))]) {
    assert.ok(modelCapsError(bad), JSON.stringify(bad));
  }
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, modelCaps: [{ model: OPUS, scope: "day", usd: 1 }] }), []);
  // #268: hosted modelCaps accept week (fleet-enforced); the local --model-cap flag still does not.
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, modelCaps: [{ model: OPUS, scope: "week", usd: 1 }] }), []);
  assert.equal(validatePolicy({ version: 1, caps: {}, modelCaps: [{ model: OPUS, scope: "year", usd: 1 }] }).length, 1);
  assert.deepEqual(mergeModelCapRules([{ model: OPUS, scope: "day", usd: 1 }], [{ model: OPUS, scope: "day", cap: 2 }, { model: OPUS, scope: "hour", cap: 0.5 }]), [{ model: OPUS, scope: "day", cap: 1 }, { model: OPUS, scope: "hour", cap: 0.5 }]);
  assert.deepEqual(mergeModelCapRules([{ model: OPUS, scope: "day", usd: 3 }], [{ model: `anthropic/${OPUS}`, scope: "day", cap: 2 }]), [{ model: `anthropic/${OPUS}`, scope: "day", cap: 2 }]);
  assert.deepEqual(mergeModelCapRules(null, null), []);
  const p = resolvePolicy({ lastKnown: { version: 2, caps: {}, modelCaps: [{ model: OPUS, scope: "day", usd: 1 }] } });
  assert.deepEqual(p.modelCaps, [{ model: OPUS, scope: "day", usd: 1 }]);
  assert.equal(resolvePolicy({ lastKnown: { version: 2, caps: {} } }).modelCaps, undefined);
});

async function wrapRun(t, up, receipts, flags, models) {
  const script = `for (const m of ${JSON.stringify(models)}) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: m }) }); const b = await r.json(); console.log(JSON.stringify({ m, status: r.status, error: b.error?.type ?? b.error ?? null })); }`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...flags, "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: up.url } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, lines: out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) }));
  });
}

test("e2e: wrap --model-cap refuses Opus, keeps Haiku, and stays refused after a restart (AC1, AC2)", async (t) => {
  const up = await upstream(t);
  const receipts = join(mkdtempSync(join(tmpdir(), "cc-modelcap-wrap-")), "r.jsonl");
  const first = await wrapRun(t, up, receipts, ["--model-cap", `${OPUS}:day=1`], [OPUS, OPUS, OPUS, OPUS, "claude-haiku-4-5"]);
  assert.deepEqual(first.lines.map((l) => l.status), [200, 200, 200, 429, 200]);
  assert.equal(first.lines[3].error, "model_budget_exceeded");
  const second = await wrapRun(t, up, receipts, ["--model-cap", `${OPUS}:day=1`], [OPUS, "claude-haiku-4-5"]);
  assert.deepEqual(second.lines.map((l) => l.status), [429, 200]);
});

test("e2e: enrolled wrapper merges fleet modelCaps with local rules and enforces the cached rule offline (AC7)", async (t) => {
  const up = await upstream(t);
  const dir = mkdtempSync(join(tmpdir(), "cc-modelcap-fleet-"));
  const receipts = join(dir, "r.jsonl");
  const enrollment = join(dir, "enrollment.json");
  writeFileSync(enrollment, JSON.stringify({ url: "http://127.0.0.1:9", token: "t", agentId: "a1", policy: { version: 3, caps: {}, modelCaps: [{ model: OPUS, scope: "day", usd: 1 }] } }));
  const r = await wrapRun(t, up, receipts, ["--enrollment", enrollment, "--model-cap", `${OPUS}:day=2`], [OPUS, OPUS, OPUS, OPUS]);
  assert.deepEqual(r.lines.map((l) => l.status), [200, 200, 200, 429]);
});

// #241: OpenRouter's dotted ids (`anthropic/claude-opus-4.6`) and variant suffixes share the first-party bucket.
const OPUS46 = "claude-opus-4-6";
const orCall = (port, model, i) => call(port, { model, max_tokens: 100, messages: [{ role: "user", content: `distinct ${model} ${i}` }] }, "openrouter");

test("normalize: OpenRouter dotted ids, vendor prefixes and variant suffixes map to the priced first-party id (#241)", () => {
  assert.equal(normalizeModel("anthropic/claude-opus-4.6"), OPUS46);
  assert.equal(normalizeModel("anthropic/claude-opus-4-6"), OPUS46);
  assert.equal(normalizeModel("anthropic/claude-opus-4.6:thinking"), OPUS46);
  assert.equal(normalizeModel("claude-opus-4.6"), OPUS46);
  assert.equal(normalizeModel("openai/gpt-4o"), "gpt-4o");
  assert.equal(normalizeModel("openai/gpt-4o:online"), "gpt-4o");
  assert.equal(normalizeModel("google/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(normalizeModel("anthropic.claude-opus-4-8-v1:0"), OPUS);
  // No pricing row after normalization: exact match, unchanged (today's behaviour).
  assert.equal(normalizeModel("acme/mystery-1.2"), "acme/mystery-1.2");
  assert.equal(normalizeModel("mystery-1.2:thinking"), "mystery-1.2:thinking");
  assert.throws(() => parseModelCaps([`${OPUS46}:day=1`, "anthropic/claude-opus-4.6:day=2"]), /duplicate/);
});

test("proxy: 3rd dotted OpenRouter Opus call refused, dotted and hyphenated share one bucket (#241 AC1, AC2)", async (t) => {
  const up = await upstream(t);
  const modelCaps = createModelCaps({ rules: [rule("day", 1, OPUS46)] });
  const { server, port } = await startMeteringProxy({ upstreams: { openrouter: up.url }, modelCaps });
  t.after(() => server.close());
  for (let i = 0; i < 2; i++) assert.equal((await orCall(port, "anthropic/claude-opus-4.6", i)).status, 200);
  assert.deepEqual(modelCaps.remaining([OPUS46]).map((r) => r.remaining_usd), [0.2]);
  assert.equal((await orCall(port, "anthropic/claude-opus-4-6", 2)).status, 200);
  const r = await orCall(port, "anthropic/claude-opus-4.6", 3);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, "model_budget_exceeded");
  assert.equal((await orCall(port, "anthropic/claude-opus-4-6", 4)).status, 429);
  assert.equal((await orCall(port, "anthropic/claude-opus-4.6:thinking", 5)).status, 429);
  assert.equal(up.hits.length, 3);
  assert.ok(modelCaps.check(["anthropic/claude-opus-4.6"]));
});

test("proxy: a dotted-form rule caps first-party Opus on the /anthropic route (#241 AC3)", async (t) => {
  const up = { hits: 0 };
  up.server = http.createServer((q, s) => { q.resume(); q.on("end", () => { up.hits += 1; s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: OPUS46, usage: { input_tokens: 30_000, output_tokens: 10_000 } })); }); });
  await new Promise((res) => up.server.listen(0, "127.0.0.1", res));
  t.after(() => up.server.close());
  const modelCaps = createModelCaps({ rules: parseModelCaps(["anthropic/claude-opus-4.6:day=1"]) });
  const { server, port } = await startMeteringProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.server.address().port}` }, modelCaps });
  t.after(() => server.close());
  const msg = (i) => fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: OPUS46, max_tokens: 100, messages: [{ role: "user", content: `m${i}` }] }) });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await msg(i)).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
  assert.equal(up.hits, 3);
});

for (const [vendorId, ruleModel] of [["openai/gpt-4o", "gpt-4o"], ["google/gemini-2.5-pro", "gemini-2.5-pro"]]) {
  test(`proxy: ${vendorId} on OpenRouter is capped by a ${ruleModel} rule (#241 AC4)`, async (t) => {
    const up = await upstream(t);
    const modelCaps = createModelCaps({ rules: [rule("day", 0.01, ruleModel)] });
    const { server, port } = await startMeteringProxy({ upstreams: { openrouter: up.url }, modelCaps });
    t.after(() => server.close());
    assert.equal((await orCall(port, vendorId, 0)).status, 200);
    const r = await orCall(port, vendorId, 1);
    assert.equal(r.status, 429);
    assert.equal((await r.json()).model, vendorId);
    assert.equal(up.hits.length, 1);
  });
}

test("check --model-cap and hosted modelCaps agree on a dotted-id ledger (#241 AC6)", () => {
  const now = new Date().toISOString();
  const rows = [0.4, 0.4, 0.4].map((c, i) => ({ id: `d${i}`, ts: now, model: i ? "anthropic/claude-opus-4.6" : "anthropic/claude-opus-4.6:thinking", provider: "openrouter", cost_usd: c }));
  const { p } = ledgerFile(rows);
  const res = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", p, "--model-cap", `${OPUS46}:day=1`], { encoding: "utf8" });
  assert.equal(res.status, 1, res.stderr);
  const cli = JSON.parse(res.stdout).model_caps;
  assert.deepEqual(cli, [{ model: OPUS46, scope: "day", spend_usd: 1.2, cap_usd: 1, verdict: "model_budget_exceeded" }]);
  const hosted = [{ model: OPUS46, scope: "day", usd: 1 }];
  assert.equal(modelCapsError(hosted), null);
  const engine = createModelCaps({ rules: mergeModelCapRules(hosted, []), history: rows });
  assert.deepEqual(engine.over(), cli);
});

// #244: hosted day/month modelCaps enforced against the fleet snapshot plus unsynced local receipts.
import { cachedFleetModelVerdict, withFleetModelCaps, isFleetModelScope } from "../src/model-cap.js";

test("fleet model verdict: snapshot + pending over the cap refuses Opus only, fleet: true (#244 AC1)", () => {
  const rules = [{ model: OPUS, scope: "day", usd: 5 }, { model: OPUS, scope: "hour", usd: 1 }];
  const snap = { as_of: new Date(T0 - 60_000).toISOString(), models: { [OPUS]: { day: 3, month: 3, unknown: 0 } } };
  const pending = [{ id: "p1", ts: ago(5), model: OPUS, cost_usd: 2.1 }, { id: "p2", ts: ago(5), model: "claude-haiku-4-5", cost_usd: 9 }, { id: "p3", ts: ago(5), model: OPUS, cost_usd: 9, blocked: true }];
  assert.deepEqual(cachedFleetModelVerdict(rules, snap, ["claude-haiku-4-5", OPUS], pending, T0), { model: OPUS, rule_model: OPUS, scope: "day", spend_usd: 5.1, cap_usd: 5, fleet: true });
  assert.equal(cachedFleetModelVerdict(rules, snap, ["claude-haiku-4-5"], pending, T0), null);
  assert.equal(cachedFleetModelVerdict(rules, snap, [OPUS], pending.slice(1), T0), null); // $3 < $5
  assert.equal(cachedFleetModelVerdict([{ model: OPUS, scope: "hour", usd: 0.01 }], snap, [OPUS], pending, T0), null); // hour stays local
  assert.equal(cachedFleetModelVerdict([], snap, [OPUS], pending, T0), null);
  // A snapshot from an earlier day no longer counts toward the day cap, only the month.
  const old = { as_of: new Date(T0 - 2 * 86_400_000).toISOString(), models: { [OPUS]: { day: 4, month: 4, unknown: 0 } } };
  assert.equal(cachedFleetModelVerdict(rules, old, [OPUS], pending, T0), null);
  assert.equal(cachedFleetModelVerdict([{ model: OPUS, scope: "month", usd: 6 }], old, [OPUS], pending, T0).spend_usd, 6.1);
  assert.equal(isFleetModelScope("hour"), false);
  assert.equal(isFleetModelScope("month"), true);
});

test("fleet model verdict: unknown cost refuses that model only; OpenRouter dotted id shares the bucket (#244 AC2)", () => {
  const rules = [{ model: OPUS, scope: "day", usd: 5 }];
  const snap = { as_of: new Date(T0).toISOString(), models: { [OPUS]: { day: 1, month: 1, unknown: 1 } } };
  const unk = cachedFleetModelVerdict(rules, snap, ["anthropic/claude-opus-4.8"], [], T0);
  assert.equal(unk.verdict, "accounting_unavailable");
  assert.equal(unk.model, "anthropic/claude-opus-4.8");
  assert.equal(unk.fleet, true);
  assert.equal(cachedFleetModelVerdict(rules, snap, ["claude-haiku-4-5"], [], T0), null);
  // Settled (unknown 0): Opus is back; local dotted-id spend counts in the same bucket.
  const settled = { ...snap, models: { [OPUS]: { day: 1, month: 1, unknown: 0 } } };
  assert.equal(cachedFleetModelVerdict(rules, settled, [OPUS], [], T0), null);
  const hit = cachedFleetModelVerdict(rules, settled, [OPUS], [{ id: "or", ts: ago(1), model: "anthropic/claude-opus-4.8", provider: "openrouter", cost_usd: 4 }], T0);
  assert.equal(hit.spend_usd, 5);
  // A pending local unknown-cost receipt refuses too; a pending batch does not.
  assert.equal(cachedFleetModelVerdict(rules, settled, [OPUS], [{ id: "u", ts: ago(1), model: OPUS, cost_usd: null }], T0).verdict, "accounting_unavailable");
  assert.equal(cachedFleetModelVerdict(rules, settled, [OPUS], [{ id: "b", ts: ago(1), model: OPUS, cost_usd: null, batch_pending: true, reason: "batch_pending" }], T0)?.verdict ?? null, null);
  // No server snapshot: only the pending receipts count.
  assert.equal(cachedFleetModelVerdict(rules, null, [OPUS], [{ id: "l", ts: ago(1), model: OPUS, cost_usd: 5 }], T0).spend_usd, 5);
});

test("fleet model verdict: the day follows the org budget period, not UTC (#244 AC3)", () => {
  const la = { timezone: "America/Los_Angeles", monthStartDay: 1 };
  const now = Date.parse("2026-11-16T09:00:00Z"); // 01:00 Nov 16 in LA
  const rules = [{ model: OPUS, scope: "day", usd: 5 }];
  const pending = [{ id: "late", ts: "2026-11-16T07:00:00Z", model: OPUS, cost_usd: 6 }]; // 23:00 Nov 15 in LA
  assert.equal(cachedFleetModelVerdict(rules, null, [OPUS], pending, now, la), null);
  assert.equal(cachedFleetModelVerdict(rules, null, [OPUS], pending, now).spend_usd, 6); // UTC: same day
  // The cap resets at LA midnight (08:00 UTC), not UTC midnight.
  const before = Date.parse("2026-11-16T07:30:00Z");
  assert.equal(cachedFleetModelVerdict(rules, null, [OPUS], pending, before, la).spend_usd, 6);
});

test("withFleetModelCaps: local engine first, then the fleet check; other methods delegate", () => {
  const local = createModelCaps({ rules: [rule("day", 1)], history: [{ id: "x", ts: new Date().toISOString(), model: OPUS, cost_usd: 2 }] });
  const calls = [];
  const fleet = { modelCheck: (m) => { calls.push(m); return { fleet: true }; } };
  const w = withFleetModelCaps(local, fleet);
  assert.equal(w.check([OPUS]).scope, "day");
  assert.deepEqual(w.check(["claude-haiku-4-5"]), { fleet: true });
  assert.deepEqual(calls, [["claude-haiku-4-5"]]);
  w.setRules([]);
  assert.deepEqual(w.rules(), []);
  w.record({ id: "u", ts: new Date().toISOString(), model: OPUS, cost_usd: null });
  assert.equal(w.settle("u", 1), true);
  assert.deepEqual(w.remaining([OPUS]), []);
  assert.equal(w.preflight([OPUS], 1), null);
  assert.deepEqual(w.over(), []);
  const bare = withFleetModelCaps(null, fleet);
  assert.deepEqual(bare.rules(), []);
  assert.equal(bare.settle("u", 1), false);
  assert.deepEqual(bare.remaining([OPUS]), []);
  assert.equal(bare.preflight([OPUS], 1), null);
  assert.deepEqual(bare.over(), []);
  assert.deepEqual(bare.check([OPUS]), { fleet: true });
});
