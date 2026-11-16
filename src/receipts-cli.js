// `costcap receipts`: list/filter local ledger receipts, or export them as CSV.
// Local only: no network, no account. Unknown cost stays "unknown", never $0.

import { readFileSync, existsSync } from "node:fs";
import { applySettlements } from "./cap.js";
import { receiptsCsv } from "./hosted/receipts-csv.js";
import { parseTagPair, tagsCell, tagsMatch } from "./tags.js";

export const DEFAULT_LEDGER = ".costcap/receipts.jsonl";

export function parseTime(value, flag, now = new Date()) {
  const rel = /^(\d+)([mhdw])$/.exec(value ?? "");
  if (rel) {
    const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[2]];
    return now.getTime() - Number(rel[1]) * ms;
  }
  const t = /^\d{4}-\d{2}-\d{2}/.test(value ?? "") ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) throw new Error(`${flag} must be like 14d, 24h or an ISO date, got "${value}"`);
  return t;
}

export function parseReceiptsArgs(argv, now = new Date()) {
  const opts = { receiptsPath: DEFAULT_LEDGER, json: false, exportCsv: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--json") { opts.json = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${f} needs a value`);
    if (f === "--receipts") opts.receiptsPath = v;
    else if (f === "--since") opts.since = parseTime(v, f, now);
    else if (f === "--until") opts.until = parseTime(v, f, now);
    else if (f === "--agent") opts.agentId = v;
    else if (f === "--run-id") opts.runId = v;
    else if (f === "--tag") { const [k, val] = parseTagPair(v); opts.tags = { ...(opts.tags ?? {}), [k]: val }; }
    else if (f === "--export") { if (v !== "csv") throw new Error(`--export supports only csv, got "${v}"`); opts.exportCsv = true; }
    else throw new Error(`unknown flag ${f}`);
  }
  return opts;
}

function toRow(r) {
  return {
    ts: r.ts, agent_id: r.agent_id ?? null, run_id: r.run_id ?? null, receipt_id: r.id ?? null, model: r.model ?? null,
    cost_usd: r.settled ? null : (r.cost_usd ?? null), cost_source: r.cost_source ?? null,
    settled_cost_usd: r.settled ? r.cost_usd : null,
    settle_source: r.settled?.source ?? null, reason: r.reason ?? null, scope: r.scope ?? null, outcome: r.outcome ?? null,
    ...(r.tags ? { tags: r.tags } : {}),
  };
}

// An explicit --receipts path must exist; the default ledger may be absent (zero receipts).
export function listReceipts(opts) {
  const path = opts.receiptsPath;
  if (path !== DEFAULT_LEDGER && !existsSync(path)) throw new Error(`cannot read ledger ${path}: not found`);
  let lines = [];
  if (existsSync(path)) {
    let text;
    try { text = readFileSync(path, "utf8"); } catch (e) { throw new Error(`cannot read ledger ${path}: ${e.code ?? e.message}`); }
    try { lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { throw new Error(`cannot read ledger ${path}: corrupt line`); }
  }
  return applySettlements(lines)
    .filter((r) => {
      const t = Date.parse(r.ts);
      if (opts.since !== undefined && !(t >= opts.since)) return false;
      if (opts.until !== undefined && !(t <= opts.until)) return false;
      if (opts.agentId !== undefined && r.agent_id !== opts.agentId) return false;
      if (opts.runId !== undefined && r.run_id !== opts.runId) return false;
      if (!tagsMatch(r.tags, opts.tags)) return false;
      return true;
    })
    .map(toRow)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.receipt_id).localeCompare(String(b.receipt_id)));
}

const money = (v) => (v === null || v === undefined ? "unknown" : `$${Number(v).toFixed(4)}`);

export function receiptsCommand(argv, { log = console.log, warn = console.error, now = new Date() } = {}) {
  let rows;
  let opts;
  try { opts = parseReceiptsArgs(argv, now); rows = listReceipts(opts); }
  catch (e) { warn(`costcap: ${e.message}`); return 2; }
  if (opts.exportCsv) log(receiptsCsv(rows, { limit: Infinity }).body.replace(/\n$/, ""));
  else if (opts.json) log(JSON.stringify(rows, null, 2));
  else if (!rows.length) log("no receipts match");
  else for (const r of rows) {
    const cost = r.settled_cost_usd !== null ? `settled_cost_usd=${money(r.settled_cost_usd)}` : `cost=${money(r.cost_usd)}`;
    log(`${r.ts}  ${r.receipt_id}  agent=${r.agent_id ?? "-"}  run=${r.run_id ?? "-"}  model=${r.model ?? "-"}  ${cost}${r.tags ? `  tags=${tagsCell(r.tags)}` : ""}`);
  }
  return 0;
}
