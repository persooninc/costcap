// Compare local receipts with a provider charge file. This does not call a provider.
// Unknown receipt cost is never treated as zero, and a missing charge is not a match.
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadReceipts, loadLedgerLines, applySettlements, isSettlement } from "./cap.js";

export function reconcile({ receipts, charges }) {
  if (!Array.isArray(receipts) || !receipts.length) throw new Error("No receipts found; reconciliation needs evidence");
  if (!Array.isArray(charges)) throw new Error("Provider charges must be a list");
  const byId = new Map();
  for (const charge of charges) {
    if (!charge || typeof charge.id !== "string" || !charge.id) throw new Error("Provider charge needs an id");
    if (charge.cost_usd !== null && (typeof charge.cost_usd !== "number" || !Number.isFinite(charge.cost_usd) || charge.cost_usd < 0)) throw new Error("Provider charge cost must be a non-negative number or null");
    if (byId.has(charge.id)) throw new Error("Duplicate provider charge id");
    byId.set(charge.id, charge);
  }
  const unknown = [];
  const receiptOnly = [];
  const mismatched = [];
  const seen = new Set();
  let matched = 0;
  for (const receipt of receipts) {
    if (!receipt || typeof receipt.id !== "string" || !receipt.id) throw new Error("Receipt needs an id");
    if (seen.has(receipt.id)) throw new Error("Duplicate receipt id");
    seen.add(receipt.id);
    if (receipt.cost_usd === null) { unknown.push(receipt.id); byId.delete(receipt.id); continue; }
    if (typeof receipt.cost_usd !== "number" || !Number.isFinite(receipt.cost_usd) || receipt.cost_usd < 0) throw new Error("Receipt cost must be a non-negative number or null");
    const charge = byId.get(receipt.id);
    if (!charge) receiptOnly.push(receipt.id);
    else if (charge.cost_usd === null || Math.abs(charge.cost_usd - receipt.cost_usd) > 0.000001) mismatched.push(receipt.id);
    else matched += 1;
    byId.delete(receipt.id);
  }
  const providerOnly = [...byId.keys()];
  return { ok: unknown.length === 0 && receiptOnly.length === 0 && providerOnly.length === 0 && mismatched.length === 0,
    matched, unknown, receipt_only: receiptOnly, provider_only: providerOnly, mismatched, estimate_only: false };
}

export function reconcileFiles({ receiptsPath, providerPath }) {
  return reconcile({ receipts: applySettlements(loadLedgerLines(receiptsPath)), charges: loadReceipts(providerPath) });
}

// Pure planner: which null-cost receipts a provider charge list can settle.
// A charge with null, missing, negative or non-finite cost never settles; nor
// does a missing charge. Already-settled ids are skipped (idempotent).
export function planSettlements({ lines, charges }) {
  const byId = new Map();
  for (const c of charges) if (c && typeof c.id === "string" && c.id && !byId.has(c.id)) byId.set(c.id, c);
  const already = new Set(lines.filter(isSettlement).map((e) => e.receipt_id));
  const settle = [];
  const stillUnknown = [];
  const alreadySettled = [];
  for (const r of lines) {
    if (!r || r.event || r.cost_usd !== null) continue;
    if (typeof r.id !== "string" || !r.id) throw new Error("Receipt needs an id");
    if (already.has(r.id)) { alreadySettled.push(r.id); continue; }
    const c = byId.get(r.id);
    const cost = c?.cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) { settle.push({ receipt_id: r.id, cost_usd: cost }); already.add(r.id); }
    else stillUnknown.push(r.id);
  }
  return { settle, still_unknown: stillUnknown, already_settled: alreadySettled };
}

// `costcap reconcile --apply`: append one reconciliation event per settled id.
// Existing ledger bytes are never rewritten.
export function applyReconciliation({ receiptsPath, providerPath, now = () => new Date() }) {
  const lines = loadLedgerLines(receiptsPath);
  if (!lines.some((r) => !r.event)) throw new Error("No receipts found; reconciliation needs evidence");
  const providerBytes = readFileSync(providerPath);
  const provider_sha256 = createHash("sha256").update(providerBytes).digest("hex");
  const plan = planSettlements({ lines, charges: loadReceipts(providerPath) });
  const ts = now().toISOString();
  const events = plan.settle.map((s) => ({ event: "reconciliation", receipt_id: s.receipt_id, cost_usd: s.cost_usd, source: "provider_file", provider_sha256, ts }));
  if (events.length) appendFileSync(receiptsPath, events.map((e) => JSON.stringify(e) + "\n").join(""));
  return { ok: plan.still_unknown.length === 0, settled: events.map((e) => ({ receipt_id: e.receipt_id, cost_usd: e.cost_usd })),
    still_unknown: plan.still_unknown, already_settled: plan.already_settled, provider_sha256, estimate_only: false };
}
