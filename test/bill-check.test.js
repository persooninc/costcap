import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseOpenAICosts, parseAnthropicCostReport, parseExport, billCheck, billCheckFiles, normalizeModel, parseBillCheckArgs, formatBillCheck, billCheckCommand, fetchExport } from "../src/bill-check.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`../docs/fixtures/${n}`, import.meta.url), "utf8"));
const D1 = "2026-10-30", D2 = "2026-10-31";
const oa = (id, ts, cost, model = "gpt-4.1-2025-04-14") => ({ id, ts, provider: "openai", model, cost_usd: cost });
const AC1 = [oa("a", `${D1}T10:00:00Z`, 4), oa("b", `${D1}T23:59:00Z`, 6), oa("c", `${D2}T01:00:00Z`, 5)];

test("normalizeModel strips dated snapshots", () => {
  assert.equal(normalizeModel("gpt-4.1-2025-04-14"), "gpt-4.1");
  assert.equal(normalizeModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(normalizeModel(" "), null);
  assert.equal(normalizeModel(undefined), null);
});

test("OpenAI costs parser buckets by UTC day and line_item model", () => {
  const rows = parseOpenAICosts(fx("openai-costs.sample.json"));
  assert.deepEqual(rows.map((r) => [r.day, r.model, r.usd]), [[D1, "gpt-4.1", 4.1], [D1, "gpt-4.1", 6], [D2, "gpt-4.1", 9]]);
  assert.equal(parseOpenAICosts(fx("openai-costs.sample.json"), { project: "other" }).length, 0);
  assert.equal(parseOpenAICosts([{ data: [{ start_time: 1793318400, results: [{ amount: { value: 1 }, line_item: "web search tool calls" }] }] }])[0].model, null);
  assert.throws(() => parseOpenAICosts({}), /data list/);
  assert.throws(() => parseOpenAICosts({ data: [{ results: [] }] }), /start_time/);
  assert.throws(() => parseOpenAICosts({ data: [{ start_time: 1, results: [{ amount: { value: 1, currency: "eur" } }] }] }), /currency/);
  assert.throws(() => parseOpenAICosts({ data: [{ start_time: 1, results: [{ amount: { value: "x" } }] }] }), /finite/);
  assert.throws(() => parseOpenAICosts(5), /JSON object/);
});

test("Anthropic cost report parser converts cents and filters workspace", () => {
  const rows = parseAnthropicCostReport(fx("anthropic-cost-report.sample.json"));
  assert.deepEqual(rows.map((r) => [r.day, r.model, r.usd]), [[D2, "claude-sonnet-4-5", 3], [D2, "claude-sonnet-4-5", 5]]);
  assert.equal(parseAnthropicCostReport(fx("anthropic-cost-report.sample.json"), { workspace: "x" }).length, 0);
  assert.throws(() => parseAnthropicCostReport({}), /data list/);
  assert.throws(() => parseAnthropicCostReport({ data: [{ results: [] }] }), /starting_at/);
  assert.throws(() => parseAnthropicCostReport({ data: [{ starting_at: D1, results: [{ currency: "EUR", amount: "1" }] }] }), /currency/);
  assert.throws(() => parseExport("gemini", {}), /--provider/);
});

test("AC1: day 1 match, day 2 unmetered_spend, verdict unmetered_spend", () => {
  const r = billCheck({ receipts: AC1, billed: parseExport("openai", fx("openai-costs.sample.json")), provider: "openai", tolerancePct: 5 });
  assert.equal(r.verdict, "unmetered_spend");
  assert.equal(r.ok, false);
  assert.equal(r.rows[0].status, "match");
  assert.equal(r.rows[0].delta_pct.toFixed(2), "-0.99");
  assert.equal(r.rows[1].status, "unmetered_spend");
  assert.equal(r.rows[1].delta_usd, -4);
  assert.equal(r.totals.metered_usd, 15);
  assert.equal(r.totals.billed_usd, 19.1);
  assert.match(formatBillCheck(r), /unmetered_spend/);
});

test("AC2: Anthropic agrees within tolerance; unmapped USD prevents match", () => {
  const receipts = [{ id: "x", ts: `${D2}T05:00:00Z`, provider: "anthropic", model: "claude-sonnet-4-5-20250929", cost_usd: 7.9 }];
  const billed = parseExport("anthropic", fx("anthropic-cost-report.sample.json"));
  const ok = billCheck({ receipts, billed, provider: "anthropic" });
  assert.equal(ok.verdict, "match");
  const withUnmapped = billCheck({ receipts, billed: [...billed, { day: D2, model: null, line_item: "Web Search", usd: 2 }], provider: "anthropic" });
  assert.deepEqual(withUnmapped.unmapped, [{ day: D2, line_item: "Web Search", usd: 2 }]);
  assert.equal(withUnmapped.verdict, "unmetered_spend");
  // Tiny unmapped within tolerance is still a match.
  assert.equal(billCheck({ receipts, billed: [...billed, { day: D2, model: null, line_item: "x", usd: 0.01 }], provider: "anthropic" }).verdict, "match");
});

test("AC3: unknown receipts make the verdict incomplete and never count as $0; settlements count", () => {
  const r = billCheck({ receipts: [...AC1, oa("u", `${D1}T11:00:00Z`, null)], billed: parseExport("openai", fx("openai-costs.sample.json")), provider: "openai" });
  assert.equal(r.verdict, "incomplete");
  assert.equal(r.totals.unknown_count, 1);
  assert.equal(r.rows[0].metered_usd, 10);
  assert.equal(r.rows[0].status, "incomplete");
  const dir = mkdtempSync(join(tmpdir(), "bc-"));
  const p = join(dir, "r.jsonl");
  writeFileSync(p, [oa("a", `${D1}T10:00:00Z`, null), { event: "reconciliation", receipt_id: "a", cost_usd: 10.1, source: "provider_file" }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const s = billCheckFiles({ receiptsPath: p, exportDoc: fx("openai-costs.sample.json"), provider: "openai", until: D1 });
  assert.equal(s.verdict, "match");
  assert.equal(s.rows[0].metered_usd, 10.1);
});

test("AC4: window and metered_only / billed_only / over_metered", () => {
  const billed = [{ day: D1, model: "gpt-4.1", usd: 1 }, { day: D2, model: "gpt-4o", usd: 2 }];
  const receipts = [oa("a", `${D1}T00:00:00Z`, 3), oa("b", `${D2}T00:00:00Z`, 1, "gpt-4.1"), oa("z", "2026-11-05T00:00:00Z", 9), { id: "q", ts: `${D1}T00:00:00Z`, provider: "anthropic", model: "m", cost_usd: 1 }];
  const r = billCheck({ receipts, billed, provider: "openai", since: D1, until: D2 });
  assert.deepEqual(r.rows.map((x) => [x.day, x.model, x.status]), [[D1, "gpt-4.1", "over_metered"], [D2, "gpt-4.1", "metered_only"], [D2, "gpt-4o", "billed_only"]]);
  assert.equal(r.rows[2].metered_usd, 0);
  assert.equal(r.verdict, "unmetered_spend");
  assert.equal(billCheck({ receipts: [oa("a", `${D1}T00:00:00Z`, 3)], billed: [{ day: D1, model: "gpt-4.1", usd: 1 }], provider: "openai" }).verdict, "over_metered");
  assert.equal(billCheck({ receipts: [oa("a", `${D1}T00:00:00Z`, 0)], billed: [], provider: "openai" }).verdict, "match");
  assert.throws(() => billCheck({ receipts: [], billed: [], provider: "openai", since: "yesterday" }), /YYYY-MM-DD/);
  assert.throws(() => billCheck({ receipts: [], billed: [], provider: "x" }), /--provider/);
  assert.throws(() => billCheck({ receipts: [], billed: [], provider: "openai", tolerancePct: -1 }), /tolerance/);
  assert.throws(() => billCheck({ receipts: [oa("a", `${D1}T00:00:00Z`, "1")], billed: [], provider: "openai" }), /number or null/);
});

test("argument parsing", () => {
  const o = parseBillCheckArgs(["--receipts", "r", "--provider", "openai", "--provider-export", "e", "--since", D1, "--until", D2, "--tolerance-pct", "2", "--json", "--project", "p", "--workspace", "w"]);
  assert.equal(o.tolerancePct, 2);
  assert.throws(() => parseBillCheckArgs(["--receipts", "r", "--provider", "openai"]), /exactly one/);
  assert.throws(() => parseBillCheckArgs(["--receipts", "r", "--provider", "x", "--fetch"]), /--provider/);
  assert.throws(() => parseBillCheckArgs(["--provider", "openai", "--fetch"]), /--receipts/);
  assert.throws(() => parseBillCheckArgs(["--provider"]), /needs a value/);
  assert.throws(() => parseBillCheckArgs(["--bogus"]), /unknown option/);
  assert.throws(() => parseBillCheckArgs(["--tolerance-pct", "abc"]), /tolerance/);
});

test("command returns 2 on bad input and fetch validates env", async () => {
  const errs = [];
  assert.equal(await billCheckCommand(["--receipts", "/nonexistent", "--provider", "openai", "--fetch"], { env: {}, out: () => {}, err: (m) => errs.push(m) }), 2);
  assert.match(errs[0], /COSTCAP_OPENAI_ADMIN_KEY/);
  await assert.rejects(fetchExport({ provider: "anthropic", env: { COSTCAP_ANTHROPIC_ADMIN_KEY: "k" } }), /--since/);
  await assert.rejects(fetchExport({ provider: "x", env: {} }), /--provider/);
});
