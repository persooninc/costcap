import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createTransactionalEmail } from "./email.js";
import { defaultsWant, routeMatches, routeDisabled } from "./alert-routes.js";
import { digestText, digestHtml, digestSlack, digestWebhookPayload, digestSubject } from "./digest.js";
// Hosted delivery adapter. The caller authorizes recipients and supplies secrets.
// Tests pass a fake fetch. This module does not send by itself.
export function createAlertDelivery({ emailKey, emailFrom, emailTo, slackWebhook, webhook, kinds = null, routes = [], dashboardUrl, lookup = dnsLookup, fetchImpl = fetch, nowMs = () => Date.now() } = {}) {
  if (slackWebhook) {
    const url = new URL(slackWebhook);
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || !url.pathname.startsWith("/services/")) throw new Error("Slack webhook must use hooks.slack.com/services over HTTPS");
  }
  const post = async (url, headers, body) => {
    const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`delivery HTTP ${response.status}`);
  };
  // Issue #206: `channels` limits a retry to the channels that failed; omitted
  // channels are not sent and not reported.
  return async (alert, { channels } = {}) => {
    const want = (ch) => !Array.isArray(channels) || channels.includes(ch);
    const text = alert.kind === "cost_unknown" ? unknownCostText(alert, dashboardUrl) : alert.kind === "test" ? `CostCap test alert for ${alert.org_name ?? alert.orgId ?? "your org"}: your destinations are working. No spend or cap is involved.` : `CostCap ${alert.kind}: ${alert.org ? "org budget" : alert.tag ? `tag ${alert.tag.key}=${alert.tag.value}` : alert.team ? `team ${alert.team}` : alert.model ? `agent ${alert.agentName ?? alert.agentId ?? "unknown"}, model ${alert.model}` : `agent ${alert.agentId ?? "unknown"}`}${alert.scope ? `, ${alert.scope}` : ""}${alert.kind === "spend_anomaly" ? ` (today $${alert.today}${alert.lower_bound ? "+" : ""} vs $${alert.baseline} daily median, ${alert.multiplier}x)` : alert.kind === "cap_projected" && num(alert.projected) !== null ? ` (spent $${fmt(alert.spent)}, projected $${fmt(alert.projected)} of $${fmt(alert.cap)} cap by period end)` : alert.model && alert.spent != null ? ` (spent $${alert.spent} of $${alert.cap} cap)` : alert.team || alert.org || alert.tag ? ` (spent $${alert.spent} of $${alert.cap} cap)` : ""}. Estimated spend guardrails, not a billing guarantee.`;
    const results = [];
    // Issue #258: defaults first, then routes in order. An address or Slack URL
    // already claimed by an earlier destination is not sent again. Claims do not
    // depend on `channels`, so a retry sees the same assignment.
    const sentEmails = new Set(), sentSlack = new Set();
    const sendEmail = async (channel, to) => {
      if (!want(channel)) return;
      if (!(emailKey && emailFrom && to.length)) { results.push({ channel, status: "unconfigured" }); return; }
      try {
        await createTransactionalEmail({ apiKey: emailKey, from: emailFrom, fetchImpl })({ to, subject: `CostCap: ${alert.kind}`, text });
        results.push({ channel, status: "accepted" });
      } catch (err) { results.push({ channel, status: "failed", error: err.message }); }
    };
    const sendSlack = async (channel, url) => {
      if (!want(channel)) return;
      if (!url) { results.push({ channel, status: "unconfigured" }); return; }
      try { await post(url, {}, { text }); results.push({ channel, status: "accepted" }); }
      catch (err) { results.push({ channel, status: "failed", error: err.message }); }
    };
    const defaultsOn = defaultsWant(kinds, alert.kind);
    const defaultEmails = defaultsOn ? (emailTo ?? []) : [];
    for (const e of defaultEmails) sentEmails.add(e);
    await sendEmail("email", defaultEmails);
    const defaultSlack = defaultsOn ? (slackWebhook || null) : null;
    if (defaultSlack) sentSlack.add(defaultSlack);
    await sendSlack("slack", defaultSlack);
    const team = alert.team ?? alert.routeTeam ?? null;
    for (const route of Array.isArray(routes) ? routes : []) {
      if (routeDisabled(route) || !routeMatches(route, alert, team)) continue;
      const to = (route.emails ?? []).filter((e) => !sentEmails.has(e));
      for (const e of to) sentEmails.add(e);
      if (to.length) await sendEmail(`route:${route.id}:email`, to);
      const url = route.slackWebhook && validSlackWebhook(route.slackWebhook) && !sentSlack.has(route.slackWebhook) ? route.slackWebhook : null;
      if (url) { sentSlack.add(url); await sendSlack(`route:${route.id}:slack`, url); }
    }
    if (!want("webhook")) { /* skip */ }
    else if (webhook?.url && webhook?.secret) {
      try {
        await assertWebhookTarget(webhook.url, lookup); // Re-checked at send time: DNS can change after save.
        const body = JSON.stringify(webhookPayload(alert, { dashboardUrl }));
        const t = Math.floor(nowMs() / 1000);
        const response = await fetchImpl(webhook.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "CostCap-Webhook/1", "x-costcap-signature": signWebhook(webhook.secret, body, t) }, body, redirect: "error", signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`delivery HTTP ${response.status}`);
        results.push({ channel: "webhook", status: "accepted" });
      } catch (err) { results.push({ channel: "webhook", status: "failed", error: err.message }); }
    } else results.push({ channel: "webhook", status: "unconfigured" });
    // Issue #282: native PagerDuty (own kinds filter), Teams and Discord (default kinds).
    const scrubbed = (err) => [pagerduty?.routingKey, teamsWebhook, discordWebhook].filter(Boolean).reduce((m, v) => m.split(v).join("[redacted]"), String(err?.message ?? err));
    const native = [
      ["pagerduty", validPagerDuty(pagerduty) && pagerDutyKindOn(pagerduty, alert.kind), () => post(pagerDutyUrl(pagerduty.region), {}, pagerDutyPayload(alert, { routingKey: pagerduty.routingKey, text, dashboardUrl }))],
      ["teams", defaultsOn && Boolean(teamsWebhook) && !teamsWebhookProblem(teamsWebhook), () => post(teamsWebhook, {}, teamsPayload(alert, { text, dashboardUrl }))],
      ["discord", defaultsOn && Boolean(discordWebhook) && !discordWebhookProblem(discordWebhook), () => post(discordWebhook, {}, discordPayload(alert, { text }))],
    ];
    for (const [channel, on, send] of native) {
      if (!want(channel)) continue;
      if (!on) { if (Array.isArray(channels)) results.push({ channel, status: "unconfigured" }); continue; } // Unrequested + unset: no row, so legacy result shapes are unchanged.
      try { await send(); results.push({ channel, status: "accepted" }); }
      catch (err) { results.push({ channel, status: "failed", error: scrubbed(err) }); }
    }
    // Issue #258: additive routes. Defaults first, then routes in order; an
    // address or Slack URL already covered in this occurrence is not sent again.
    for (const route of matchingRoutes(routes, alert)) {
      const emailCh = `route:${route.id}:email`, slackCh = `route:${route.id}:slack`;
      const to = (route.emails ?? []).filter((e) => !sentEmails.has(e));
      to.forEach((e) => sentEmails.add(e));
      if (to.length && emailKey && emailFrom && want(emailCh)) {
        try {
          await createTransactionalEmail({ apiKey: emailKey, from: emailFrom, fetchImpl })({ to, subject: `CostCap: ${alert.kind}`, text });
          results.push({ channel: emailCh, status: "accepted" });
        } catch (err) { results.push({ channel: emailCh, status: "failed", error: err.message }); }
      }
      const hook = route.slackWebhook && validSlackWebhook(route.slackWebhook) && !sentSlack.has(route.slackWebhook) ? route.slackWebhook : null;
      if (hook) sentSlack.add(hook);
      if (hook && want(slackCh)) {
        try { await post(hook, {}, { text }); results.push({ channel: slackCh, status: "accepted" }); }
        catch (err) { results.push({ channel: slackCh, status: "failed", error: err.message }); }
      }
    }
    return results;
  };
}

// Issue #258: alert routes. `kinds` null = all kinds; `teams` null = any team
// (including no team); `teams: []` (its teams were deleted) matches nothing.
export const MAX_ALERT_ROUTES = 10;
const kindMatches = (kinds, kind) => !Array.isArray(kinds) || kinds.includes(kind);
/** The team an alert routes by: its own team, else (agent alerts) the team listing the agent at send time. */
export const alertRouteTeam = (alert) => (alert.org || alert.tag ? null : alert.team ?? alert.routeTeam ?? null);
export function matchingRoutes(routes, alert) {
  const team = alertRouteTeam(alert);
  return (Array.isArray(routes) ? routes : []).filter((r) => kindMatches(r.kinds, alert.kind) && (!Array.isArray(r.teams) || (team !== null && r.teams.includes(team))));
}
export function maskRoute(r) {
  return { id: r.id, name: r.name, kinds: Array.isArray(r.kinds) ? [...r.kinds] : null, teams: Array.isArray(r.teams) ? [...r.teams] : null, emails: [...(r.emails ?? [])], slackWebhook: maskWebhook(r.slackWebhook), disabled: Array.isArray(r.teams) && r.teams.length === 0 };
}

// Issue #121: per-org alert destinations. Validation and masking for the
// settings an org owner/admin stores on the org record.
export const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\-/]{1,200}$/;
export function validSlackWebhook(value) {
  if (typeof value !== "string" || !SLACK_WEBHOOK_PATTERN.test(value)) return false;
  try { const u = new URL(value); return u.protocol === "https:" && u.hostname === "hooks.slack.com" && u.pathname.startsWith("/services/") && !u.search && !u.hash && !u.username && !u.port; }
  catch { return false; }
}
/** Masked webhook: never the full value. Shows only the fixed prefix and last 4 characters. */
export function maskWebhook(value) {
  if (typeof value !== "string" || !value) return null;
  return `https://hooks.slack.com/services/…${value.slice(-4)}`;
}
// Issue #258: `kinds` and `routes` appear only once set, so the #121 shape is unchanged for orgs without them.
export function maskRoute(r) {
  return { id: r.id, name: r.name, kinds: Array.isArray(r.kinds) ? [...r.kinds] : null, teams: Array.isArray(r.teams) ? [...r.teams] : null, emails: [...(r.emails ?? [])], slackWebhook: maskWebhook(r.slackWebhook), disabled: routeDisabled(r) };
}
export function maskAlertSettings(settings) {
  const routes = Array.isArray(settings?.routes) ? settings.routes : [];
  return {
    emails: [...(settings?.emails ?? [])], slackWebhook: maskWebhook(settings?.slackWebhook), webhook: maskSignedWebhook(settings?.webhook),
    ...(Array.isArray(settings?.kinds) ? { kinds: [...settings.kinds] } : {}),
    ...(routes.length ? { routes: routes.map(maskRoute) } : {}),
    configured: Boolean(settings?.emails?.length || settings?.slackWebhook || settings?.webhook?.url || routes.length),
  };
}

// Issue #199: signed generic webhook. One HTTPS endpoint per org receives
// HMAC-SHA256-signed JSON for every hosted alert.
export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("hex")}`;
/** Masked endpoint: origin only, plus the last 4 secret characters. Never the path or the full secret. */
export function maskSignedWebhook(webhook) {
  if (!webhook?.url) return null;
  let origin;
  try { origin = new URL(webhook.url).origin; } catch { origin = "https://invalid"; }
  return { url: `${origin}/…`, secret: webhook.secret ? `whsec_…${webhook.secret.slice(-4)}` : null };
}
export function signWebhook(secret, body, t) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}
/** Receiver-side check (also documented in the README). */
export function verifyWebhookSignature(secret, body, header, { nowMs = Date.now(), toleranceSec = 300 } = {}) {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  return timingSafeEqual(expected, Buffer.from(parts.v1));
}
const fmt = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "?");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// Issue #279: the cost_unknown page names the cause, the blast radius and the fix.
export function unknownCostText(alert, dashboardUrl) {
  const n = Number.isInteger(alert.unknown_count) ? alert.unknown_count : 0;
  const receipts = `${n} unknown-cost receipt${n === 1 ? "" : "s"}`;
  const link = `Settle it in the dashboard: ${dashboardUrl ? String(dashboardUrl).replace(/#.*$/, "") : ""}#unknownCard`;
  if (alert.org || alert.team) {
    const who = alert.org ? "org budget" : `team ${alert.team}`;
    const src = Array.isArray(alert.source_agents) && alert.source_agents.length ? alert.source_agents.join(", ") : "unknown";
    const p = Number.isInteger(alert.paused_agents) ? alert.paused_agents : 0;
    return `CostCap cost_unknown: ${who} is paused by ${receipts} from agent ${src}; it is pausing ${p} agent${p === 1 ? "" : "s"}. Unknown cost is never counted as $0. ${link}`;
  }
  const f = alert.first ?? {};
  const b = Number.isInteger(alert.blocked_calls_1h) ? alert.blocked_calls_1h : 0;
  return `CostCap cost_unknown: agent ${alert.agentName ?? alert.agentId ?? "unknown"} is paused by ${receipts} (model ${f.model ?? "unknown"}, ${f.reason ?? "unpriced"}, receipt ${f.receipt_id ?? "?"}); it is pausing 1 agent, ${b} call${b === 1 ? "" : "s"} refused in the last hour. Unknown cost is never counted as $0. ${link}`;
}
export function webhookPayload(alert, { dashboardUrl } = {}) {
  return {
    id: alert.id ?? null, kind: alert.kind, org_id: alert.orgId ?? null,
    agent_id: alert.agentId ?? null, agent_name: alert.agentName ?? null, team: alert.team ?? null, org: Boolean(alert.org),
    tag: alert.tag && typeof alert.tag === "object" ? { key: alert.tag.key, value: alert.tag.value } : null,
    model: typeof alert.model === "string" ? alert.model : null, // #244
    run_id: alert.run_id ?? null, scope: alert.scope ?? null, period: alert.period ?? null,
    fraction: num(alert.fraction), spent_usd: num(alert.spent), cap_usd: num(alert.cap),
    // Issue #247: projected month-end spend on cap_projected; null on other kinds.
    projected_usd: alert.kind === "cap_projected" ? num(alert.projected) : null,
    unknown_count: Number.isInteger(alert.unknown_count) ? alert.unknown_count : Number.isInteger(alert.unknownCount) ? alert.unknownCount : null,
    // Spend anomaly (#223) fields; null on other kinds.
    today_usd: num(alert.today), baseline_usd: num(alert.baseline), multiplier: num(alert.multiplier),
    top_models: Array.isArray(alert.top_models) ? alert.top_models.map((m) => ({ model: m.model, usd: num(m.usd) })) : null,
    lower_bound: typeof alert.lower_bound === "boolean" ? alert.lower_bound : null,
    fired_at: alert.fired_at ?? null, dashboard_url: dashboardUrl ?? null,
    // Issue #259: a test send is marked so receivers can ignore it after verifying the signature.
    ...(alert.kind === "test" ? { test: true } : {}),
    // Issue #279: which receipt paused what.
    ...(alert.kind === "cost_unknown" ? { first_receipt_id: alert.first?.receipt_id ?? null, first: alert.first ?? null, blocked_calls_1h: Number.isInteger(alert.blocked_calls_1h) ? alert.blocked_calls_1h : null, source_agents: Array.isArray(alert.source_agents) ? [...alert.source_agents] : null, paused_agents: Number.isInteger(alert.paused_agents) ? alert.paused_agents : null } : {}),
  };
}

// SSRF guard. Literal-address checks are pure; DNS resolution is injectable.
const v4 = (ip) => ip.split(".").map(Number);
export function isBlockedAddress(ip) {
  let addr = String(ip).toLowerCase();
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) addr = mapped[1];
  const family = isIP(addr);
  if (family === 4) {
    const [a, b] = v4(addr);
    return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (family === 6) {
    return addr === "::" || addr === "::1" || /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr) || /^ff/.test(addr) || addr.startsWith("::ffff:") || addr === "fd00:ec2::254";
  }
  return true;
}
/** Sync shape check. Returns an error string or null. */
export function webhookUrlProblem(value) {
  if (typeof value !== "string" || value.length > 500) return "Webhook must be an https URL";
  let u;
  try { u = new URL(value); } catch { return "Webhook must be an https URL"; }
  if (u.protocol !== "https:") return "Webhook must use https";
  if (u.username || u.password) return "Webhook URL must not contain credentials";
  if (u.port && u.port !== "443") return "Webhook URL must use port 443";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return "Webhook host must be a DNS name, not an IP address";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return "Webhook host must be a public DNS name";
  return null;
}
export async function assertWebhookTarget(value, lookup = dnsLookup) {
  const problem = webhookUrlProblem(value);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  let addresses;
  try { addresses = await lookup(new URL(value).hostname, { all: true, verbatim: true }); }
  catch { throw Object.assign(new Error("Webhook host does not resolve"), { status: 400 }); }
  const list = (Array.isArray(addresses) ? addresses : [addresses]).map((a) => (typeof a === "string" ? a : a?.address));
  if (!list.length || list.some((a) => isBlockedAddress(a))) throw Object.assign(new Error("Webhook host resolves to a private or reserved address"), { status: 400 });
}

// Routes each org's alert to that org's own settings. `fallback` keeps the
// documented COSTCAP_ALERT_ORG_ID env destination for that one org only, and only
// while it has no saved settings. Any other org with no settings stays unconfigured.
export function createOrgAlertRouter({ emailKey, emailFrom, fetchImpl = fetch, fallback, dashboardUrl, lookup = dnsLookup, nowMs } = {}) {
  const fallbackDelivery = fallback?.orgId ? createAlertDelivery({ emailKey, emailFrom, emailTo: fallback.emailTo, slackWebhook: fallback.slackWebhook, fetchImpl }) : null;
  return async (alert, settings, opts) => {
    const has = settings && (settings.emails?.length || settings.slackWebhook || settings.webhook?.url || settings.routes?.length);
    if (has) return createAlertDelivery({ emailKey, emailFrom, emailTo: settings.emails, slackWebhook: settings.slackWebhook || undefined, webhook: settings.webhook ?? undefined, kinds: settings.kinds ?? null, routes: settings.routes ?? [], dashboardUrl, lookup, fetchImpl, nowMs })(alert, opts);
    if (fallbackDelivery && alert.orgId === fallback.orgId) return fallbackDelivery(alert, opts);
    return [{ status: "unconfigured" }];
  };
}

// Issue #224: weekly digest delivery to the org's own alert destinations.
// `channels` is the list to send (a retry passes only the failed ones). One
// result row per requested channel, same shape as alert delivery (#206).
export function createDigestDelivery({ emailKey, emailFrom, fetchImpl = fetch, lookup = dnsLookup, nowMs = () => Date.now() } = {}) {
  return async (digest, settings, { channels = ["email", "slack", "webhook"] } = {}) => {
    const results = [];
    const attempt = async (channel, configured, send) => {
      if (!channels.includes(channel)) return;
      if (!configured) { results.push({ channel, status: "unconfigured" }); return; }
      try { await send(); results.push({ channel, status: "accepted" }); }
      catch (err) { results.push({ channel, status: "failed", error: err.message }); }
    };
    await attempt("email", emailKey && emailFrom && settings?.emails?.length, () =>
      createTransactionalEmail({ apiKey: emailKey, from: emailFrom, fetchImpl })({ to: settings.emails, subject: digestSubject(digest), text: digestText(digest), html: digestHtml(digest) }));
    await attempt("slack", settings?.slackWebhook && validSlackWebhook(settings.slackWebhook), async () => {
      const response = await fetchImpl(settings.slackWebhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(digestSlack(digest)), redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`delivery HTTP ${response.status}`);
    });
    await attempt("webhook", settings?.webhook?.url && settings?.webhook?.secret, async () => {
      await assertWebhookTarget(settings.webhook.url, lookup);
      const body = JSON.stringify(digestWebhookPayload(digest));
      const t = Math.floor(nowMs() / 1000);
      const response = await fetchImpl(settings.webhook.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "CostCap-Webhook/1", "x-costcap-signature": signWebhook(settings.webhook.secret, body, t) }, body, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`delivery HTTP ${response.status}`);
    });
    return results;
  };
}
