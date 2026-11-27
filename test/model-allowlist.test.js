// Issue #153: per-agent model allowlist and --unknown-models refuse.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAgentPolicy, budgetRemaining, createAgentBudgets, intersectModels, isModelList } from "../src/agent-budget.js";
import { resolvePolicy, validatePolicy } from "../src/hosted/policy.js";
import { isPricedModel } from "../src/pricing.js";
import { startMeteringProxy } from "../src/proxy.js";
import { parseWrapArgs } from "../src/cli.js";
import { guardedAgentStatus, guardedBudgetStatus } from "../src/check.js";
import { handleMcp } from "../src/mcp.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("isModelList / intersectModels", () => {
  assert.equal(isModelList(["gpt-4o-mini"]), true);
  for (const bad of [[], [""], [" a"], [1], "gpt-4o", null, {}]) assert.equal(isModelList(bad), false, JSON.stringify(bad));
  assert.equal(intersectModels(), null);
  assert.equal(intersectModels(null, undefined), null);
  assert.deepEqual(intersectModels(["a", "b", "a"]), ["a", "b"]);
  assert.deepEqual(intersectModels(["a", "b"], null, ["b", "c"]), ["b"]);
  assert.deepEqual(intersectModels(["a"], ["c"]), []);
});

test("agent policy models: validation and agent ∩ team ∩ default", () => {
  assertAgentPolicy({ default: { models: ["gpt-4o-mini"] }, agents: { a: { models: ["gpt-4o"] } }, teams: { t: { agents: ["a"], models: ["gpt-4o"] } } });
  for (const models of [[], [""], "gpt-4o", [3]]) {
    assert.throws(() => assertAgentPolicy({ default: { models } }), /Invalid default models/);
    assert.throws(() => assertAgentPolicy({ agents: { bot: { models } } }), /Invalid bot models/);
    assert.throws(() => assertAgentPolicy({ teams: { t: { agents: ["x"], models } } }), /Invalid team t models/);
  }
  assert.throws(() => assertAgentPolicy({ default: { model: ["x"] } }), /Unknown limit model/);
  const b = createAgentBudgets({ policy: {
    default: { run: 5, models: ["gpt-4o-mini", "gpt-4o", "claude-haiku-4-5"] },
    agents: { a: { run: 5, models: ["gpt-4o", "gpt-4o-mini"] }, solo: { run: 1, models: ["o3"] }, free: { run: 1 } },
    teams: { t: { agents: ["a", "solo"], models: ["gpt-4o-mini", "o3"] } },
  } });
  assert.deepEqual(b.modelsFor("a"), ["gpt-4o-mini"]);
  assert.deepEqual(b.modelsFor("solo"), []); // o3 is not in default: empty intersection
  assert.deepEqual(b.modelsFor("free"), ["gpt-4o-mini", "gpt-4o", "claude-haiku-4-5"]);
  assert.deepEqual(b.modelsFor("nobody"), ["gpt-4o-mini", "gpt-4o", "claude-haiku-4-5"]);
  assert.deepEqual(budgetRemaining(b, { agent_id: "a", run_id: null }).models, ["gpt-4o-mini"]);
  const open = createAgentBudgets({ policy: { default: { run: 1 } } });
  assert.equal(open.modelsFor("x"), null);
  assert.equal("models" in budgetRemaining(open, { agent_id: "x", run_id: null }), false);
});

test("hosted policy models: validation and local ∩ server resolution", () => {
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, models: ["gpt-4o-mini"] }), []);
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, models: null }), []);
  for (const models of [[], [""], "x", [1]]) assert.deepEqual(validatePolicy({ version: 1, caps: {}, models }), ["models must be a non-empty array of model ids"]);
  assert.equal(resolvePolicy({}).models, null);
  assert.deepEqual(resolvePolicy({ local: { models: ["a", "b"] } }).models, ["a", "b"]);
  assert.deepEqual(resolvePolicy({ local: { models: ["a", "b"] }, lastKnown: { version: 1, caps: {}, models: ["b", "c"] } }).models, ["b"]);
  assert.deepEqual(resolvePolicy({ local: { models: ["a"] }, lastKnown: { version: 1, caps: {}, models: ["c"] } }).models, []);
  assert.throws(() => resolvePolicy({ local: { models: [] } }), /Invalid local models/);
  assert.throws(() => resolvePolicy({ lastKnown: { version: 1, caps: {}, models: [] } }), /Invalid cached fleet policy/);
});

test("--unknown-models: priced vs unpriced models", () => {
  assert.equal(isPricedModel("gpt-4o-mini"), true);
  assert.equal(isPricedModel("gpt-4o-mini-2024-07-18"), true);
  assert.equal(isPricedModel("totally-new-pro-model"), false);
  assert.equal(isPricedModel(undefined), false);
  assert.equal(isPricedModel(""), false);
});

test("parseWrapArgs --models / --unknown-models", () => {
  const o = parseWrapArgs(["--models", "gpt-4o-mini, claude-haiku-4-5,gpt-4o-mini", "--unknown-models", "refuse", "--", "x"]);
  assert.deepEqual(o.models, ["gpt-4o-mini", "claude-haiku-4-5"]);
  assert.equal(o.unknownModels, "refuse");
  assert.equal(parseWrapArgs(["--", "x"]).models, undefined);
  assert.throws(() => parseWrapArgs(["--models", " , ", "--", "x"]), /--models needs at least one model id/);
  assert.throws(() => parseWrapArgs(["--unknown-models", "allow", "--", "x"]), /--unknown-models must be refuse or fallback/);
});

async function proxyFixture(t, opts) {
  const seen = [];
  const up = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      seen.push({ url: req.url, body: text });
      if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [] })); return; }
      if (req.url.startsWith("/v1/messages")) return res.end(JSON.stringify({ model: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 1 } }));
      if (req.url.includes(":generateContent")) return res.end(JSON.stringify({ modelVersion: "gemini-2.5-flash", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } }));
      res.end(JSON.stringify({ model: JSON.parse(text).model, usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    });
  });
  const upPort = await listen(up);
  const u = `http://127.0.0.1:${upPort}`;
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: u, anthropic: u, gemini: u, openrouter: u }, onReceipt: (r) => receipts.push(r), ...opts });
  t.after(() => { server.close(); up.close(); });
  const call = async (path, body, method = "POST") => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { seen, receipts, call };
}

test("proxy refuses a disallowed model before forwarding, per provider, without freezing", async (t) => {
  const f = await proxyFixture(t, { allowedModels: () => ["gpt-4o-mini", "claude-haiku-4-5", "gemini-2.5-flash"] });
  let r = await f.call("/openai/v1/chat/completions", { model: "gpt-4o", messages: [] });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "model_not_allowed");
  assert.equal(r.body.model, "gpt-4o");
  assert.equal(f.seen.length, 0);
  assert.deepEqual({ ...f.receipts[0], id: 0, ts: 0 }, { id: 0, ts: 0, provider: "openai", path: "/v1/chat/completions", blocked: true, reason: "model_not_allowed", outcome: "blocked_model", model: "gpt-4o", cost_usd: 0 });
  // Streaming request: refused the same way, no upstream byte.
  r = await f.call("/openrouter/v1/chat/completions", { model: "openai/gpt-4o", stream: true });
  assert.equal(r.status, 403);
  assert.equal(f.seen.length, 0);
  // Anthropic body model and Gemini path model.
  assert.equal((await f.call("/anthropic/v1/messages", { model: "claude-opus-4-1" })).status, 403);
  assert.equal((await f.call("/gemini/v1beta/models/gemini-2.5-pro:generateContent", { contents: [] })).body.model, "gemini-2.5-pro");
  assert.equal(f.seen.length, 0);
  // Model unknown from the request: refused when an allowlist is set.
  r = await f.call("/openai/v1/chat/completions", "not json");
  assert.equal(r.status, 403);
  assert.equal(r.body.model, null);
  assert.equal(f.receipts.at(-1).model, "unknown");
  // Not frozen: allowed calls still succeed on every provider.
  assert.equal((await f.call("/openai/v1/chat/completions", { model: "gpt-4o-mini" })).status, 200);
  assert.equal((await f.call("/anthropic/v1/messages", { model: "claude-haiku-4-5" })).status, 200);
  assert.equal((await f.call("/gemini/v1beta/models/gemini-2.5-flash:generateContent", { contents: [] })).status, 200);
  // Metadata reads carry no model and are not refused.
  assert.equal((await f.call("/openai/v1/models", undefined, "GET")).status, 200);
  assert.equal(f.seen.length, 4);
  assert.equal(f.receipts.filter((x) => x.outcome === "blocked_model").length, 5);
});

test("proxy: empty allowlist intersection refuses every model with a clear message", async (t) => {
  const f = await proxyFixture(t, { allowedModels: () => [] });
  const r = await f.call("/openai/v1/chat/completions", { model: "gpt-4o-mini" });
  assert.equal(r.status, 403);
  assert.match(r.body.message, /do not overlap/);
  assert.equal(f.seen.length, 0);
});

test("proxy: --unknown-models refuse blocks unpriced models; default keeps fallback pricing", async (t) => {
  const f = await proxyFixture(t, { unknownModels: "refuse" });
  const r = await f.call("/openai/v1/chat/completions", { model: "secret-pro-model" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "model_unpriced");
  assert.equal(f.receipts[0].reason, "model_unpriced");
  assert.equal(f.receipts[0].outcome, "blocked_model");
  assert.equal(f.seen.length, 0);
  assert.equal((await f.call("/openai/v1/chat/completions", { model: "gpt-4o-mini-2024-07-18" })).status, 200);
  const g = await proxyFixture(t, {});
  assert.equal((await g.call("/openai/v1/chat/completions", { model: "secret-pro-model" })).status, 200);
  assert.equal(g.receipts[0].fallback, true);
});

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], { env: { ...process.env, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out: out.trim(), err }));
  });
}

const script = `for (const m of ["gpt-4o-mini", "gpt-4o", "gpt-4o-mini"]) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: m, stream: false }) }); const b = await r.json(); console.log(r.status + " " + (b.error ?? "ok")); }`;

test("e2e: costcap wrap --models against a fake upstream, then check shows the blocked row", async (t) => {
  const seen = [];
  const up = http.createServer((req, res) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => { seen.push(JSON.parse(s).model); res.end(JSON.stringify({ model: JSON.parse(s).model, usage: { prompt_tokens: 10, completion_tokens: 1 } })); }); });
  const upPort = await listen(up);
  t.after(() => up.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-models-"));
  const receipts = join(dir, "r.jsonl");
  const r = await runCli(["wrap", "--models", "gpt-4o-mini", "--receipts", receipts, "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script], { COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}` });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.split("\n"), ["200 ok", "403 model_not_allowed", "200 ok"]);
  assert.deepEqual(seen, ["gpt-4o-mini", "gpt-4o-mini"]);
  const rows = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.id);
  const blocked = rows.filter((x) => x.outcome === "blocked_model");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].cost_usd, 0);
  assert.equal(blocked[0].model, "gpt-4o");
  const c = await runCli(["check", "--models", "gpt-4o-mini", "--receipts", receipts]);
  assert.equal(c.code, 0, c.err);
  const status = JSON.parse(c.out);
  assert.equal(status.blocked_model_count, 1);
  assert.deepEqual(status.allowed_models, ["gpt-4o-mini"]);
  const csv = await runCli(["receipts", "--receipts", receipts, "--export", "csv"]);
  assert.match(csv.out, /gpt-4o,.*model_not_allowed.*blocked_model/);
});

test("e2e: enrolled wrapper enforces the synced hosted models offline, intersected with --models and agent policy", async (t) => {
  const seen = [];
  const up = http.createServer((req, res) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => { seen.push(JSON.parse(s).model); res.end(JSON.stringify({ model: JSON.parse(s).model, usage: { prompt_tokens: 10, completion_tokens: 1 } })); }); });
  const upPort = await listen(up);
  t.after(() => up.close());
  const dead = http.createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => dead.close(r));
  const dir = mkdtempSync(join(tmpdir(), "cc-models-fleet-"));
  const enrollment = join(dir, "enrollment.json");
  const receipts = join(dir, "r.jsonl");
  writeFileSync(enrollment, JSON.stringify({ url: `http://127.0.0.1:${deadPort}`, token: "agent-token", agentId: "agent-1",
    policy: { version: 3, caps: {}, killed: false, models: ["gpt-4o-mini", "gpt-4o"] }, syncedIds: [] }), { mode: 0o600 });
  const wrap = (extra) => runCli(["wrap", ...extra, "--enrollment", enrollment, "--receipts", receipts, "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script], { COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}` });
  let r = await wrap([]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /fleet offline; cached policy enforced/);
  assert.deepEqual(r.out.split("\n"), ["200 ok", "200 ok", "200 ok"]);
  // Local --models cannot loosen: gpt-4.1 is not in the fleet list, so only gpt-4o-mini survives.
  r = await wrap(["--models", "gpt-4o-mini,gpt-4.1"]);
  assert.deepEqual(r.out.split("\n"), ["200 ok", "403 model_not_allowed", "200 ok"]);
  // Agent policy file intersects too; disjoint lists refuse everything.
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({ default: { run: 5, models: ["o3"] } }));
  r = await wrap(["--policy", policy, "--agent", "bot"]);
  assert.deepEqual(r.out.split("\n"), ["403 model_not_allowed", "403 model_not_allowed", "403 model_not_allowed"]);
  // Read-only self checks report the effective allowlist.
  assert.deepEqual(guardedBudgetStatus({ receiptsPath: receipts, enrollmentPath: enrollment, models: ["gpt-4o", "x"] }).allowed_models, ["gpt-4o"]);
  const agent = guardedAgentStatus({ receiptsPath: receipts, enrollmentPath: enrollment, policy: { default: { run: 5, models: ["gpt-4o-mini"] } }, agent_id: "bot" });
  assert.deepEqual(agent.allowed_models, ["gpt-4o-mini"]);
  const mcp = handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_budget_status", arguments: { agent_id: "bot" } } },
    { receiptsPath: receipts, policy: { default: { run: 5, models: ["gpt-4o"] } } });
  assert.deepEqual(JSON.parse(mcp.result.content[0].text).allowed_models, ["gpt-4o"]);
});

// #167: OpenRouter `models` fallback array cannot bypass the allowlist.
test("proxy: OpenRouter models fallbacks are each checked against the allowlist", async (t) => {
  const f = await proxyFixture(t, { allowedModels: () => ["openai/gpt-4o-mini", "google/gemini-2.5-flash"] });
  const p = "/openrouter/v1/chat/completions";
  let r = await f.call(p, { model: "openai/gpt-4o-mini", models: ["openai/gpt-4o-mini", "anthropic/claude-opus-4"] });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "model_not_allowed");
  assert.equal(r.body.model, "anthropic/claude-opus-4");
  assert.equal(f.seen.length, 0);
  assert.equal(f.receipts.at(-1).outcome, "blocked_model");
  assert.equal(f.receipts.at(-1).cost_usd, 0);
  // models without model: every entry checked.
  r = await f.call(p, { models: ["google/gemini-2.5-flash", "openai/gpt-4o"] });
  assert.equal(r.status, 403);
  assert.equal(r.body.model, "openai/gpt-4o");
  // openrouter/auto is refused unless itself allowlisted.
  r = await f.call(p, { model: "openrouter/auto" });
  assert.equal(r.status, 403);
  assert.equal(r.body.model, "openrouter/auto");
  // Invalid models shape: 400 invalid_models, zero-cost blocked receipt.
  for (const models of ["openai/gpt-4o", [1], [""], {}]) {
    r = await f.call(p, { model: "openai/gpt-4o-mini", models });
    assert.equal(r.status, 400, JSON.stringify(models));
    assert.equal(r.body.error, "invalid_models");
  }
  assert.equal(f.receipts.at(-1).reason, "invalid_models");
  assert.equal(f.receipts.at(-1).cost_usd, 0);
  assert.equal(f.seen.length, 0);
  // All allowed: forwarded unchanged.
  const ok = { model: "openai/gpt-4o-mini", models: ["openai/gpt-4o-mini", "google/gemini-2.5-flash"], messages: [] };
  r = await f.call(p, ok);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(f.seen[0].body).models, ok.models);
  assert.equal(JSON.parse(f.seen[0].body).model, ok.model);
  r = await f.call(p, { models: ["google/gemini-2.5-flash"] });
  assert.equal(r.status, 200);
  // Non-OpenRouter providers ignore a models field.
  const g = await proxyFixture(t, { allowedModels: () => ["gpt-4o-mini"] });
  assert.equal((await g.call("/openai/v1/chat/completions", { model: "gpt-4o-mini", models: ["gpt-4o", 3] })).status, 200);
  const a = await proxyFixture(t, { allowedModels: () => ["openrouter/auto"] });
  assert.equal((await a.call(p, { model: "openrouter/auto" })).status, 200);
});

test("proxy: --unknown-models refuse applies to every OpenRouter fallback", async (t) => {
  const f = await proxyFixture(t, { unknownModels: "refuse" });
  const r = await f.call("/openrouter/v1/chat/completions", { model: "openai/gpt-4o-mini", models: ["made-up/secret-9"] });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "model_unpriced");
  assert.equal(r.body.model, "made-up/secret-9");
  assert.equal(f.seen.length, 0);
});

test("#188: allowlist checks use the mapped Bedrock path model", async (t) => {
  const up = http.createServer((q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "x", usage: { input_tokens: 1, output_tokens: 1 } })));
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => up.close());
  const { server, port } = await startMeteringProxy({ upstreams: { bedrock: `http://127.0.0.1:${up.address().port}` }, awsRegion: "us-east-1", allowedModels: () => ["claude-sonnet-4-5"] });
  t.after(() => server.close());
  const call = (id) => fetch(`http://127.0.0.1:${port}/bedrock/model/${encodeURIComponent(id)}/invoke`, { method: "POST", headers: { authorization: "Bearer k" }, body: "{}" });
  assert.equal((await call("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).status, 200);
  const r = await call("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  assert.equal(r.status, 403);
  assert.equal((await r.json()).model, "claude-haiku-4-5");
});
