// Issue #173: a hosted settle unblocks a running `wrap --policy` (agent budgets), no restart.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBudgets } from "../src/agent-budget.js";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

async function wrapWithSettle(t, settleCost, dayCap) {
  let calls = 0;
  const up = http.createServer((req, res) => { calls++; res.end(calls === 1 ? "{}" : JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 0 } })); });
  let unknownId = null, armed = false;
  const fleet = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/policy") {
        const settlements = armed && unknownId ? [{ receipt_id: unknownId, settled_cost_usd: settleCost, settle_source: "provider_invoice" }] : [];
        return res.end(JSON.stringify({ version: 1, caps: { day: 100 }, killed: false, settlements }));
      }
      if (req.url === "/v1/receipts") {
        const rs = JSON.parse(text).receipts;
        for (const r of rs) if (r.cost_usd === null && !unknownId) unknownId = r.id;
        return res.end(JSON.stringify({ acceptedIds: rs.map((r) => r.id) }));
      }
      if (req.url === "/v1/arm") { armed = true; return res.end("{}"); }
      res.statusCode = 404; res.end("{}");
    });
  });
  const upPort = await listen(up), fleetPort = await listen(fleet);
  t.after(() => { up.closeAllConnections(); up.close(); fleet.closeAllConnections(); fleet.close(); });
  const dir = mkdtempSync(join(tmpdir(), "cc-173-"));
  const enrollment = join(dir, "e.json"), policy = join(dir, "p.json");
  writeFileSync(enrollment, JSON.stringify({ url: `http://127.0.0.1:${fleetPort}`, token: "t", agentId: "a1", policy: { version: 1, caps: { day: 100 }, killed: false }, syncedIds: [] }), { mode: 0o600 });
  writeFileSync(policy, JSON.stringify({ agents: { bot: dayCap ? { day: dayCap } : { month: 100 } } }));
  // Call 1 unknown cost, call 2 refused, then arm the settle and keep calling until it changes.
  const script = `const B = process.env.OPENAI_BASE_URL; const call = async () => { const r = await fetch(B + "/chat/completions", { method: "POST", body: "{}" }); const j = await r.json().catch(() => ({})); return r.status + ":" + (j.error?.type ?? j.error ?? ""); };
    const out = [await call(), await call()]; await fetch(process.env.ARM, { method: "POST", body: "{}" });
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 100)); const s = await call(); if (s !== out[1]) { out.push(s); break; } }
    console.log(JSON.stringify(out));`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "wrap", "--agent", "bot", "--policy", policy, "--enrollment", enrollment, "--receipts", join(dir, "r.jsonl"), "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}`, COSTCAP_SYNC_MS: "200", ARM: `http://127.0.0.1:${fleetPort}/v1/arm` } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, err, out: JSON.parse(out.trim().split("\n").at(-1)) }));
  });
}

const statusOf = (s) => s.split(":")[0];

test("#173 wrap --policy: unknown → 429 accounting_unavailable → hosted settle → 200 without restart", async (t) => {
  const r = await wrapWithSettle(t, 0.01);
  assert.equal(statusOf(r.out[0]), "200", r.err);
  assert.equal(r.out[1], "429:accounting_unavailable");
  assert.equal(r.out.length, 3, r.err);
  assert.equal(statusOf(r.out[2]), "200");
});

test("#173 wrap --policy: a $2 settlement counts toward day cap 1 → budget_exceeded", async (t) => {
  const r = await wrapWithSettle(t, 2, 1);
  assert.equal(r.out[1], "429:accounting_unavailable");
  assert.equal(r.out[2], "429:budget_exceeded", r.err);
});

const ts = () => new Date().toISOString();

test("#173 settle(): matches by receipt id, idempotent, never overrides a known cost", () => {
  const b = createAgentBudgets({ policy: { agents: { bot: { day: 1 } } }, history: [{ id: "u", agent_id: "bot", cost_usd: null, ts: ts() }, { id: "k", agent_id: "bot", cost_usd: 0.1, ts: ts() }] });
  assert.equal(b.check({ agent_id: "bot" }).verdict, "accounting_unavailable");
  assert.equal(b.settle({ receipt_id: "nope", settled_cost_usd: 1 }), false);
  assert.equal(b.settle({ receipt_id: "u" }), false);
  assert.equal(b.settle({ receipt_id: "u", settled_cost_usd: -1 }), false);
  assert.equal(b.settle({ receipt_id: "k", settled_cost_usd: 5 }), false);
  assert.equal(b.settle({ receipt_id: "u", settled_cost_usd: 0.2 }), true);
  assert.equal(b.settle({ id: "u", cost_usd: 9 }), false);
  assert.equal(b.check({ agent_id: "bot" }), null);
  assert.equal(Number(b.spend({ agent_id: "bot" }).day.toFixed(6)), 0.3);
});

test("#173 settle(): $2 settlement on day cap 1 → budget_exceeded citing day", () => {
  const b = createAgentBudgets({ policy: { agents: { bot: { day: 1 } } }, history: [{ id: "u", agent_id: "bot", cost_usd: null, ts: ts() }] });
  b.settle({ id: "u", cost_usd: 2 });
  const v = b.check({ agent_id: "bot" });
  assert.equal(v.verdict, "budget_exceeded");
  assert.equal(v.scope, "day");
});

test("#173 settle(): a teammate's settled unknown clears team accounting_unavailable", () => {
  const b = createAgentBudgets({ policy: { agents: { bot: { day: 10 }, mate: { day: 10 } }, teams: { t: { agents: ["bot", "mate"], day: 10 } } }, history: [{ id: "m", agent_id: "mate", cost_usd: null, ts: ts() }] });
  const v = b.check({ agent_id: "bot" });
  assert.equal(v.verdict, "accounting_unavailable");
  assert.equal(v.team, "t");
  assert.equal(b.settle({ receipt_id: "m", settled_cost_usd: 0.5 }), true);
  assert.equal(b.check({ agent_id: "bot" }), null);
  assert.equal(Number(b.teamSpend({ agent_id: "bot" }).day.toFixed(6)), 0.5);
});
