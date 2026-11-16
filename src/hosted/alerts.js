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

// Issue #139: hosted team budgets alert like per-agent caps. Pure.
// verdict: teamVerdict() output; blockedScopes: ["day"|"month"] from member
// receipts blocked with scope team:<name>:<scope> in the last hour.
// Unknown cost (accounting_unavailable) or non-finite spend raises no cap
// alert: unknown cost never counts as $0.
export function evaluateTeamAlerts({ orgId, verdict, blockedScopes = [] }, { approachFraction = 0.8 } = {}) {
  if (!verdict || verdict.spend?.unknown_count !== 0 || verdict.verdict === "accounting_unavailable") return [];
  const out = [];
  const id = `team:${orgId}:${verdict.name}`;
  for (const scope of ["day", "month"]) {
    const cap = verdict.caps?.[scope];
    if (typeof cap !== "number" || !Number.isFinite(cap)) continue;
    const spent = verdict.spend[`${scope}_usd`];
    if (typeof spent !== "number" || !Number.isFinite(spent)) continue;
    const base = { team: verdict.name, scope, cap, spent };
    if (spent >= cap || blockedScopes.includes(scope)) out.push({ kind: "cap_hit", key: `cap_hit:${id}:${scope}`, ...base });
    else if (spent >= cap * approachFraction) out.push({ kind: "cap_approaching", key: `cap_approaching:${id}:${scope}`, ...base });
  }
  return out;
}

// Issue #143: alert lifecycle. s.alerts holds one record per firing (occurrence),
// keyed by occurrence id. Records never get deleted: clearing sets resolved_at.
// Legacy records (keyed by alert key, no id/fired_at) keep fired_at null.
export const ALERT_STATUSES = ["active", "acknowledged", "resolved", "all"];

export function alertOccurrences(alerts = {}) {
  return Object.entries(alerts).map(([id, a]) => ({
    ...a, id: a.id ?? id, fired_at: a.fired_at ?? null,
    resolved_at: a.resolved_at ?? null,
    acknowledged_at: a.acknowledged_at ?? null, acknowledged_by: a.acknowledged_by ?? null,
  }));
}

export function activeOccurrence(alerts, key) {
  for (const [id, a] of Object.entries(alerts)) if (a.key === key && a.active) return [id, a];
  return null;
}

export function fireAlert(alerts, alert, extra, { nowMs, id }) {
  const record = { ...alert, ...extra, id, active: true, delivery: "pending", fired_at: new Date(nowMs).toISOString(), resolved_at: null, acknowledged_at: null, acknowledged_by: null };
  alerts[id] = record;
  return record;
}

export function resolveAlert(record, nowMs) {
  if (!record.active) return;
  record.active = false;
  record.resolved_at ??= new Date(nowMs).toISOString();
}

export function alertStatus(a) {
  if (!a.active) return "resolved";
  return a.acknowledged_at ? "acknowledged" : "active";
}

export function filterAlerts(list, { status = "all", since, until } = {}) {
  return list.filter((a) => {
    if (status !== "all" && alertStatus(a) !== status) return false;
    if (since !== undefined || until !== undefined) {
      const ms = Date.parse(a.fired_at);
      if (Number.isNaN(ms)) return false;
      if (since !== undefined && ms < since) return false;
      if (until !== undefined && ms > until) return false;
    }
    return true;
  }).sort((x, y) => Number(!x.active) - Number(!y.active) || String(y.fired_at ?? "").localeCompare(String(x.fired_at ?? "")));
}
