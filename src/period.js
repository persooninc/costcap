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

// Issue #261 (moved from the #224 digest): ISO weeks, Monday start, in the org timezone.
const DAY_MS = 86_400_000;
function isoWeek(year, month, day) {
  const d = Date.UTC(year, month - 1, day);
  const dow = (new Date(d).getUTCDay() + 6) % 7;
  const thursday = new Date(d + (3 - dow) * DAY_MS);
  const y = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(y, 0, 1)) / DAY_MS / 7);
  return `${y}-W${pad(week)}`;
}
/** ISO week label (YYYY-Www) of instant ms in the timezone. */
export function weekLabel(ms, timezone = "UTC") {
  const { year, month, day } = localParts(ms, timezone);
  return isoWeek(year, month, day);
}
/** #264: UTC ISO week label without Intl, for the local wrapper's per-receipt hot path. */
export function utcWeekLabel(ms) {
  const d = new Date(ms);
  return isoWeek(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
export function mondayOf(year, week) {
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS + (week - 1) * 7 * DAY_MS;
}
/** { year, week } for a valid YYYY-Www label, else null. */
export function parseWeek(label) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(label ?? ""));
  if (!m) return null;
  const year = Number(m[1]), week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const mon = new Date(mondayOf(year, week));
  if (isoWeek(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate()) !== label) return null;
  return { year, week };
}
/** { weekStart, weekEnd } UTC ms (end exclusive): local Monday midnight to the next, DST-safe. */
export function weekBounds(label, timezone = "UTC") {
  const p = parseWeek(label);
  if (!p) throw Object.assign(new Error("week must be YYYY-Www"), { status: 400 });
  const mon = new Date(mondayOf(p.year, p.week));
  const [y, m, d] = [mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate()];
  return { weekStart: zonedMidnight(y, m, d, timezone), weekEnd: zonedMidnight(y, m, d + 7, timezone) };
}

// "day" -> local YYYY-MM-DD; "week" -> ISO YYYY-Www (#261, monthStartDay ignored);
// "month" -> YYYY-MM of the period's start month.
export function periodKey(scope, ms, budgetPeriod) {
  const bp = normalizeBudgetPeriod(budgetPeriod);
  if (scope === "week") return weekLabel(ms, bp.timezone);
  if (bp === DEFAULT_BUDGET_PERIOD) { const iso = new Date(ms).toISOString(); return scope === "month" ? iso.slice(0, 7) : iso.slice(0, 10); }
  if (scope === "month") { const m = monthStart(ms, bp); return `${m.year}-${pad(m.month)}`; }
  const { year, month, day } = localParts(ms, bp.timezone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

// { start, end } UTC ms of the day/month period containing ms (end exclusive).
export function periodBounds(scope, ms, budgetPeriod) {
  const bp = normalizeBudgetPeriod(budgetPeriod);
  if (scope === "week") { const b = weekBounds(weekLabel(ms, bp.timezone), bp.timezone); return { start: b.weekStart, end: b.weekEnd }; }
  if (scope === "month") {
    const m = monthStart(ms, bp);
    return { start: zonedMidnight(m.year, m.month, bp.monthStartDay, bp.timezone), end: zonedMidnight(m.year, m.month + 1, bp.monthStartDay, bp.timezone) };
  }
  const { year, month, day } = localParts(ms, bp.timezone);
  return { start: zonedMidnight(year, month, day, bp.timezone), end: zonedMidnight(year, month, day + 1, bp.timezone) };
}

export const samePeriod = (scope, aMs, bMs, budgetPeriod) => periodKey(scope, aMs, budgetPeriod) === periodKey(scope, bMs, budgetPeriod);

// #261: receipts that can count toward any day/week/month window at nowMs. A week
// can start in the previous month, so this is the current month OR the current week.
export const inSpendWindow = (tsMs, nowMs, budgetPeriod) => samePeriod("month", tsMs, nowMs, budgetPeriod) || samePeriod("week", tsMs, nowMs, budgetPeriod);
