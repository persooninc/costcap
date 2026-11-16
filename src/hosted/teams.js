// Hosted team budgets (issue #123, SRM #3017). Pure, no I/O.
// A team shares one day/month cap across a group of enrolled agents in one org.
// The verdict reuses the local agent-budget engine (src/agent-budget.js), so the
// hosted answer and a local `--policy` team cannot drift. Unknown cost
// (cost_usd: null) from any member makes the team verdict accounting_unavailable;
// it is never treated as $0.
import { createAgentBudgets } from "../agent-budget.js";
import { isPendingBatch } from "../cap.js";
import { warnFractionsError, sortWarnFractions } from "./alerts.js";

export const TEAM_SCOPES = Object.freeze(["day", "month"]);
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const round6 = (n) => Number(n.toFixed(6));

export const teamKey = (orgId, name) => `${orgId}:${name}`;
export const teamScope = (name, scope) => `team:${name}:${scope}`;

// Validates a POST /v1/teams body against the org. Returns { name, agents, day?, month? }
// or { name, remove: true }. Throws Error with .status 400 on bad input.
export function parseTeamInput(body, { orgAgents, teams, orgId }) {
  const bad = (message) => { const err = new Error(message); err.status = 400; throw err; };
  if (!body || typeof body !== "object") bad("Team body required");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!NAME.test(name)) bad("Team name must be 1-40 letters, digits, - or _");
  if (body.remove === true) return { name, remove: true };
  for (const key of Object.keys(body)) if (!["name", "agents", "day", "month", "warnFractions"].includes(key)) bad(`Unknown team field ${key}`);
  if (!Array.isArray(body.agents) || !body.agents.length || body.agents.length > 100 || body.agents.some((a) => typeof a !== "string" || !a)) bad("Team agents must be a non-empty list of agent ids");
  const agents = [...new Set(body.agents)];
  const inOrg = new Set(orgAgents.filter((a) => a.orgId === orgId).map((a) => a.id));
  if (agents.some((a) => !inOrg.has(a))) bad("Team agents must be enrolled agents of this organization");
  for (const t of teams) {
    if (t.orgId !== orgId || t.name === name) continue;
    const clash = agents.find((a) => t.agents.includes(a));
    if (clash) bad(`Agent ${clash} is already in team ${t.name}`);
  }
  const out = { name, agents };
  for (const scope of TEAM_SCOPES) {
    const v = body[scope];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(`Team ${scope} cap must be a positive number`);
    out[scope] = v;
  }
  if (!TEAM_SCOPES.some((s) => out[s] != null)) bad("Team needs a day or month cap");
  // Issue #165: undefined keeps the saved value, null resets to the default, [] turns warnings off.
  if (body.warnFractions === null) out.warnFractions = null;
  else if (body.warnFractions !== undefined) {
    const err = warnFractionsError(body.warnFractions);
    if (err) bad(err);
    out.warnFractions = sortWarnFractions(body.warnFractions);
  }
  return out;
}

export const teamFor = (teams, orgId, agentId) => teams.find((t) => t.orgId === orgId && t.agents.includes(agentId)) ?? null;

// team: { name, agents, day?, month? }
// receiptsByAgent: { [agentId]: receipt[] } with { id, ts, cost_usd, blocked? }
export function teamVerdict({ team, receiptsByAgent, nowMs }) {
  const nowDate = new Date(nowMs);
  const month = nowDate.toISOString().slice(0, 7);
  const def = { agents: team.agents };
  for (const s of TEAM_SCOPES) if (team[s] != null) def[s] = team[s];
  const history = [];
  for (const agentId of team.agents) {
    for (const r of receiptsByAgent[agentId] ?? []) {
      if (!Number.isFinite(Date.parse(r?.ts)) || new Date(r.ts).toISOString().slice(0, 7) !== month) continue;
      history.push({ id: `${agentId}:${r.id}`, ts: r.ts, cost_usd: r.cost_usd ?? null, blocked: Boolean(r.blocked), agent_id: agentId, run_id: null, ...(r.reason ? { reason: r.reason } : {}) });
    }
  }
  // #183: keep `reason` so a synced pending batch is pending, not unknown, server side too.
  const pendingBatches = history.filter(isPendingBatch).length;
  const budgets = createAgentBudgets({ policy: { teams: { [team.name]: def } }, history, now: () => nowDate });
  const spend = budgets.spend({ agent_id: team.agents[0] }, team.agents);
  // Any member's view of the team is the same once its own receipts are folded in.
  const hit = team.agents.map((a) => budgets.check({ agent_id: a })).find(Boolean) ?? null;
  const caps = Object.fromEntries(TEAM_SCOPES.filter((s) => team[s] != null).map((s) => [s, team[s]]));
  return {
    name: team.name,
    agents: [...team.agents],
    caps,
    spend: { day_usd: round6(spend.day), month_usd: round6(spend.month), unknown_count: spend.unknown, pending_batch_count: pendingBatches, cost_complete: spend.unknown === 0 && pendingBatches === 0 },
    verdict: hit ? hit.verdict : "ok",
    ...(hit?.scope ? { scope: teamScope(team.name, hit.scope), cap_usd: hit.cap_usd, spent_usd: hit.spent_usd } : {}),
    ...(hit?.unknown_receipts ? { unknown_receipts: hit.unknown_receipts } : {}),
    ...(Array.isArray(team.warnFractions) ? { warnFractions: [...team.warnFractions] } : {}),
  };
}

// What an enrolled wrapper caches with its policy: the caps plus the synced
// team spend at `as_of`. The wrapper adds its own unsynced spend on top.
export function teamPolicy(verdict, nowMs) {
  return { name: verdict.name, caps: verdict.caps, spent: { day: verdict.spend.day_usd, month: verdict.spend.month_usd }, unknown: verdict.spend.unknown_count, as_of: new Date(nowMs).toISOString() };
}

export function validTeamPolicy(t) {
  if (t === null || t === undefined) return true;
  if (typeof t !== "object" || typeof t.name !== "string" || !NAME.test(t.name) || !Number.isFinite(Date.parse(t.as_of))) return false;
  if (!Number.isInteger(t.unknown) || t.unknown < 0) return false;
  for (const s of TEAM_SCOPES) {
    const cap = t.caps?.[s];
    if (cap != null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) return false;
    const spent = t.spent?.[s];
    if (!(typeof spent === "number" && Number.isFinite(spent) && spent >= 0)) return false;
  }
  return true;
}

// Synced spend plus pending local receipts, per UTC window. Shared by team (#123)
// and per-agent (#127) cached enforcement. Synced spend from an earlier UTC
// day/month than now no longer counts in that window.
function cachedTotals(entry, pending, nowMs) {
  const now = new Date(nowMs).toISOString();
  const asOf = new Date(entry.as_of).toISOString();
  const window = { day: 10, month: 7 };
  const total = {};
  let unknown = entry.unknown;
  for (const s of TEAM_SCOPES) total[s] = now.slice(0, window[s]) === asOf.slice(0, window[s]) ? entry.spent[s] : 0;
  for (const r of pending) {
    if (r.blocked || !Number.isFinite(Date.parse(r.ts))) continue;
    // #183: a pending batch is not unknown spend (same rule as cap.js); its cost
    // arrives as a settlement, which settled-aware loading has already applied.
    if (isPendingBatch(r)) continue;
    if (r.cost_usd === null || r.cost_usd === undefined) { unknown += 1; continue; }
    const ts = new Date(r.ts).toISOString();
    for (const s of TEAM_SCOPES) if (ts.slice(0, window[s]) === now.slice(0, window[s])) total[s] += r.cost_usd;
  }
  return { total, unknown };
}

// Offline enforcement in the wrapper from the cached team policy.
// pending: this agent's receipts not yet synced (counted on top of `spent`).
export function cachedTeamVerdict(team, pending, nowMs) {
  if (!team) return null;
  const { total, unknown } = cachedTotals(team, pending, nowMs);
  if (unknown > 0) return { verdict: "accounting_unavailable", reason: "unreconciled_receipt", team: team.name, unknown_receipts: unknown };
  for (const s of TEAM_SCOPES) {
    const cap = team.caps?.[s];
    if (cap != null && total[s] >= cap) return { verdict: "budget_exceeded", reason: "budget_exceeded", scope: teamScope(team.name, s), team: team.name, cap_usd: cap, spent_usd: round6(total[s]) };
  }
  return null;
}

// Issue #127: the agent's own fleet-wide synced spend (all hosts/runners using
// this identity), from settled-aware stored receipts. Pure.
export function agentSpendPolicy(receipts, nowMs) {
  const now = new Date(nowMs).toISOString();
  const spent = { day: 0, month: 0 };
  let unknown = 0;
  let pendingBatches = 0;
  for (const r of receipts) {
    if (!r || r.blocked || !Number.isFinite(Date.parse(r.ts))) continue;
    const ts = new Date(r.ts).toISOString();
    if (ts.slice(0, 7) !== now.slice(0, 7)) continue;
    if (isPendingBatch(r)) { pendingBatches += 1; continue; } // #183: pending, not unknown
    if (r.cost_usd === null || r.cost_usd === undefined) { unknown += 1; continue; }
    spent.month += r.cost_usd;
    if (ts.slice(0, 10) === now.slice(0, 10)) spent.day += r.cost_usd;
  }
  return { spent: { day: round6(spent.day), month: round6(spent.month) }, unknown, pending_batches: pendingBatches, as_of: now };
}

export function validAgentSpend(a) {
  if (a === null || a === undefined) return true;
  if (typeof a !== "object" || !Number.isFinite(Date.parse(a.as_of)) || !Number.isInteger(a.unknown) || a.unknown < 0) return false;
  return TEAM_SCOPES.every((s) => typeof a.spent?.[s] === "number" && Number.isFinite(a.spent[s]) && a.spent[s] >= 0);
}

// Offline per-agent enforcement against the agent's fleet caps (#127).
// caps: the resolved day/month caps; pending: unsynced local receipts.
export function cachedAgentVerdict(spend, caps, pending, nowMs) {
  if (!spend || !TEAM_SCOPES.some((s) => caps?.[s] != null)) return null;
  const { total, unknown } = cachedTotals(spend, pending, nowMs);
  if (unknown > 0) return { verdict: "accounting_unavailable", reason: "unreconciled_receipt", unknown_receipts: unknown };
  for (const s of TEAM_SCOPES) {
    const cap = caps[s];
    if (cap != null && total[s] >= cap) return { verdict: "budget_exceeded", reason: "budget_exceeded", scope: s, cap_usd: cap, spent_usd: round6(total[s]), fleet: true };
  }
  return null;
}
