// Issue #208: time-boxed cap raise requests. Pure logic over the store object `s`;
// the server wraps each call in a store transaction. A raise is an overlay on the
// agent policy (policy.raise[scope] = [{ amount_usd, expires_at, request_id }, ...]); base caps
// are never edited, raises on one scope stack (#212), and each lapses on its own at expires_at
// (see effectiveCaps).
import { RAISE_KEYS as CAP_KEYS, raiseEntries } from "./policy.js";

export const CAP_REQUEST_STATUSES = ["pending", "approved", "denied", "expired", "all"];
const MAX_AMOUNT_USD = 100_000;

const bad = (message) => { const err = new Error(message); err.status = 400; throw err; };
const conflict = (message) => { const err = new Error(message); err.status = 409; throw err; };
const notFound = (message) => { const err = new Error(message); err.status = 404; throw err; };

export function parseCapRequest(body) {
  const { scope, amount_usd: amount, duration_hours: hours, reason } = body ?? {};
  if (!CAP_KEYS.includes(scope)) bad(`scope must be one of ${CAP_KEYS.join("|")}`);
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT_USD) bad(`amount_usd must be a number > 0 and <= ${MAX_AMOUNT_USD}`);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) bad("duration_hours must be an integer from 1 to 168");
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 500) bad("Reason must be 1-500 characters");
  return { scope, amount_usd: amount, duration_hours: hours, reason: reason.trim() };
}

// Approve may lower (never raise) the requested amount or duration.
export function parseApproval(body, request) {
  const amount = body?.amount_usd ?? request.amount_usd;
  const hours = body?.duration_hours ?? request.duration_hours;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > request.amount_usd) bad("amount_usd may only lower the requested amount");
  if (!Number.isInteger(hours) || hours < 1 || hours > request.duration_hours) bad("duration_hours may only lower the requested duration");
  const note = body?.reason;
  if (note !== undefined && note !== null && (typeof note !== "string" || note.trim().length > 500)) bad("Reason must be up to 500 characters");
  return { amount_usd: amount, duration_hours: hours, note: typeof note === "string" && note.trim() ? note.trim() : null };
}

export function createCapRequest(s, { agent, actor, input, id, nowMs }) {
  if (agent.policy?.caps?.[input.scope] == null) bad(`Agent has no ${input.scope} cap to raise`);
  s.capRequests ??= {};
  if (Object.values(s.capRequests).some((r) => r.agentId === agent.id && r.scope === input.scope && r.status === "pending")) conflict(`A ${input.scope} cap request is already pending for this agent`);
  const record = { id, orgId: agent.orgId, agentId: agent.id, ...input, status: "pending", requested_by: actor, created_at: new Date(nowMs).toISOString() };
  s.capRequests[id] = record;
  return record;
}

export function findRequest(s, orgId, id) {
  const r = Object.hasOwn(s.capRequests ?? {}, id) ? s.capRequests[id] : null;
  if (!r || r.orgId !== orgId) notFound("Cap request not found");
  if (r.status !== "pending") conflict(`Cap request is already ${r.status}`);
  return r;
}

/** Writes the overlay and bumps version. Returns { request, before, after }. */
export function approveCapRequest(s, { request, approval, actor, nowMs }) {
  const a = s.agents[request.agentId];
  if (!a || a.revoked) conflict("Agent is revoked");
  const base = a.policy.caps?.[request.scope];
  if (base == null) conflict(`Agent no longer has a ${request.scope} cap`);
  const before = { caps: { ...a.policy.caps }, raise: { ...(a.policy.raise ?? {}) } };
  const expires_at = new Date(nowMs + approval.duration_hours * 3600_000).toISOString();
  migrateRaises(s, a);
  const prior = raiseEntries(a.policy.raise?.[request.scope]);
  const raise = { ...(a.policy.raise ?? {}), [request.scope]: [...prior, { amount_usd: approval.amount_usd, expires_at, request_id: request.id }] };
  a.policy = { ...a.policy, version: a.policy.version + 1, raise };
  Object.assign(request, { status: "approved", approved_amount_usd: approval.amount_usd, approved_duration_hours: approval.duration_hours, expires_at, decided_by: actor, decided_at: new Date(nowMs).toISOString(), ...(approval.note ? { decision_note: approval.note } : {}) });
  return { request, before, after: { caps: { ...a.policy.caps }, raise } };
}

export function denyCapRequest(request, { actor, note, nowMs }) {
  Object.assign(request, { status: "denied", decided_by: actor, decided_at: new Date(nowMs).toISOString(), ...(note ? { decision_note: note } : {}) });
  return request;
}

/** #212: rewrites legacy #208 { cap } overlays as stacked { amount_usd } entries using the approved amount. */
export function migrateRaises(s, a) {
  const raise = a.policy?.raise;
  if (!raise || Object.values(raise).every(Array.isArray)) return false;
  const next = {};
  for (const [scope, v] of Object.entries(raise)) {
    next[scope] = raiseEntries(v).map((r) => {
      if (!("cap" in r)) return r;
      const req = s.capRequests?.[r.request_id];
      const amount = req?.approved_amount_usd ?? Math.max(0, r.cap - (a.policy.caps?.[scope] ?? r.cap));
      return { amount_usd: amount, expires_at: r.expires_at, request_id: r.request_id };
    }).filter((r) => r.amount_usd > 0);
    if (!next[scope].length) delete next[scope];
  }
  const { raise: _drop, ...rest } = a.policy;
  a.policy = { ...rest, ...(Object.keys(next).length ? { raise: next } : {}) };
  return true;
}

/**
 * Drops expired raise entries from policies (bumping version), marks their requests expired, and
 * also expires any approved request whose expires_at has passed but has no overlay entry
 * (e.g. one overwritten before #212). Each request is audited exactly once. Returns audit rows.
 */
export function expireRaises(s, nowMs) {
  const rows = [];
  for (const a of Object.values(s.agents ?? {})) {
    if (!a.policy?.raise) continue;
    migrateRaises(s, a);
    const raise = a.policy.raise;
    if (!raise) continue;
    const expired = [];
    const next = {};
    for (const [scope, list] of Object.entries(raise)) {
      const live = list.filter((r) => Date.parse(r.expires_at) > nowMs);
      for (const r of list) if (!live.includes(r)) expired.push([scope, r]);
      if (live.length) next[scope] = live;
    }
    if (!expired.length) continue;
    const before = { caps: { ...a.policy.caps }, raise: { ...raise } };
    const { raise: _drop, ...rest } = a.policy;
    a.policy = { ...rest, version: a.policy.version + 1, ...(Object.keys(next).length ? { raise: next } : {}) };
    for (const [scope, r] of expired) {
      const req = s.capRequests?.[r.request_id];
      if (req && req.status !== "approved") continue;
      if (req) req.status = "expired";
      rows.push({ orgId: a.orgId, agentId: a.id, request_id: r.request_id, scope, reason: req?.reason ?? null, before, after: { caps: { ...a.policy.caps }, raise: next } });
    }
  }
  for (const req of Object.values(s.capRequests ?? {})) {
    if (req.status !== "approved" || !(Date.parse(req.expires_at) <= nowMs)) continue;
    req.status = "expired";
    const a = s.agents?.[req.agentId];
    const snap = { caps: { ...(a?.policy?.caps ?? {}) }, raise: { ...(a?.policy?.raise ?? {}) } };
    rows.push({ orgId: req.orgId, agentId: req.agentId, request_id: req.id, scope: req.scope, reason: req.reason ?? null, before: snap, after: snap });
  }
  return rows;
}

export function listCapRequests(s, orgId, status = "all") {
  return Object.values(s.capRequests ?? {}).filter((r) => r.orgId === orgId && (status === "all" || r.status === status)).sort((a, b) => b.created_at.localeCompare(a.created_at));
}
