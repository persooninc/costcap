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

export function buildRunSummary({ runId, startedAt, endedAt, exitCode, receipts = [], caps = {}, spent = {}, killed = false }) {
  const byModel = {};
  let calls = 0, blocked = 0, unknown = 0, total = 0, cause = null;
  for (const r of receipts) {
    if (r.event) continue;
    if (r.blocked) { blocked += 1; cause = stopCause(r) ?? cause; continue; }
    calls += 1;
    const m = (byModel[r.model ?? "unknown"] ??= { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 });
    m.calls += 1;
    m.input_tokens += r.input_tokens ?? 0;
    m.output_tokens += r.output_tokens ?? 0;
    m.cache_read_tokens += r.cached_input_tokens ?? 0;
    m.cache_write_tokens += (r.cache_write_input_tokens ?? 0) + (r.cache_write_1h_input_tokens ?? 0);
    if (r.cost_usd === null || r.cost_usd === undefined) { unknown += 1; m.cost_usd = null; }
    else { total += r.cost_usd; if (m.cost_usd !== null) m.cost_usd = round6(m.cost_usd + r.cost_usd); }
  }
  if (killed) cause = { stopped_by: "killed", scope: null };
  const capOut = {};
  for (const scope of ["run", "day", "month"]) {
    if (caps[scope] != null || spent[scope] != null) capOut[scope] = { limit_usd: caps[scope] ?? null, spent_usd: spent[scope] != null ? round6(spent[scope]) : null };
  }
  return {
    schema: SCHEMA,
    run_id: runId,
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: exitCode,
    calls,
    blocked_calls: blocked,
    by_model: byModel,
    total_cost_usd: unknown > 0 ? null : round6(total),
    unknown_cost_calls: unknown,
    caps: capOut,
    stopped_by: cause?.stopped_by ?? null,
    stopped_scope: cause?.scope ?? null,
  };
}

export function rollupLine(s) {
  const cost = s.total_cost_usd === null ? `unknown (${s.unknown_cost_calls} unpriced call${s.unknown_cost_calls === 1 ? "" : "s"})` : `$${s.total_cost_usd.toFixed(4)}`;
  const models = Object.keys(s.by_model).length;
  const stop = s.stopped_by ? `, stopped by ${s.stopped_by}${s.stopped_scope ? ` (${s.stopped_scope})` : ""}` : "";
  return `costcap: run ${s.run_id}: ${s.calls} call${s.calls === 1 ? "" : "s"} across ${models} model${models === 1 ? "" : "s"}, ${s.blocked_calls} refused, cost ${cost}${stop}`;
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
  runs.sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at));
  return { runs: runs.slice(0, limit), errors };
}
