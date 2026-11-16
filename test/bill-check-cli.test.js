import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const FIX = (n) => new URL(`../docs/fixtures/${n}`, import.meta.url).pathname;
const KEY = "sk-admin-TESTONLY-" + "f00dfeed";

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

function ledger(rows) {
  const dir = mkdtempSync(join(tmpdir(), "bc-cli-"));
  const p = join(dir, "receipts.jsonl");
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { dir, p };
}
const oa = (id, ts, cost) => ({ id, ts, provider: "openai", model: "gpt-4.1", cost_usd: cost });
const AC1 = [oa("a", "2026-10-30T10:00:00Z", 10), oa("b", "2026-10-31T10:00:00Z", 5)];

test("CLI AC1 against the OpenAI fixture exits 1 with per-day rows", async () => {
  const { p } = ledger(AC1);
  const r = await run(["bill-check", "--receipts", p, "--provider", "openai", "--provider-export", FIX("openai-costs.sample.json"), "--tolerance-pct", "5", "--json"]);
  assert.equal(r.code, 1, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.verdict, "unmetered_spend");
  assert.deepEqual(j.rows.map((x) => x.status), ["match", "unmetered_spend"]);
  assert.equal(j.rows[1].delta_usd, -4);
  const text = await run(["bill-check", "--receipts", p, "--provider", "openai", "--provider-export", FIX("openai-costs.sample.json"), "--until", "2026-10-30"]);
  assert.equal(text.code, 0);
  assert.match(text.out, /: match/);
});

test("CLI AC2 Anthropic fixture matches (exit 0); usage errors exit 2", async () => {
  const { p } = ledger([{ id: "x", ts: "2026-10-31T05:00:00Z", provider: "anthropic", model: "claude-sonnet-4-5-20250929", cost_usd: 8 }]);
  const r = await run(["bill-check", "--receipts", p, "--provider", "anthropic", "--provider-export", FIX("anthropic-cost-report.sample.json")]);
  assert.equal(r.code, 0, r.err);
  assert.equal((await run(["bill-check", "--receipts", p])).code, 2);
  assert.match((await run(["--help"])).out, /costcap bill-check/);
});

function stub(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const s = createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res, seen.length); });
    s.listen(0, "127.0.0.1", () => resolve({ s, seen, base: `http://127.0.0.1:${s.address().port}` }));
  });
}

test("CLI --fetch paginates with the key only in the auth header, never leaks it", async () => {
  const { s, seen, base } = await stub((req, res, n) => {
    res.setHeader("content-type", "application/json");
    const bucket = (t, v) => ({ start_time: t, results: [{ amount: { value: v, currency: "usd" }, line_item: "gpt-4.1, input" }] });
    res.end(JSON.stringify(n === 1 ? { data: [bucket(1793318400, 10)], has_more: true, next_page: "pg2" } : { data: [bucket(1793404800, 5)], has_more: false, next_page: null }));
  });
  const { dir, p } = ledger(AC1);
  const r = await run(["bill-check", "--receipts", p, "--provider", "openai", "--fetch", "--since", "2026-10-30", "--until", "2026-10-31", "--json"], { COSTCAP_OPENAI_ADMIN_KEY: KEY, COSTCAP_OPENAI_ADMIN_BASE_URL: base });
  s.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(seen.length, 2);
  assert.match(seen[1].url, /page=pg2/);
  assert.match(seen[0].url, /group_by=line_item/);
  for (const q of seen) { assert.equal(q.headers.authorization, `Bearer ${KEY}`); assert.ok(!q.url.includes(KEY)); }
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
  for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f), "utf8").includes(KEY));
});

test("CLI --fetch Anthropic uses x-api-key and does not follow redirects", async () => {
  const { s, seen, base } = await stub((req, res) => { res.statusCode = 302; res.setHeader("location", "http://127.0.0.1:1/steal"); res.end(); });
  const { p } = ledger(AC1);
  const r = await run(["bill-check", "--receipts", p, "--provider", "anthropic", "--fetch", "--since", "2026-10-30"], { COSTCAP_ANTHROPIC_ADMIN_KEY: KEY, COSTCAP_ANTHROPIC_ADMIN_BASE_URL: base });
  s.close();
  assert.equal(r.code, 2);
  assert.match(r.err, /redirected/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["x-api-key"], KEY);
  assert.match(seen[0].url, /cost_report/);
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
});

test("CLI --fetch: missing key, HTTP error and bad JSON exit 2", async () => {
  const { p } = ledger(AC1);
  const miss = await run(["bill-check", "--receipts", p, "--provider", "openai", "--fetch", "--since", "2026-10-30"]);
  assert.equal(miss.code, 2);
  assert.match(miss.err, /COSTCAP_OPENAI_ADMIN_KEY/);
  const { s, base } = await stub((req, res, n) => { if (n === 1) { res.statusCode = 500; res.end(); } else res.end("not json"); });
  const env = { COSTCAP_OPENAI_ADMIN_KEY: KEY, COSTCAP_OPENAI_ADMIN_BASE_URL: base };
  const a = await run(["bill-check", "--receipts", p, "--provider", "openai", "--fetch", "--since", "2026-10-30"], env);
  const b = await run(["bill-check", "--receipts", p, "--provider", "openai", "--fetch", "--since", "2026-10-30"], env);
  s.close();
  assert.match(a.err, /HTTP 500/);
  assert.match(b.err, /invalid JSON/);
  assert.equal(a.code + b.code, 4);
  const down = await run(["bill-check", "--receipts", p, "--provider", "openai", "--fetch", "--since", "2026-10-30"], { ...env, COSTCAP_OPENAI_ADMIN_BASE_URL: "http://127.0.0.1:1" });
  assert.match(down.err, /request failed/);
});

test("AC6 regression: reconcile output is unchanged", async () => {
  const { dir, p } = ledger([{ id: "r1", ts: "2026-10-30T00:00:00Z", provider: "openai", model: "gpt-4.1", cost_usd: 1 }]);
  const charges = join(dir, "charges.jsonl");
  writeFileSync(charges, JSON.stringify({ id: "r1", cost_usd: 1 }) + "\n");
  const r = await run(["reconcile", "--receipts", p, "--provider", charges]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), JSON.stringify({ ok: true, matched: 1, unknown: [], receipt_only: [], provider_only: [], mismatched: [], estimate_only: false }));
});
