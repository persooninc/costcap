// Alert rules for the hosted dashboard (story #14). Pure logic: given an
// agent's state, returns the alerts that should fire now. The caller sends
// them (Brevo email, Slack) and writes the audit log. Dedupe: an alert
// with the same key does not fire again until it clears and re-arms.

export const ALERT_KINDS = ["cap_approaching", "cap_hit", "loop_detected", "agent_silent", "cap_projected"];

// state: { agentId, caps:{run,day,month}, spend:{run,day,month},
//          blockedReasons:[...recent blocked receipts' reason/error],
//          lastSeenMs, nowMs }
// Month burn-rate projection (issue #109). Linear: month-to-date spend divided
// by the elapsed share of the UTC month. Returns null before minElapsedMs so a
// first-hour burst does not page. Unknown-cost receipts are not counted as
// zero; the caller reports them and the projection is then a lower bound.
export function projectMonthSpend(spent, nowMs, { minElapsedMs = 24 * 3600_000 } = {}) {
  if (typeof spent !== "number" || !Number.isFinite(spent) || !Number.isFinite(nowMs)) return null;
  const now = new Date(nowMs);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = nowMs - start;
  if (elapsed < minElapsedMs) return null;
  return spent * ((end - start) / elapsed);
}

export const DEFAULT_SILENT_AFTER_HOURS = 6;

// Issue #134: per-agent override. null/undefined -> default, 0 -> off (returns Infinity).
export function silentAfterMsFor(policy) {
  const h = policy?.silentAfterHours;
  if (h == null) return DEFAULT_SILENT_AFTER_HOURS * 3600_000;
  return h === 0 ? Infinity : h * 3600_000;
}

export function evaluateAlerts(state, { approachFraction = 0.8, silentAfterMs = DEFAULT_SILENT_AFTER_HOURS * 3600_000, minProjectionMs = 24 * 3600_000 } = {}) {
  const out = [];
  for (const scope of ["run", "day", "month"]) {
    const cap = state.caps?.[scope];
    if (typeof cap !== "number" || !Number.isFinite(cap)) continue;
    const spent = state.spend?.[scope] ?? 0;
    if (typeof spent !== "number" || !Number.isFinite(spent)) continue;
    if (spent >= cap) out.push({ kind: "cap_hit", scope, key: `cap_hit:${state.agentId}:${scope}`, cap, spent });
    else if (spent >= cap * approachFraction) out.push({ kind: "cap_approaching", scope, key: `cap_approaching:${state.agentId}:${scope}`, cap, spent });
  }
  const monthCap = state.caps?.month;
  if (typeof monthCap === "number" && Number.isFinite(monthCap) && !out.some((a) => a.scope === "month")) {
    const projected = projectMonthSpend(state.spend?.month, state.nowMs, { minElapsedMs: minProjectionMs });
    if (projected !== null && projected >= monthCap) {
      const unknown = state.unknown?.month ?? 0;
      out.push({ kind: "cap_projected", scope: "month", key: `cap_projected:${state.agentId}:month`, cap: monthCap, spent: state.spend.month, projected: Number(projected.toFixed(6)), lowerBound: unknown > 0 });
    }
  }
  // Step budget is the third shipped loop guardrail, with spiral and velocity.
  // Accounting gaps and ordinary cap or kill blocks are not loops.
  // The named reason is stable: spiral, then velocity, then step budget.
  const loopOrder = ["spiral_detected", "cost_velocity", "step_budget"];
  const blocked = state.blockedReasons ?? [];
  const loopReason = loopOrder.find((reason) => blocked.includes(reason));
  if (loopReason) {
    out.push({ kind: "loop_detected", key: `loop_detected:${state.agentId}`, reason: loopReason });
  }
  // A local run cap is not a day or month sum. The proxy records that block
  // as budget_exceeded plus a scope. Page that scope once, without turning
  // every budget block into a loop alert.
  for (const scope of ["run", "day", "month"]) {
    if (out.some((alert) => alert.kind === "cap_hit" && alert.scope === scope)) continue;
    if ((state.blockedReasons ?? []).includes(`budget_exceeded:${scope}`)) {
      out.push({ kind: "cap_hit", scope, key: `cap_hit:${state.agentId}:${scope}`, cap: state.caps?.[scope] ?? null, spent: state.spend?.[scope] ?? null });
    }
  }
  if (Number.isFinite(silentAfterMs) && state.lastSeenMs != null && state.nowMs - state.lastSeenMs > silentAfterMs) {
    out.push({ kind: "agent_silent", key: `agent_silent:${state.agentId}`, silentMs: state.nowMs - state.lastSeenMs });
  }
  return out;
}

// active: Set of keys currently firing (persisted by the caller).
// Returns { fire: alerts to send now, active: next Set }.
export function dedupeAlerts(alerts, active = new Set()) {
  const next = new Set(alerts.map((a) => a.key));
  return { fire: alerts.filter((a) => !active.has(a.key)), active: next };
}

// An audit-log entry is append-only and carries who, what, when.
export function auditEntry({ orgId, actor, action, target, detail = {}, now = new Date() }) {
  if (!orgId || !actor || !action) throw new Error("audit entry needs orgId, actor and action");
  return { ts: now.toISOString(), org_id: orgId, actor, action, target: target ?? null, detail };
}
