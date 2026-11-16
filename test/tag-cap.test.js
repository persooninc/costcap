// #191: per-tag spend caps (wrap/check --tag-cap KEY:SCOPE=USD).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTagCap, parseTagCaps, createTagCaps, tagBudgetExceededBody, UNTAGGED } from "../src/tag-cap.js";
import { startMeteringProxy } from "../src/proxy.js";
import { createSettler } from "../src/settle.js";
import { checkBudget } from "../src/check.js";
import { checkOutputs, formatSummary } from "../src/github-output.js";
import { parseWrapArgs } from "../src/cli.js";

const T0 = Date.parse("2026-11-16T12:00:00Z");
const at = (ms) => () => new Date(ms);
const ago = (min) => new Date(T0 - min * 60_000).toISOString();
const r = (cost, tags, ts = ago(1), extra = {}) => ({ id: `r${Math.random()}`, ts, cost_usd: cost, ...(tags ? { tags } : {}), ...extra });
// gpt-4o-mini: 1M input ($0.15) + 500k output ($0.30) = $0.45 per call.
const COMPLETION = JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, prompt_tokens_details: { cached_tokens: 0 } } });

test("parse: KEY:SCOPE=USD, every invalid form names the rule (AC5)", () => {
  assert.deepEqual(parseTagCap("customer:day=5"), { key: "customer", scope: "day", cap: 5 });
  assert.deepEqual(parseTagCaps(["customer:day=5", "customer:month=50", "team:hour=1.5"]).map((x) => x.scope), ["day", "month", "hour"]);
  for (const bad of ["customer:run=1", "Bad:day=1", "customer:day=0", "customer:day=-1", "customer:day=abc", "customer:day=", "customer:week=1", "customer=1", "nocolon", ":day=1", "customer:day=Infinity"]) {
    assert.throws(() => parseTagCap(bad), (e) => e.code === "invalid_tag_cap" && /KEY:SCOPE=USD/.test(e.message), bad);
  }
  assert.throws(() => parseTagCaps(["customer:day=1", "customer:day=2"]), /duplicate --tag-cap customer:day/);
  assert.deepEqual(parseWrapArgs(["--tag-cap", "customer:day=1", "--tag-cap", "customer:hour=1", "--", "true"]).tagCaps.length, 2);
  assert.equal(parseWrapArgs(["--", "true"]).tagCaps, undefined);
});

test("wrap exits 2 before spawning on each invalid --tag-cap (AC5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tagcap-bad-"));
  const marker = join(dir, "spawned");
  for (const args of [["--tag-cap", "customer:run=1"], ["--tag-cap", "Bad:day=1"], ["--tag-cap", "customer:day=0"], ["--tag-cap", "customer:day=1", "--tag-cap", "customer:day=2"]]) {
    const p = spawnSync(process.execPath, ["src/cli.js", "wrap", ...args, "--receipts", join(dir, "r.jsonl"), "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)},"x")`], { encoding: "utf8" });
    assert.equal(p.status, 2, args.join(" "));
    assert.match(p.stderr, /--tag-cap/);
  }
  assert.throws(() => readFileSync(marker));
});

test("engine: per-value day buckets, (untagged), UTC day and month boundaries", () => {
  const history = [r(0.6, { customer: "acme" }), r(0.5, { customer: "acme" }), r(0.3, { customer: "globex" }), r(2, { customer: "acme" }, "2026-11-15T23:59:59Z"), r(1, null)];
  const tc = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 1 }], history, now: at(T0) });
  assert.deepEqual(tc.check({ customer: "acme" }), { tag_key: "customer", tag_value: "acme", scope: "day", spend_usd: 1.1, cap_usd: 1 });
  assert.equal(tc.check({ customer: "globex" }), null);
  assert.equal(tc.check({ customer: "new" }), null);
  assert.equal(tc.check(null).tag_value, UNTAGGED);
  assert.equal(tc.check({ other: "x" }).tag_value, UNTAGGED);
  assert.deepEqual(tc.over().map((o) => o.value), [UNTAGGED, "acme"]);
  const month = createTagCaps({ rules: [{ key: "customer", scope: "month", cap: 3 }], history, now: at(T0) });
  assert.equal(month.check({ customer: "acme" }).spend_usd, 3.1);
  const nextMonth = createTagCaps({ rules: [{ key: "customer", scope: "month", cap: 3 }], history, now: at(Date.parse("2026-12-01T00:00:00Z")) });
  assert.equal(nextMonth.check({ customer: "acme" }), null);
  const nextDay = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 1 }], history, now: at(Date.parse("2026-11-17T00:00:00Z")) });
  assert.equal(nextDay.check({ customer: "acme" }), null);
  assert.deepEqual(createTagCaps().over(), []);
});

test("engine: unknown cost waits for a settlement, counted once, at its original ts", () => {
  const tc = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 1 }], history: [r(0.5, { customer: "acme" })], now: at(T0) });
  tc.record({ id: "u1", ts: ago(5), cost_usd: null, tags: { customer: "acme" } });
  tc.record({ id: "b1", ts: ago(5), cost_usd: null, reason: "batch_pending", tags: { customer: "acme" } });
  tc.record(null);
  tc.record({ id: "x", ts: ago(1), cost_usd: "bad" });
  assert.equal(tc.check({ customer: "acme" }), null);
  assert.equal(tc.settle("u1", 0.2), true);
  assert.equal(tc.settle("u1", 0.2), false);
  assert.equal(tc.settle("never-seen", 5), false);
  assert.equal(tc.settle("b1", -1), false);
  assert.equal(tc.settle("", 1), false);
  assert.equal(tc.check({ customer: "acme" }), null);
  assert.equal(tc.settle("b1", 0.3), true);
  assert.equal(tc.check({ customer: "acme" }).spend_usd, 1);
  assert.equal(tc.rules()[0].key, "customer");
});

test("engine: hour scope rolls, retry_after_s waits until enough ages out (AC3)", () => {
  let now = T0;
  const history = [r(0.6, { customer: "acme" }, ago(50)), r(0.6, { customer: "acme" }, ago(10)), r(0.6, { customer: "acme" }, ago(70))];
  const tc = createTagCaps({ rules: [{ key: "customer", scope: "hour", cap: 1 }], history, now: () => new Date(now) });
  const hit = tc.check({ customer: "acme" });
  assert.equal(hit.spend_usd, 1.2);
  assert.equal(hit.retry_after_s, 600);
  tc.record(r(0.1, { customer: "acme" }, ago(55))); // out-of-order insert
  assert.equal(tc.check({ customer: "acme" }).retry_after_s, 600);
  now = T0 + 600_000;
  assert.equal(tc.check({ customer: "acme" }), null);
  assert.equal(tc.check({ customer: "globex" }), null);
  const body = tagBudgetExceededBody(hit);
  assert.equal(body.error, "tag_budget_exceeded");
  assert.match(body.message, /customer=acme reached its hour cap/);
});

async function upstream(t) {
  const up = { hits: [] };
  await new Promise((res) => {
    up.server = http.createServer((q, s) => { up.hits.push(q.headers); q.resume(); q.on("end", () => s.writeHead(200, { "content-type": "application/json" }).end(COMPLETION)); });
    up.server.listen(0, "127.0.0.1", () => res());
  });
  t.after(() => up.server.close());
  return `http://127.0.0.1:${up.server.address().port}`;
}

const call = (port, tag) => fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", headers: tag ? { "x-costcap-tag": tag } : {}, body: JSON.stringify({ model: "gpt-4o-mini" }) });

test("proxy: one customer is refused at its day cap, others keep going, no latch (AC1)", async (t) => {
  const base = await upstream(t);
  const receipts = [];
  const tagCaps = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 1 }] });
  const { server, port } = await startMeteringProxy({ upstreams: { openai: base }, onReceipt: (x) => receipts.push(x), tagCaps });
  t.after(() => server.close());
  for (let i = 0; i < 3; i++) assert.equal((await call(port, "customer=acme")).status, 200);
  const refused = await call(port, "customer=acme");
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), null);
  const body = await refused.json();
  assert.equal(body.error, "tag_budget_exceeded");
  assert.deepEqual([body.tag_key, body.tag_value, body.scope, body.spend_usd, body.cap_usd], ["customer", "acme", "day", 1.35, 1]);
  const blocked = receipts.find((x) => x.blocked);
  assert.equal(blocked.reason, "tag_budget_exceeded");
  assert.equal(blocked.cost_usd, 0);
  assert.equal(blocked.tags.customer, "acme");
  assert.equal((await call(port, "customer=globex")).status, 200);
  assert.equal((await call(port, "customer=acme")).status, 429);
  assert.equal(receipts.filter((x) => !x.blocked && x.tags?.customer === "globex" && x.cost_usd > 0).length, 1);
});

test("proxy: untagged requests share (untagged); wrapper --tag overrides the header (AC2)", async (t) => {
  const base = await upstream(t);
  const tagCaps = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 0.4 }] });
  const { server, port } = await startMeteringProxy({ upstreams: { openai: base }, tagCaps });
  t.after(() => server.close());
  assert.equal((await call(port)).status, 200);
  const r2 = await call(port, "env=prod");
  assert.equal(r2.status, 429);
  assert.equal((await r2.json()).tag_value, UNTAGGED);
  const tagCaps2 = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 0.4 }] });
  const { server: s2, port: p2 } = await startMeteringProxy({ upstreams: { openai: base }, tagCaps: tagCaps2, tags: { customer: "fixed" } });
  t.after(() => s2.close());
  assert.equal((await call(p2, "customer=other")).status, 200);
  const r3 = await call(p2, "customer=other");
  assert.equal(r3.status, 429);
  assert.equal((await r3.json()).tag_value, "fixed");
});

test("proxy: hour scope sends Retry-After (AC3)", async (t) => {
  const base = await upstream(t);
  const tagCaps = createTagCaps({ rules: [{ key: "customer", scope: "hour", cap: 0.4 }] });
  const { server, port } = await startMeteringProxy({ upstreams: { openai: base }, tagCaps });
  t.after(() => server.close());
  assert.equal((await call(port, "customer=acme")).status, 200);
  const res = await call(port, "customer=acme");
  assert.equal(res.status, 429);
  const b = await res.json();
  assert.ok(b.retry_after_s > 3500 && b.retry_after_s <= 3600);
  assert.equal(res.headers.get("retry-after"), String(b.retry_after_s));
});

test("settler: a live settlement of a null-cost tagged receipt pushes the value over (AC4)", () => {
  const tc = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 1 }], history: [r(0.4, { customer: "acme" })], now: at(T0) });
  tc.record({ id: "n1", ts: ago(2), cost_usd: null, tags: { customer: "acme" } });
  const settle = createSettler({ cap: () => null, agentBudgets: () => null, proxySettle: () => null, tagCaps: () => tc });
  assert.equal(tc.check({ customer: "acme" }), null);
  assert.equal(settle({ receipt_id: "n1", cost_usd: 0.8 }, { id: "n1", ts: ago(2), tags: { customer: "acme" } }), true);
  assert.equal(tc.check({ customer: "acme" }).spend_usd, 1.2);
  // Default tagCaps accessor: settlers built without tag caps still work.
  assert.equal(createSettler({ cap: () => null, agentBudgets: () => null, proxySettle: () => null })({ receipt_id: "z", cost_usd: 1 }), true);
});

function ledgerFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), "cc-tagcap-"));
  const p = join(dir, "r.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, p };
}

test("check --tag-cap: JSON lists only values over the cap; exits 1; GitHub output (AC6)", () => {
  const now = new Date().toISOString();
  const { dir, p } = ledgerFile([0.45, 0.45, 0.45].map((c) => ({ id: `a${c}${Math.random()}`, ts: now, cost_usd: c, tags: { customer: "acme" } })).concat([{ id: "g", ts: now, cost_usd: 0.45, tags: { customer: "globex" } }]));
  const out = join(dir, "out"), sum = join(dir, "sum");
  const res = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", p, "--tag-cap", "customer:day=1", "--github-output"], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum } });
  assert.equal(res.status, 1, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.equal(j.ok, false);
  assert.deepEqual(j.tag_caps, [{ key: "customer", value: "acme", scope: "day", spend_usd: 1.35, cap_usd: 1, verdict: "tag_budget_exceeded" }]);
  assert.equal(j.hit.reason, "tag_budget_exceeded");
  assert.match(readFileSync(out, "utf8"), /verdict<<.*\ntag_budget_exceeded\n/);
  assert.match(readFileSync(out, "utf8"), /tag-caps<<.*\ncustomer=acme:day:1.35\/1\n/);
  assert.match(readFileSync(sum, "utf8"), /\| tag-caps \| customer=acme:day:1.35\/1 \|/);
  const ok = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", p, "--tag-cap", "customer:day=5"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).tag_caps, []);
  const bad = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", p, "--tag-cap", "customer:run=5"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

test("check: run-scoped check and an existing hit keep their hit; no --tag-cap is unchanged (AC7)", () => {
  const now = new Date().toISOString();
  const { p } = ledgerFile([{ id: "a", ts: now, cost_usd: 2, run_id: "R", tags: { customer: "acme" } }]);
  const plain = checkBudget({ receiptsPath: p, caps: { day: 5 } });
  assert.equal("tag_caps" in plain, false);
  const both = checkBudget({ receiptsPath: p, caps: { day: 1 }, tagCaps: [{ key: "customer", scope: "day", cap: 1 }] });
  assert.equal(both.hit.scope, "day");
  assert.equal(both.hit.reason, undefined);
  assert.equal(both.tag_caps.length, 1);
  const run = checkBudget({ receiptsPath: p, runId: "R", tagCaps: [{ key: "customer", scope: "day", cap: 1 }] });
  assert.equal(run.ok, false);
  assert.equal(run.run_id, "R");
  assert.equal(checkOutputs(run)["tag-caps"], "customer=acme:day:2/1");
  assert.equal(checkOutputs(plain)["tag-caps"], undefined);
  assert.doesNotMatch(formatSummary(checkOutputs(plain)), /tag-caps/);
  assert.match(formatSummary(checkOutputs({ ...plain, tag_caps: [] })), /\| tag-caps \| none \|/);
});

async function wrapRun(t, receipts, flags, script, extraEnv = {}) {
  const base = await upstream(t);
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...flags, "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: base, ...extraEnv } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, lines: out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) }));
  });
}

const CHILD = (tags) => `
  for (const tag of ${JSON.stringify(tags)}) {
    const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", headers: { "x-costcap-tag": tag }, body: JSON.stringify({ model: "gpt-4o-mini" }) });
    const b = await r.json();
    console.log(JSON.stringify({ tag, status: r.status, error: b.error ?? null }));
  }`;

test("e2e: wrap --tag-cap enforces per value and survives a restart on the same ledger (AC1, AC4)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tagcap-wrap-"));
  const receipts = join(dir, "r.jsonl");
  const first = await wrapRun(t, receipts, ["--tag-cap", "customer:day=1"], CHILD(["customer=acme", "customer=acme", "customer=acme", "customer=acme", "customer=globex"]));
  assert.deepEqual(first.lines.map((l) => l.status), [200, 200, 200, 429, 200]);
  assert.equal(first.lines[3].error, "tag_budget_exceeded");
  const second = await wrapRun(t, receipts, ["--tag-cap", "customer:day=1"], CHILD(["customer=acme", "customer=globex"]));
  assert.deepEqual(second.lines.map((l) => l.status), [429, 200]);
  const ledger = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => !l.event);
  assert.equal(ledger.filter((l) => l.reason === "tag_budget_exceeded").length, 2);
});

test("e2e: a --shared-ledger sibling's tagged spend counts without a restart (AC4)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tagcap-shared-"));
  const receipts = join(dir, "r.jsonl");
  writeFileSync(receipts, "");
  const sibling = JSON.stringify({ id: "sib", ts: new Date().toISOString(), provider: "openai", cost_usd: 0.8, tags: { customer: "acme" }, run_id: "other" });
  const child = `
    const go = async () => { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", headers: { "x-costcap-tag": "customer=acme" }, body: JSON.stringify({ model: "gpt-4o-mini" }) }); await r.text(); return r.status; };
    const a = await go();
    (await import("node:fs")).appendFileSync(${JSON.stringify(receipts)}, ${JSON.stringify(sibling + "\n")});
    await new Promise((r) => setTimeout(r, 200));
    console.log(JSON.stringify({ a, b: await go() }));`;
  const res = await wrapRun(t, receipts, ["--shared-ledger", "--tag-cap", "customer:day=1"], child);
  assert.deepEqual(res.lines[0], { a: 200, b: 429 });
  appendFileSync(receipts, "");
});
