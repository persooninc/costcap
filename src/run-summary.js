// Local per-run JSON summary (costcap.run-summary/v1, #119).
// Built only from this run's receipt lines, written next to the ledger as
// <ledger-dir>/runs/<run_id>.json. Unknown cost is never summed as $0: one
// null-cost call makes total_cost_usd null.
//
// Public API: buildRunSummary, rollupLine, writeRunSummary, listRunSummaries,
// runsDirFor. Deps: node:fs, node:path only.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA = "costcap.run-summary/v1";
const BREAKER_REASONS = new Set(["breaker_open", "step_budget", "cost_velocity", "spiral_detected"]);
const round6 = (n) => Number(n.toFixed(6));

export const runsDirFor = (receiptsPath) => join(dirname(receiptsPath), "runs");

// Maps a blocked receipt to a stop cause, or null when it is not a stop cause.
function stopCause(r) {
  if (r.reason === "killed") return { stopped_by: "killed", scope: null };
  if (r.reason === "budget_exceeded") return { stopped_by: "budget_exceeded", scope: r.scope ?? null };
  if (BREAKER_REASONS.has(r.reason)) return { stopped_by: "breaker_open", scope: r.reason };
  return null;
}

// Build a summary from this run's receipt lines (event lines are ignored).
export function buildRunSummary({ run_id, started_at, ended_at, exit_code = null, receipts = [], caps = {}, spend = {}, killed = false, kill = null, warnings = [], cacheEnabled = false }) {
  const by_model = {};
  let calls = 0, blocked_calls = 0, rejected_calls = 0, unknown_cost_calls = 0, total = 0, downgraded_calls = 0;
  let stopped_by = killed ? "killed" : null, stopped_scope = killed ? (kill?.kill_scope ?? null) : null;
  const cache = { hits: 0, misses: 0, saved_usd: 0 };
  let cacheSeen = cacheEnabled;
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
    // #207: forwarded on a cheaper model because a cap fraction was reached.
    if (r.requested_model && r.downgrade && typeof r.downgrade === "object") downgraded_calls++;
    // #184: cache hits are $0 calls; saved_usd is reported, never added to cost.
    if (r.cache) cacheSeen = true;
    if (r.cache === "hit") { cache.hits++; if (Number.isFinite(r.saved_usd)) cache.saved_usd = r6(cache.saved_usd + r.saved_usd); }
    else if (r.cache === "miss") cache.misses++;
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
  if (killed) cause = { stopped_by: "killed", scope: null };
  const capOut = {};
  for (const scope of ["run", "day", "month"]) {
    if (caps[scope] != null || spent[scope] != null) capOut[scope] = { limit_usd: caps[scope] ?? null, spent_usd: spent[scope] != null ? round6(spent[scope]) : null };
  }
  return {
    schema: SCHEMA, run_id, started_at, ended_at, exit_code, calls, blocked_calls, rejected_calls, by_model,
    total_cost_usd: unknown_cost_calls > 0 ? null : r6(total), unknown_cost_calls, ...(downgraded_calls ? { downgraded_calls } : {}),
    caps: capsOut, warnings: warnings.map(({ scope, fraction, cap, spent_usd, period, lower_bound }) => ({ scope, fraction, cap, spent_usd, period, lower_bound })), stopped_by, ...(cacheSeen ? { cache } : {}), ...(stopped_scope ? { stopped_scope } : {}), ...(killInfo ?? {}),
  };
}

export function rollupLine(s) {
  const cost = s.total_cost_usd === null
    ? `unknown (${s.unknown_cost_calls} unpriced call${s.unknown_cost_calls === 1 ? "" : "s"})`
    : `$${s.total_cost_usd.toFixed(4)}`;
  const saved = s.cache?.hits > 0 ? ` · cache: ${s.cache.hits} hit${s.cache.hits === 1 ? "" : "s"}, saved $${s.cache.saved_usd.toFixed(4)}` : "";
  const stop = s.stopped_by ? ` stopped_by=${s.stopped_by}${s.stopped_scope ? `:${s.stopped_scope}` : ""}` : "";
  return `costcap: run ${s.run_id} calls=${s.calls} rejected=${s.rejected_calls ?? 0} refused=${s.blocked_calls} models=${Object.keys(s.by_model).length} cost=${cost}${s.downgraded_calls ? ` downgraded=${s.downgraded_calls}` : ""}${stop}${saved}`;
}

export function writeRunSummary(receiptsPath, summary) {
  const dir = runsDirFor(receiptsPath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${summary.run_id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

// Newest first by ended_at. Corrupt files are reported in `errors`, never thrown.
export function listRunSummaries(receiptsPath, { limit = 20 } = {}) {
  const dir = runsDirFor(receiptsPath);
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return { runs: [], errors: [] }; }
  const runs = [], errors = [];
  for (const name of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (s?.schema !== SCHEMA || !Number.isFinite(Date.parse(s.ended_at))) throw new Error("not a costcap.run-summary/v1 file");
      runs.push(s);
    } catch (err) { errors.push({ file: name, error: err.message }); }
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
    log(`${r.ended_at}  ${r.run_id}  calls=${r.calls}  cost=${cost}${r.downgraded_calls ? `  downgraded=${r.downgraded_calls}` : ""}${r.stopped_by ? `  stopped_by=${r.stopped_by}` : ""}`);
  }
  return { runs, errors };
}
