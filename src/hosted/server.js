// Free-beta API. Durable local datastore, exactly one replica, trusted TLS ingress.
// Existing company membership is never inferred from an email domain.
import http from "node:http";
import { uiResponse } from "./ui.js";
import { randomBytes, randomUUID, randomInt } from "node:crypto";
import { openStore } from "./store.js";
import { hashToken, validatePolicy } from "./policy.js";
import { buildEvidence } from "./evidence.js";
import { evaluateAlerts, evaluateTeamAlerts, auditEntry, silentAfterMsFor, alertOccurrences, activeOccurrence, fireAlert, resolveAlert, filterAlerts, ALERT_STATUSES } from "./alerts.js";
import { VERSION } from "../version.js";
import { stripeHealth } from "./billing.js";
import { receiptsCsv, parseReceiptsQuery } from "./receipts-csv.js";
import { pageRuns, parseRunsQuery, runReceipts, summarizeRuns } from "./runs.js";
import { parseSpendQuery, spendBreakdown } from "./spend.js";
import { labelAudit, auditCsv, parseAuditRange } from "./audit-log.js";
import { scrubReceiptPath } from "../receipt-path.js";
import { DEFAULT_PLANS, entitlementsFor, requireLimit, resolveBillingConfig, retentionCutoff } from "../billing/index.js";
import { onboardingState } from "./onboarding.js";
import { hostedAgentVerdict } from "./agent-verdict.js";
import { maskAlertSettings, validSlackWebhook } from "./delivery.js";
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

// A missing channel is not a failed send. Retry only when a configured
// channel failed. Accepted, or nothing configured, does not send again
// until the alert clears and re-arms.
export function alertDeliveryState(result) {
  const configured = (Array.isArray(result) ? result : []).filter((row) => row?.status !== "unconfigured");
  if (!configured.length) return "unconfigured";
  return configured.every((row) => row.status === "accepted") ? "accepted" : "failed";
}

// Estimated receipt spend for the dashboard. Null cost is unknown, never zero.
// Windows follow the UTC instant, matching the local cap engine. A numeric
// offset is not a calendar prefix.
export function spendSummary(receipts, nowMs) {
  const utc = new Date(nowMs).toISOString();
  const fold = (window) => {
    let usd = 0, unknown = 0;
    for (const item of receipts) {
      const r = costedReceipt(item);
      const instant = new Date(r.ts);
      if (Number.isNaN(instant.getTime())) continue;
      const iso = instant.toISOString();
      if (window === "day" && iso.slice(0, 10) !== utc.slice(0, 10)) continue;
      if (window === "month" && iso.slice(0, 7) !== utc.slice(0, 7)) continue;
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
  plans = DEFAULT_PLANS, enforceEntitlements, publicPricing } = {}) {
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
  // Receipts older than the plan retention window are hidden (never deleted) when entitlements are enforced.
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
  const agentUser = (s, req) => {
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
  const agentReceipts = (s, agentId) => Object.values(s.receipts).filter((r) => r.agentId === agentId).map(costedReceipt);
  // Issue #127: org-scoped, so another org's receipts never count toward agent_spend.
  const orgAgentReceipts = (s, orgId, agentId) => Object.values(s.receipts).filter((r) => r.orgId === orgId && r.agentId === agentId).map(costedReceipt);
  const verdictOf = (s, team) => teamVerdict({ team, nowMs: now(), receiptsByAgent: Object.fromEntries(team.agents.map((id) => [id, agentReceipts(s, id)])) });
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
      if (path === "/v1/enrollment-tokens" && req.method === "POST") {
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
        const p = store.transaction((s) => { const a = agentUser(s, req); a.lastSeen = now(); const t = teamFor(Object.values(s.teams ?? {}), a.orgId, a.id); return { ...a.policy, team: t ? teamPolicy(verdictOf(s, t), now()) : null, agent_spend: agentSpendPolicy(orgAgentReceipts(s, a.orgId, a.id), now()) }; });
        return json(200, p);
      }
      if (path === "/v1/receipts" && req.method === "POST") {
        if (!Array.isArray(body.receipts) || body.receipts.length > 100) fail(400, "Up to 100 receipts required");
        const result = store.transaction((s) => {
          const a = agentUser(s, req);
          const acceptedIds = [];
          for (const r of body.receipts) {
            if (r && typeof r.path === "string") r.path = scrubReceiptPath(r.path);
            if (!r || typeof r.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(r.id) || !Number.isFinite(Date.parse(r.ts)) || (r.cost_usd !== null && (!Number.isFinite(r.cost_usd) || r.cost_usd < 0))) fail(400, "Invalid receipt");
            const key = `${a.id}:${r.id}`;
            if (s.receipts[key] && JSON.stringify(s.receipts[key].receipt) !== JSON.stringify(r)) fail(409, "Receipt ID content conflict");
            s.receipts[key] ??= { orgId: a.orgId, agentId: a.id, receipt: r };
            acceptedIds.push(r.id);
          }
          a.lastSeen = now();
          audit(s, a.orgId, a.id, "receipts.sync", a.id, { count: acceptedIds.length });
          return { acceptedIds };
        });
        return json(200, result);
      }
      if (path === "/v1/receipts.csv" && req.method === "GET") {
        const csv = store.read((s) => {
          const u = sessionUser(s, req);
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
          const u = sessionUser(s, req);
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
          const u = sessionUser(s, req);
          return buildEvidence({ orgId: u.orgId, nowMs: now(), spendFor: (rs) => spendSummary(rs, now()),
            agents: Object.values(s.agents).filter((a) => a.orgId === u.orgId),
            receipts: visibleReceipts(s, u.orgId),
            alerts: filterAlerts(alertOccurrences(s.alerts).filter((a) => a.orgId === u.orgId)),
            audit: labelAudit(s, u.orgId, s.audit),
            teams: orgTeams(s, u.orgId).map((t) => verdictOf(s, t)) });
        }));
      }
      if (path === "/v1/spend" && req.method === "GET") {
        return json(200, store.read((s) => {
          const u = sessionUser(s, req);
          const query = parseSpendQuery(new URL(req.url, origin).searchParams);
          const names = Object.fromEntries(Object.values(s.agents).filter((a) => a.orgId === u.orgId).map((a) => [a.id, a.name]));
          return spendBreakdown(visibleReceipts(s, u.orgId), { ...query, cutoff: retentionCutoff(entitlements(s, u.orgId), now()), names });
        }));
      }
      if (path === "/v1/fleet" && req.method === "GET") {
        return json(200, store.read((s) => {
          const u = sessionUser(s, req);
          return { agents: Object.values(s.agents).filter((a) => a.orgId === u.orgId).map(({ hash, ...a }) => ({ ...a, spend: spendSummary(Object.values(s.receipts).filter((r) => r.agentId === a.id), now()) })),
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
          const next = { emails, slackWebhook };
          org.alertSettings = next;
          audit(s, u.orgId, u.id, "alert_settings.change", u.orgId, { previous: maskAlertSettings(current), next: maskAlertSettings(next) });
          return { ...maskAlertSettings(next), canEdit: true };
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
          const strip = (t) => (t ? { name: t.name, agents: [...t.agents], day: t.day ?? null, month: t.month ?? null } : null);
          if (input.remove) {
            if (!current) fail(404, "Team not found");
            delete s.teams[key];
            audit(s, u.orgId, u.id, "team.change", input.name, { previous: strip(current), next: null });
            return { removed: true, name: input.name };
          }
          const { name, agents, day, month } = input;
          s.teams[key] = { orgId: u.orgId, name, agents, ...(day != null ? { day } : {}), ...(month != null ? { month } : {}) };
          audit(s, u.orgId, u.id, "team.change", name, { previous: strip(current), next: strip(s.teams[key]) });
          return verdictOf(s, s.teams[key]);
        });
        return json(200, result);
      }
      // Issue #159: per-run drill-down. An agent token reads only its own runs; any member (viewer included) any agent in the org.
      const runsRoute = /^\/v1\/agents\/([^/]+)\/runs(?:\/([^/]+))?$/.exec(path);
      if (runsRoute && req.method === "GET") {
        return json(200, store.read((s) => {
          const caller = req.headers.authorization ? { agent: agentUser(s, req) } : { user: sessionUser(s, req) };
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
          const caller = req.headers.authorization ? { agent: agentUser(s, req) } : { user: sessionUser(s, req) };
          const a = s.agents[budgetRoute[1]];
          const orgId = caller.agent?.orgId ?? caller.user.orgId;
          if (!a || a.orgId !== orgId || (caller.agent && caller.agent.id !== a.id)) fail(404, "Agent not found");
          const receipts = agentReceipts(s, a.id);
          const runId = new URL(req.url, origin).searchParams.get("run_id");
          const t = teamFor(Object.values(s.teams ?? {}), a.orgId, a.id);
          return hostedAgentVerdict({ agent: a, receipts, nowMs: now(), runId: runId || null, team: t ? verdictOf(s, t) : null });
        }));
      }
      if ((path === "/v1/fleet/freeze" || path === "/v1/fleet/resume") && req.method === "POST") {
        const freeze = path.endsWith("/freeze");
        const result = store.transaction((s) => {
          const u = admin(s, req);
          const reason = fleetReason(body?.reason, true);
          return freeze ? freezeFleet(s, u, reason) : resumeFleet(s, u, reason);
        });
        return json(200, result);
      }
      const update = /^\/v1\/agents\/([^/]+)\/(policy|revoke)$/.exec(path);
      if (update && req.method === "POST") {
        const result = store.transaction((s) => {
          const u = admin(s, req), a = s.agents[update[1]];
          if (!a || a.orgId !== u.orgId) fail(404, "Agent not found");
          if (update[2] === "revoke") { a.revoked = true; audit(s, u.orgId, u.id, "agent.revoke", a.id); return { revoked: true }; }
          const reason = fleetReason(body.reason, false);
          // maxSteps: omitted keeps the current value, null clears it (issue #114).
          const maxSteps = body.maxSteps === undefined ? a.policy.maxSteps : body.maxSteps;
          // silentAfterHours (issue #134): omitted keeps, null resets to the 6h default, 0 turns silence alerts off.
          const silentAfterHours = body.silentAfterHours === undefined ? a.policy.silentAfterHours : body.silentAfterHours;
          // models (issue #153): omitted keeps the allowlist, null clears it.
          const models = body.models === undefined ? a.policy.models : body.models;
          const policy = { version: a.policy.version + 1, caps: body.caps ?? a.policy.caps, killed: body.killed ?? a.policy.killed, ...(maxSteps != null ? { maxSteps } : {}), ...(silentAfterHours != null ? { silentAfterHours } : {}), ...(models != null ? { models } : {}) };
          if (validatePolicy(policy).length) fail(400, "Invalid policy");
          const prev = a.policy ?? {};
          const previous = { caps: { ...(prev.caps ?? {}) }, killed: Boolean(prev.killed), maxSteps: prev.maxSteps ?? null, silentAfterHours: prev.silentAfterHours ?? null, models: prev.models ?? null };
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
          const u = sessionUser(s, req);
          return { alerts: filterAlerts(alertOccurrences(s.alerts).filter((a) => a.orgId === u.orgId), { status, ...range }) };
        }));
      }
      const ackRoute = /^\/v1\/alerts\/([^/]+)\/ack$/.exec(path);
      if (ackRoute && req.method === "POST") {
        const id = decodeURIComponent(ackRoute[1]);
        return json(200, store.transaction((s) => {
          const u = admin(s, req);
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
          const u = admin(s, req);
          const matches = Object.values(s.receipts).filter((r) => r.orgId === u.orgId && r.receipt?.id === receiptId && (input.agentId === undefined || r.agentId === input.agentId));
          if (!matches.length) fail(404, "Receipt not found");
          if (matches.length > 1) fail(409, "Receipt id is ambiguous; pass agent_id");
          const item = matches[0];
          if (item.settlement) { const e = new Error("Receipt already settled"); e.status = 409; e.body = { code: "already_settled" }; throw e; }
          if (item.receipt.cost_usd != null) { const e = new Error("Receipt cost is already known"); e.status = 409; e.body = { code: "already_known" }; throw e; }
          item.settlement = { cost_usd: input.cost_usd, at: new Date(now()).toISOString(), by: u.id, source: input.source, reason: input.reason };
          audit(s, u.orgId, u.id, "receipt.settle", receiptId, { event: "reconciliation", agent_id: item.agentId, before: null, after: input.cost_usd, source: input.source, reason: input.reason });
          return { agent_id: item.agentId, receipt_id: receiptId, cost_usd: null, settled_cost_usd: input.cost_usd, settled_at: item.settlement.at, settled_by: u.id, settle_source: input.source, settle_reason: input.reason };
        });
        return json(200, result);
      }
      fail(404, "Route not found");
    } catch (err) { if (!res.headersSent) await json(err.status ?? 500, { error: err.status ? err.message : "Internal error", ...(err.status && err.body ? err.body : {}) }); }
  });
  async function evaluateFleetAlerts() {
    const queued = store.transaction((s) => {
      const out = [];
      for (const a of Object.values(s.agents)) {
        if (a.revoked) {
          for (const prior of Object.values(s.alerts).filter((x) => x.agentId === a.id && x.active)) resolveAlert(prior, now());
          continue;
        }
        const receipts = agentReceipts(s, a.id);
        const spent = spendSummary(receipts, now());
        const recent = receipts.filter((r) => Date.parse(r.ts) > now() - 3600_000);
        const blockedReasons = recent.flatMap((r) => {
          if (r.reason === "budget_exceeded" && ["run", "day", "month"].includes(r.scope)) return [`budget_exceeded:${r.scope}`];
          return r.reason ? [r.reason] : [];
        });
        const alerts = evaluateAlerts({ agentId: a.id, caps: a.policy.caps, spend: { day: spent.day.usd, month: spent.month.usd }, unknown: { month: spent.month.unknown }, blockedReasons, lastSeenMs: a.lastSeen, nowMs: now() }, { silentAfterMs: silentAfterMsFor(a.policy) });
        // A configured global alert channel is not an org recipient grant.
        // The caller must explicitly route each org's alerts.
        const keys = new Set(alerts.map((x) => x.key));
        for (const prior of Object.values(s.alerts).filter((x) => x.agentId === a.id && !keys.has(x.key))) resolveAlert(prior, now());
        for (const alert of alerts) {
          const prior = activeOccurrence(s.alerts, alert.key);
          if (!prior) out.push({ ...fireAlert(s.alerts, alert, { orgId: a.orgId, agentId: a.id }, { nowMs: now(), id: randomUUID() }) });
          else if (prior[1].delivery === "failed") out.push({ ...prior[1], id: prior[0] });
        }
      }
      // Issue #139: team day/month caps alert too, keyed per org and team.
      const teamKeys = new Set();
      for (const t of Object.values(s.teams ?? {})) {
        const prefix = `team:${t.name}:`;
        const blockedScopes = t.agents.flatMap((id) => agentReceipts(s, id))
          .filter((r) => Date.parse(r.ts) > now() - 3600_000 && r.reason === "budget_exceeded" && typeof r.scope === "string" && r.scope.startsWith(prefix))
          .map((r) => r.scope.slice(prefix.length));
        for (const alert of evaluateTeamAlerts({ orgId: t.orgId, verdict: verdictOf(s, t), blockedScopes })) {
          teamKeys.add(alert.key);
          const prior = activeOccurrence(s.alerts, alert.key);
          if (!prior) out.push({ ...fireAlert(s.alerts, alert, { orgId: t.orgId, agentId: null }, { nowMs: now(), id: randomUUID() }) });
          else if (prior[1].delivery === "failed") out.push({ ...prior[1], id: prior[0] });
        }
      }
      for (const prior of Object.values(s.alerts).filter((x) => x.team && x.active && !teamKeys.has(x.key))) resolveAlert(prior, now());
      return out;
    });
    for (const a of queued) {
      let result;
      try { // Only addresses that are still verified members of the org receive the alert.
        const settings = store.read((s) => {
          const saved = s.orgs[a.orgId]?.alertSettings;
          if (!saved) return null;
          const members = new Set(Object.values(s.users).filter((m) => m.orgId === a.orgId && m.verified).map((m) => m.email));
          return { emails: (saved.emails ?? []).filter((e) => members.has(e)), slackWebhook: saved.slackWebhook ?? null };
        });
        result = deliverAlert ? await deliverAlert(a, settings) : [{ status: "unconfigured" }]; }
      catch { result = [{ status: "failed" }]; }
      store.transaction((s) => {
        if (s.alerts[a.id]) s.alerts[a.id].delivery = alertDeliveryState(result);
        audit(s, a.orgId, "alert-worker", "alert.delivery", a.agentId ?? `team:${a.team}`, { kind: a.kind, ...(a.team ? { team: a.team, scope: a.scope } : {}), result });
      });
    }
    return queued.length;
  }
  return { server, billingReady, evaluateFleetAlerts };
}
