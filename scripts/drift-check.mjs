// FA-CC-01 drift alarm. Compares the production /health sha to main HEAD.
// Red (exit 1) when production has been behind main for longer than the grace
// window, when /health is unreachable, or when the deployed sha is unknown.
// Opens nothing and changes nothing. Prints shas and hours, never secrets.
//
// Owner-pending acknowledgement: when the deploy is blocked on an owner action
// (see deploy-apply exits 3/4), a committed ack file (default infra/drift-ack.json)
// can downgrade `drift` to a warning. The ack only applies to the exact prod sha
// it names, never to an unreachable or unknown prod, and it expires after at
// most MAX_ACK_DAYS so the alarm comes back on its own.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Pure decision. `behindSinceMs` is the commit time of the oldest main commit
 * that production does not have (null when the deployed sha is not in main's history).
 * @param {{ prodSha?: string|null, mainSha: string, behindSinceMs?: number|null, nowMs: number, graceHours?: number }} input
 * @returns {{ ok: boolean, state: "current"|"behind-within-grace"|"drift"|"unknown-prod-sha", hoursBehind: number|null }}
 */
export function driftDecision({ prodSha, mainSha, behindSinceMs = null, nowMs, graceHours = 24 }) {
  if (!SHA_RE.test(mainSha ?? "")) throw new Error("main sha must be a 40-character commit");
  if (!SHA_RE.test(prodSha ?? "")) return { ok: false, state: "unknown-prod-sha", hoursBehind: null };
  if (prodSha === mainSha) return { ok: true, state: "current", hoursBehind: 0 };
  if (!Number.isFinite(behindSinceMs)) return { ok: false, state: "unknown-prod-sha", hoursBehind: null };
  const hoursBehind = Math.max(0, (nowMs - behindSinceMs) / 3600_000);
  if (hoursBehind > graceHours) return { ok: false, state: "drift", hoursBehind };
  return { ok: true, state: "behind-within-grace", hoursBehind };
}

export const MAX_ACK_DAYS = 7;
const DAY_MS = 24 * 3600_000;

/**
 * Pure. Downgrades a `drift` decision to `drift-acknowledged` (ok) when `ack` is a
 * valid, unexpired owner-pending acknowledgement for this exact prod sha.
 * Any other state, a malformed ack, a different sha, an expired ack, or an ack
 * window longer than MAX_ACK_DAYS leaves the decision unchanged.
 * @param {{ ok: boolean, state: string, hoursBehind: number|null }} decision
 * @param {{ prodSha?: string, reason?: string, acknowledgedOn?: string, expiresOn?: string }|null} ack
 * @param {{ prodSha?: string|null, nowMs: number }} ctx
 * @returns {{ ok: boolean, state: string, hoursBehind: number|null, ack?: { reason: string, expiresOn: string } }}
 */
export function applyDriftAck(decision, ack, { prodSha, nowMs }) {
  if (decision.state !== "drift" || !ack || typeof ack !== "object") return decision;
  if (!SHA_RE.test(prodSha ?? "") || ack.prodSha !== prodSha) return decision;
  if (typeof ack.reason !== "string" || !ack.reason.trim()) return decision;
  const from = Date.parse(ack.acknowledgedOn), until = Date.parse(ack.expiresOn);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until < from) return decision;
  if (until - from > MAX_ACK_DAYS * DAY_MS || nowMs < from || nowMs > until) return decision;
  return { ...decision, ok: true, state: "drift-acknowledged", ack: { reason: ack.reason, expiresOn: ack.expiresOn } };
}

/** Reads the ack JSON at `path`; null when absent or unparseable. */
export function readDriftAck(path) {
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** Commit time (ms) of the oldest commit in prodSha..mainSha, or null if prodSha is not an ancestor. */
export function behindSince(prodSha, mainSha, git = (args) => execFileSync("git", args, { encoding: "utf8" })) {
  if (!SHA_RE.test(prodSha ?? "") || !SHA_RE.test(mainSha ?? "")) return null;
  try { git(["merge-base", "--is-ancestor", prodSha, mainSha]); } catch { return null; }
  const times = git(["log", "--reverse", "--format=%ct", `${prodSha}..${mainSha}`]).trim().split("\n").filter(Boolean);
  return times.length ? Number(times[0]) * 1000 : null;
}

export async function readProdSha(origin, fetchImpl = globalThis.fetch) {
  const root = String(origin).replace(/\/$/, "");
  try {
    const res = await fetchImpl(`${root}/health`, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (res.status !== 200) return null;
    const body = await res.json();
    return typeof body?.sha === "string" ? body.sha : null;
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origin = process.argv[2] || process.env.COSTCAP_PUBLIC_ORIGIN || "https://app.costcap.dev";
  const mainSha = process.env.COSTCAP_MAIN_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const graceHours = Number(process.env.COSTCAP_DRIFT_GRACE_HOURS || 24);
  const prodSha = await readProdSha(origin);
  const nowMs = Date.now();
  const ackPath = process.env.COSTCAP_DRIFT_ACK_FILE || "infra/drift-ack.json";
  const raw = driftDecision({ prodSha, mainSha, behindSinceMs: behindSince(prodSha, mainSha), nowMs, graceHours });
  const decision = applyDriftAck(raw, readDriftAck(ackPath), { prodSha, nowMs });
  const hours = decision.hoursBehind === null ? "unknown" : decision.hoursBehind.toFixed(1);
  console.error(`drift: prod=${prodSha ?? "unreachable"} main=${mainSha} state=${decision.state} hours_behind=${hours} grace=${graceHours}`);
  if (decision.ack) {
    console.log(`::warning title=prod drift (owner-pending)::prod ${prodSha} is ${hours}h behind main. Acknowledged until ${decision.ack.expiresOn}: ${decision.ack.reason}`);
  }
  process.exit(decision.ok ? 0 : 1);
}
