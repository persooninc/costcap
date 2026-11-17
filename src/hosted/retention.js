// Issue #211: org receipt retention. Pure and portable (no I/O, no globals):
// validates the setting, computes the cutoff and the protected floor, and picks
// which synced receipts a sweep may delete.
import { periodBounds } from "../period.js";
import { PENDING_REASONS } from "../cap.js";
import { normalizeModel } from "../model-cap.js";

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
 * #265: receipts of agents in `keepAgents` (a Set of agent ids whose own or team
 * total cap counts every receipt) are never deleted.
 */
export function expiredReceiptKeys(receipts, orgId, cutoffMs, floorMs, keepAgents = null) {
  if (cutoffMs === null) return [];
  // #286: keepAgents may also be a predicate over the stored item (org, tag and model totals).
  const kept = typeof keepAgents === "function" ? keepAgents : (item) => Boolean(keepAgents?.has(item.agentId));
  return Object.entries(receipts ?? {}).filter(([, item]) => item?.orgId === orgId && !kept(item) && isExpired(item, cutoffMs, floorMs)).map(([key]) => key);
}

/**
 * #286: predicate over stored receipt items that count toward any configured
 * total: the agent/team totals (#265), an org total (every org receipt), a fleet
 * tag total rule (every receipt has a value for its key, UNTAGGED included) and a
 * hosted model total (that agent's receipts of that model).
 */
export function totalCapKeep({ agents, teams, org, orgId }) {
  const byAgent = totalCapAgents(agents, teams, orgId);
  const all = org?.orgBudget?.total != null || (org?.tagCaps ?? []).some((r) => r?.scope === "total");
  const models = new Map();
  for (const a of agents ?? []) {
    if (a?.orgId !== orgId) continue;
    const ms = (a.policy?.modelCaps ?? []).filter((r) => r?.scope === "total").map((r) => normalizeModel(r.model));
    if (ms.length) models.set(a.id, new Set(ms));
  }
  return (item) => all || byAgent.has(item?.agentId) || Boolean(models.get(item?.agentId)?.has(normalizeModel((item?.receipt ?? item)?.model)));
}

/**
 * #265: agent ids of an org whose receipts count toward a configured total cap:
 * the agent's own caps.total, or the total of the team it belongs to.
 */
export function totalCapAgents(agents, teams, orgId) {
  const out = new Set();
  for (const a of agents ?? []) if (a?.orgId === orgId && a.policy?.caps?.total != null) out.add(a.id);
  for (const t of teams ?? []) if (t?.orgId === orgId && t.total != null) for (const id of t.agents ?? []) out.add(id);
  return out;
}
