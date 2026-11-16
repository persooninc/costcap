import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createTransactionalEmail } from "./email.js";
import { digestText, digestHtml, digestSlack, digestWebhookPayload, digestSubject } from "./digest.js";
// Hosted delivery adapter. The caller authorizes recipients and supplies secrets.
// Tests pass a fake fetch. This module does not send by itself.
export function createAlertDelivery({ emailKey, emailFrom, emailTo, slackWebhook, webhook, dashboardUrl, lookup = dnsLookup, fetchImpl = fetch, nowMs = () => Date.now() } = {}) {
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
    const text = `CostCap ${alert.kind}: ${alert.org ? "org budget" : alert.tag ? `tag ${alert.tag.key}=${alert.tag.value}` : alert.team ? `team ${alert.team}` : alert.model ? `agent ${alert.agentName ?? alert.agentId ?? "unknown"}, model ${alert.model}` : `agent ${alert.agentId ?? "unknown"}`}${alert.scope ? `, ${alert.scope}` : ""}${alert.kind === "spend_anomaly" ? ` (today $${alert.today}${alert.lower_bound ? "+" : ""} vs $${alert.baseline} daily median, ${alert.multiplier}x)` : alert.team || alert.org || alert.tag || (alert.model && typeof alert.spent === "number") ? ` (spent $${alert.spent} of $${alert.cap} cap)` : alert.model ? ` ($${alert.cap} cap)` : ""}. Estimated spend guardrails, not a billing guarantee.`;
    const results = [];
    if (!want("email")) { /* already settled for this occurrence */ }
    else if (emailKey && emailFrom && emailTo?.length) {
      try {
        await createTransactionalEmail({ apiKey: emailKey, from: emailFrom, fetchImpl })({ to: emailTo, subject: `CostCap: ${alert.kind}`, text });
        results.push({ channel: "email", status: "accepted" });
      } catch (err) { results.push({ channel: "email", status: "failed", error: err.message }); }
    } else results.push({ channel: "email", status: "unconfigured" });
    if (!want("slack")) { /* skip */ }
    else if (slackWebhook) {
      try { await post(slackWebhook, {}, { text }); results.push({ channel: "slack", status: "accepted" }); }
      catch (err) { results.push({ channel: "slack", status: "failed", error: err.message }); }
    } else results.push({ channel: "slack", status: "unconfigured" });
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
    return results;
  };
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
export function maskAlertSettings(settings) {
  return { emails: [...(settings?.emails ?? [])], slackWebhook: maskWebhook(settings?.slackWebhook), webhook: maskSignedWebhook(settings?.webhook), configured: Boolean(settings?.emails?.length || settings?.slackWebhook || settings?.webhook?.url) };
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
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export function webhookPayload(alert, { dashboardUrl } = {}) {
  return {
    id: alert.id ?? null, kind: alert.kind, org_id: alert.orgId ?? null,
    agent_id: alert.agentId ?? null, agent_name: alert.agentName ?? null, team: alert.team ?? null, org: Boolean(alert.org),
    tag: alert.tag && typeof alert.tag === "object" ? { key: alert.tag.key, value: alert.tag.value } : null,
    // #244: per-model cap alerts carry the normalized model id; null on other kinds.
    model: typeof alert.model === "string" ? alert.model : null,
    run_id: alert.run_id ?? null, scope: alert.scope ?? null, period: alert.period ?? null,
    fraction: num(alert.fraction), spent_usd: num(alert.spent), cap_usd: num(alert.cap),
    unknown_count: Number.isInteger(alert.unknown_count) ? alert.unknown_count : Number.isInteger(alert.unknownCount) ? alert.unknownCount : null,
    // Spend anomaly (#223) fields; null on other kinds.
    today_usd: num(alert.today), baseline_usd: num(alert.baseline), multiplier: num(alert.multiplier),
    top_models: Array.isArray(alert.top_models) ? alert.top_models.map((m) => ({ model: m.model, usd: num(m.usd) })) : null,
    lower_bound: typeof alert.lower_bound === "boolean" ? alert.lower_bound : null,
    fired_at: alert.fired_at ?? null, dashboard_url: dashboardUrl ?? null,
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
    const has = settings && (settings.emails?.length || settings.slackWebhook || settings.webhook?.url);
    if (has) return createAlertDelivery({ emailKey, emailFrom, emailTo: settings.emails, slackWebhook: settings.slackWebhook || undefined, webhook: settings.webhook ?? undefined, dashboardUrl, lookup, fetchImpl, nowMs })(alert, opts);
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
