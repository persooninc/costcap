// Issue #211: org receipt retention. Pure and portable (no I/O, no globals):
// validates the setting, computes the cutoff and the protected floor, and picks
// which synced receipts a sweep may delete.
import { periodBounds } from "../period.js";
import { PENDING_REASONS } from "../cap.js";

export const RETENTION_MIN_DAYS = 7;
export const RETENTION_DEFAULT_MAX_DAYS = 365;
// Caps look back at most one month; 32 days covers any month plus clock skew.
export const RETENTION_FLOOR_DAYS = 32;
const DAY_MS = 86_400_000;

/** Largest allowed setting: the plan's receiptRetentionDays when enforced, else 365. */
export function retentionMaxDays(entitlements) {
  const days = entitlements?.limits?.receiptRetentionDays;
  return entitlements?.enforced && Number.isFinite(days) ? Math.min(days, RETENTION_DEFAULT_MAX_DAYS) : RETENTION_DEFAULT_MAX_DAYS;
}

/** @returns {string|null} an error message, or null when `days` is valid (null means keep forever). */
export function retentionDaysError(days, maxDays = RETENTION_DEFAULT_MAX_DAYS) {
  if (days === null) return null;
  if (!Number.isInteger(days)) return "days must be an integer or null";
  if (days < RETENTION_MIN_DAYS || days > maxDays) return `days must be between ${RETENTION_MIN_DAYS} and ${maxDays}, or null`;
  return null;
}

/** Oldest kept timestamp (ms), or null when the org keeps everything. */
export function retentionCutoffMs(days, nowMs) {
  return Number.isInteger(days) ? nowMs - days * DAY_MS : null;
}

/**
 * Receipts at or after this instant are never deleted: the last 32 days, the
 * current UTC month and the org's current budget-period month (#209), whichever is earliest.
 */
export function retentionFloorMs(nowMs, budgetPeriod = null) {
  const d = new Date(nowMs);
  return Math.min(nowMs - RETENTION_FLOOR_DAYS * DAY_MS, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), periodBounds("month", nowMs, budgetPeriod).start);
}

/** May this stored receipt item ({ receipt, settlement? }) be deleted? */
export function isExpired(item, cutoffMs, floorMs) {
  if (cutoffMs === null) return false;
  const r = item?.receipt ?? item;
  const ts = Date.parse(r?.ts);
  if (!Number.isFinite(ts) || ts >= cutoffMs || ts >= floorMs) return false;
  if (PENDING_REASONS.includes(r.reason)) return false;
  if (r.cost_usd == null && typeof item?.settlement?.cost_usd !== "number") return false;
  return true;
}

/**
 * Keys of `receipts` (store map) belonging to `orgId` that a sweep would delete.
 * keepAgents (#265): agent ids under a total cap; their receipts are never deleted.
 */
export function expiredReceiptKeys(receipts, orgId, cutoffMs, floorMs, keepAgents = null) {
  if (cutoffMs === null) return [];
  return Object.entries(receipts ?? {}).filter(([, item]) => item?.orgId === orgId && !keepAgents?.has(item.agentId) && isExpired(item, cutoffMs, floorMs)).map(([key]) => key);
}
