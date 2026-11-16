import { applySettlements } from "./cap.js";
// Local per-run JSON summary (costcap.run-summary/v1): calls, tokens and cost per
// model, unknown-cost count, caps and stop reason. Written to <ledger-dir>/runs/.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA = "costcap.run-summary/v1";
const BREAKER = new Set(["breaker_open", "step_budget", "cost_velocity"]);
const r6 = (n) => Number(n.toFixed(6));

export function stopReason(reason) {
  if (reason === "killed") return "killed";
  if (reason === "budget_exceeded") return "budget_exceeded";
  if (BREAKER.has(reason)) return "breaker_open";
  return null;
}

// Build a summary from this run's receipt lines (event lines are ignored).
export function buildRunSummary({ run_id, started_at, ended_at, exit_code = null, receipts = [], caps = {}, spend = {}, killed = false, kill = null, warnings = [] }) {
  const by_model = {};
  let calls = 0, blocked_calls = 0, rejected_calls = 0, unknown_cost_calls = 0, total = 0;
  let stopped_by = killed ? "killed" : null, stopped_scope = killed ? (kill?.kill_scope ?? null) : null;
  let killInfo = killed && kill?.kill_scope ? { kill_scope: kill.kill_scope, kill_file: kill.kill_file } : null;
  for (const r of applySettlements(receipts.filter(Boolean))) {
    if (r.blocked) {
      blocked_calls++;
      const s = stopReason(r.reason);
      if (s && !stopped_by) { stopped_by = s; stopped_scope = r.scope ?? r.kill_scope ?? null; }
      if (s === "killed" && !killInfo && r.kill_scope) killInfo = { kill_scope: r.kill_scope, kill_file: r.kill_file };
      continue;
    }
    calls++;
    if (r.reason === "upstream_rejected") rejected_calls++;
    const m = r.model ?? "unknown";
    const b = (by_model[m] ??= { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 });
    b.calls++;
    b.input_tokens += r.input_tokens ?? 0;
    b.output_tokens += r.output_tokens ?? 0;
    b.cache_read_tokens += r.cached_input_tokens ?? 0;
    b.cache_write_tokens += (r.cache_write_input_tokens ?? 0) + (r.cache_write_1h_input_tokens ?? 0);
    // #148: where each model's cost came from (provider-reported, table or fallback rate); "mixed" if it varied.
    if (r.cost_source) b.cost_source = b.cost_source && b.cost_source !== r.cost_source ? "mixed" : r.cost_source;
    if (r.cost_usd == null) { unknown_cost_calls++; b.cost_usd = null; }
    else { total += r.cost_usd; if (b.cost_usd !== null) b.cost_usd = r6(b.cost_usd + r.cost_usd); }
  }
  const capsOut = {};
  for (const scope of ["run", "day", "month"]) {
    if (caps[scope] != null) capsOut[scope] = { limit_usd: caps[scope], spent_usd: r6(spend[scope] ?? 0) };
  }
  return {
    schema: SCHEMA, run_id, started_at, ended_at, exit_code, calls, blocked_calls, rejected_calls, by_model,
    total_cost_usd: unknown_cost_calls > 0 ? null : r6(total), unknown_cost_calls,
    caps: capsOut, warnings: warnings.map(({ scope, fraction, cap, spent_usd, period, lower_bound }) => ({ scope, fraction, cap, spent_usd, period, lower_bound })), stopped_by, ...(stopped_scope ? { stopped_scope } : {}), ...(killInfo ?? {}),
  };
}

export function rollupLine(s) {
  const cost = s.total_cost_usd === null
    ? `unknown (${s.unknown_cost_calls} unpriced call${s.unknown_cost_calls === 1 ? "" : "s"})`
    : `$${s.total_cost_usd.toFixed(4)}`;
  const stop = s.stopped_by ? ` stopped_by=${s.stopped_by}${s.stopped_scope ? `:${s.stopped_scope}` : ""}` : "";
  return `costcap: run ${s.run_id} calls=${s.calls} rejected=${s.rejected_calls ?? 0} refused=${s.blocked_calls} models=${Object.keys(s.by_model).length} cost=${cost}${stop}`;
}

export const runsDir = (receiptsPath) => join(dirname(receiptsPath), "runs");

export function writeRunSummary(receiptsPath, summary) {
  const dir = runsDir(receiptsPath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${summary.run_id}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  return file;
}

// List summaries newest first. Corrupt files are reported in `errors`, never thrown.
export function listRunSummaries(receiptsPath) {
  const dir = runsDir(receiptsPath);
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return { runs: [], errors: [] }; }
  const runs = [], errors = [];
  for (const n of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, n), "utf8"));
      if (s?.schema !== SCHEMA || typeof s.run_id !== "string") throw new Error("not a run summary");
      runs.push(s);
    } catch (e) { errors.push({ file: n, error: e.message }); }
  }
  runs.sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)));
  return { runs, errors };
}

// `costcap runs [--json] [--receipts FILE]`
export function runsCommand(argv, { log = console.log, warn = console.error } = {}) {
  const i = argv.indexOf("--receipts");
  const { runs, errors } = listRunSummaries(i !== -1 && argv[i + 1] ? argv[i + 1] : ".costcap/receipts.jsonl");
  for (const e of errors) warn(`costcap: skipped corrupt run summary ${e.file}: ${e.error}`);
  if (argv.includes("--json")) log(JSON.stringify(runs, null, 2));
  else if (!runs.length) log("no runs recorded");
  else for (const r of runs) {
    const cost = r.total_cost_usd === null ? "unknown" : `$${Number(r.total_cost_usd).toFixed(4)}`;
    log(`${r.ended_at}  ${r.run_id}  calls=${r.calls}  cost=${cost}${r.stopped_by ? `  stopped_by=${r.stopped_by}` : ""}`);
  }
  return { runs, errors };
}
