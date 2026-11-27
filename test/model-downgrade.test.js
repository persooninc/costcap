// Issue #207: budget-triggered model downgrade.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capScopes, createDowngradeTracker, downgradeError, downgradeLine, mergeDowngrade, parseDowngradeAt, parseDowngradeMap, remainingScopes, rewriteModel, triggerScope } from "../src/downgrade.js";
import { resolvePolicy, validatePolicy } from "../src/hosted/policy.js";
import { startMeteringProxy } from "../src/proxy.js";
import { parseWrapArgs } from "../src/cli.js";
import { createCapEngine } from "../src/cap.js";
import { createAgentBudgets } from "../src/agent-budget.js";
import { buildRunSummary, rollupLine, runsCommand, writeRunSummary } from "../src/run-summary.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("parseDowngradeMap / parseDowngradeAt", () => {
  assert.deepEqual(parseDowngradeMap("gpt-4o=gpt-4o-mini, claude-sonnet-4-5=claude-haiku-4-5"), { "gpt-4o": "gpt-4o-mini", "claude-sonnet-4-5": "claude-haiku-4-5" });
  assert.deepEqual(parseDowngradeMap("b=c", { a: "x" }), { a: "x", b: "c" });
  assert.deepEqual(parseDowngradeMap("a=x", { a: "x" }), { a: "x" });
  for (const bad of ["", "a", "a=", "=b", "a=b=c", "a=a"]) assert.throws(() => parseDowngradeMap(bad), /--downgrade/);
  assert.throws(() => parseDowngradeMap("a=y", { a: "x" }), /twice/);
  assert.equal(parseDowngradeAt("0.5"), 0.5);
  for (const bad of ["", "0", "1", "1.5", "x", "-0.1"]) assert.throws(() => parseDowngradeAt(bad), /--downgrade-at/);
});

test("downgradeError validates fleet policy shape", () => {
  assert.equal(downgradeError(undefined), null);
  assert.equal(downgradeError(null), null);
  assert.equal(downgradeError({ at: 0.8, map: { "gpt-4o": "gpt-4o-mini" } }), null);
  assert.match(downgradeError([]), /object/);
  assert.match(downgradeError({ at: 0.8, map: { a: "b" }, x: 1 }), /downgrade.x/);
  assert.match(downgradeError({ at: 1, map: { a: "b" } }), /downgrade.at/);
  assert.match(downgradeError({ at: 0.5, map: [] }), /downgrade.map/);
  assert.match(downgradeError({ at: 0.5, map: {} }), /1 to 50/);
  assert.match(downgradeError({ at: 0.5, map: { a: 3 } }), /model ids/);
  assert.match(downgradeError({ at: 0.5, map: { a: "a" } }), /itself/);
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, downgrade: { at: 0.5, map: { a: "b" } } }), []);
  assert.deepEqual(validatePolicy({ version: 1, caps: {}, downgrade: { at: 2, map: { a: "b" } } }), ["downgrade.at must be a number between 0 and 1 (exclusive)"]);
});

test("mergeDowngrade / resolvePolicy: local only adds or tightens", () => {
  assert.equal(mergeDowngrade(null, null), null);
  assert.equal(mergeDowngrade({ at: 0.5, map: {} }, null), null);
  assert.deepEqual(mergeDowngrade({ at: 0.9, map: { a: "b" } }, { at: 0.7, map: { a: "z", c: "d" } }), { at: 0.7, map: { a: "b", c: "d" } });
  assert.deepEqual(mergeDowngrade({ at: 0.6, map: { a: "b" } }, { at: 0.9, map: { c: "d" } }), { at: 0.6, map: { c: "d", a: "b" } });
  const r = resolvePolicy({ local: { downgrade: { at: 0.7, map: { c: "d" } } }, lastKnown: { version: 1, caps: {}, downgrade: { at: 0.8, map: { a: "b" } } } });
  assert.deepEqual(r.downgrade, { at: 0.7, map: { c: "d", a: "b" } });
  assert.equal("downgrade" in resolvePolicy({}), false);
  assert.throws(() => resolvePolicy({ local: { downgrade: { at: 3, map: { a: "b" } } } }), /Invalid local downgrade/);
});

test("triggerScope / capScopes / remainingScopes", () => {
  const scopes = capScopes({ run: 10, day: 1 }, { run: 7.9, day: 0.85 });
  assert.deepEqual(scopes.map((s) => s.scope), ["run", "day"]);
  assert.deepEqual(triggerScope(scopes, 0.8), { scope: "day", fraction: 0.85, cap: 1, spent_usd: 0.85 });
  assert.equal(triggerScope(scopes, 0.9), null);
  assert.equal(triggerScope([null, { scope: "x", cap: 0, spent: 5 }, { scope: "y", cap: 1, spent: NaN }], 0.1), null);
  assert.equal(triggerScope(undefined, 0.5), null);
  assert.deepEqual(remainingScopes({ day: 10, month: 100 }, { day: 1, month: 90 }, "fleet:"), [{ scope: "fleet:day", cap: 10, spent: 9 }, { scope: "fleet:month", cap: 100, spent: 10 }]);
  assert.deepEqual(remainingScopes({ day: 10 }, { day: 20 }), [{ scope: "day", cap: 10, spent: 0 }]);
  assert.deepEqual(remainingScopes(undefined, undefined), []);
});

test("rewriteModel changes only the model field", () => {
  const body = Buffer.from(JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true, temperature: 0.2 }));
  assert.deepEqual(JSON.parse(rewriteModel(body, "gpt-4o-mini")), { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true, temperature: 0.2 });
  assert.equal(rewriteModel(Buffer.from("not json"), "x"), null);
  assert.equal(rewriteModel(Buffer.from("[1]"), "x"), null);
  assert.equal(rewriteModel(Buffer.from('{"model":3}'), "x"), null);
});

test("downgrade tracker dedupes per scope and period, and from prior events", () => {
  const now = () => new Date("2026-11-16T10:30:00Z");
  const t = createDowngradeTracker({ runId: "r1", agentId: "a", now, events: [{ event: "model_downgrade", scope: "day", period: "2026-11-16" }] });
  assert.equal(t.observe({ scope: "day", fraction: 0.8, cap: 1, spent_usd: 0.8 }, "a", "b"), null);
  const ev = t.observe({ scope: "run", fraction: 0.8, cap: 1, spent_usd: 0.8 }, "a", "b");
  assert.deepEqual(ev, { event: "model_downgrade", scope: "run", fraction: 0.8, cap: 1, spent_usd: 0.8, period: "r1", from: "a", to: "b", run_id: "r1", agent_id: "a" });
  assert.equal(t.observe({ scope: "run", fraction: 0.9, cap: 1, spent_usd: 0.9 }, "a", "b"), null);
  assert.equal(t.observe({ scope: "agent:hour", fraction: 0.9, cap: 1, spent_usd: 0.9 }, "a", "b").period, "2026-11-16T10");
  assert.equal(t.observe({ scope: "fleet:month", fraction: 0.9, cap: 1, spent_usd: 0.9 }, "a", "b").period, "2026-11");
  assert.equal(downgradeLine(ev), "costcap: run spend is 80% of its cap; downgrading a -> b");
});

test("parseWrapArgs --downgrade / --downgrade-at", () => {
  const o = parseWrapArgs(["--downgrade", "gpt-4o=gpt-4o-mini", "--downgrade", "claude-sonnet-4-5=claude-haiku-4-5", "--downgrade-at", "0.6", "--", "x"]);
  assert.deepEqual(o.downgrade, { at: 0.6, map: { "gpt-4o": "gpt-4o-mini", "claude-sonnet-4-5": "claude-haiku-4-5" } });
  assert.equal(parseWrapArgs(["--downgrade", "gpt-4o=gpt-4o-mini", "--", "x"]).downgrade.at, 0.8);
  assert.equal(parseWrapArgs(["--", "x"]).downgrade, undefined);
  assert.throws(() => parseWrapArgs(["--downgrade-at", "0.5", "--", "x"]), /needs --downgrade/);
  assert.throws(() => parseWrapArgs(["--downgrade", "gpt-4o=totally-unpriced-model", "--", "x"]), /no published rate/);
});

async function fixture(t, opts) {
  const seen = [];
  const up = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      seen.push({ url: req.url, body: text });
      const b = JSON.parse(text || "{}");
      if (req.url.startsWith("/v1/messages")) return res.end(JSON.stringify({ model: b.model, usage: { input_tokens: 10, output_tokens: 1 } }));
      if (req.url.includes(":generateContent")) return res.end(JSON.stringify({ modelVersion: "gemini-2.5-pro", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 }, candidates: [{ finishReason: "STOP" }] }));
      if (b.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ model: b.model, choices: [{ delta: { content: "x" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ model: b.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.end(JSON.stringify({ model: b.model, usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    });
  });
  const u = `http://127.0.0.1:${await listen(up)}`;
  const receipts = [], lines = [];
  const dir = mkdtempSync(join(tmpdir(), "cc-dg-"));
  const receiptsPath = join(dir, "r.jsonl");
  const { server, port } = await startMeteringProxy({ receiptsPath, upstreams: { openai: u, anthropic: u, gemini: u, openrouter: u }, customUpstreams: { local: u }, onReceipt: (r) => receipts.push(r), onWarning: (l) => lines.push(l), ...opts });
  t.after(() => { server.close(); up.close(); });
  const call = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, header: r.headers.get("x-costcap-model-downgraded"), text: await r.text() };
  };
  return { seen, receipts, lines, call, receiptsPath };
}

const DG = { at: 0.8, map: { "gpt-4o": "gpt-4o-mini", "claude-sonnet-4-5": "claude-haiku-4-5", "openai/gpt-4o": "openai/gpt-4o-mini", "llama-big": "llama-small" } };

test("proxy: under F requests are byte-identical; at F the model is rewritten", async (t) => {
  const cap = createCapEngine({ caps: { run: 1 }, runId: "r1" });
  const f = await fixture(t, { cap, downgrade: () => DG, downgradeTracker: createDowngradeTracker({ runId: "r1" }) });
  let r = await f.call("/openai/v1/chat/completions", { model: "gpt-4o", messages: [] });
  assert.equal(r.status, 200);
  assert.equal(r.header, null);
  assert.equal(JSON.parse(f.seen[0].body).model, "gpt-4o");
  assert.equal(f.receipts[0].requested_model, undefined);
  cap.record({ cost_usd: 0.85, run_id: "r1", ts: new Date().toISOString() });
  r = await f.call("/openai/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], temperature: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.header, "gpt-4o->gpt-4o-mini");
  assert.deepEqual(JSON.parse(f.seen[1].body), { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], temperature: 0 });
  const rc = f.receipts.at(-1);
  assert.equal(rc.model, "gpt-4o-mini");
  assert.equal(rc.requested_model, "gpt-4o");
  assert.deepEqual(rc.downgrade, { scope: "run", fraction: 0.85 });
  // Anthropic, OpenRouter and custom upstreams.
  assert.equal((await f.call("/anthropic/v1/messages", { model: "claude-sonnet-4-5", max_tokens: 5 })).header, "claude-sonnet-4-5->claude-haiku-4-5");
  assert.equal(JSON.parse(f.seen.at(-1).body).model, "claude-haiku-4-5");
  assert.equal((await f.call("/openrouter/v1/chat/completions", { model: "openai/gpt-4o" })).header, "openai/gpt-4o->openai/gpt-4o-mini");
  // Unmapped model: unchanged.
  const plain = await f.call("/openai/v1/chat/completions", { model: "gpt-4.1" });
  assert.equal(plain.status, 200, plain.text);
  assert.equal(JSON.parse(f.seen.at(-1).body).model, "gpt-4.1");
  // One ledger line and one stderr line per scope and period, never spend.
  const ledger = readFileSync(f.receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ledger.filter((l) => l.event === "model_downgrade").length, 1);
  assert.equal(f.lines.filter((l) => /downgrading/.test(l)).length, 1);
  // Custom upstream last: its unpriced response latches accounting_unavailable.
  assert.equal((await f.call("/u/local/chat/completions", { model: "llama-big" })).header, "llama-big->llama-small");
  assert.equal(JSON.parse(f.seen.at(-1).body).model, "llama-small");
});

test("proxy: streamed request is downgraded and usage injection still works", async (t) => {
  const cap = createCapEngine({ caps: { day: 1 } });
  cap.record({ cost_usd: 0.9, ts: new Date().toISOString() });
  const f = await fixture(t, { cap, downgrade: () => DG });
  const r = await f.call("/openai/v1/chat/completions", { model: "gpt-4o", stream: true, messages: [] });
  assert.equal(r.status, 200);
  const sent = JSON.parse(f.seen[0].body);
  assert.equal(sent.model, "gpt-4o-mini");
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.equal(f.receipts[0].model, "gpt-4o-mini");
  assert.equal(f.receipts[0].requested_model, "gpt-4o");
  assert.equal(f.receipts[0].downgrade.scope, "day");
  assert.equal(typeof f.receipts[0].cost_usd, "number");
});

test("proxy: allowlist and unknown-models check TO; hard stop still refuses", async (t) => {
  const cap = createCapEngine({ caps: { run: 1 }, runId: "r" });
  cap.record({ cost_usd: 0.9, run_id: "r", ts: new Date().toISOString() });
  const f = await fixture(t, { cap, downgrade: () => DG, allowedModels: () => ["gpt-4o"] });
  let r = await f.call("/openai/v1/chat/completions", { model: "gpt-4o" });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.text).model, "gpt-4o-mini");
  assert.equal(f.seen.length, 0);
  const cap2 = createCapEngine({ caps: { run: 1 }, runId: "r" });
  cap2.record({ cost_usd: 0.9, run_id: "r", ts: new Date().toISOString() });
  const g = await fixture(t, { cap: cap2, downgrade: () => ({ at: 0.5, map: { "gpt-4o": "brand-new-unpriced" } }), unknownModels: "refuse" });
  r = await g.call("/openai/v1/chat/completions", { model: "gpt-4o" });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.text).error, "model_unpriced");
  assert.equal(g.seen.length, 0);
  cap2.record({ cost_usd: 0.2, run_id: "r", ts: new Date().toISOString() });
  const h = await fixture(t, { cap: cap2, downgrade: () => DG });
  r = await h.call("/openai/v1/chat/completions", { model: "gpt-4o" });
  assert.equal(r.status, 429);
  assert.equal(h.seen.length, 0);
});

test("proxy: unsupported routes pass through unchanged with downgrade: unsupported_route", async (t) => {
  const cap = createCapEngine({ caps: { run: 1 }, runId: "r" });
  cap.record({ cost_usd: 0.9, run_id: "r", ts: new Date().toISOString() });
  const f = await fixture(t, { cap, downgrade: () => ({ at: 0.5, map: { "gemini-2.5-pro": "gemini-2.5-flash", "openai/gpt-4o": "openai/gpt-4o-mini" } }) });
  let r = await f.call("/gemini/v1beta/models/gemini-2.5-pro:generateContent", { contents: [] });
  assert.equal(r.header, null);
  assert.equal(f.seen[0].url, "/v1beta/models/gemini-2.5-pro:generateContent");
  assert.equal(f.receipts[0].downgrade, "unsupported_route");
  r = await f.call("/openrouter/v1/chat/completions", { model: "openai/gpt-4o", models: ["openai/gpt-4o", "anthropic/claude-haiku-4-5"] });
  assert.equal(r.status, 200, r.text);
  assert.equal(JSON.parse(f.seen[1].body).model, "openai/gpt-4o");
  assert.equal(f.receipts[1].downgrade, "unsupported_route");
});

test("proxy: agent policy, team and fleet scopes trigger the downgrade", async (t) => {
  const now = new Date().toISOString();
  const agentBudgets = createAgentBudgets({ policy: { agents: { a: { day: 1 } }, teams: { t: { agents: ["a"], month: 10 } } },
    history: [{ id: "1", ts: now, agent_id: "a", run_id: "x", cost_usd: 0.5 }] });
  const who = { agent_id: "a", run_id: "r" };
  let fleet = [];
  const f = await fixture(t, { agentBudgets, who, downgrade: () => DG, downgradeScopes: () => fleet });
  await f.call("/openai/v1/chat/completions", { model: "gpt-4o" });
  assert.equal(JSON.parse(f.seen[0].body).model, "gpt-4o");
  fleet = remainingScopes({ day: 10 }, { day: 1 }, "fleet:");
  await f.call("/openai/v1/chat/completions", { model: "gpt-4o" });
  assert.equal(f.receipts.at(-1).downgrade.scope, "fleet:day");
  fleet = () => { throw new Error("x"); };
  const g = await fixture(t, { agentBudgets: createAgentBudgets({ policy: { agents: { a: { day: 1 } } }, history: [{ id: "1", ts: now, agent_id: "a", run_id: "x", cost_usd: 0.85 }] }), who, downgrade: () => DG, downgradeScopes: () => { throw new Error("cache"); } });
  await g.call("/openai/v1/chat/completions", { model: "gpt-4o" });
  assert.equal(g.receipts.at(-1).downgrade.scope, "agent:day");
  const h = await fixture(t, { agentBudgets: createAgentBudgets({ policy: { agents: { a: {} }, teams: { t: { agents: ["a"], day: 1 } } }, history: [{ id: "1", ts: now, agent_id: "a", run_id: "x", cost_usd: 0.85 }] }), who, downgrade: () => DG });
  await h.call("/openai/v1/chat/completions", { model: "gpt-4o" });
  assert.equal(h.receipts.at(-1).downgrade.scope, "team:day");
});

test("run summary counts downgraded calls; runs shows them", () => {
  const s = buildRunSummary({ run_id: "r", started_at: "a", ended_at: "b", receipts: [
    { model: "gpt-4o-mini", requested_model: "gpt-4o", downgrade: { scope: "run", fraction: 0.8 }, cost_usd: 0.1 },
    { model: "gpt-4o", cost_usd: 0.2 },
    { model: "x", downgrade: "unsupported_route", cost_usd: 0 },
  ] });
  assert.equal(s.downgraded_calls, 1);
  assert.match(rollupLine(s), / downgraded=1/);
  assert.equal("downgraded_calls" in buildRunSummary({ run_id: "r", receipts: [] }), false);
  const dir = mkdtempSync(join(tmpdir(), "cc-dgr-"));
  const receiptsPath = join(dir, "r.jsonl");
  writeRunSummary(receiptsPath, { ...s, ended_at: "2026-11-16T00:00:00Z" });
  const out = [];
  runsCommand(["--receipts", receiptsPath], { log: (l) => out.push(l) });
  assert.match(out[0], /downgraded=1/);
});

test("hosted: agent policy downgrade round-trip, validation, /v1/policy delivery, dashboard field", async (t) => {
  const { createHostedServer } = await import("../src/hosted/server.js");
  let code;
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-dgh-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {},
    verifyChallenge: async (v) => v === "ok", sendCode: async (d) => { code = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [] });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", connection: "close", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const c = await request("/auth/request", { email: "dg-owner@example.invalid", turnstileToken: "ok" });
  const owner = await request("/auth/verify", { challengeId: c.body.challengeId, code });
  const e = await request("/v1/enrollment-tokens", { caps: { day: 10 } }, owner.cookie);
  const a = (await request("/v1/enroll", { name: "dg" }, null, e.body.token)).body;
  const url = `/v1/agents/${a.agentId}/policy`;
  const dg = { at: 0.7, map: { "gpt-4o": "gpt-4o-mini" } };
  const ok = await request(url, { downgrade: dg }, owner.cookie);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.downgrade, dg);
  assert.equal((await request(url, { downgrade: { at: 1.2, map: { a: "b" } } }, owner.cookie)).status, 400);
  assert.deepEqual((await request(url, { caps: { day: 10 } }, owner.cookie)).body.downgrade, dg);
  assert.deepEqual((await request("/v1/policy", undefined, null, a.token)).body.downgrade, dg);
  const prev = await request(url, { downgrade: null }, owner.cookie);
  assert.equal(prev.body.downgrade, undefined);
  const audit = (await request("/v1/evidence.json", undefined, owner.cookie)).body.audit.filter((x) => x.action === "policy.change").at(-1);
  assert.deepEqual(audit.detail.previous.downgrade, dg);
  const js = await (await fetch(`${base}/assets/app.js`)).text();
  assert.match(js, /downgradeMap/);
  assert.match(js, /downgrade:dgMap\(form\)/);
});

test("wrap: --downgrade rewrites past --downgrade-at of the day cap; ledger, stderr and run summary record it", async (t) => {
  const { spawn } = await import("node:child_process");
  const { writeFileSync, readdirSync } = await import("node:fs");
  const seen = [];
  const up = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => { seen.push(JSON.parse(text)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: JSON.parse(text).model, usage: { prompt_tokens: 10, completion_tokens: 1 } })); });
  });
  await listen(up);
  t.after(() => up.close());
  const dir = mkdtempSync(join(tmpdir(), "cc-dgw-"));
  const receiptsPath = join(dir, "r.jsonl");
  writeFileSync(receiptsPath, JSON.stringify({ id: "old", ts: new Date().toISOString(), provider: "openai", model: "gpt-4o", cost_usd: 0.6, blocked: false }) + "\n");
  const script = "const r = await fetch(process.env.OPENAI_BASE_URL + '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', messages: [] }) }); console.log(r.status, r.headers.get('x-costcap-model-downgraded'));";
  const child = spawn(process.execPath, ["src/cli.js", "wrap", "--day-cap", "1", "--downgrade", "gpt-4o=gpt-4o-mini", "--downgrade-at", "0.5", "--receipts", receiptsPath, "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script],
    { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.address().port}` } });
  let out = "", err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, err);
  assert.match(out, /200 gpt-4o->gpt-4o-mini/);
  assert.equal(seen[0].model, "gpt-4o-mini");
  assert.match(err, /day spend is 60% of its cap; downgrading gpt-4o -> gpt-4o-mini/);
  assert.match(err, /downgraded=1/);
  const ledger = readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ledger.filter((l) => l.event === "model_downgrade").length, 1);
  const summary = JSON.parse(readFileSync(join(dir, "runs", readdirSync(join(dir, "runs"))[0]), "utf8"));
  assert.equal(summary.downgraded_calls, 1);
});
