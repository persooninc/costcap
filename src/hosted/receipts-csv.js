import { tagsCell } from "../tags.js";

// Session export of synced receipts. This is the operator's copy of what
// the proxy reported. It is not a provider bill.

const COLUMNS = ["ts", "agent_id", "receipt_id", "run_id", "model", "cost_usd", "cost_source", "settled_cost_usd", "settle_source", "reason", "scope", "outcome", "tags"];
export const RECEIPT_CSV_LIMIT = 5000;

export function cell(value) {
  let text = value == null ? "" : String(value);
  if (/^[=+@\t\r]/.test(text) || /^-(?!\d)/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

// Filters (since/until in epoch ms, agentId) apply before the row limit, so a
// scoped export that fits under the limit is complete. When the limit still
// truncates, the first line says so in-band: a browser download never shows
// response headers.
export function receiptsCsv(rows, { limit = RECEIPT_CSV_LIMIT, since, until, agentId, runId } = {}) {
  const matched = rows.filter((row) => {
    if (agentId !== undefined && row.agent_id !== agentId) return false;
    if (runId !== undefined && row.run_id !== runId) return false;
    if (since === undefined && until === undefined) return true;
    const ms = Date.parse(row.ts);
    if (Number.isNaN(ms)) return false;
    return (since === undefined || ms >= since) && (until === undefined || ms <= until);
  });
  const sorted = matched.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.receipt_id).localeCompare(String(b.receipt_id)));
  const total = sorted.length;
  const truncated = total > limit;
  const kept = truncated ? sorted.slice(total - limit) : sorted;
  const lines = truncated ? [`# truncated: showing newest ${kept.length} of ${total} receipts; narrow with since/until`] : [];
  lines.push(COLUMNS.join(","));
  for (const row of kept) {
    lines.push(COLUMNS.map((key) => cell(key === "tags" ? tagsCell(row.tags) : row[key])).join(","));
  }
  return { body: `${lines.join("\n")}\n`, truncated, count: kept.length, total };
}

// Validates /v1/receipts.csv query parameters. agentIds is the set of agent
// ids in the caller's org; anything else is a 400 so no foreign rows leak.
export function parseReceiptsQuery(params, agentIds, parseRange) {
  const range = parseRange(params);
  const bad = (msg) => { const err = new Error(msg); err.status = 400; throw err; };
  if (range.since !== undefined && range.until !== undefined && range.since > range.until) bad("since must not be after until");
  const agentId = params.get("agent_id");
  if (agentId !== null && !agentIds.has(agentId)) bad("agent_id is not an agent in this workspace");
  const runId = params.get("run_id");
  if (runId !== null && (!runId || runId.length > 200)) bad("run_id must be 1-200 characters");
  return { ...range, ...(agentId !== null ? { agentId } : {}), ...(runId !== null ? { runId } : {}) };
}
