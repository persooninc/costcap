// Issue #209: org budget period helper (timezone + month start day).
import test from "node:test";
import assert from "node:assert/strict";
import { periodKey, periodBounds, samePeriod, budgetPeriodError, normalizeBudgetPeriod, isDefaultBudgetPeriod, validTimezone, zonedMidnight, localParts, DEFAULT_BUDGET_PERIOD } from "../src/period.js";

const ms = (iso) => Date.parse(iso);
const iso = (n) => new Date(n).toISOString();
const LA = { timezone: "America/Los_Angeles" };

test("default period equals the UTC ISO prefixes", () => {
  for (const t of ["2026-01-01T00:00:00Z", "2026-11-16T23:59:59.999Z", "2024-02-29T12:00:00Z"]) {
    assert.equal(periodKey("day", ms(t)), new Date(t).toISOString().slice(0, 10));
    assert.equal(periodKey("month", ms(t), null), new Date(t).toISOString().slice(0, 7));
    assert.equal(periodKey("month", ms(t), { timezone: "UTC", monthStartDay: 1 }), new Date(t).toISOString().slice(0, 7));
  }
  const b = periodBounds("month", ms("2026-02-10T00:00:00Z"));
  assert.deepEqual([iso(b.start), iso(b.end)], ["2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]);
});

test("AC1: Los Angeles day keys split at local midnight, not UTC", () => {
  assert.equal(periodKey("day", ms("2026-11-16T07:30:00Z"), LA), "2026-11-15");
  assert.equal(periodKey("day", ms("2026-11-16T08:30:00Z"), LA), "2026-11-16");
  assert.equal(periodKey("day", ms("2026-11-15T23:00:00Z"), { timezone: "Asia/Kolkata" }), "2026-11-16");
  assert.equal(periodKey("day", ms("2026-11-15T10:59:00Z"), { timezone: "Pacific/Auckland" }), "2026-11-15");
  assert.equal(periodKey("day", ms("2026-11-15T11:00:00Z"), { timezone: "Pacific/Auckland" }), "2026-11-16");
  const b = periodBounds("day", ms("2026-11-16T07:30:00Z"), LA);
  assert.deepEqual([iso(b.start), iso(b.end)], ["2026-11-15T08:00:00.000Z", "2026-11-16T08:00:00.000Z"]);
});

test("AC2: monthStartDay 15 puts Nov 14 in the Oct 15 - Nov 14 period", () => {
  const p = { monthStartDay: 15 };
  assert.equal(periodKey("month", ms("2026-11-14T23:59:59Z"), p), "2026-10");
  assert.equal(periodKey("month", ms("2026-11-15T00:00:00Z"), p), "2026-11");
  assert.equal(periodKey("month", ms("2026-01-10T00:00:00Z"), p), "2025-12");
  const b = periodBounds("month", ms("2026-11-14T12:00:00Z"), p);
  assert.deepEqual([iso(b.start), iso(b.end)], ["2026-10-15T00:00:00.000Z", "2026-11-15T00:00:00.000Z"]);
  const la = periodBounds("month", ms("2026-11-20T12:00:00Z"), { ...LA, monthStartDay: 15 });
  assert.deepEqual([iso(la.start), iso(la.end)], ["2026-11-15T08:00:00.000Z", "2026-12-15T08:00:00.000Z"]);
});

test("start day 28 and February, plus start day 1 across the year", () => {
  const p = { monthStartDay: 28 };
  assert.equal(periodKey("month", ms("2026-02-27T12:00:00Z"), p), "2026-01");
  assert.equal(periodKey("month", ms("2026-02-28T00:00:00Z"), p), "2026-02");
  assert.equal(periodKey("month", ms("2026-03-27T00:00:00Z"), p), "2026-02");
  const b = periodBounds("month", ms("2026-03-01T00:00:00Z"), p);
  assert.deepEqual([iso(b.start), iso(b.end)], ["2026-02-28T00:00:00.000Z", "2026-03-28T00:00:00.000Z"]);
  assert.equal(periodKey("month", ms("2027-01-01T07:00:00Z"), LA), "2026-12");
  assert.equal(periodKey("month", ms("2027-01-01T08:00:00Z"), LA), "2027-01");
  const dec = periodBounds("month", ms("2026-12-31T12:00:00Z"), LA);
  assert.deepEqual([iso(dec.start), iso(dec.end)], ["2026-12-01T08:00:00.000Z", "2027-01-01T08:00:00.000Z"]);
});

test("AC3: DST fall-back day in Los Angeles has 25 hours, spring-forward 23", () => {
  const fall = periodBounds("day", ms("2026-11-01T20:00:00Z"), LA);
  assert.deepEqual([iso(fall.start), iso(fall.end)], ["2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"]);
  assert.equal((fall.end - fall.start) / 3600_000, 25);
  // Every hour of that day maps to the same key; nothing double counted or dropped.
  for (let t = fall.start; t < fall.end; t += 15 * 60_000) assert.equal(periodKey("day", t, LA), "2026-11-01");
  assert.equal(periodKey("day", fall.start - 1, LA), "2026-10-31");
  assert.equal(periodKey("day", fall.end, LA), "2026-11-02");
  const spring = periodBounds("day", ms("2026-03-08T20:00:00Z"), LA);
  assert.equal((spring.end - spring.start) / 3600_000, 23);
  const london = periodBounds("day", ms("2026-10-25T12:00:00Z"), { timezone: "Europe/London" });
  assert.equal((london.end - london.start) / 3600_000, 25);
  // The November month period spans the DST change: start is PDT, end is PST.
  const nov = periodBounds("month", ms("2026-11-10T00:00:00Z"), LA);
  assert.deepEqual([iso(nov.start), iso(nov.end)], ["2026-11-01T07:00:00.000Z", "2026-12-01T08:00:00.000Z"]);
});

test("validation and normalization", () => {
  assert.equal(budgetPeriodError({ timezone: "America/Los_Angeles", monthStartDay: 15 }), null);
  assert.equal(budgetPeriodError({}), null);
  assert.match(budgetPeriodError({ timezone: "Mars/Olympus" }), /IANA/);
  assert.match(budgetPeriodError({ timezone: "" }), /IANA/);
  assert.match(budgetPeriodError({ timezone: 5 }), /IANA/);
  for (const d of [0, 29, 1.5, "3", -1]) assert.match(budgetPeriodError({ monthStartDay: d }), /1 to 28/);
  assert.match(budgetPeriodError(null), /object/);
  assert.match(budgetPeriodError([]), /object/);
  assert.match(budgetPeriodError({ reset: "09:00" }), /Unknown/);
  assert.equal(validTimezone("x".repeat(65)), false);
  assert.equal(normalizeBudgetPeriod(undefined), DEFAULT_BUDGET_PERIOD);
  assert.equal(normalizeBudgetPeriod({ timezone: "Bad/Zone", monthStartDay: 99 }), DEFAULT_BUDGET_PERIOD);
  assert.deepEqual(normalizeBudgetPeriod({ timezone: "Asia/Tokyo" }), { timezone: "Asia/Tokyo", monthStartDay: 1 });
  assert.equal(isDefaultBudgetPeriod({ timezone: "UTC" }), true);
  assert.equal(isDefaultBudgetPeriod(LA), false);
  assert.equal(samePeriod("day", ms("2026-11-16T07:30:00Z"), ms("2026-11-16T08:30:00Z"), LA), false);
  assert.equal(samePeriod("day", ms("2026-11-16T07:30:00Z"), ms("2026-11-16T08:30:00Z")), true);
  assert.equal(iso(zonedMidnight(2026, 13, 1, "UTC")), "2027-01-01T00:00:00.000Z");
  assert.deepEqual(localParts(ms("2026-11-16T07:30:05Z"), "America/Los_Angeles"), { year: 2026, month: 11, day: 15, hour: 23, minute: 30, second: 5 });
});
