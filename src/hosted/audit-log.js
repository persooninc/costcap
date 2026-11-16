// Audit log "who" (#133): resolve raw actor/target IDs to labels inside the
// caller's org, and export the full org audit trail as CSV.
import { cell } from "./receipts-csv.js";

export const SYSTEM_ACTORS = Object.freeze({ "alert-worker": "system:alert-worker" });
export const AUDIT_CSV_COLUMNS = ["ts", "actor", "actor_label", "action", "target", "target_label", "reason", "detail_json"];

// Labels never cross orgs: only users, agents, teams, invitations and the org
// itself that belong to orgId are consulted.
export function auditLabeler(s, orgId) {
  const users = new Map(); const agents = new Map(); const teams = new Map(); const invites = new Map();
  for (const u of Object.values(s.users ?? {})) if (u.orgId === orgId && u.verified) users.set(u.id, u.email);
  for (const a of Object.values(s.agents ?? {})) if (a.orgId === orgId) agents.set(a.id, a.name);
  for (const t of Object.values(s.teams ?? {})) if (t.orgId === orgId) teams.set(t.name, t.name);
  for (const i of Object.values(s.invitations ?? {})) if (i.orgId === orgId) invites.set(i.id, i.email);
  const org = s.orgs?.[orgId];
  const actorLabel = (actor) => users.get(actor) ?? agents.get(actor) ?? SYSTEM_ACTORS[actor] ?? "unknown";
  const targetLabel = (target) => {
    if (target == null) return null;
    if (agents.has(target)) return agents.get(target);
    if (teams.has(target)) return teams.get(target);
    if (users.has(target)) return users.get(target);
    if (invites.has(target)) return invites.get(target);
    if (target === orgId && org) return org.name ?? target;
    return target;
  };
  return (e) => ({ ...e, actor_label: actorLabel(e.actor), target_label: targetLabel(e.target) });
}

export function labelAudit(s, orgId, entries) {
  const label = auditLabeler(s, orgId);
  return entries.filter((e) => e && e.org_id === orgId).map(label);
}

export function parseAuditRange(params) {
  const out = {};
  for (const key of ["since", "until"]) {
    const v = params.get(key);
    if (v === null) continue;
    const ms = Date.parse(v);
    if (!v || Number.isNaN(ms)) { const err = new Error(`${key} must be an ISO date`); err.status = 400; throw err; }
    out[key] = ms;
  }
  return out;
}

export function auditCsv(entries, { since, until } = {}) {
  const rows = entries.map((e, i) => ({ e, i }))
    .filter(({ e }) => { const ms = Date.parse(e.ts); return (since === undefined || ms >= since) && (until === undefined || ms <= until); })
    .sort((x, y) => String(x.e.ts).localeCompare(String(y.e.ts)) || x.i - y.i);
  const lines = [AUDIT_CSV_COLUMNS.join(",")];
  for (const { e } of rows) {
    const row = { ts: e.ts, actor: e.actor, actor_label: e.actor_label, action: e.action, target: e.target, target_label: e.target_label,
      reason: e.detail?.reason ?? "", detail_json: JSON.stringify(e.detail ?? {}) };
    lines.push(AUDIT_CSV_COLUMNS.map((k) => cell(row[k])).join(","));
  }
  return { body: `${lines.join("\n")}\n`, count: rows.length };
}
