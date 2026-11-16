import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { receiptsCommand, parseTime } from "../src/receipts-cli.js";

const NOW = new Date("2026-11-15T00:00:00Z");
const day = (n) => new Date(NOW.getTime() - n * 86400e3).toISOString();
const lines = [
  { id: "r-old", ts: day(30), agent_id: "nightlyqa", run_id: "run1", model: "gpt-x", cost_usd: 0.5 },
  { id: "r-b", ts: day(2), agent_id: "nightlyqa", run_id: "run2", model: "gpt-x", cost_usd: 0.25 },
  { id: "r-a", ts: day(5), agent_id: "other", run_id: "run3", model: "=HYPERLINK(\"x\")", cost_usd: 0.1 },
  { id: "r-unk", ts: day(1), agent_id: "nightlyqa", run_id: "run2", model: "@evil", cost_usd: null },
  { id: "r-set", ts: day(3), agent_id: "nightlyqa", run_id: "run2", model: "+m", cost_usd: null },
  { event: "kill", ts: day(1), note: "-boom" },
  { event: "resume", ts: day(1) },
  { event: "reconciliation", receipt_id: "r-set", cost_usd: 0.07, source: "provider_file", ts: day(0) },
];
function ledger() {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rcpt-"));
  const file = path.join(dir, "receipts.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, file };
}
function run(argv) {
  const out = []; const err = [];
  const code = receiptsCommand(argv, { log: (s) => out.push(s), warn: (s) => err.push(s), now: NOW });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const ids = (r) => JSON.parse(r.out).map((x) => x.receipt_id);

test("lists receipts oldest first and skips event lines", () => {
  const { file } = ledger();
  const r = run(["--receipts", file, "--json"]);
  assert.equal(r.code, 0);
  assert.deepEqual(ids(r), ["r-old", "r-a", "r-set", "r-b", "r-unk"]);
});

test("filters: since, until, agent, run-id", () => {
  const { file } = ledger();
  assert.deepEqual(ids(run(["--receipts", file, "--json", "--since", "14d"])), ["r-a", "r-set", "r-b", "r-unk"]);
  assert.deepEqual(ids(run(["--receipts", file, "--json", "--until", day(4)])), ["r-old", "r-a"]);
  assert.deepEqual(ids(run(["--receipts", file, "--json", "--agent", "nightlyqa", "--since", "14d"])), ["r-set", "r-b", "r-unk"]);
  assert.deepEqual(ids(run(["--receipts", file, "--json", "--run-id", "run2"])), ["r-set", "r-b", "r-unk"]);
  assert.equal(parseTime("24h", "--since", NOW), NOW.getTime() - 86400e3);
});

test("unknown cost prints unknown, never 0; settled shows settled_cost_usd", () => {
  const { file } = ledger();
  const r = run(["--receipts", file, "--run-id", "run2"]);
  assert.match(r.out, /r-unk .*cost=unknown/);
  assert.doesNotMatch(r.out, /r-unk .*\$0\.0000/);
  assert.match(r.out, /r-set .*settled_cost_usd=\$0\.0700/);
  const json = JSON.parse(run(["--receipts", file, "--json", "--run-id", "run2"]).out);
  assert.equal(json.find((x) => x.receipt_id === "r-unk").cost_usd, null);
  assert.equal(json.find((x) => x.receipt_id === "r-set").settled_cost_usd, 0.07);
});

test("CSV export escapes formula cells (=, +, -, @)", () => {
  const { file } = ledger();
  const r = run(["--receipts", file, "--export", "csv"]);
  assert.equal(r.code, 0);
  const rows = r.out.split("\n");
  assert.equal(rows[0], "ts,agent_id,receipt_id,model,cost_usd,cost_source,settled_cost_usd,settle_source,reason,scope");
  assert.equal(rows.length, 6);
  assert.match(r.out, /'=HYPERLINK/);
  assert.match(r.out, /,'@evil,/);
  assert.match(r.out, /,'\+m,/);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-rcpt-"));
  const f2 = path.join(dir, "r.jsonl");
  writeFileSync(f2, JSON.stringify({ id: "x", ts: day(1), agent_id: "-a", cost_usd: 1 }) + "\n");
  assert.match(run(["--receipts", f2, "--export", "csv"]).out, /,'-a,/);
});

test("exit codes: zero matches is 0 (CSV header only), bad time or unreadable ledger is 2", () => {
  const { file, dir } = ledger();
  const none = run(["--receipts", file, "--export", "csv", "--agent", "nobody"]);
  assert.equal(none.code, 0);
  assert.equal(none.out.split("\n").length, 1);
  assert.equal(run(["--receipts", file, "--since", "yesterday"]).code, 2);
  assert.equal(run(["--receipts", file, "--until", "nope"]).code, 2);
  const missing = run(["--receipts", path.join(dir, "missing.jsonl")]);
  assert.equal(missing.code, 2);
  assert.equal(missing.err.split("\n").length, 1);
  const bad = path.join(dir, "bad.jsonl"); writeFileSync(bad, "{not json\n");
  assert.equal(run(["--receipts", bad]).code, 2);
});

test("runbook commands run as written against a fixture ledger (CLI)", () => {
  const { dir } = ledger();
  const cwd = mkdtempSync(path.join(tmpdir(), "cc-rb-"));
  mkdirSync(path.join(cwd, ".costcap"));
  const now = new Date();
  const fixture = [
    { id: "n1", ts: new Date(now - 2 * 86400e3).toISOString(), agent_id: "nightlyqa", run_id: "a", model: "m", cost_usd: 0.2 },
    { id: "n2", ts: new Date(now - 20 * 86400e3).toISOString(), agent_id: "nightlyqa", run_id: "b", model: "m", cost_usd: 0.3 },
    { id: "o1", ts: new Date(now - 1 * 86400e3).toISOString(), agent_id: "other", run_id: "c", model: "m", cost_usd: null },
  ];
  writeFileSync(path.join(cwd, ".costcap/receipts.jsonl"), fixture.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const cli = path.resolve("src/cli.js");
  const a = spawnSync("sh", ["-c", `node ${cli} receipts --since 14d --agent nightlyqa`], { cwd, encoding: "utf8" });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /n1/); assert.doesNotMatch(a.stdout, /n2|o1/);
  const b = spawnSync("sh", ["-c", `node ${cli} receipts --export csv --since 14d > dogfood-receipts.csv && cat dogfood-receipts.csv`], { cwd, encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout.trim().split("\n").length, 3);
  const help = spawnSync("node", [cli, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /costcap receipts/);
  void dir;
});
