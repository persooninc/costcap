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

// #204: fleet tag caps (pure parts).
import { parseFleetTagCaps, fleetTagCapsPolicy, validFleetTagCaps, mergeTagCapRules, cachedFleetTagVerdict } from "../src/hosted/tag-caps.js";
import { withFleetTagCaps } from "../src/tag-cap.js";

test("#204 fleet rules: validation, merge (lower cap wins) and composite engine", () => {
  assert.deepEqual(parseFleetTagCaps([{ key: "customer", scope: "day", usd: 1, extra: 1 }]), { rules: [{ key: "customer", scope: "day", usd: 1 }] });
  for (const bad of [null, [null], [{ key: "x", scope: "day", usd: Infinity }], [{ key: "x", scope: "week", usd: 1 }]]) assert.ok(parseFleetTagCaps(bad).error);
  assert.deepEqual(mergeTagCapRules([{ key: "customer", scope: "day", usd: 1 }, { key: "customer", scope: "month", usd: 9 }], [{ key: "customer", scope: "day", cap: 0.5 }, { key: "customer", scope: "month", cap: 20 }]),
    [{ key: "customer", scope: "day", cap: 0.5, fleetUsd: 1 }, { key: "customer", scope: "month", cap: 9, fleetUsd: 9 }]);
  const calls = [];
  const fleet = { tagCheck: (tags, rules) => { calls.push([tags, rules]); return { fleet: true }; } };
  const bare = withFleetTagCaps(null, fleet, []);
  assert.deepEqual(bare.check({ customer: "a" }), { fleet: true });
  assert.deepEqual([bare.rules(), bare.remaining({}), bare.preflight({}, 1), bare.over(), bare.settle("x", 1), bare.record({})], [[], [], null, [], false, undefined]);
  const local = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 0.1 }], now: at(T0) });
  const both = withFleetTagCaps(local, fleet, local.rules());
  both.record(r(0.2, { customer: "a" }, ago(1)));
  assert.equal(both.check({ customer: "a" }).fleet, undefined); // local hit first
  assert.equal(both.check({ customer: "b" }).fleet, true);
  assert.equal(both.rules().length, 1);
  assert.equal(both.remaining({ customer: "a" })[0].remaining_usd, 0);
  assert.equal(both.preflight({ customer: "a" }, 1).reason, "preflight_estimate");
  assert.equal(both.over().length, 1);
  assert.equal(both.settle("nope", 1), false);
});

test("#204 fleet policy payload: windows, unknown, untagged and truncation at the lowest listed spend", () => {
  const rules = [{ key: "customer", scope: "day", usd: 1 }];
  assert.equal(fleetTagCapsPolicy([], [], T0), null);
  const now = new Date(T0).toISOString();
  const yesterday = new Date(T0 - 86_400_000).toISOString();
  const p = fleetTagCapsPolicy(rules, [
    r(0.5, { customer: "acme" }, now), r(0.25, { customer: "acme" }, yesterday), r(null, { customer: "zed" }, now), r(0.1, null, now),
    r(9, { customer: "old" }, "2026-10-01T00:00:00Z"), r(9, { customer: "blk" }, now, { blocked: true }), null, r(1, { customer: "bad" }, "nope"),
    r(null, { customer: "bat" }, now, { reason: "batch_pending" }),
  ], T0);
  assert.deepEqual(p.spend.customer.acme, { day: 0.5, month: 0.75, unknown: 0 });
  assert.equal(Object.keys(p.spend.customer)[0], "zed"); // unknown first
  assert.equal(p.spend.customer[UNTAGGED].day, 0.1);
  assert.equal(p.spend.customer.old, undefined);
  assert.equal(p.truncated, false);
  assert.equal(validFleetTagCaps(p), true);
  for (const bad of [5, { ...p, truncated: "no" }, { ...p, rules: [] }, { ...p, spend: null }, { ...p, spend: { customer: null } }, { ...p, spend: { customer: { a: { day: -1, month: 0, unknown: 0 } } } }, { ...p, spend: { customer: { a: { day: 0, month: 0, unknown: 0.5 } } } }]) assert.equal(validFleetTagCaps(bad), false);

  // AC6: 1001 values -> truncated, 1000 entries; an unlisted value counts at the 1000th entry's spend.
  const many = Array.from({ length: 1001 }, (_, i) => r(0.001 * (i + 1), { customer: `c${i}` }, now));
  const big = fleetTagCapsPolicy(rules, many, T0);
  assert.equal(big.truncated, true);
  assert.equal(Object.keys(big.spend.customer).length, 1000);
  assert.equal(big.spend.customer.c0, undefined);
  const floor = Object.values(big.spend.customer).at(-1).month;
  assert.equal(floor, 0.002);
  const tiny = { ...big, rules: [{ key: "customer", scope: "day", usd: 0.002 }] };
  assert.equal(cachedFleetTagVerdict(tiny, [], { customer: "never-seen" }, [], T0).spend_usd, 0.002);
  assert.equal(cachedFleetTagVerdict({ ...tiny, spend: {} }, [], { customer: "x" }, [], T0), null);
});

test("#204 cached fleet verdict: pending receipts, UTC rollover and unknown for one value only", () => {
  const now = new Date(T0).toISOString();
  const policy = { rules: [{ key: "customer", scope: "day", usd: 1 }], spend: { customer: { acme: { day: 0.8, month: 0.8, unknown: 0 } } }, truncated: false, as_of: now };
  assert.equal(cachedFleetTagVerdict(null, [], {}, [], T0), null);
  assert.equal(cachedFleetTagVerdict(policy, [], { customer: "acme" }, [], T0), null);
  const pending = [r(0.4, { customer: "acme" }, now), r(5, { customer: "acme" }, now, { blocked: true }), r(5, { customer: "acme" }, "2026-10-01T00:00:00Z"), r(5, { customer: "acme" }, "bad"), r(null, { customer: "acme" }, now, { reason: "batch_pending" }), r(5, { customer: "acme" }, new Date(T0 - 86_400_000).toISOString())];
  const hit = cachedFleetTagVerdict(policy, [], { customer: "acme" }, pending, T0);
  assert.deepEqual([hit.verdict, hit.spend_usd, hit.fleet], ["tag_budget_exceeded", 1.2, true]);
  // Next UTC day: synced day spend no longer counts.
  assert.equal(cachedFleetTagVerdict(policy, [], { customer: "acme" }, [], T0 + 86_400_000), null);
  const nextMonth = Date.parse("2026-12-01T01:00:00Z");
  assert.equal(cachedFleetTagVerdict({ ...policy, spend: { customer: { acme: { day: 0, month: 0, unknown: 3 } } } }, [], { customer: "acme" }, [], nextMonth), null);
  const unk = cachedFleetTagVerdict(policy, [], { customer: "acme" }, [r(null, { customer: "acme" }, now)], T0);
  assert.deepEqual([unk.verdict, unk.unknown_receipts], ["accounting_unavailable", 1]);
  assert.equal(cachedFleetTagVerdict(policy, [], { customer: "globex" }, [r(null, { customer: "acme" }, now)], T0), null);
});

test("#204 truncation floor ignores listed unknown-cost values; all-unknown lists refuse the unlisted value", () => {
  const now = new Date(T0).toISOString();
  const rules = [{ key: "customer", scope: "month", usd: 30 }];
  const p = fleetTagCapsPolicy(rules, [r(null, { customer: "c-unknown" }, now), r(100, { customer: "c-big" }, now), r(40, { customer: "c-drop" }, now)], T0, 2);
  assert.equal(p.truncated, true);
  assert.equal(p.spend.customer["c-drop"], undefined);
  const hit = cachedFleetTagVerdict(p, [], { customer: "c-drop" }, [], T0);
  assert.deepEqual([hit.verdict, hit.spend_usd], ["tag_budget_exceeded", 100]);
  const allUnknown = fleetTagCapsPolicy(rules, [r(null, { customer: "u1" }, now), r(null, { customer: "u2" }, now), r(5, { customer: "c-drop" }, now)], T0, 2);
  assert.equal(cachedFleetTagVerdict(allUnknown, [], { customer: "c-drop" }, [], T0).verdict, "accounting_unavailable");
});
