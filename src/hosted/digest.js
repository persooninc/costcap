// Issue #224: weekly spend digest. Pure: settings validation, ISO-week math in
// the org budget-period timezone, the digest itself and its renderings. The
// server schedules and delivers. Unknown cost is never shown as $0: totals that
// miss unknown-cost receipts carry lower_bound and read "at least $X".

import { normalizeBudgetPeriod, localParts, zonedMidnight, periodBounds, weekLabel, parseWeek, weekBounds, mondayOf } from "../period.js";
export { weekLabel, parseWeek, weekBounds };
import { spendBreakdown, NO_TEAM } from "./spend.js";
import { effectiveCaps } from "./policy.js";

export const DIGEST_CHANNELS = ["email", "slack", "webhook"];
export const DEFAULT_DIGEST = Object.freeze({ enabled: false, weekday: 1, hour: 9, channels: Object.freeze(["email"]) });
/** New orgs get the digest on, email only. Existing orgs (no saved setting) stay off. */
export const newOrgDigest = () => ({ enabled: true, weekday: 1, hour: 9, channels: ["email"] });
/** A missed send slot is still sent within this window, then skipped. */
export const DIGEST_GRACE_MS = 24 * 3600_000;
export const DIGEST_TOP = 5;
const DAY = 86_400_000;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** Error message, or null when `v` is a valid (partial) digest settings object. */
export function digestSettingsError(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "digest settings must be an object";
  const known = ["enabled", "weekday", "hour", "channels"];
  const extra = Object.keys(v).find((k) => !known.includes(k));
  if (extra) return `unknown digest setting: ${extra}`;
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") return "enabled must be a boolean";
  if (v.weekday !== undefined && !(Number.isInteger(v.weekday) && v.weekday >= 0 && v.weekday <= 6)) return "weekday must be an integer 0-6 (0 = Sunday)";
  if (v.hour !== undefined && !(Number.isInteger(v.hour) && v.hour >= 0 && v.hour <= 23)) return "hour must be an integer 0-23";
  if (v.channels !== undefined) {
    if (!Array.isArray(v.channels) || v.channels.some((c) => !DIGEST_CHANNELS.includes(c))) return `channels must be a list of ${DIGEST_CHANNELS.join("|")}`;
    if (new Set(v.channels).size !== v.channels.length) return "channels must be unique";
  }
  return null;
}

/** Saved settings (or the default) with `input` applied. */
export function resolveDigest(saved, input = {}) {
  const base = { ...DEFAULT_DIGEST, ...(saved ?? {}), ...input };
  return { enabled: base.enabled, weekday: base.weekday, hour: base.hour, channels: DIGEST_CHANNELS.filter((c) => base.channels.includes(c)) };
}

export const previousWeek = (label, timezone = "UTC") => weekLabel(weekBounds(label, timezone).weekStart - 1, timezone);

// Instant of local wall time y-m-d h:00 (overflowing day normalized).
function zonedHour(y, m, d, h, timezone) {
  let t = zonedMidnight(y, m, d, timezone) + h * 3600_000;
  const off = localParts(t, timezone).hour - h; // A DST change between midnight and h.
  if (off) t -= (off > 12 ? off - 24 : off < -12 ? off + 24 : off) * 3600_000;
  return t;
}
/** When the digest covering `label` is due: the configured weekday/hour of the following week. */
export function digestSlot(label, settings, timezone = "UTC") {
  const p = parseWeek(label);
  const mon = new Date(mondayOf(p.year, p.week) + 7 * DAY);
  const offset = (settings.weekday + 6) % 7;
  return zonedHour(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate() + offset, settings.hour, timezone);
}
export const digestKey = (orgId, week) => `${orgId}:${week}`;

/**
 * What the scheduler does now for one org: { action: "wait"|"done"|"send"|"skip", week, slot }.
 * The covered week is the latest one whose slot has passed. Within DIGEST_GRACE_MS of that
 * slot it is sent once (ledger key org:week); later it is skipped. `since` (org creation or
 * the time the digest was turned on) ignores slots that predate it.
 */
export function digestDue(nowMs, settings, orgId, ledger = {}, timezone = "UTC", { since = 0 } = {}) {
  if (!settings?.enabled) return { action: "wait", week: null, slot: null };
  const current = weekLabel(nowMs, timezone);
  for (const week of [previousWeek(current, timezone), previousWeek(previousWeek(current, timezone), timezone)]) {
    const slot = digestSlot(week, settings, timezone);
    if (slot > nowMs) continue;
    // A slot before the org existed (or before the digest was turned on) is neither sent nor skipped.
    if (slot < since) return { action: "wait", week: null, slot: null };
    if (ledger[digestKey(orgId, week)]) return { action: "done", week, slot };
    return { action: nowMs - slot < DIGEST_GRACE_MS ? "send" : "skip", week, slot };
  }
  return { action: "wait", week: null, slot: null };
}

const top = (rows, map) => rows.filter((r) => r.calls > 0).slice(0, DIGEST_TOP).map(map);
const amount = (r) => ({ usd_known: r.usd_known, unknown_count: r.unknown_count, lower_bound: r.unknown_count > 0 });

/**
 * The digest for one org and week. `state` is the hosted store state. Uses the
 * same aggregation as /v1/spend (spendBreakdown, settlement-aware).
 */
export function buildDigest(state, orgId, { week, nowMs, dashboardUrl = null } = {}) {
  const org = state.orgs?.[orgId];
  const bp = normalizeBudgetPeriod(org?.budgetPeriod);
  const tz = bp.timezone;
  const { weekStart, weekEnd } = weekBounds(week, tz);
  const prev = weekBounds(previousWeek(week, tz), tz);
  const items = Object.values(state.receipts ?? {}).filter((r) => r.orgId === orgId);
  const agents = Object.values(state.agents ?? {}).filter((a) => a.orgId === orgId);
  const names = Object.fromEntries(agents.map((a) => [a.id, a.name]));
  const teams = Object.values(state.teams ?? {}).filter((t) => t.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name));
  const range = (since, until) => ({ since, until, untilExclusive: true, names, budgetPeriod: bp, teams });
  const byAgent = spendBreakdown(items, { ...range(weekStart, weekEnd), groupBy: "agent" });
  const byModel = spendBreakdown(items, { ...range(weekStart, weekEnd), groupBy: "model" });
  const byTeam = spendBreakdown(items, { ...range(weekStart, weekEnd), groupBy: "team" });
  const last = spendBreakdown(items, { ...range(prev.weekStart, prev.weekEnd), groupBy: "agent" }).total;
  const total = byAgent.total;
  const delta = round6(total.usd_known - last.usd_known);
  // Cap headroom in the current budget period (month cap first, then day, then week #271).
  const headroom = [];
  const spentSince = (agentIds, start) => spendBreakdown(items.filter((r) => agentIds.includes(r.agentId)), { since: start, until: nowMs, budgetPeriod: bp }).total;
  const room = (base, scope, cap, ids) => {
    const t = spentSince(ids, periodBounds(scope, nowMs, bp).start);
    headroom.push({ ...base, scope, cap_usd: cap, spent_usd: t.usd_known, headroom_usd: round6(cap - t.usd_known), unknown_count: t.unknown_count, lower_bound: t.unknown_count > 0 });
  };
  const capScope = (caps) => (Number.isFinite(caps?.month) ? "month" : Number.isFinite(caps?.day) ? "day" : Number.isFinite(caps?.week) ? "week" : null);
  for (const a of [...agents].filter((x) => !x.revoked).sort((x, y) => String(x.name).localeCompare(String(y.name)))) {
    const caps = effectiveCaps(a.policy ?? {}, nowMs);
    const scope = capScope(caps);
    if (scope) room({ type: "agent", id: a.id, name: a.name }, scope, caps[scope], [a.id]);
  }
  for (const t of teams) {
    const scope = capScope(t);
    if (scope) room({ type: "team", id: t.name, name: t.name }, scope, t[scope], t.agents ?? []);
  }
  // #294: linear projection for the current budget month (same as /v1/spend).
  const month = spendBreakdown(items, { groupBy: "agent", range: "current_month", since: periodBounds("month", nowMs, bp).start, budgetPeriod: bp, now: nowMs }).forecast;
  const forecast = month?.total ? { period_end: month.period_end, period_end_local: month.period_end_local, projected_usd: month.total.projected_usd, lower_bound: month.total.lower_bound } : null;
  const alerts = Object.values(state.alerts ?? {}).filter((a) => a.orgId === orgId && Date.parse(a.fired_at) >= weekStart && Date.parse(a.fired_at) < weekEnd);
  const byKind = {};
  for (const a of alerts) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  return {
    org_id: orgId, org_name: org?.name ?? null, week, timezone: tz,
    week_start: new Date(weekStart).toISOString(), week_end: new Date(weekEnd).toISOString(),
    total: { ...amount(total), calls: total.calls },
    previous: { week: previousWeek(week, tz), ...amount(last), calls: last.calls },
    change: { usd: delta, pct: last.usd_known > 0 ? Math.round((delta / last.usd_known) * 1000) / 10 : null, lower_bound: total.unknown_count > 0 || last.unknown_count > 0 },
    top_agents: top(byAgent.buckets, (r) => ({ id: r.key, name: r.label ?? r.key, ...amount(r) })),
    top_teams: top(byTeam.buckets.filter((r) => r.key !== NO_TEAM), (r) => ({ name: r.key, ...amount(r) })),
    top_models: top(byModel.buckets, (r) => ({ model: r.key, ...amount(r) })),
    forecast,
    headroom, headroom_as_of: new Date(nowMs).toISOString(),
    unknown: { count: total.unknown_count, lower_bound: total.unknown_count > 0 },
    alerts: { total: alerts.length, by_kind: byKind },
    dashboard_url: dashboardUrl,
  };
}

const money = (n) => `$${n.toFixed(2)}`;
/** "$X", "at least $X", or "unknown cost" — never "$0" for unknown spend. */
export const spendText = (a) => (!a.lower_bound ? money(a.usd_known) : a.usd_known > 0 ? `at least ${money(a.usd_known)}` : "unknown cost");
const changeText = (d) => {
  const sign = d.change.usd >= 0 ? "+" : "-";
  const pct = d.change.pct === null ? "" : ` (${d.change.pct >= 0 ? "+" : ""}${d.change.pct}%)`;
  return `${sign}${money(Math.abs(d.change.usd))}${pct} vs ${spendText(d.previous)} the week before${d.change.lower_bound ? " (known cost only)" : ""}`;
};
/** #294: "Projected this budget month: $X" (≥ when unknown cost is unsettled); a linear estimate, not a bill. */
export const forecastText = (d) => (d.forecast?.projected_usd == null ? null
  : `Projected this budget month: ${d.forecast.lower_bound ? "≥ " : ""}${money(d.forecast.projected_usd)} by ${d.forecast.period_end_local} at the current pace (linear estimate, not a bill).`);
const sections = (d) => {
  const s = [];
  s.push(["Top agents", d.top_agents.map((a) => `${a.name}: ${spendText(a)}`)]);
  s.push(["Top teams", d.top_teams.map((t) => `${t.name}: ${spendText(t)}`)]);
  s.push(["Top models", d.top_models.map((m) => `${m.model}: ${spendText(m)}`)]);
  s.push(["Cap headroom", d.headroom.map((h) => `${h.type} ${h.name}: ${h.headroom_usd < 0 ? `over by ${money(-h.headroom_usd)}` : `${money(h.headroom_usd)} left`} of ${money(h.cap_usd)} ${h.scope} cap${h.lower_bound ? ` (spent ${spendText({ usd_known: h.spent_usd, lower_bound: true })})` : ""}`)]);
  s.push(["Alerts fired", Object.entries(d.alerts.by_kind).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}: ${n}`)]);
  return s;
};
export const digestSubject = (d) => `CostCap weekly digest ${d.week}: ${spendText(d.total)}`;
export function digestText(d) {
  const lines = [`CostCap weekly spend digest for ${d.org_name ?? d.org_id}, week ${d.week} (${d.timezone}).`, "", `Spend: ${spendText(d.total)} (${changeText(d)}).`];
  if (forecastText(d)) lines.push(forecastText(d));
  if (d.unknown.count) lines.push(`${d.unknown.count} receipt${d.unknown.count === 1 ? "" : "s"} with unknown cost not yet settled: the total is a lower bound.`);
  for (const [title, rows] of sections(d)) { lines.push("", `${title}:`); lines.push(...(rows.length ? rows.map((r) => `- ${r}`) : ["- none"])); }
  if (d.dashboard_url) lines.push("", `Dashboard: ${d.dashboard_url}`);
  lines.push("", "Estimated spend guardrails, not a billing guarantee.");
  return lines.join("\n");
}
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function digestHtml(d) {
  const parts = [`<h2>CostCap weekly spend digest, week ${esc(d.week)}</h2>`, `<p><strong>${esc(spendText(d.total))}</strong> (${esc(changeText(d))}).</p>`];
  if (forecastText(d)) parts.push(`<p>${esc(forecastText(d))}</p>`);
  if (d.unknown.count) parts.push(`<p>${d.unknown.count} receipt${d.unknown.count === 1 ? "" : "s"} with unknown cost not yet settled: the total is a lower bound.</p>`);
  for (const [title, rows] of sections(d)) parts.push(`<h3>${esc(title)}</h3><ul>${(rows.length ? rows : ["none"]).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`);
  if (d.dashboard_url) parts.push(`<p><a href="${esc(d.dashboard_url)}">Open the CostCap dashboard</a></p>`);
  parts.push("<p><small>Estimated spend guardrails, not a billing guarantee.</small></p>");
  return parts.join("");
}
/** Slack Block Kit payload for the org's incoming webhook. */
export function digestSlack(d) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `CostCap weekly digest ${d.week}` } },
    { type: "section", text: { type: "mrkdwn", text: `*${spendText(d.total)}* (${changeText(d)})${forecastText(d) ? `\n${forecastText(d)}` : ""}${d.unknown.count ? `\n${d.unknown.count} unknown-cost receipt(s) unsettled: lower bound.` : ""}` } },
  ];
  for (const [title, rows] of sections(d)) if (rows.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${title}*\n${rows.map((r) => `• ${r}`).join("\n")}` } });
  if (d.dashboard_url) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${d.dashboard_url}|Open dashboard> · Estimated spend guardrails, not a billing guarantee.` }] });
  return { text: digestSubject(d), blocks };
}
/** Signed generic-webhook event body (#199 scheme). */
export const digestWebhookPayload = (d) => ({ type: "costcap.digest", id: digestKey(d.org_id, d.week), ...d });
