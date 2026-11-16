// Issue #225: run outcomes and wasted spend. Pure, no I/O.
// A run-end record comes from an enrolled `costcap wrap` when its child exits.
// The outcome is only the exit code, the stop reason or an explicit override;
// task quality is never judged. Unknown cost is never counted as $0.

export const STOP_REASONS = ["exited", "cap_hit", "kill_switch", "spiral", "velocity", "step_budget"];
export const OUTCOMES = ["success", "failure", "killed", "unknown"];
export const OVERRIDE_OUTCOMES = ["success", "failure"];
const SIGNAL = /^signal:[A-Z0-9]{2,16}$/;
const RUN_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const bad = (message) => { const err = new Error(message); err.status = 400; return err; };

export const validStopReason = (v) => STOP_REASONS.includes(v) || (typeof v === "string" && SIGNAL.test(v));

// success = exit 0 + exited; failure = non-zero + exited; killed = any guardrail,
// kill or signal stop; unknown = no record. An override wins over the derivation.
export function deriveOutcome(runEnd, override = null) {
  if (override && OVERRIDE_OUTCOMES.includes(override.outcome)) return override.outcome;
  if (!runEnd || !validStopReason(runEnd.stop_reason)) return "unknown";
  if (runEnd.stop_reason !== "exited") return "killed";
  if (!Number.isInteger(runEnd.exit_code)) return "unknown";
  return runEnd.exit_code === 0 ? "success" : "failure";
}

// Local wrap → stop_reason, from the run summary's first stopping receipt reason,
// the costcap kill watcher, or the signal that ended the child.
export function stopReasonFor({ killed = false, reason = null, signal = null } = {}) {
  if (killed || reason === "killed") return "kill_switch";
  if (reason === "budget_exceeded") return "cap_hit";
  if (reason === "breaker_open") return "spiral";
  if (reason === "cost_velocity") return "velocity";
  if (reason === "step_budget") return "step_budget";
  if (typeof signal === "string" && SIGNAL.test(`signal:${signal}`)) return `signal:${signal}`;
  return "exited";
}

const isoOrBad = (v, key) => { if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) throw bad(`${key} must be an ISO timestamp`); return v; };
const countOrBad = (v, key) => { if (!Number.isInteger(v) || v < 0) throw bad(`${key} must be a non-negative integer`); return v; };

export function parseRunEnd(body) {
  if (!body || typeof body !== "object") throw bad("Run-end body required");
  if (typeof body.run_id !== "string" || !RUN_ID.test(body.run_id)) throw bad("run_id is required");
  if (!validStopReason(body.stop_reason)) throw bad(`stop_reason must be one of ${STOP_REASONS.join("|")} or signal:<NAME>`);
  if (body.exit_code !== null && !(Number.isInteger(body.exit_code) && body.exit_code >= 0 && body.exit_code <= 255)) throw bad("exit_code must be an integer 0-255 or null");
  if (body.usd_known !== null && !(typeof body.usd_known === "number" && Number.isFinite(body.usd_known) && body.usd_known >= 0)) throw bad("usd_known must be a non-negative number or null");
  const out = {
    run_id: body.run_id, started_at: isoOrBad(body.started_at, "started_at"), ended_at: isoOrBad(body.ended_at, "ended_at"),
    exit_code: body.exit_code, stop_reason: body.stop_reason,
    calls: countOrBad(body.calls, "calls"), usd_known: body.usd_known === null ? null : round6(body.usd_known), unknown_count: countOrBad(body.unknown_count, "unknown_count"),
  };
  if (Date.parse(out.ended_at) < Date.parse(out.started_at)) throw bad("ended_at must not be before started_at");
  return out;
}

export function parseOutcomeOverride(body) {
  if (!body || !OVERRIDE_OUTCOMES.includes(body.outcome)) throw bad("outcome must be success or failure");
  if (body.note !== undefined && body.note !== null && (typeof body.note !== "string" || body.note.length > 500)) throw bad("note must be a string up to 500 characters");
  return { outcome: body.outcome, note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : null };
}

// Idempotent upsert keyed by (agent_id, run_id). Same record: no-op. A changed
// record for the same run is a 409 (the run already ended differently).
export function upsertRunEnd(map, { orgId, agentId }, runEnd, nowIso) {
  const key = `${agentId}:${runEnd.run_id}`;
  const existing = map[key];
  if (existing) {
    const same = JSON.stringify(existing.run_end) === JSON.stringify(runEnd);
    if (same) return { key, duplicate: true };
    const err = new Error("Run already ended with different values"); err.status = 409; throw err;
  }
  map[key] = { orgId, agentId, run_end: runEnd, received_at: nowIso, override: null };
  return { key, duplicate: false };
}

// The fields a hosted run gains. A missing record leaves them null, outcome unknown.
export function runOutcomeFields(record) {
  const re = record?.run_end ?? null;
  return {
    ended_at: re?.ended_at ?? null, exit_code: re ? re.exit_code : null, stop_reason: re?.stop_reason ?? null,
    outcome: deriveOutcome(re, record?.override), outcome_override: record?.override ?? null,
  };
}

// usd_known / success_count. "—" with zero successes, "≥" when any unknown cost exists.
export function costPerSuccess(usdKnown, successCount, lowerBound) {
  if (!successCount) return { usd: null, lower_bound: Boolean(lowerBound), label: "—" };
  const usd = round6(usdKnown / successCount);
  return { usd, lower_bound: Boolean(lowerBound), label: `${lowerBound ? "≥" : ""}$${usd.toFixed(usd < 1 ? 4 : 2)}` };
}

// Agent-card figures over receipts already windowed to the last 30 days.
// items: [{ agentId, receipt, settlement? }]. outcomeOf(agentId, runId) → outcome.
export function outcomeSummary(items, outcomeOf) {
  const runs = new Map();
  for (const item of items) {
    const r = item?.receipt;
    if (!r || !Number.isFinite(Date.parse(r.ts))) continue;
    const runId = typeof r.run_id === "string" && r.run_id ? r.run_id : null;
    const key = runId ? `${item.agentId}:${runId}` : null;
    const run = key ? (runs.get(key) ?? runs.set(key, { outcome: outcomeOf(item.agentId, runId), usd: 0, unknown: 0 }).get(key)) : null;
    const settled = item.settlement?.cost_usd;
    const cost = r.cost_usd == null ? (typeof settled === "number" && Number.isFinite(settled) ? settled : null) : r.cost_usd;
    const target = run ?? { outcome: "unknown", usd: 0, unknown: 0 };
    if (typeof cost === "number" && Number.isFinite(cost)) target.usd += cost; else target.unknown += 1;
    if (!run) runs.set(`\u0000${runs.size}`, target);
  }
  let total = 0, wasted = 0, successUsd = 0, successes = 0, wastedUnknown = false, successUnknown = false;
  for (const run of runs.values()) {
    total += run.usd;
    if (run.outcome === "failure" || run.outcome === "killed") { wasted += run.usd; if (run.unknown) wastedUnknown = true; }
    if (run.outcome === "success") { successes += 1; successUsd += run.usd; if (run.unknown) successUnknown = true; }
  }
  return {
    window_days: 30,
    wasted_usd: round6(wasted), wasted_lower_bound: wastedUnknown,
    wasted_share: total > 0 ? Math.round((wasted / total) * 1000) / 10 : 0,
    total_usd: round6(total), success_runs: successes,
    cost_per_success: costPerSuccess(successUsd, successes, successUnknown),
  };
}
