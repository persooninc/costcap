// Free-beta API. Durable local datastore, exactly one replica, trusted TLS ingress.
// Existing company membership is never inferred from an email domain.
import http from "node:http";
import { uiResponse } from "./ui.js";
import { randomBytes, randomUUID, randomInt } from "node:crypto";
import { openStore } from "./store.js";
import { hashToken, validatePolicy, effectiveCaps } from "./policy.js";
import { parseCapRequest, parseApproval, createCapRequest, findRequest, approveCapRequest, denyCapRequest, expireRaises, listCapRequests, CAP_REQUEST_STATUSES } from "./cap-requests.js";
import { buildEvidence } from "./evidence.js";
import { evaluateAlerts, evaluateRunAlerts, evaluateTeamAlerts, armWarnings, claimWarning, capPeriod, sortWarnFractions, auditEntry, silentAfterMsFor, alertOccurrences, activeOccurrence, fireAlert, resolveAlert, filterAlerts, ALERT_STATUSES } from "./alerts.js";
import { VERSION } from "../version.js";
import { stripeHealth } from "./billing.js";
import { receiptsCsv, parseReceiptsQuery } from "./receipts-csv.js";
import { pageRuns, parseRunsQuery, runReceipts, summarizeRuns } from "./runs.js";
import { parseSpendQuery, spendBreakdown, spendCsv } from "./spend.js";
import { validTags } from "../tags.js";
import { labelAudit, auditCsv, parseAuditRange } from "./audit-log.js";
import { scrubReceiptPath } from "../receipt-path.js";
import { DEFAULT_PLANS, entitlementsFor, requireLimit, resolveBillingConfig, retentionCutoff } from "../billing/index.js";
import { onboardingState } from "./onboarding.js";
import { hostedAgentVerdict } from "./agent-verdict.js";
import { assertWebhookTarget, maskAlertSettings, newWebhookSecret, validSlackWebhook } from "./delivery.js";
import { bearerApiKey, parseApiKeyInput, createApiKey, maskApiKey, findApiKey, apiKeyPrincipal } from "./api-keys.js";
import { parseFleetTagCaps, fleetTagCapsPolicy } from "./tag-caps.js";
import { expiredReceiptKeys, isExpired, retentionCutoffMs, retentionDaysError, retentionFloorMs, retentionMaxDays, RETENTION_MIN_DAYS } from "./retention.js";
import { budgetPeriodError, normalizeBudgetPeriod, periodKey } from "../period.js";
import { parseTeamInput, teamFor, teamKey, teamVerdict, teamPolicy, agentSpendPolicy } from "./teams.js";
const token = () => randomBytes(32).toString("base64url");
const fail = (status, message) => { const err = new Error(message); err.status = status; throw err; };

// Issue #130: one-time, idempotent startup scrub of credential query parameters in
// receipts stored by older clients. Only rows that change are written.
export function scrubStoredReceipts(store) {
  const dirty = store.read((s) => Object.values(s.receipts ?? {}).some((r) => typeof r.receipt?.path === "string" && scrubReceiptPath(r.receipt.path) !== r.receipt.path));
  if (!dirty) return 0;
  let changed = 0;
  store.transaction((s) => {
    for (const item of Object.values(s.receipts ?? {})) {
      const p = item.receipt?.path;
      if (typeof p !== "string") continue;
      const next = scrubReceiptPath(p);
      if (next !== p) { item.receipt.path = next; changed++; }
    }
  });
  Promise.resolve(store.flush?.()).catch(() => {});
  return changed;
}

// Plan usage counted from the store. Pending enrollment tokens and invitations
// hold a slot so a free workspace cannot issue ten tokens and redeem them all.
export function planUsage(s, orgId, nowMs, { pending = true } = {}) {
  const agents = Object.values(s.agents).filter((a) => a.orgId === orgId && !a.revoked).length;
  const tokens = pending ? Object.values(s.enrollments ?? {}).filter((e) => e.orgId === orgId && e.expires > nowMs).length : 0;
  const users = Object.values(s.users).filter((u) => u.orgId === orgId).length;
  const invites = pending ? Object.values(s.invitations ?? {}).filter((i) => i.orgId === orgId && i.expires > nowMs).length : 0;
  return { agents: agents + tokens, seats: users + invites };
}
// CC-3: fleet-wide freeze/resume. A reason is required (1-500 chars after trimming).
export function fleetReason(value, required) {
  if (value === undefined || value === null) { if (required) fail(400, "A reason is required"); return null; }
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500) fail(400, "Reason must be 1-500 characters");
  return value.trim();
}
// Freeze kills every non-revoked agent in the org in the caller's transaction. Only the
// agents this freeze killed are recorded, so resume never revives an agent killed on its own.
export function freezeFleet(s, u, reason) {
  s.fleetFreezes ??= {};
  const current = s.fleetFreezes[u.orgId];
  if (current?.active) return { frozen: true, alreadyFrozen: true, count: 0, agentIds: [] };
  const agentIds = [];
  for (const a of Object.values(s.agents)) {
    if (a.orgId !== u.orgId || a.revoked || a.policy.killed) continue;
    a.policy = { ...a.policy, version: a.policy.version + 1, killed: true };
    agentIds.push(a.id);
  }
  s.fleetFreezes[u.orgId] = { orgId: u.orgId, active: true, reason, agentIds, by: u.id, at: new Date().toISOString() };
  audit(s, u.orgId, u.id, "fleet.freeze", null, { reason, agentIds });
  return { frozen: true, alreadyFrozen: false, count: agentIds.length, agentIds };
}
export function resumeFleet(s, u, reason) {
  s.fleetFreezes ??= {};
  const current = s.fleetFreezes[u.orgId];
  if (!current?.active) return { frozen: false, notFrozen: true, count: 0, agentIds: [] };
  const agentIds = [];
  for (const id of current.agentIds) {
    const a = s.agents[id];
    if (!a || a.orgId !== u.orgId || a.revoked || !a.policy.killed) continue;
    a.policy = { ...a.policy, version: a.policy.version + 1, killed: false };
    agentIds.push(a.id);
  }
  s.fleetFreezes[u.orgId] = { ...current, active: false, resumedBy: u.id, resumeReason: reason };
  audit(s, u.orgId, u.id, "fleet.resume", null, { reason, agentIds });
  return { frozen: false, notFrozen: false, count: agentIds.length, agentIds };
}
// Issue #125: a settled unknown-cost receipt keeps cost_usd null on the stored receipt;
// budget, spend and alert math uses the audited settled cost instead.
export const SETTLE_SOURCES = ["provider_invoice", "provider_usage_export", "manual_evidence"];
export function costedReceipt(item) {
  const r = item?.receipt ?? item;
  const settled = item?.settlement?.cost_usd;
  return r && r.cost_usd == null && typeof settled === "number" ? { ...r, cost_usd: settled } : r;
}
// Issue #162: hosted settlements of this agent's own unknown-cost receipts, so the
// wrapper can append them to its local ledger and stop refusing calls.
export function agentSettlements(s, a) {
  return Object.values(s.receipts ?? {})
    .filter((r) => r.orgId === a.orgId && r.agentId === a.id && r.receipt?.cost_usd == null && typeof r.settlement?.cost_usd === "number")
    .map((r) => ({ receipt_id: r.receipt.id, settled_cost_usd: r.settlement.cost_usd, settle_source: r.settlement.source ?? null, audit_id: r.settlement.audit_id ?? null }));
}

export function settleInput(body) {
  const cost = body?.cost_usd, source = body?.source, reason = body?.reason;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) fail(400, "cost_usd must be a finite number >= 0");
  if (!SETTLE_SOURCES.includes(source)) fail(400, `source must be one of ${SETTLE_SOURCES.join("|")}`);
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 500) fail(400, "Reason must be 1-500 characters");
  if (body.agent_id !== undefined && typeof body.agent_id !== "string") fail(400, "agent_id must be a string");
  return { cost_usd: cost, source, reason: reason.trim(), agentId: body.agent_id };
}
// Issue #129: agent-uploaded local settlement.
export function agentSettlementInput(body) {
  const id = body?.receipt_id, cost = body?.cost_usd, sha = body?.provider_sha256 ?? null, ts = body?.ts ?? null;
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) fail(400, "Invalid receipt_id");
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) fail(400, "cost_usd must be a finite number >= 0");
  if (sha !== null && (typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha))) fail(400, "provider_sha256 must be 64 hex characters");
  if (ts !== null && (typeof ts !== "string" || !Number.isFinite(Date.parse(ts)))) fail(400, "Invalid ts");
  return { receipt_id: id, cost_usd: cost, provider_sha256: sha, ts };
}
const audit = (s, orgId, actor, action, target, detail = {}) => s.audit.push(auditEntry({ orgId, actor, action, target, detail }));

// Issue #206: per-channel retry. Each occurrence keeps `deliveryChannels`
// ({ email: "accepted", webhook: "failed", ... }) and `deliveryRetry`
// ({ webhook: { attempts, next_at } }). Only failed channels are re-sent, with
// backoff 1, 2, 4 ... minutes capped at 30, and at most ALERT_MAX_ATTEMPTS
// sends per channel per occurrence; then the channel is `gave_up`.
export const ALERT_MAX_ATTEMPTS = 10;
export const alertBackoffMs = (attempts) => Math.min(2 ** Math.max(0, attempts - 1), 30) * 60_000;
/** Channels due for a retry now, `null` for a legacy/untagged full resend, or [] when nothing is due. */
// Issue #210: a queued send stamps `delivery_claimed_at`. While that claim is
// within ALERT_CLAIM_LEASE_MS no other sweep re-sends it (no double page). A
// `pending` occurrence whose claim expired (or legacy, unclaimed) was cut off
// by a restart, so every channel is re-sent.
export const ALERT_CLAIM_LEASE_MS = 2 * 60_000;
const claimLive = (record, nowMs) => {
  const at = Date.parse(record.delivery_claimed_at ?? "");
  return Number.isFinite(at) && nowMs - at < ALERT_CLAIM_LEASE_MS;
};
/** True when a `pending` occurrence was interrupted and must be re-sent. */
export const pendingRecovered = (record, nowMs) => record.delivery === "pending" && !claimLive(record, nowMs);
export function dueRetryChannels(record, nowMs) {
  if (claimLive(record, nowMs)) return [];
  if (record.delivery === "pending") return null;
  if (record.delivery !== "failed") return [];
  const chans = record.deliveryChannels;
  if (!chans) return null;
  const due = Object.entries(chans).filter(([ch, st]) => st === "failed" && (record.deliveryRetry?.[ch]?.next_at ?? 0) <= nowMs).map(([ch]) => ch);
  if (due.includes("all")) return null;
  return due;
}
/** Merges one send's results into the occurrence. Returns channels that just gave up. */
export function applyDeliveryResult(record, result, requested, nowMs) {
  record.deliveryChannels ??= {};
  record.deliveryRetry ??= {};
  const rows = Array.isArray(result) ? result : [];
  const tagged = rows.filter((r) => typeof r?.channel === "string");
  const untagged = rows.find((r) => typeof r?.channel !== "string" && r?.status !== "unconfigured");
  const untaggedFailed = untagged?.status === "failed";
  const updates = tagged.map((r) => [r.channel, r.status]);
  // An untagged row (the send threw, or a legacy adapter) covers every
  // requested channel, or "all" when the channels are unknown.
  if (untagged) for (const ch of requested ?? ["all"]) if (!tagged.some((r) => r.channel === ch)) updates.push([ch, untagged.status === "accepted" ? "accepted" : "failed"]);
  if (requested == null && tagged.length) delete record.deliveryChannels.all;
  const gaveUp = [];
  for (const [ch, status] of updates) {
    if (status === "unconfigured") { record.deliveryChannels[ch] = "unconfigured"; continue; }
    const attempts = (record.deliveryRetry[ch]?.attempts ?? 0) + 1;
    if (status === "accepted") { record.deliveryChannels[ch] = "accepted"; record.deliveryRetry[ch] = { attempts, next_at: null }; continue; }
    if (attempts >= ALERT_MAX_ATTEMPTS) { record.deliveryChannels[ch] = "gave_up"; record.deliveryRetry[ch] = { attempts, next_at: null }; gaveUp.push(ch); continue; }
    record.deliveryChannels[ch] = "failed";
    record.deliveryRetry[ch] = { attempts, next_at: nowMs + alertBackoffMs(attempts) };
  }
  const states = Object.values(record.deliveryChannels).filter((st) => st !== "unconfigured");
  record.delivery = !states.length ? (untaggedFailed ? "failed" : "unconfigured") : states.every((st) => st === "accepted") ? "accepted" : "failed";
  return gaveUp;
}

// Estimated receipt spend for the dashboard. Null cost is unknown, never zero.
// Windows follow the org budget period (#209; UTC instant, day 1 by default),
// matching the hosted cap engine. A numeric offset is not a calendar prefix.
export function spendSummary(receipts, nowMs, budgetPeriod = null) {
  const cur = { day: periodKey("day", nowMs, budgetPeriod), month: periodKey("month", nowMs, budgetPeriod) };
  const fold = (window) => {
    let usd = 0, unknown = 0;
    for (const item of receipts) {
      const r = costedReceipt(item);
      const instant = new Date(r.ts);
      if (Number.isNaN(instant.getTime())) continue;
      if (window !== "all" && periodKey(window, instant.getTime(), budgetPeriod) !== cur[window]) continue;
      if (r.cost_usd === null || r.cost_usd === undefined) unknown += 1;
      else if (typeof r.cost_usd === "number" && Number.isFinite(r.cost_usd)) usd += r.cost_usd;
    }
    return { usd, unknown };
  };
  return { day: fold("day"), month: fold("month"), all: fold("all") };
}

// `store` (optional) injects any adapter with the store interface (mode, read, transaction,
// flush), for example openPostgresStore(); otherwise the JSON file at `storePath` is used.
export function createHostedServer({ storePath, store: injectedStore, verifyChallenge, sendCode, sendInvite, deliverAlert,
  now = () => Date.now(), secureCookies = true, origin, turnstileSiteKey = "", bodyLimit = 256_000,
  requestLog = () => {}, billingFactory, stripeEnv = process.env, stripeMode = stripeEnv.COSTCAP_STRIPE_MODE || "test",
  plans = DEFAULT_PLANS, enforceEntitlements, publicPricing, resolveHost } = {}) {
  if ((!storePath && !injectedStore) || !verifyChallenge || !sendCode || !origin) throw new Error("Store, origin, Turnstile verifier and authorized code sender required");
  const store = injectedStore ?? openStore(storePath);
  scrubStoredReceipts(store);
  const billingConfig = resolveBillingConfig({ ...stripeEnv, COSTCAP_STRIPE_MODE: stripeMode });
  const pricingPublic = publicPricing ?? billingConfig.publicPricing;
  const upgradeUrl = pricingPublic ? "/pricing" : "/#plan";
  let billing;
  // Gating applies only when checkout exists, so a limited workspace always has an upgrade path.
  const enforced = () => Boolean(billing) && (enforceEntitlements ?? billingConfig.enforceEntitlements);
  const entitlements = (s, orgId) => entitlementsFor({ status: s.orgs[orgId]?.billing?.status ?? null, plan: s.orgs[orgId]?.billing?.plan ?? null, enforced: enforced(), catalog: plans });
  // Receipts older than the plan retention window are hidden when entitlements are enforced.
  // Deletion is opt-in per org (#211, /v1/retention + purgeExpiredReceipts).
  const visibleReceipts = (s, orgId) => {
    const cutoff = retentionCutoff(entitlements(s, orgId), now());
    return Object.values(s.receipts).filter((r) => r.orgId === orgId && (cutoff === null || !(Date.parse(r.receipt?.ts) < cutoff)));
  };
  const billingReady = billingFactory ? Promise.resolve().then(() => billingFactory(store)).then(b => { billing = b; }) : Promise.resolve();
  const rate = new Map();
  const sessionUser = (s, req) => {
    const cookie = /(?:^|;\s*)costcap_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const found = cookie && s.sessions[hashToken(cookie)];
    if (!found || found.expires <= now()) fail(401, "Verified session required");
    const user = s.users[found.userId];
    if (!user?.verified) fail(401, "Email verification required");
    return user;
  };
  // Issue #203: a human route accepts a session or an org API key (`cck_`).
  const member = (s, req) => { const raw = bearerApiKey(req); return raw ? apiKeyPrincipal(findApiKey(s, raw, now())) : sessionUser(s, req); };
  const memberAdmin = (s, req) => { const u = member(s, req); if (!["owner", "admin"].includes(u.role)) fail(403, "Admin role required"); return u; };
  // Key management, billing, members and enrollment stay session-only: a key never mints a key.
  const sessionOnly = (req) => { if (bearerApiKey(req)) fail(403, "API keys cannot use this route"); };
  const agentUser = (s, req) => {
    if (bearerApiKey(req)) fail(401, "Agent credential invalid or revoked");
    const credential = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const hashed = hashToken(credential);
    const agent = Object.values(s.agents).find((a) => a.hash === hashed && !a.revoked);
    if (!agent) fail(401, "Agent credential invalid or revoked");
    return agent;
  };
  const admin = (s, req) => { const u = sessionUser(s, req); if (!["owner", "admin"].includes(u.role)) fail(403, "Admin role required"); return u; };
  const ownerOnly = (s, req) => { const u = sessionUser(s, req); if (u.role !== "owner") fail(403, "Workspace owner required"); return u; };
  const orgMembers = (s, orgId) => Object.values(s.users).filter((m) => m.orgId === orgId).map((m) => ({ id: m.id, email: m.email, role: m.role, verified: Boolean(m.verified) })).sort((a, b) => a.email.localeCompare(b.email));
  // Issue #123: org teams and their verdicts from synced receipts.
  const orgTeams = (s, orgId) => Object.values(s.teams ?? {}).filter((t) => t.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name));
  const sweepRaises = (s) => { for (const row of expireRaises(s, now())) audit(s, row.orgId, "cap-raise-expiry", "cap_request.expire", row.agentId, { request_id: row.request_id, scope: row.scope, reason: row.reason, before: row.before, after: row.after }); };
  const agentReceipts = (s, agentId) => Object.values(s.receipts).filter((r) => r.agentId === agentId).map(costedReceipt);
  // Issue #127: org-scoped, so another org's receipts never count toward agent_spend.
  const orgAgentReceipts = (s, orgId, agentId) => Object.values(s.receipts).filter((r) => r.orgId === orgId && r.agentId === agentId).map(costedReceipt);
  // Issue #204: settled-aware org receipts for fleet tag caps.
  const orgReceipts = (s, orgId) => Object.values(s.receipts).filter((r) => r.orgId === orgId).map(costedReceipt);
  // Issue #209: the org budget period (timezone + month start day); UTC/day 1 when unset.
  const orgPeriod = (s, orgId) => normalizeBudgetPeriod(s.orgs?.[orgId]?.budgetPeriod);
  // Issue #211: org receipt retention (null = keep). Deleted receipts take their settlement with them.
  const orgRetention = (s, orgId) => { const days = s.orgs?.[orgId]?.receiptRetentionDays; return Number.isInteger(days) ? days : null; };
  const retentionWindow = (s, orgId) => ({ cutoff: retentionCutoffMs(orgRetention(s, orgId), now()), floor: retentionFloorMs(now(), orgPeriod(s, orgId)) });
  const retentionView = (s, orgId, role) => {
    const days = orgRetention(s, orgId);
    const { cutoff, floor } = retentionWindow(s, orgId);
    return { days, cutoff: cutoff === null ? null : new Date(cutoff).toISOString(), protected_since: new Date(floor).toISOString(), eligible_count: expiredReceiptKeys(s.receipts, orgId, cutoff, floor).length,
      min: RETENTION_MIN_DAYS, max: retentionMaxDays(entitlements(s, orgId)), canEdit: ["owner", "admin"].includes(role) };
  };
  // Nightly sweep (run.js): one receipts.purge audit entry per org that lost receipts.
  function purgeExpiredReceipts() {
    return store.transaction((s) => {
      const out = [];
      for (const orgId of Object.keys(s.orgs ?? {})) {
        const { cutoff, floor } = retentionWindow(s, orgId);
        const keys = expiredReceiptKeys(s.receipts, orgId, cutoff, floor);
        if (!keys.length) continue;
        for (const key of keys) delete s.receipts[key];
        audit(s, orgId, "retention-sweep", "receipts.purge", orgId, { count: keys.length, cutoff: new Date(cutoff).toISOString() });
        out.push({ orgId, count: keys.length });
      }
      return out;
    });
  }
  const verdictOf = (s, team) => teamVerdict({ team, nowMs: now(), budgetPeriod: orgPeriod(s, team.orgId), receiptsByAgent: Object.fromEntries(team.agents.map((id) => [id, agentReceipts(s, id)])) });
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let logged = false;
    res.on("finish", () => {
      if (logged) return;
      logged = true;
      let path = "/";
      try { path = new URL(req.url ?? "/", origin).pathname; } catch { path = "/"; }
      const line = JSON.stringify({ method: req.method, path, status: res.statusCode, durationMs: Date.now() - started });
      try { requestLog(line); } catch { /* a log sink failure must not change the response */ }
    });
    // Answer only after the datastore holds every committed change (a no-op for the file store).
    const json = async (status, value, headers = {}) => {
      try { await store.flush?.(); }
      catch { if (status < 400) { status = 503; value = { error: "Datastore unavailable" }; headers = {}; } }
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers }).end(JSON.stringify(value));
    };
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === "GET") {
        const ui = uiResponse(path, turnstileSiteKey, origin, Boolean(billing) && stripeMode !== "test", stripeMode, { publicPricing: pricingPublic, plans, checkout: Boolean(billing) });
        if (ui) return res.writeHead(200, ui.headers).end(ui.body);
      }
      if (req.method === "GET" && path === "/health") return json(200, { status: "ok", product: "CostCap", beta: true, billing: billing ? "enabled" : "disabled", persistence: store.mode ?? "single-process-file", ...(store.healthy && !store.healthy() ? { datastore: "degraded" } : {}), version: VERSION, sha: process.env.COSTCAP_GIT_SHA || null });
      if (req.method === "GET" && path === "/api/health/stripe") {
        await billingReady;
        return json(200, stripeHealth({ enabled: Boolean(billing), env: stripeEnv, mode: stripeMode }));
      }
      const browserMutation = req.method !== "GET" && !req.headers.authorization;
      if (browserMutation && !(billing && path === "/billing/webhook") && req.headers.origin !== origin) fail(403, "Origin rejected");
      let text = "";
      for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > bodyLimit) fail(413, "Body too large"); }
      if (billing && path === "/billing/webhook" && req.method === "POST") return json(200, await billing.webhook(text, req.headers["stripe-signature"]));
      if (billing && path.startsWith("/billing/") && ["GET", "POST"].includes(req.method)) {
        if (req.method === "POST" && req.headers.origin !== origin) fail(403, "Origin rejected");
        sessionOnly(req);
        const user = store.read(s => sessionUser(s, req));
        if (path === "/billing/status" && req.method === "GET") return json(200, await billing.status(user.orgId));
        if (user.role !== "owner") fail(403, "Workspace owner required");
        if (path === "/billing/checkout" && req.method === "POST") {
          let plan;
          try { plan = text ? JSON.parse(text).plan : undefined; } catch { fail(400, "Invalid JSON"); }
          if (plan !== undefined && (typeof plan !== "string" || !/^[a-z]{1,20}$/.test(plan))) fail(400, "Unknown plan");
          return json(200, await billing.checkout(user, plan ? { plan } : {}));
        }
        if (path === "/billing/portal" && req.method === "POST") return json(200, await billing.portal(user.orgId));
      }
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { fail(400, "Invalid JSON"); }
      if (path === "/auth/request" && req.method === "POST") {
        const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
        if (!/^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{2,40}$/.test(email)) fail(400, "Valid email required");
        const key = req.socket.remoteAddress;
        if (rate.size > 10000) rate.clear();
        const recent = (rate.get(key) ?? []).filter((ts) => ts > now() - 3600_000);
        if (recent.length >= 5) fail(429, "Try later");
        if (!await verifyChallenge(body.turnstileToken, req.socket.remoteAddress)) fail(403, "Challenge failed");
        rate.set(key, [...recent, now()]);
        const code = String(randomInt(10000000, 100000000));
        const challengeId = token();
        store.transaction((s) => { s.challenges[hashToken(challengeId)] = { email, code: hashToken(code), expires: now() + 600_000, attempts: 0 }; });
        try { await sendCode({ email, code }); }
        catch { store.transaction((s) => { delete s.challenges[hashToken(challengeId)]; }); fail(503, "Verification delivery unavailable"); }
        return json(200, { challengeId, expiresInSeconds: 600 });
      }
      if (path === "/auth/verify" && req.method === "POST") {
        const challengeHash = hashToken(String(body.challengeId ?? ""));
        const sessionToken = token();
        const result = store.transaction((s) => {
          const challenge = s.challenges[challengeHash];
          if (!challenge || challenge.expires <= now() || challenge.attempts >= 5) return { error: "Challenge expired" };
          challenge.attempts++;
          if (challenge.code !== hashToken(String(body.code ?? ""))) return { error: "Wrong code" };
          delete s.challenges[challengeHash];
          let user = Object.values(s.users).find((u) => u.email === challenge.email);
          if (!user) {
            s.invitations ??= {};
            const invite = Object.values(s.invitations).filter((item) => item.email === challenge.email && item.expires > now()).sort((a, b) => b.expires - a.expires)[0];
            const id = randomUUID();
            if (invite && ["admin", "viewer"].includes(invite.role) && s.orgs[invite.orgId]) {
              // Re-check at acceptance: the plan may have lapsed since the invite was issued.
              // Count current members only, so the invite being redeemed never counts against itself.
              // A refusal throws, rolling back the whole transaction: no user, no fallback org, invite kept.
              try {
                requireLimit(entitlements(s, invite.orgId), "seats", planUsage(s, invite.orgId, now(), { pending: false }).seats, 1, upgradeUrl);
              } catch (err) {
                err.message = "This workspace is at its people limit. Ask the owner to upgrade or remove someone, then sign in again to accept the invite.";
                throw err;
              }
              user = { id, email: challenge.email, orgId: invite.orgId, role: invite.role, verified: true };
              s.users[id] = user;
              delete s.invitations[invite.id];
              audit(s, invite.orgId, id, "invitation.accept", invite.id, { role: invite.role });
            } else {
              const orgId = randomUUID();
              s.orgs[orgId] = { id: orgId, name: challenge.email.split("@")[1], created: now() };
              user = { id, email: challenge.email, orgId, role: "owner", verified: true };
              s.users[id] = user;
              audit(s, orgId, id, "org.create", orgId);
            }
          }
          s.sessions[hashToken(sessionToken)] = { userId: user.id, expires: now() + 24 * 3600_000 };
          return { id: user.id, orgId: user.orgId, role: user.role };
        });
        if (result.error) fail(401, result.error);
        return json(200, result, { "set-cookie": `costcap_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secureCookies ? "; Secure" : ""}` });
      }
      if (path === "/auth/logout" && req.method === "POST") {
        store.transaction((s) => {
          sessionUser(s, req);
          const cookie = /(?:^|;\s*)costcap_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
          delete s.sessions[hashToken(cookie)];
        });
        return json(200, { ok: true }, { "set-cookie": "costcap_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
      }
      // Issue #203: a valid key records last use before the route runs (reads use a snapshot).
      const rawKey = bearerApiKey(req);
      if (rawKey) store.transaction((s) => { findApiKey(s, rawKey, now()).lastUsedAt = new Date(now()).toISOString(); });
      if (path === "/v1/api-keys" && req.method === "GET") {
        sessionOnly(req);
        return json(200, store.read((s) => { const u = admin(s, req); return { keys: Object.values(s.apiKeys ?? {}).filter((k) => k.orgId === u.orgId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((k) => maskApiKey(k, now())) }; }));
      }
      if (path === "/v1/api-keys" && req.method === "POST") {
        sessionOnly(req);
        const input = parseApiKeyInput(body, now());
        const result = store.transaction((s) => {
          const u = admin(s, req);
          const { record, raw } = createApiKey(s, { orgId: u.orgId, createdBy: u.id, ...input }, now());
          audit(s, u.orgId, u.id, "api_key.create", record.id, { name: record.name, role: record.role, expires_at: record.expiresAt });
          return { ...maskApiKey(record, now()), key: raw };
        });
        return json(201, result);
      }
      const keyRevoke = /^\/v1\/api-keys\/([^/]+)\/revoke$/.exec(path);
      if (keyRevoke && req.method === "POST") {
        sessionOnly(req);
        const result = store.transaction((s) => {
          const u = admin(s, req);
          const k = (s.apiKeys ?? {})[decodeURIComponent(keyRevoke[1])];
          if (!k || k.orgId !== u.orgId) fail(404, "API key not found");
          if (!k.revokedAt) { k.revokedAt = new Date(now()).toISOString(); audit(s, u.orgId, u.id, "api_key.revoke", k.id, { name: k.name }); }
          return maskApiKey(k, now());
        });
        return json(200, result);
      }
      if (path === "/v1/enrollment-tokens" && req.method === "POST") {
        sessionOnly(req);
        const raw = token();
        const policy = { version: 1, caps: body.caps ?? {}, killed: false, ...(body.maxSteps != null ? { maxSteps: body.maxSteps } : {}), ...(body.models != null ? { models: body.models } : {}) };
        if (validatePolicy(policy).length) fail(400, "Invalid caps");
        store.transaction((s) => {
          const user = admin(s, req);
          requireLimit(entitlements(s, user.orgId), "agents", planUsage(s, user.orgId, now()).agents, 1, upgradeUrl);
          s.enrollments[hashToken(raw)] = { orgId: user.orgId, policy, expires: now() + 600_000 };
          audit(s, user.orgId, user.id, "enrollment.issue", null);
        });
        return json(201, { token: raw, expiresInSeconds: 600 });
      }
      if (path === "/v1/enroll" && req.method === "POST") {
        const raw = token();
        const result = store.transaction((s) => {
          const h = hashToken((req.headers.authorization ?? "").replace(/^Bearer /, ""));
          const grant = s.enrollments[h];
          if (!grant || grant.expires <= now()) fail(401, "Enrollment invalid/expired/used");
          if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100) fail(400, "Agent name required");
          // Re-check at redemption: the plan may have lapsed since the token was issued.
          requireLimit(entitlements(s, grant.orgId), "agents", planUsage(s, grant.orgId, now(), { pending: false }).agents, 1, upgradeUrl);
          const id = randomUUID();
          s.agents[id] = { id, orgId: grant.orgId, name: body.name, hash: hashToken(raw), policy: grant.policy, lastSeen: now(), revoked: false };
          delete s.enrollments[h];
          audit(s, grant.orgId, id, "agent.enroll", id);
          return { agentId: id, token: raw, policy: grant.policy };
        });
        return json(201, result);
      }
      if (path === "/v1/policy" && req.method === "GET") {
        const p = store.transaction((s) => { const a = agentUser(s, req); a.lastSeen = now(); const t = teamFor(Object.values(s.teams ?? {}), a.orgId, a.id); const bp = orgPeriod(s, a.orgId); return { ...a.policy, team: t ? teamPolicy(verdictOf(s, t), now()) : null, agent_spend: agentSpendPolicy(orgAgentReceipts(s, a.orgId, a.id), now(), bp), settlements: agentSettlements(s, a), tag_caps: fleetTagCapsPolicy(s.orgs[a.orgId]?.tagCaps ?? [], orgReceipts(s, a.orgId), now(), undefined, bp), budget_period: { ...bp } }; });
        return json(200, p);
      }
      if (path === "/v1/receipts" && req.method === "POST") {
        if (!Array.isArray(body.receipts) || body.receipts.length > 100) fail(400, "Up to 100 receipts required");
        const result = store.transaction((s) => {
          const a = agentUser(s, req);
          const acceptedIds = [];
          let expired = 0;
          const keep = retentionWindow(s, a.orgId);
          for (const r of body.receipts) {
            if (r && typeof r.path === "string") r.path = scrubReceiptPath(r.path);
            if (!r || typeof r.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(r.id) || !Number.isFinite(Date.parse(r.ts)) || (r.cost_usd !== null && (!Number.isFinite(r.cost_usd) || r.cost_usd < 0)) || !validTags(r.tags)) fail(400, "Invalid receipt");
            // #184: saved_usd only on a $0 cache_hit receipt, as a finite number >= 0.
            if ("saved_usd" in r && (r.reason !== "cache_hit" || r.cost_usd !== 0 || typeof r.saved_usd !== "number" || !Number.isFinite(r.saved_usd) || r.saved_usd < 0)) fail(400, "Invalid receipt: saved_usd");
            const key = `${a.id}:${r.id}`;
            // #211: older than the org retention cutoff: acknowledged so the backlog drains, never stored.
            if (!s.receipts[key] && isExpired({ receipt: r }, keep.cutoff, keep.floor)) { expired++; acceptedIds.push(r.id); continue; }
            if (s.receipts[key] && JSON.stringify(s.receipts[key].receipt) !== JSON.stringify(r)) fail(409, "Receipt ID content conflict");
            s.receipts[key] ??= { orgId: a.orgId, agentId: a.id, receipt: r };
            acceptedIds.push(r.id);
          }
          a.lastSeen = now();
          audit(s, a.orgId, a.id, "receipts.sync", a.id, expired ? { count: acceptedIds.length, expired } : { count: acceptedIds.length });
          return { acceptedIds, expired };
        });
        return json(200, result);
      }
      if (path === "/v1/receipts.csv" && req.method === "GET") {
        const csv = store.read((s) => {
          const u = member(s, req);
          const orgAgents = new Set(Object.values(s.agents).filter((a) => a.orgId === u.orgId).map((a) => a.id));
          const query = parseReceiptsQuery(new URL(req.url, origin).searchParams, orgAgents, parseAuditRange);
          const rows = visibleReceipts(s, u.orgId).map((item) => ({
            ts: item.receipt?.ts ?? "",
            agent_id: item.agentId,
            receipt_id: item.receipt?.id ?? "",
            run_id: item.receipt?.run_id ?? "",
            model: item.receipt?.model ?? "",
            cost_usd: item.receipt?.cost_usd == null ? "" : item.receipt.cost_usd,
            cost_source: item.receipt?.cost_source ?? "",
            settled_cost_usd: item.settlement?.cost_usd ?? "",
            settle_source: item.settlement?.source ?? "",
            reason: item.receipt?.reason ?? "",
            scope: item.receipt?.scope ?? "",
            outcome: item.receipt?.outcome ?? "",
            tags: item.receipt?.tags ?? null,
          }));
          return receiptsCsv(rows, query);
        });
        const headers = {
          "content-type": "text/csv; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": 'attachment; filename="costcap-receipts.csv"',
        };
        headers["x-costcap-total"] = String(csv.total);
        if (csv.truncated) headers["x-costcap-truncated"] = "true";
        return res.writeHead(200, headers).end(csv.body);
      }
      if (path === "/v1/audit.csv" && req.method === "GET") {
        const csv = store.read((s) => {
          const u = member(s, req);
          const range = parseAuditRange(new URL(req.url, origin).searchParams);
          return auditCsv(labelAudit(s, u.orgId, s.audit), range);
        });
        return res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": 'attachment; filename="costcap-audit.csv"',
        }).end(csv.body);
      }
      if (path === "/v1/evidence.json" && req.method === "GET") {
        return json(200, store.read((s) => {
          const u = member(s, req);
          return buildEvidence({ orgId: u.orgId, nowMs: now(), spendFor: (rs) => spendSummary(rs, now(), orgPeriod(s, u.orgId)),
            agents: Object.values(s.agents).filter((a) => a.orgId === u.orgId),
            receipts: visibleReceipts(s, u.orgId),
            alerts: filterAlerts(alertOccurrences(s.alerts).filter((a) => a.orgId === u.orgId)),
            audit: labelAudit(s, u.orgId, s.audit),
            teams: orgTeams(s, u.orgId).map((t) => verdictOf(s, t)) });
        }));
      }
      if (path === "/v1/spend" && req.method === "GET") {
        return json(200, store.read((s) => {
          const u = member(s, req);
          const query = parseSpendQuery(new URL(req.url, origin).searchParams);
          const names = Object.fromEntries(Object.values(s.agents).filter((a) => a.orgId === u.orgId).map((a) => [a.id, a.name]));
          return spendBreakdown(visibleReceipts(s, u.orgId), { ...query, cutoff: retentionCutoff(entitlements(s, u.orgId), now()), names, budgetPeriod: orgPeriod(s, u.orgId), teams: orgTeams(s, u.orgId) });
        }));
      }
      // #213: finance summary CSV, one row per period and group. Viewers and viewer keys may read it.
      if (path === "/v1/spend.csv" && req.method === "GET") {
        const csv = store.read((s) => {
          const u = member(s, req);
          const query = parseSpendQuery(new URL(req.url, origin).searchParams, { csv: true });
          const names = Object.fromEntries(Object.values(s.agents).filter((a) => a.orgId === u.orgId).map((a) => [a.id, a.name]));
          return spendCsv(visibleReceipts(s, u.orgId), { ...query, cutoff: retentionCutoff(entitlements(s, u.orgId), now()), names, budgetPeriod: orgPeriod(s, u.orgId), teams: orgTeams(s, u.orgId) });
        });
        return res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": 'attachment; filename="costcap-spend.csv"',
        }).end(csv.body);
      }
      if (path === "/v1/fleet" && req.method === "GET") {
        return json(200, store.read((s) => {
          const u = member(s, req);
          return { agents: Object.values(s.agents).filter((a) => a.orgId === u.orgId).map(({ hash, ...a }) => ({ ...a, spend: spendSummary(Object.values(s.receipts).filter((r) => r.agentId === a.id), now(), orgPeriod(s, u.orgId)) })),
            budget_period: { ...orgPeriod(s, u.orgId) },
            receipts: visibleReceipts(s, u.orgId),
            audit: labelAudit(s, u.orgId, s.audit), alerts: filterAlerts(alertOccurrences(s.alerts).filter((a) => a.orgId === u.orgId)),
            fleetFrozen: Boolean(s.fleetFreezes?.[u.orgId]?.active),
            teams: orgTeams(s, u.orgId).map((t) => verdictOf(s, t)),
            role: u.role, members: orgMembers(s, u.orgId), invitations: ["owner", "admin"].includes(u.role) ? Object.values(s.invitations ?? {}).filter((item) => item.orgId === u.orgId && item.expires > now()).map(({ invitedBy, ...item }) => item) : [],
            beta: true, billing: billing ? "enabled" : "disabled",
            plan: { ...entitlements(s, u.orgId), usage: planUsage(s, u.orgId, now(), { pending: false }), upgradeUrl },
            onboarding: onboardingState({
              tokensIssued: s.audit.filter((e) => e.org_id === u.orgId && e.action === "enrollment.issue").length,
              agents: Object.values(s.agents).filter((a) => a.orgId === u.orgId).length,
              receipts: Object.values(s.receipts).filter((r) => r.orgId === u.orgId).length,
            }) };
        }));
      }
      if (path === "/v1/invitations" && req.method === "POST") {
        const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
        if (!/^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{2,40}$/.test(email)) fail(400, "Valid email required");
        if (!["admin", "viewer"].includes(body.role)) fail(400, "Role must be admin or viewer");
        if (!sendInvite) fail(503, "Invitation delivery unavailable");
        const id = randomUUID();
        const created = store.transaction((s) => {
          s.invitations ??= {};
          const user = admin(s, req);
          if (Object.values(s.users).some((u) => u.email === email)) fail(409, "That email already has an account");
          const pending = Object.values(s.invitations).filter((item) => item.orgId === user.orgId && item.expires > now());
          if (pending.some((item) => item.email === email)) fail(409, "An invite is already pending for that email");
          if (pending.length >= 20) fail(429, "Too many pending invitations");
          requireLimit(entitlements(s, user.orgId), "seats", planUsage(s, user.orgId, now()).seats, 1, upgradeUrl);
          s.invitations[id] = { id, email, orgId: user.orgId, role: body.role, expires: now() + 7 * 24 * 3600_000, invitedBy: user.id };
          audit(s, user.orgId, user.id, "invitation.issue", id, { email, role: body.role });
          return { orgName: s.orgs[user.orgId].name };
        });
        try { await sendInvite({ email, role: body.role, orgName: created.orgName }); }
        catch {
          store.transaction((s) => { delete s.invitations?.[id]; });
          fail(503, "Invitation delivery unavailable");
        }
        return json(201, { id, email, role: body.role, expiresInSeconds: 7 * 24 * 3600 });
      }
      const inviteRevoke = /^\/v1\/invitations\/([^/]+)\/revoke$/.exec(path);
      if (inviteRevoke && req.method === "POST") {
        store.transaction((s) => {
          const user = admin(s, req);
          const invite = s.invitations?.[inviteRevoke[1]];
          if (!invite || invite.orgId !== user.orgId) fail(404, "Invitation not found");
          delete s.invitations[invite.id];
          audit(s, user.orgId, user.id, "invitation.revoke", invite.id);
        });
        return json(200, { revoked: true });
      }
      // Issue #137: member removal and role change. Org-scoped; the last owner is never removed or demoted.
      const memberAction = /^\/v1\/members\/([^/]+)\/(remove|role)$/.exec(path);
      if (memberAction && req.method === "POST") {
        const [, targetId, action] = memberAction;
        if (action === "role" && !["admin", "viewer"].includes(body.role)) fail(400, "Role must be admin or viewer");
        const result = store.transaction((s) => {
          const actor = action === "role" ? ownerOnly(s, req) : admin(s, req);
          const target = s.users[targetId];
          if (!target || target.orgId !== actor.orgId) fail(404, "Member not found");
          const owners = Object.values(s.users).filter((m) => m.orgId === actor.orgId && m.role === "owner");
          if (target.role === "owner" && actor.role !== "owner") fail(403, "Only an owner can remove an owner");
          if (target.role === "owner" && owners.length <= 1) fail(409, action === "role" ? "Cannot demote the last owner" : "Cannot remove the last owner");
          if (action === "role") {
            const previous = target.role;
            target.role = body.role;
            audit(s, actor.orgId, actor.id, "member.role", target.id, { email: target.email, previous, role: body.role });
            return { id: target.id, email: target.email, role: target.role, verified: Boolean(target.verified) };
          }
          for (const [key, session] of Object.entries(s.sessions)) if (session.userId === target.id) delete s.sessions[key];
          const org = s.orgs[actor.orgId];
          if (org?.alertSettings?.emails?.includes(target.email)) org.alertSettings = { ...org.alertSettings, emails: org.alertSettings.emails.filter((e) => e !== target.email) };
          delete s.users[target.id];
          audit(s, actor.orgId, actor.id, "member.remove", target.id, { email: target.email, role: target.role });
          return { removed: true, id: target.id };
        });
        return json(200, result);
      }
      // Issue #121: per-org alert destinations. Any member reads the masked view;
      // owner/admin writes. The full Slack webhook is never returned or audited.
      if (path === "/v1/alert-settings" && req.method === "GET") {
        return json(200, store.read((s) => { const u = sessionUser(s, req); return { ...maskAlertSettings(s.orgs[u.orgId]?.alertSettings), canEdit: ["owner", "admin"].includes(u.role) }; }));
      }
      if (path === "/v1/alert-settings" && req.method === "POST") {
        if (body.emails !== undefined && (!Array.isArray(body.emails) || body.emails.length > 20 || body.emails.some((e) => typeof e !== "string"))) fail(400, "emails must be a list of up to 20 addresses");
        if (body.slackWebhook !== undefined && body.slackWebhook !== null && body.slackWebhook !== "" && !validSlackWebhook(body.slackWebhook)) fail(400, "Slack webhook must be https://hooks.slack.com/services/...");
        if (body.webhook !== undefined && body.webhook !== null && body.webhook !== "") {
          store.read((s) => admin(s, req)); // Role check before any DNS lookup.
          await assertWebhookTarget(body.webhook, resolveHost);
        }
        if (body.rotateWebhookSecret !== undefined && typeof body.rotateWebhookSecret !== "boolean") fail(400, "rotateWebhookSecret must be a boolean");
        const result = store.transaction((s) => {
          const u = admin(s, req);
          const org = s.orgs[u.orgId];
          if (!org) fail(404, "Organization not found");
          const current = org.alertSettings ?? { emails: [], slackWebhook: null };
          let emails = current.emails ?? [];
          if (body.emails !== undefined) {
            emails = [...new Set(body.emails.map((e) => e.toLowerCase().trim()).filter(Boolean))];
            const members = new Set(Object.values(s.users).filter((m) => m.orgId === u.orgId && m.verified).map((m) => m.email));
            const bad = emails.filter((e) => !members.has(e));
            if (bad.length) fail(400, "Alert emails must be verified members of this organization");
          }
          const slackWebhook = body.slackWebhook === undefined ? (current.slackWebhook ?? null) : (body.slackWebhook || null);
          // Issue #199: the signing secret is server-generated and returned in full only here, on create or rotate.
          let webhook = current.webhook ?? null, issued = null;
          if (body.webhook === null || body.webhook === "") webhook = null;
          else if (body.webhook !== undefined && body.webhook !== webhook?.url) { issued = newWebhookSecret(); webhook = { url: body.webhook, secret: issued }; }
          if (body.rotateWebhookSecret === true) {
            if (!webhook) fail(400, "No webhook to rotate");
            if (!issued) { issued = newWebhookSecret(); webhook = { url: webhook.url, secret: issued }; }
          }
          const next = { emails, slackWebhook, ...(webhook ? { webhook } : {}) };
          org.alertSettings = next;
          audit(s, u.orgId, u.id, "alert_settings.change", u.orgId, { previous: maskAlertSettings(current), next: maskAlertSettings(next), ...(issued ? { webhookSecret: "issued" } : {}) });
          return { ...maskAlertSettings(next), canEdit: true, ...(issued ? { webhookSecret: issued } : {}) };
        });
        return json(200, result);
      }
      // Issue #209: org budget period. Owner/admin write (audited before/after), any member reads.
      if (path === "/v1/budget-period" && req.method === "GET") {
        return json(200, store.read((s) => { const u = sessionUser(s, req); return { budgetPeriod: { ...orgPeriod(s, u.orgId) }, canEdit: ["owner", "admin"].includes(u.role) }; }));
      }
      if (path === "/v1/budget-period" && (req.method === "POST" || req.method === "PUT")) {
        const result = store.transaction((s) => {
          const u = admin(s, req);
          const input = body?.budgetPeriod ?? body;
          const err = budgetPeriodError(input);
          if (err) fail(400, err);
          const org = s.orgs[u.orgId];
          if (!org) fail(404, "Organization not found");
          const before = { ...orgPeriod(s, u.orgId) };
          const after = { ...before, ...input };
          org.budgetPeriod = after;
          audit(s, u.orgId, u.id, "budget_period.change", u.orgId, { before, after });
          return { budgetPeriod: after, canEdit: true };
        });
        return json(200, result);
      }
      // Issue #211: receipt retention. Owner/admin session writes (audited), any member reads.
      if (path === "/v1/retention" && req.method === "GET") {
        return json(200, store.read((s) => { const u = member(s, req); return retentionView(s, u.orgId, u.role); }));
      }
      if (path === "/v1/retention" && (req.method === "POST" || req.method === "PUT")) {
        sessionOnly(req);
        const result = store.transaction((s) => {
          const u = admin(s, req);
          const days = body?.days === undefined ? undefined : body.days;
          const err = days === undefined ? "days required" : retentionDaysError(days, retentionMaxDays(entitlements(s, u.orgId)));
          if (err) fail(400, err);
          const org = s.orgs[u.orgId];
          if (!org) fail(404, "Organization not found");
          const before = orgRetention(s, u.orgId);
          org.receiptRetentionDays = days;
          audit(s, u.orgId, u.id, "retention.change", u.orgId, { before, after: days });
          return retentionView(s, u.orgId, u.role);
        });
        return json(200, result);
      }
      // Issue #204: org-level fleet tag caps. Owner/admin write, any member reads.
      if (path === "/v1/tag-caps" && req.method === "GET") {
        return json(200, store.read((s) => { const u = sessionUser(s, req); return { tagCaps: s.orgs[u.orgId]?.tagCaps ?? [], canEdit: ["owner", "admin"].includes(u.role) }; }));
      }
      if (path === "/v1/tag-caps" && req.method === "PUT") {
        const result = store.transaction((s) => {
          const u = admin(s, req);
          const parsed = parseFleetTagCaps(body.tagCaps);
          if (parsed.error) fail(400, parsed.error);
          const org = s.orgs[u.orgId];
          if (!org) fail(404, "Organization not found");
          const previous = org.tagCaps ?? [];
          org.tagCaps = parsed.rules;
          audit(s, u.orgId, u.id, "tag_caps.change", u.orgId, { previous, next: parsed.rules });
          return { tagCaps: parsed.rules, canEdit: true };
        });
        return json(200, result);
      }
      if (path === "/v1/teams" && req.method === "GET") {
        return json(200, store.read((s) => { const u = sessionUser(s, req); return { teams: orgTeams(s, u.orgId).map((t) => verdictOf(s, t)), canEdit: ["owner", "admin"].includes(u.role) }; }));
      }
      if (path === "/v1/teams" && req.method === "POST") {
        const result = store.transaction((s) => {
          s.teams ??= {};
          const u = admin(s, req);
          const input = parseTeamInput(body, { orgId: u.orgId, orgAgents: Object.values(s.agents).filter((a) => !a.revoked), teams: Object.values(s.teams) });
          const key = teamKey(u.orgId, input.name);
          const current = s.teams[key] ?? null;
          const strip = (t) => (t ? { name: t.name, agents: [...t.agents], day: t.day ?? null, month: t.month ?? null, ...(Array.isArray(t.warnFractions) ? { warnFractions: [...t.warnFractions] } : {}) } : null);
          if (input.remove) {
            if (!current) fail(404, "Team not found");
            delete s.teams[key];
            audit(s, u.orgId, u.id, "team.change", input.name, { previous: strip(current), next: null });
            return { removed: true, name: input.name };
          }
          const { name, agents, day, month } = input;
          const warnFractions = input.warnFractions === undefined ? current?.warnFractions : input.warnFractions;
          s.teams[key] = { orgId: u.orgId, name, agents, ...(day != null ? { day } : {}), ...(month != null ? { month } : {}), ...(Array.isArray(warnFractions) ? { warnFractions } : {}) };
          audit(s, u.orgId, u.id, "team.change", name, { previous: strip(current), next: strip(s.teams[key]) });
          return verdictOf(s, s.teams[key]);
        });
        return json(200, result);
      }
      // Issue #159: per-run drill-down. An agent token reads only its own runs; any member (viewer included) any agent in the org.
      const runsRoute = /^\/v1\/agents\/([^/]+)\/runs(?:\/([^/]+))?$/.exec(path);
      if (runsRoute && req.method === "GET") {
        return json(200, store.read((s) => {
          const caller = req.headers.authorization && !bearerApiKey(req) ? { agent: agentUser(s, req) } : { user: member(s, req) };
          const a = s.agents[decodeURIComponent(runsRoute[1])];
          const orgId = caller.agent?.orgId ?? caller.user.orgId;
          if (!a || a.orgId !== orgId || (caller.agent && caller.agent.id !== a.id)) fail(404, "Agent not found");
          const cutoff = retentionCutoff(entitlements(s, orgId), now());
          const items = Object.values(s.receipts).filter((r) => r.orgId === orgId && r.agentId === a.id);
          if (runsRoute[2]) {
            const runId = decodeURIComponent(runsRoute[2]);
            const receipts = runReceipts(items, runId, { cutoff });
            if (!receipts.length) fail(404, "Run not found");
            const [run] = summarizeRuns(items.filter((item) => receipts.some((r) => r.receipt_id === item.receipt?.id)));
            return { agent_id: a.id, run, receipts, estimate_only: true };
          }
          const query = parseRunsQuery(new URL(req.url, origin).searchParams);
          return { agent_id: a.id, ...pageRuns(items, { ...query, cutoff }), estimate_only: true };
        }));
      }
      const budgetRoute = /^\/v1\/agents\/([^/]+)\/budget$/.exec(path);
      if (budgetRoute && req.method === "GET") {
        return json(200, store.read((s) => {
          // An enrolled agent token may read only its own verdict; a member (viewers included) any agent in the org.
          const caller = req.headers.authorization && !bearerApiKey(req) ? { agent: agentUser(s, req) } : { user: member(s, req) };
          const a = s.agents[budgetRoute[1]];
          const orgId = caller.agent?.orgId ?? caller.user.orgId;
          if (!a || a.orgId !== orgId || (caller.agent && caller.agent.id !== a.id)) fail(404, "Agent not found");
          const receipts = agentReceipts(s, a.id);
          const runId = new URL(req.url, origin).searchParams.get("run_id");
          const t = teamFor(Object.values(s.teams ?? {}), a.orgId, a.id);
          return hostedAgentVerdict({ agent: a, receipts, nowMs: now(), budgetPeriod: orgPeriod(s, a.orgId), runId: runId || null, team: t ? verdictOf(s, t) : null });
        }));
      }
      // Issue #208: time-boxed cap raise requests.
      const capReqRoute = /^\/v1\/agents\/([^/]+)\/cap-requests$/.exec(path);
      if (capReqRoute && req.method === "POST") {
        const input = parseCapRequest(body);
        const result = store.transaction((s) => {
          const caller = req.headers.authorization && !bearerApiKey(req) ? { agent: agentUser(s, req) } : { user: member(s, req) };
          const a = s.agents[decodeURIComponent(capReqRoute[1])];
          const orgId = caller.agent?.orgId ?? caller.user.orgId;
          if (!a || a.orgId !== orgId || a.revoked || (caller.agent && caller.agent.id !== a.id)) fail(404, "Agent not found");
          const actor = caller.agent?.id ?? caller.user.id;
          const record = createCapRequest(s, { agent: a, actor, input, id: randomUUID(), nowMs: now() });
          audit(s, orgId, actor, "cap_request.create", a.id, { request_id: record.id, scope: input.scope, amount_usd: input.amount_usd, duration_hours: input.duration_hours, reason: input.reason, before: { caps: { ...a.policy.caps } }, after: { caps: { ...a.policy.caps } } });
          return record;
        });
        return json(201, result);
      }
      if (path === "/v1/cap-requests" && req.method === "GET") {
        const status = new URL(req.url, origin).searchParams.get("status") ?? "all";
        if (!CAP_REQUEST_STATUSES.includes(status)) fail(400, `status must be one of ${CAP_REQUEST_STATUSES.join("|")}`);
        return json(200, store.transaction((s) => {
          const u = member(s, req);
          sweepRaises(s);
          const names = Object.fromEntries(Object.values(s.agents).filter((a) => a.orgId === u.orgId).map((a) => [a.id, a.name]));
          return { requests: listCapRequests(s, u.orgId, status).map((r) => ({ ...r, agent_name: names[r.agentId] ?? null })), canDecide: ["owner", "admin"].includes(u.role) };
        }));
      }
      const decideRoute = /^\/v1\/cap-requests\/([^/]+)\/(approve|deny)$/.exec(path);
      if (decideRoute && req.method === "POST") {
        return json(200, store.transaction((s) => {
          const u = memberAdmin(s, req);
          const r = findRequest(s, u.orgId, decodeURIComponent(decideRoute[1]));
          const a = s.agents[r.agentId];
          if (decideRoute[2] === "deny") {
            const note = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
            denyCapRequest(r, { actor: u.id, note, nowMs: now() });
            audit(s, u.orgId, u.id, "cap_request.deny", r.agentId, { request_id: r.id, scope: r.scope, reason: r.reason, note, before: { caps: { ...a.policy.caps } }, after: { caps: { ...a.policy.caps } } });
            return r;
          }
          const approval = parseApproval(body, r);
          const { before, after } = approveCapRequest(s, { request: r, approval, actor: u.id, nowMs: now() });
          audit(s, u.orgId, u.id, "cap_request.approve", r.agentId, { request_id: r.id, scope: r.scope, amount_usd: approval.amount_usd, duration_hours: approval.duration_hours, expires_at: r.expires_at, reason: r.reason, note: approval.note, before, after });
          return r;
        }));
      }
      if ((path === "/v1/fleet/freeze" || path === "/v1/fleet/resume") && req.method === "POST") {
        const freeze = path.endsWith("/freeze");
        const result = store.transaction((s) => {
          const u = memberAdmin(s, req);
          const reason = fleetReason(body?.reason, true);
          return freeze ? freezeFleet(s, u, reason) : resumeFleet(s, u, reason);
        });
        return json(200, result);
      }
      const update = /^\/v1\/agents\/([^/]+)\/(policy|revoke)$/.exec(path);
      if (update && req.method === "POST") {
        const result = store.transaction((s) => {
          const u = memberAdmin(s, req), a = s.agents[update[1]];
          if (!a || a.orgId !== u.orgId) fail(404, "Agent not found");
          if (update[2] === "revoke") { a.revoked = true; audit(s, u.orgId, u.id, "agent.revoke", a.id); return { revoked: true }; }
          const reason = fleetReason(body.reason, false);
          // maxSteps: omitted keeps the current value, null clears it (issue #114).
          const maxSteps = body.maxSteps === undefined ? a.policy.maxSteps : body.maxSteps;
          // silentAfterHours (issue #134): omitted keeps, null resets to the 6h default, 0 turns silence alerts off.
          const silentAfterHours = body.silentAfterHours === undefined ? a.policy.silentAfterHours : body.silentAfterHours;
          // models (issue #153): omitted keeps the allowlist, null clears it.
          const models = body.models === undefined ? a.policy.models : body.models;
          // warnFractions (issue #165): omitted keeps, null resets to the [0.8] default, [] turns cap_approaching off.
          const rawWarn = body.warnFractions === undefined ? a.policy.warnFractions : body.warnFractions;
          const warnFractions = Array.isArray(rawWarn) && rawWarn.every((f) => typeof f === "number") ? sortWarnFractions(rawWarn) : rawWarn;
          // rpm/tpm (issue #192): omitted keeps the current value, null clears it.
          const rpm = body.rpm === undefined ? a.policy.rpm : body.rpm;
          const tpm = body.tpm === undefined ? a.policy.tpm : body.tpm;
          // downgrade (issue #207): omitted keeps, null clears.
          const downgrade = body.downgrade === undefined ? a.policy.downgrade : body.downgrade;
          const policy = { version: a.policy.version + 1, caps: body.caps ?? a.policy.caps, killed: body.killed ?? a.policy.killed, ...(maxSteps != null ? { maxSteps } : {}), ...(rpm != null ? { rpm } : {}), ...(tpm != null ? { tpm } : {}), ...(silentAfterHours != null ? { silentAfterHours } : {}), ...(models != null ? { models } : {}), ...(warnFractions != null ? { warnFractions } : {}), ...(downgrade != null ? { downgrade } : {}), ...(a.policy.raise ? { raise: a.policy.raise } : {}) };
          { const errs = validatePolicy(policy); if (errs.length) fail(400, `Invalid policy: ${errs.join("; ")}`); }
          const prev = a.policy ?? {};
          const previous = { caps: { ...(prev.caps ?? {}) }, killed: Boolean(prev.killed), maxSteps: prev.maxSteps ?? null, silentAfterHours: prev.silentAfterHours ?? null, models: prev.models ?? null, ...(prev.rpm != null && { rpm: prev.rpm }), ...(prev.tpm != null && { tpm: prev.tpm }) };
          a.policy = policy;
          audit(s, u.orgId, u.id, "policy.change", a.id, reason ? { previous, policy, reason } : { previous, policy });
          return policy;
        });
        return json(200, result);
      }
      // Issue #129: an enrolled agent uploads its own local reconcile settlement
      // (costcap reconcile --apply). Same record and audit shape as admin settle (#125).
      if (path === "/v1/receipts/settlements" && req.method === "POST") {
        const input = agentSettlementInput(body);
        const result = store.transaction((s) => {
          const a = agentUser(s, req);
          const item = s.receipts[`${a.id}:${input.receipt_id}`];
          if (!item || item.orgId !== a.orgId || item.agentId !== a.id) fail(404, "Receipt not found");
          if (item.settlement) {
            const same = item.settlement.source === "agent_reconcile" && item.settlement.by === a.id && item.settlement.cost_usd === input.cost_usd;
            if (same) return { receipt_id: input.receipt_id, settled_cost_usd: input.cost_usd, duplicate: true };
            const e = new Error("Receipt already settled"); e.status = 409; e.body = { code: "already_settled" }; throw e;
          }
          if (item.receipt.cost_usd != null) { const e = new Error("Receipt cost is already known"); e.status = 409; e.body = { code: "already_known" }; throw e; }
          const reason = `local reconcile${input.provider_sha256 ? ` sha256:${input.provider_sha256}` : ""}`;
          item.settlement = { cost_usd: input.cost_usd, at: new Date(now()).toISOString(), by: a.id, source: "agent_reconcile", reason, provider_sha256: input.provider_sha256, settled_ts: input.ts };
          a.lastSeen = now();
          audit(s, a.orgId, a.id, "receipt.settle", input.receipt_id, { event: "reconciliation", agent_id: a.id, before: null, after: input.cost_usd, source: "agent_reconcile", reason, provider_sha256: input.provider_sha256 });
          return { receipt_id: input.receipt_id, settled_cost_usd: input.cost_usd, duplicate: false };
        });
        return json(200, result);
      }
      if (path === "/v1/alerts" && req.method === "GET") {
        const params = new URL(req.url, origin).searchParams;
        const status = params.get("status") ?? "all";
        if (!ALERT_STATUSES.includes(status)) fail(400, "status must be active, acknowledged, resolved or all");
        const range = parseAuditRange(params);
        return json(200, store.read((s) => {
          const u = member(s, req);
          return { alerts: filterAlerts(alertOccurrences(s.alerts).filter((a) => a.orgId === u.orgId), { status, ...range }) };
        }));
      }
      const ackRoute = /^\/v1\/alerts\/([^/]+)\/ack$/.exec(path);
      if (ackRoute && req.method === "POST") {
        const id = decodeURIComponent(ackRoute[1]);
        return json(200, store.transaction((s) => {
          const u = memberAdmin(s, req);
          const record = Object.hasOwn(s.alerts, id) ? s.alerts[id] : null;
          if (!record || record.orgId !== u.orgId) fail(404, "Alert not found");
          if (!record.acknowledged_at) {
            record.acknowledged_at = new Date(now()).toISOString();
            record.acknowledged_by = u.email;
            audit(s, u.orgId, u.id, "alert.ack", id, { kind: record.kind ?? null, key: record.key ?? null });
          }
          return { alert: alertOccurrences({ [id]: record })[0] };
        }));
      }
      const settleRoute = /^\/v1\/receipts\/([^/]+)\/settle$/.exec(path);
      if (settleRoute && req.method === "POST") {
        const input = settleInput(body);
        const receiptId = decodeURIComponent(settleRoute[1]);
        const result = store.transaction((s) => {
          const u = memberAdmin(s, req);
          const matches = Object.values(s.receipts).filter((r) => r.orgId === u.orgId && r.receipt?.id === receiptId && (input.agentId === undefined || r.agentId === input.agentId));
          if (!matches.length) fail(404, "Receipt not found");
          if (matches.length > 1) fail(409, "Receipt id is ambiguous; pass agent_id");
          const item = matches[0];
          if (item.settlement) { const e = new Error("Receipt already settled"); e.status = 409; e.body = { code: "already_settled" }; throw e; }
          if (item.receipt.cost_usd != null) { const e = new Error("Receipt cost is already known"); e.status = 409; e.body = { code: "already_known" }; throw e; }
          const auditId = randomUUID();
          item.settlement = { cost_usd: input.cost_usd, at: new Date(now()).toISOString(), by: u.id, source: input.source, reason: input.reason, audit_id: auditId };
          audit(s, u.orgId, u.id, "receipt.settle", receiptId, { event: "reconciliation", agent_id: item.agentId, before: null, after: input.cost_usd, source: input.source, reason: input.reason, audit_id: auditId });
          return { agent_id: item.agentId, receipt_id: receiptId, cost_usd: null, settled_cost_usd: input.cost_usd, settled_at: item.settlement.at, settled_by: u.id, settle_source: input.source, settle_reason: input.reason };
        });
        return json(200, result);
      }
      fail(404, "Route not found");
    } catch (err) { if (!res.headersSent) await json(err.status ?? 500, { error: err.status ? err.message : "Internal error", ...(err.status && err.body ? err.body : {}) }); }
  });
  // Issue #165: explicit warning fractions fire at most once per UTC cap period.
  // Legacy policies (no warnFractions) keep the plain key dedupe.
  function gateWarnings(s, id, caps, spend, fractions, budgetPeriod = null) {
    if (!Array.isArray(fractions)) return () => true;
    s.warnArm ??= {};
    const states = {};
    for (const scope of ["day", "month"]) states[scope] = armWarnings(s.warnArm, { id, scope, cap: caps?.[scope], spent: spend[scope], nowMs: now(), budgetPeriod });
    return (alert) => alert.kind !== "cap_approaching" || alert.fraction === undefined || !states[alert.scope] || claimWarning(states[alert.scope], alert, fractions);
  }
  // Issue #168: run warnings fire at most once per run (period = run id).
  // Arm state for runs that left the active window is dropped.
  function gateRunWarnings(s, id, cap, runs, warnFractions) {
    s.warnArm ??= {};
    const fractions = Array.isArray(warnFractions) ? warnFractions : [0.8];
    const live = new Set(runs.map((r) => `${id}:run:${r.run_id}`));
    for (const k of Object.keys(s.warnArm)) if (k.startsWith(`${id}:run:`) && !live.has(k)) delete s.warnArm[k];
    const spentOf = Object.fromEntries(runs.map((r) => [r.run_id, r.usd_known]));
    return (alert) => {
      if (alert.kind !== "cap_approaching") return true;
      const st = armWarnings(s.warnArm, { id, scope: `run:${alert.run_id}`, cap, spent: spentOf[alert.run_id], nowMs: now() });
      return claimWarning(st, alert, fractions);
    };
  }
  const warnExtra = (alert, budgetPeriod = null) => (alert.fraction !== undefined && alert.run_id === undefined ? { period: capPeriod(alert.scope, now(), budgetPeriod) } : {});
  const claim = (record) => { record.delivery_claimed_at = new Date(now()).toISOString(); return record; };
  const queueRetry = ([id, record], out) => {
    const recovered = pendingRecovered(record, now());
    const ch = recovered ? null : dueRetryChannels(record, now());
    if (ch === null || ch.length) out.push({ ...claim(record), id, retryChannels: ch, ...(recovered ? { recovered: true } : {}) });
  };
  async function evaluateFleetAlerts() {
    const queued = store.transaction((s) => {
      sweepRaises(s);
      const out = [];
      for (const a of Object.values(s.agents)) {
        if (a.revoked) {
          for (const prior of Object.values(s.alerts).filter((x) => x.agentId === a.id && x.active)) resolveAlert(prior, now());
          continue;
        }
        const receipts = agentReceipts(s, a.id);
        const bp = orgPeriod(s, a.orgId);
        const spent = spendSummary(receipts, now(), bp);
        const recent = receipts.filter((r) => Date.parse(r.ts) > now() - 3600_000);
        const blockedReasons = recent.flatMap((r) => {
          // Issue #168: a run block with a run_id pages through the per-run key.
          if (r.reason === "budget_exceeded" && r.scope === "run" && typeof r.run_id === "string" && r.run_id) return [];
          if (r.reason === "budget_exceeded" && ["run", "day", "month"].includes(r.scope)) return [`budget_exceeded:${r.scope}`];
          return r.reason ? [r.reason] : [];
        });
        const caps = effectiveCaps(a.policy, now());
        const alerts = evaluateAlerts({ agentId: a.id, caps, spend: { day: spent.day.usd, month: spent.month.usd }, unknown: { month: spent.month.unknown }, blockedReasons, lastSeenMs: a.lastSeen, nowMs: now() }, { silentAfterMs: silentAfterMsFor(a.policy), warnFractions: a.policy.warnFractions, budgetPeriod: bp });
        // Issue #168: per-run alerts from synced receipts (active runs only).
        const blockedRunIds = recent.filter((r) => r.reason === "budget_exceeded" && r.scope === "run" && typeof r.run_id === "string" && r.run_id).map((r) => r.run_id);
        const runCap = caps.run;
        const hasRunCap = typeof runCap === "number" && Number.isFinite(runCap);
        const activeRuns = hasRunCap || blockedRunIds.length
          ? summarizeRuns(receipts.filter((r) => typeof r.run_id === "string" && r.run_id)).filter((run) => Date.parse(run.last_ts) > now() - 3600_000)
          : [];
        // Issue #180: every active run is evaluated (no top-N slice), so a
        // blocked or over-cap run past the 20 most recent still pages and its
        // alert is not flap-resolved when newer runs sync.
        const runAlerts = evaluateRunAlerts({ agentId: a.id, cap: hasRunCap ? runCap : null, runs: activeRuns, blockedRunIds }, { warnFractions: a.policy.warnFractions });
        alerts.push(...runAlerts);
        // A configured global alert channel is not an org recipient grant.
        // The caller must explicitly route each org's alerts.
        const keys = new Set(alerts.map((x) => x.key));
        for (const prior of Object.values(s.alerts).filter((x) => x.agentId === a.id && !keys.has(x.key))) resolveAlert(prior, now());
        const warnOk = gateWarnings(s, a.id, caps, { day: spent.day.usd, month: spent.month.usd }, a.policy.warnFractions, bp);
        const runOk = gateRunWarnings(s, a.id, runCap, activeRuns, a.policy.warnFractions);
        for (const alert of alerts) {
          const prior = activeOccurrence(s.alerts, alert.key);
          if (!prior && !(alert.run_id !== undefined ? runOk(alert) : warnOk(alert))) continue;
          if (!prior) out.push({ ...claim(fireAlert(s.alerts, alert, { orgId: a.orgId, agentId: a.id, ...warnExtra(alert, bp) }, { nowMs: now(), id: randomUUID() })) });
          else queueRetry(prior, out);
        }
      }
      // Issue #139: team day/month caps alert too, keyed per org and team.
      const teamKeys = new Set();
      for (const t of Object.values(s.teams ?? {})) {
        const prefix = `team:${t.name}:`;
        const blockedScopes = t.agents.flatMap((id) => agentReceipts(s, id))
          .filter((r) => Date.parse(r.ts) > now() - 3600_000 && r.reason === "budget_exceeded" && typeof r.scope === "string" && r.scope.startsWith(prefix))
          .map((r) => r.scope.slice(prefix.length));
        const verdict = verdictOf(s, t);
        const warnOk = gateWarnings(s, `team:${t.orgId}:${t.name}`, verdict.caps, { day: verdict.spend.day_usd, month: verdict.spend.month_usd }, t.warnFractions, orgPeriod(s, t.orgId));
        for (const alert of evaluateTeamAlerts({ orgId: t.orgId, verdict, blockedScopes }, { warnFractions: t.warnFractions })) {
          teamKeys.add(alert.key);
          const prior = activeOccurrence(s.alerts, alert.key);
          if (!prior && !warnOk(alert)) continue;
          if (!prior) out.push({ ...claim(fireAlert(s.alerts, alert, { orgId: t.orgId, agentId: null, ...warnExtra(alert, orgPeriod(s, t.orgId)) }, { nowMs: now(), id: randomUUID() })) });
          else queueRetry(prior, out);
        }
      }
      for (const prior of Object.values(s.alerts).filter((x) => x.team && x.active && !teamKeys.has(x.key))) resolveAlert(prior, now());
      return out;
    });
    for (const queuedAlert of queued) {
      const { retryChannels, recovered, deliveryChannels: _c, deliveryRetry: _r, delivery_claimed_at: _k, ...a } = queuedAlert;
      const requested = retryChannels ?? null;
      let result;
      try { // Only addresses that are still verified members of the org receive the alert.
        const settings = store.read((s) => {
          const saved = s.orgs[a.orgId]?.alertSettings;
          if (!saved) return null;
          const members = new Set(Object.values(s.users).filter((m) => m.orgId === a.orgId && m.verified).map((m) => m.email));
          return { emails: (saved.emails ?? []).filter((e) => members.has(e)), slackWebhook: saved.slackWebhook ?? null, webhook: saved.webhook ?? null };
        });
        const agentName = a.agentId ? store.read((s) => s.agents[a.agentId]?.name ?? null) : null;
        result = deliverAlert ? await deliverAlert({ ...a, agentName }, settings, requested ? { channels: requested } : undefined) : [{ status: "unconfigured" }]; }
      catch { result = [{ status: "failed" }]; }
      store.transaction((s) => {
        const target = a.agentId ?? `team:${a.team}`;
        const extra = a.team ? { team: a.team, scope: a.scope } : {};
        const rec = s.alerts[a.id];
        if (rec) delete rec.delivery_claimed_at;
        const gaveUp = rec ? applyDeliveryResult(rec, result, requested, now()) : [];
        audit(s, a.orgId, "alert-worker", "alert.delivery", target, { kind: a.kind, ...extra, alert_id: a.id, ...(requested ? { channels: requested } : {}), ...(recovered ? { recovered: true } : {}), result });
        for (const channel of gaveUp) audit(s, a.orgId, "alert-worker", "alert.delivery_gave_up", target, { kind: a.kind, ...extra, alert_id: a.id, channel, attempts: ALERT_MAX_ATTEMPTS });
      });
    }
    return queued.length;
  }
  return { server, billingReady, evaluateFleetAlerts, purgeExpiredReceipts };
}
