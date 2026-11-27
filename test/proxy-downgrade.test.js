// Issue #207 regression: the proxy rewrites FROM -> TO past the downgrade fraction, against a fake upstream.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { createAgentBudgets } from "../src/agent-budget.js";
import { createDowngradeNotifier, mergeDowngrade } from "../src/downgrade.js";
import { cacheKey, createResponseCache } from "../src/response-cache.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const MAP = { "gpt-4o": "gpt-4o-mini", "claude-sonnet-4-5": "claude-haiku-4-5" };
const today = () => new Date().toISOString();

async function setup(t, { capSpend = 0, caps = { day: 1 }, at = 0.8, opts = {} } = {}) {
  const seen = [];
  const up = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url, body, raw });
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "hi" } }] })}\n\n`);
        if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.startsWith("/v1/messages")) res.end(JSON.stringify({ model: body.model, usage: { input_tokens: 10, output_tokens: 5 } }));
      else res.end(JSON.stringify({ model: body.model, usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  const u = `http://127.0.0.1:${await listen(up)}`;
  const dir = mkdtempSync(join(tmpdir(), "cc-dg-"));
  const receiptsPath = join(dir, "receipts.jsonl");
  const history = capSpend ? [{ id: "h", ts: today(), cost_usd: capSpend, blocked: false }] : [];
  const cap = createCapEngine({ caps, history, runId: "r1" });
  const warnings = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: u, anthropic: u, openrouter: u, gemini: u }, receiptsPath, cap,
    who: { run_id: "r1" }, onWarning: (l) => warnings.push(l),
    downgrade: () => mergeDowngrade(null, { map: MAP, at }), downgradeNotifier: createDowngradeNotifier({ runId: "r1" }), ...opts });
  t.after(() => { server.close(); up.close(); });
  const call = async (path, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, header: r.headers.get("x-costcap-model-downgraded"), text: await r.text() };
  };
  const ledger = () => readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { seen, call, ledger, warnings, cap, dir, u };
}

const chat = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], temperature: 0.2 };

test("under F the request is byte-identical; no downgrade fields", async (t) => {
  const s = await setup(t, { capSpend: 0.5 });
  const r = await s.call("/openai/v1/chat/completions", chat);
  assert.equal(r.status, 200);
  assert.equal(r.header, null);
  assert.equal(s.seen[0].raw, JSON.stringify(chat));
  const [rec] = s.ledger();
  assert.equal(rec.model, "gpt-4o");
  assert.equal("requested_model" in rec, false);
  assert.equal("downgrade" in rec, false);
});

test("at or above F: FROM goes upstream as TO, other fields unchanged; receipt, header, one ledger event", async (t) => {
  const s = await setup(t, { capSpend: 0.8 });
  const r1 = await s.call("/openai/v1/chat/completions", chat);
  assert.equal(r1.status, 200);
  assert.equal(r1.header, "gpt-4o->gpt-4o-mini");
  assert.deepEqual(s.seen[0].body, { ...chat, model: "gpt-4o-mini" });
  await s.call("/openai/v1/chat/completions", chat);
  // An unmapped model is untouched.
  await s.call("/openai/v1/chat/completions", { ...chat, model: "gpt-4.1" });
  assert.equal(s.seen[2].body.model, "gpt-4.1");
  const lines = s.ledger();
  const events = lines.filter((l) => l.event === "model_downgrade");
  assert.equal(events.length, 1);
  assert.equal(events[0].scope, "day");
  assert.equal(events[0].from, "gpt-4o");
  assert.equal(events[0].to, "gpt-4o-mini");
  assert.equal(events[0].kind, "local");
  assert.equal("cost_usd" in events[0], false);
  const rec = lines.find((l) => !l.event);
  assert.equal(rec.model, "gpt-4o-mini");
  assert.equal(rec.requested_model, "gpt-4o");
  assert.deepEqual(rec.downgrade, { scope: "day", fraction: 0.8 });
  assert.equal(s.warnings.filter((w) => /downgrading gpt-4o -> gpt-4o-mini/.test(w)).length, 1);
  // The event is never spend: day spend is the history plus the three priced calls only.
  assert.ok(s.cap.spend().day < 0.81);
});

test("anthropic route and SSE stream (stream usage injection still works)", async (t) => {
  const s = await setup(t, { capSpend: 0.9 });
  const a = await s.call("/anthropic/v1/messages", { model: "claude-sonnet-4-5", max_tokens: 10, messages: [] }, { "x-api-key": "k" });
  assert.equal(a.header, "claude-sonnet-4-5->claude-haiku-4-5");
  assert.equal(s.seen[0].body.model, "claude-haiku-4-5");
  const r = await s.call("/openai/v1/chat/completions", { ...chat, stream: true });
  assert.equal(r.status, 200);
  assert.equal(s.seen[1].body.model, "gpt-4o-mini");
  assert.deepEqual(s.seen[1].body.stream_options, { include_usage: true });
  assert.doesNotMatch(r.text, /"usage"/); // the injected usage chunk is filtered out
  const rec = s.ledger().filter((l) => !l.event).at(-1);
  assert.equal(rec.model, "gpt-4o-mini");
  assert.equal(rec.requested_model, "gpt-4o");
  assert.equal(typeof rec.cost_usd, "number");
});

test("a disallowed TO is refused, never sent as FROM", async (t) => {
  const s = await setup(t, { capSpend: 0.9, opts: { allowedModels: () => ["gpt-4o"] } });
  const r = await s.call("/openai/v1/chat/completions", chat);
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.text).error, "model_not_allowed");
  assert.equal(JSON.parse(r.text).model, "gpt-4o-mini");
  assert.equal(s.seen.length, 0);
  const rec = s.ledger().find((l) => !l.event);
  assert.equal(rec.requested_model, "gpt-4o");
});

test("an unpriced TO is refused with --unknown-models refuse", async (t) => {
  const s = await setup(t, { capSpend: 0.9, opts: { unknownModels: "refuse", downgrade: () => ({ at: 0.8, map: { "gpt-4o": "no-such-model-x" } }) } });
  const r = await s.call("/openai/v1/chat/completions", chat);
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.text).error, "model_unpriced");
  assert.equal(s.seen.length, 0);
});

test("at 100% the hard stop still refuses", async (t) => {
  const s = await setup(t, { capSpend: 1 });
  const r = await s.call("/openai/v1/chat/completions", chat);
  assert.equal(r.status, 429);
  assert.equal(s.seen.length, 0);
});

test("cache key is computed on TO", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-dg-cache-"));
  const cache = createResponseCache({ dir, ttlMs: 60_000 });
  const s = await setup(t, { capSpend: 0.9, opts: { cache } });
  const det = { ...chat, temperature: 0 };
  await s.call("/openai/v1/chat/completions", det);
  await s.call("/openai/v1/chat/completions", det);
  assert.equal(s.seen.length, 1, "second call is a cache hit");
  const toKey = cacheKey({ provider: "openai", upstream: s.u, method: "POST", path: "/v1/chat/completions", body: Buffer.from(JSON.stringify({ ...det, model: "gpt-4o-mini" })), headers: { "content-type": "application/json" } });
  assert.ok(cache.get(toKey), "entry stored under the TO body");
});

test("unsupported routes pass through unchanged with downgrade: unsupported_route", async (t) => {
  const s = await setup(t, { capSpend: 0.9 });
  await s.call("/openrouter/v1/chat/completions", { ...chat, models: ["gpt-4o", "gpt-4.1"] });
  assert.equal(s.seen[0].body.model, "gpt-4o");
  const rec = s.ledger().find((l) => !l.event);
  assert.equal(rec.downgrade, "unsupported_route");
  assert.equal(s.ledger().filter((l) => l.event === "model_downgrade").length, 0);
});

test("agent/team policy budgets and fleet remainders trigger", async (t) => {
  const agentBudgets = createAgentBudgets({ policy: { agents: { bot: { run: 1 } } }, history: [{ id: "x", ts: today(), agent_id: "bot", run_id: "r1", cost_usd: 0.85 }] });
  const s = await setup(t, { caps: {}, opts: { agentBudgets, who: { agent_id: "bot", run_id: "r1" }, cap: undefined } });
  const r = await s.call("/openai/v1/chat/completions", chat);
  assert.equal(r.status, 200);
  assert.equal(s.seen[0].body.model, "gpt-4o-mini");
  assert.equal(s.ledger().find((l) => l.event).kind, "agent");
  assert.equal(s.ledger().find((l) => l.event).scope, "run");

  const team = createAgentBudgets({ policy: { agents: { bot: { day: 100 } }, teams: { t: { agents: ["bot", "peer"], day: 1 } } }, history: [{ id: "p", ts: today(), agent_id: "peer", run_id: "z", cost_usd: 0.9 }] });
  const s2 = await setup(t, { caps: {}, opts: { agentBudgets: team, who: { agent_id: "bot", run_id: "r1" }, cap: undefined } });
  assert.equal((await s2.call("/openai/v1/chat/completions", chat)).header, "gpt-4o->gpt-4o-mini");
  assert.equal(s2.ledger().find((l) => l.event).kind, "team");

  const s3 = await setup(t, { caps: {}, opts: { cap: undefined, fleetRemaining: () => ({ agent: { day: 0.1, month: 9 }, agentCaps: { day: 1, month: 10 }, team: { month: 50 }, teamCaps: null }) } });
  assert.equal((await s3.call("/openai/v1/chat/completions", chat)).header, "gpt-4o->gpt-4o-mini");
  assert.equal(s3.ledger().find((l) => l.event).kind, "fleet_agent");
  const s4 = await setup(t, { caps: {}, opts: { cap: undefined, fleetRemaining: () => ({ agent: null, team: { day: 5, month: 1 }, teamCaps: { day: 10, month: 10 } }) } });
  assert.equal((await s4.call("/openai/v1/chat/completions", chat)).header, "gpt-4o->gpt-4o-mini");
  assert.equal(s4.ledger().find((l) => l.event).kind, "fleet_team");
});

test("no downgrade configured or GET requests: nothing changes", async (t) => {
  const s = await setup(t, { capSpend: 0.9, opts: { downgrade: () => null } });
  await s.call("/openai/v1/chat/completions", chat);
  assert.equal(s.seen[0].body.model, "gpt-4o");
});
