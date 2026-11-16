// Enrolled-agent transport. Credentials/cache stay local, mode 0600.
// This client needs a real authenticated service; it does not create one.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { validatePolicy, resolvePolicy } from "./policy.js";
import { loadReceipts, loadSettledReceipts, loadEvents, isSettlement } from "../cap.js";
import { validTeamPolicy, cachedTeamVerdict, validAgentSpend, cachedAgentVerdict } from "./teams.js";

export function serviceUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("Service URL must not contain credentials/query/fragment");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("Enrollment requires HTTPS (HTTP allowed only for loopback tests)");
  return url.href.replace(/\/$/, "");
}

export function saveEnrollment(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

export function loadEnrollment(path) {
  if (!existsSync(path)) throw new Error("Enrollment not found. Use costcap enroll first.");
  const data = JSON.parse(readFileSync(path, "utf8"));
  serviceUrl(data.url);
  if (!data.token || !data.agentId || validatePolicy(data.policy).length) throw new Error("Invalid enrollment cache; refusing to run");
  return data;
}

async function request(url, token, path, body) {
  const response = await fetch(`${serviceUrl(url)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000), redirect: "error",
  });
  if (!response.ok) {
    const err = new Error(`Fleet service returned HTTP ${response.status}`);
    err.status = response.status;
    err.route = await response.json().then((b) => b?.error === "Route not found", () => true);
    throw err;
  }
  return response.json();
}

export async function enroll({ url, token, name, path }) {
  if (!token || !name) throw new Error("Enrollment token and agent name are required");
  const result = await request(url, token, "/v1/enroll", { name });
  if (typeof result.agentId !== "string" || typeof result.token !== "string" || validatePolicy(result.policy).length) throw new Error("Invalid enrollment response");
  const data = { url: serviceUrl(url), token: result.token, agentId: result.agentId, policy: result.policy, syncedIds: [] };
  saveEnrollment(path, data);
  return { agentId: data.agentId };
}

export function createFleetClient({ path, receiptsPath, onPolicy = () => {} }) {
  let data = loadEnrollment(path);
  let revoked = Boolean(data.revoked);
  let busy = false;
  const policy = () => resolvePolicy({ lastKnown: data.policy });
  // Issue #129: each local reconcile settlement of a synced null-cost receipt goes up
  // once. An older server without the endpoint (404) skips it; receipt sync still succeeds.
  async function uploadSettlements(synced) {
    const done = new Set(data.syncedSettlementIds ?? []);
    const nullIds = new Set(loadReceipts(receiptsPath).filter((r) => r.cost_usd === null && typeof r.id === "string").map((r) => r.id));
    const seen = new Set();
    for (const e of loadEvents(receiptsPath)) {
      if (!isSettlement(e) || seen.has(e.receipt_id)) continue;
      seen.add(e.receipt_id);
      if (done.has(e.receipt_id) || !synced.has(e.receipt_id) || !nullIds.has(e.receipt_id)) continue;
      try {
        await request(data.url, data.token, "/v1/receipts/settlements", { receipt_id: e.receipt_id, cost_usd: e.cost_usd, provider_sha256: e.provider_sha256 ?? null, ts: e.ts ?? null });
      } catch (err) {
        // Missing route: older server, skip all. Missing receipt: leave it for a later sync.
        if (err.status === 404 && err.route) return;
        if (err.status === 404) continue;
        if (err.status !== 409) throw err;
      }
      done.add(e.receipt_id);
      data.syncedSettlementIds = [...done];
      saveEnrollment(path, data);
    }
  }
  return {
    policy,
    team: () => data.team ?? null,
    // Team budget (#123), enforced offline from the cached team policy. Spend this
    // agent has not synced yet is added on top of the server's synced team spend.
    teamCheck(nowMs = Date.now()) {
      if (!data.team) return null;
      const synced = new Set(data.syncedIds ?? []);
      return cachedTeamVerdict(data.team, loadSettledReceipts(receiptsPath).filter((r) => !synced.has(r.id)), nowMs);
    },
    agentSpend: () => data.agentSpend ?? null,
    // Per-agent fleet caps (#127) against the agent's fleet-wide synced spend plus
    // this host's unsynced receipts. No agent_spend from the server: no-op.
    agentCheck(nowMs = Date.now()) {
      if (!data.agentSpend) return null;
      const synced = new Set(data.syncedIds ?? []);
      return cachedAgentVerdict(data.agentSpend, policy().caps, loadSettledReceipts(receiptsPath).filter((r) => !synced.has(r.id)), nowMs);
    },
    revoked: () => revoked,
    async sync() {
      if (busy) return { skipped: true };
      busy = true;
      try {
        // Receipts go up first so the team spend fetched next already includes them (#123).
        const synced = new Set(data.syncedIds ?? []);
        const pending = loadReceipts(receiptsPath).filter((r) => r.id && !synced.has(r.id)).slice(0, 100);
        if (pending.length) {
          const result = await request(data.url, data.token, "/v1/receipts", { receipts: pending });
          const ids = new Set(pending.map((r) => r.id));
          if (!Array.isArray(result.acceptedIds) || result.acceptedIds.some((id) => !ids.has(id))) throw new Error("Invalid receipt acknowledgment");
          for (const id of result.acceptedIds) synced.add(id);
          data.syncedIds = [...synced];
          saveEnrollment(path, data);
        }
        await uploadSettlements(synced);
        const fetched = await request(data.url, data.token, "/v1/policy");
        const { team = null, agent_spend: agentSpend = null, ...fetchedPolicy } = fetched ?? {};
        if (validatePolicy(fetchedPolicy).length || !validTeamPolicy(team) || !validAgentSpend(agentSpend)) throw new Error("Invalid fleet policy response");
        if (JSON.stringify(agentSpend) !== JSON.stringify(data.agentSpend ?? null)) { data.agentSpend = agentSpend; saveEnrollment(path, data); }
        // Team membership and spend refresh on every poll; removal (null) stops team enforcement.
        if (JSON.stringify(team) !== JSON.stringify(data.team ?? null)) { data.team = team; saveEnrollment(path, data); }
        // Only strictly newer valid versions can replace a cached policy.
        if (fetchedPolicy.version > data.policy.version) {
          data.policy = fetchedPolicy;
          saveEnrollment(path, data);
          onPolicy(policy());
        }
        return { online: true, version: data.policy.version };
      } catch (err) {
        // Revoked credentials cannot keep an agent running as if merely offline.
        if (/HTTP (401|403)/.test(err.message)) { revoked = true; data.revoked = true; saveEnrollment(path, data); }
        return { online: false, revoked, version: data.policy.version, error: err.message };
      } finally { busy = false; }
    },
  };
}
