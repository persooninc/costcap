// Issue #209: org budget period. Day and month cap windows follow an IANA
// timezone and a month start day (1-28) instead of fixed UTC. Pure; built on
// Intl.DateTimeFormat. With no setting ({ timezone: "UTC", monthStartDay: 1 })
// every key equals the old ISO prefix (YYYY-MM-DD / YYYY-MM).

export const DEFAULT_BUDGET_PERIOD = Object.freeze({ timezone: "UTC", monthStartDay: 1 });

const formatters = new Map();
function formatter(timezone) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timezone, f);
  }
  return f;
}

export function validTimezone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { formatter(tz); return true; } catch { return false; }
}

// Returns an error message, or null when bp is a valid budget period body.
export function budgetPeriodError(bp) {
  if (!bp || typeof bp !== "object" || Array.isArray(bp)) return "budgetPeriod must be an object";
  for (const k of Object.keys(bp)) if (k !== "timezone" && k !== "monthStartDay") return `Unknown budgetPeriod field ${k}`;
  if (bp.timezone !== undefined && !validTimezone(bp.timezone)) return "timezone must be a valid IANA timezone (e.g. America/Los_Angeles)";
  if (bp.monthStartDay !== undefined && !(Number.isInteger(bp.monthStartDay) && bp.monthStartDay >= 1 && bp.monthStartDay <= 28)) return "monthStartDay must be an integer from 1 to 28";
  return null;
}

// Any stored/synced value -> a usable period. Invalid input falls back to UTC/1.
export function normalizeBudgetPeriod(bp) {
  if (!bp || typeof bp !== "object") return DEFAULT_BUDGET_PERIOD;
  const timezone = validTimezone(bp.timezone) ? bp.timezone : "UTC";
  const d = bp.monthStartDay;
  const monthStartDay = Number.isInteger(d) && d >= 1 && d <= 28 ? d : 1;
  return timezone === "UTC" && monthStartDay === 1 ? DEFAULT_BUDGET_PERIOD : { timezone, monthStartDay };
}

export const isDefaultBudgetPeriod = (bp) => { const n = normalizeBudgetPeriod(bp); return n.timezone === "UTC" && n.monthStartDay === 1; };

// Wall-clock parts of instant ms in timezone.
export function localParts(ms, timezone = "UTC") {
  const p = {};
  for (const { type, value } of formatter(timezone).formatToParts(new Date(ms))) if (type !== "literal") p[type] = Number(value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

// Offset (ms) of timezone at instant ms: local wall clock minus UTC.
function offsetAt(ms, timezone) {
  const p = localParts(ms, timezone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - (Math.floor(ms / 1000) * 1000);
}

// UTC instant of local midnight on y-m-d (month 1-12; overflow is normalized).
export function zonedMidnight(year, month, day, timezone = "UTC") {
  const wall = Date.UTC(year, month - 1, day);
  let t = wall - offsetAt(wall, timezone);
  t = wall - offsetAt(t, timezone);
  return t;
}

const pad = (n) => String(n).padStart(2, "0");

// Local calendar date (y, m 1-12) of the month period containing ms.
function monthStart(ms, bp) {
  const { year, month, day } = localParts(ms, bp.timezone);
  if (day >= bp.monthStartDay) return { year, month };
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

// "day" -> local YYYY-MM-DD; "month" -> YYYY-MM of the period's start month.
export function periodKey(scope, ms, budgetPeriod) {
  const bp = normalizeBudgetPeriod(budgetPeriod);
  if (bp === DEFAULT_BUDGET_PERIOD) { const iso = new Date(ms).toISOString(); return scope === "month" ? iso.slice(0, 7) : iso.slice(0, 10); }
  if (scope === "month") { const m = monthStart(ms, bp); return `${m.year}-${pad(m.month)}`; }
  const { year, month, day } = localParts(ms, bp.timezone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

// { start, end } UTC ms of the day/month period containing ms (end exclusive).
export function periodBounds(scope, ms, budgetPeriod) {
  const bp = normalizeBudgetPeriod(budgetPeriod);
  if (scope === "month") {
    const m = monthStart(ms, bp);
    return { start: zonedMidnight(m.year, m.month, bp.monthStartDay, bp.timezone), end: zonedMidnight(m.year, m.month + 1, bp.monthStartDay, bp.timezone) };
  }
  const { year, month, day } = localParts(ms, bp.timezone);
  return { start: zonedMidnight(year, month, day, bp.timezone), end: zonedMidnight(year, month, day + 1, bp.timezone) };
}

export const samePeriod = (scope, aMs, bMs, budgetPeriod) => periodKey(scope, aMs, budgetPeriod) === periodKey(scope, bMs, budgetPeriod);
