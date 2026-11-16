// Soft cap warnings (#164): a heads-up before the hard stop. When run/day/month
// spend first crosses a fraction of its cap, the wrapper appends one
// {"event":"cap_warning"} ledger line and prints one stderr line. Warnings never
// block. Unknown cost is never counted as $0: spend that excludes unknown-cost
// receipts is reported as a lower bound.

export const DEFAULT_WARN_AT = Object.freeze([0.8]);
export const SCOPES = Object.freeze(["run", "day", "month"]);

// "--warn-at F[,F...]": 0 < F < 1, distinct; "off" disables warnings.
export function parseWarnAt(v) {
  if (v === "off") return [];
  const parts = String(v).split(",").map((s) => s.trim());
  const out = [];
  for (const p of parts) {
    const n = p === "" ? NaN : Number(p);
    if (!Number.isFinite(n) || n <= 0 || n >= 1) throw new Error(`--warn-at needs fractions between 0 and 1 (exclusive) or "off", got "${v}"`);
    if (out.includes(n)) throw new Error(`--warn-at has a duplicate fraction ${n}, got "${v}"`);
    out.push(n);
  }
  return out.sort((a, b) => a - b);
}

// Period key a warning is deduped on: run_id for run, UTC day or month otherwise.
export function periodKey(scope, { runId, now = new Date() } = {}) {
  const iso = new Date(now).toISOString();
  if (scope === "run") return String(runId ?? "");
  if (scope === "day") return iso.slice(0, 10);
  if (scope === "month") return iso.slice(0, 7);
  throw new Error(`unknown scope ${scope}`);
}

// Pure: every (scope, fraction) whose threshold lies in (before, after], in scope
// order then ascending fraction. A threshold already reached before is not crossed.
export function crossedThresholds({ caps = {}, before = {}, after = {}, fractions = DEFAULT_WARN_AT }) {
  const out = [];
  const sorted = [...fractions].sort((a, b) => a - b);
  for (const scope of SCOPES) {
    const cap = caps[scope];
    if (cap == null) continue;
    const b = before[scope] ?? 0, a = after[scope] ?? 0;
    for (const fraction of sorted) {
      const line = cap * fraction;
      if (b < line && a >= line) out.push({ scope, fraction });
    }
  }
  return out;
}

// Current warnings (for `costcap check`): every fraction reached by current spend.
export function currentWarnings({ caps = {}, spend = {}, fractions = DEFAULT_WARN_AT, lowerBound = {} }) {
  const out = [];
  for (const scope of SCOPES) {
    const cap = caps[scope];
    if (cap == null || typeof spend[scope] !== "number") continue;
    for (const fraction of [...fractions].sort((a, b) => a - b)) {
      if (spend[scope] >= cap * fraction) out.push({ scope, fraction, cap, spent_usd: Number(spend[scope].toFixed(6)), lower_bound: !!lowerBound[scope] });
    }
  }
  return out;
}

const dedupeKey = (scope, fraction, period) => `${scope}|${fraction}|${period}`;

export function warningLine({ scope, fraction, cap, spent_usd: spent, period, lower_bound: lb }) {
  const when = scope === "run" ? `run ${period}` : `${period} UTC`;
  return `costcap: warning: ${scope} spend ${lb ? "(lower bound) " : ""}$${spent.toFixed(4)} is ${Math.round(fraction * 100)}% of $${cap} cap (${when})`;
}

// Stateful warner used by the proxy. `seen` is rebuilt from existing cap_warning
// events so a second wrap in the same period does not warn again.
export function createCapWarner({ fractions = DEFAULT_WARN_AT, events = [], runId = null, agentId = null, now = () => new Date() } = {}) {
  const seen = new Set();
  for (const e of events) if (e?.event === "cap_warning") seen.add(dedupeKey(e.scope, e.fraction, e.period));
  const emitted = [];
  return {
    emitted,
    // Returns the new cap_warning events (not yet persisted) for a spend change.
    observe({ caps, before, after, lowerBound = false }) {
      if (!fractions.length) return [];
      const at = now();
      const out = [];
      for (const { scope, fraction } of crossedThresholds({ caps, before, after, fractions })) {
        const period = periodKey(scope, { runId, now: at });
        const k = dedupeKey(scope, fraction, period);
        if (seen.has(k)) continue;
        seen.add(k);
        const ev = { event: "cap_warning", scope, fraction, cap: caps[scope], spent_usd: Number(after[scope].toFixed(6)), period, run_id: runId, agent_id: agentId, lower_bound: !!lowerBound };
        out.push(ev);
        emitted.push(ev);
      }
      return out;
    },
  };
}
