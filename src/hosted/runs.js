// Issue #159: hosted per-run drill-down. Pure, no I/O.
// Groups one agent's synced receipts by run_id. An unknown cost (cost_usd null
// and not settled) is never counted as $0: it raises unknown_count and makes the
// run cost_complete: false. A settled unknown counts at its settled value.

export const RUNS_DEFAULT_LIMIT = 20;
export const RUNS_MAX_LIMIT = 100;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const NO_RUN = "(none)";

// items: stored receipt records { receipt, settlement? }.
export function runDetailRow(item) {
  const r = item?.receipt ?? item ?? {};
  const settled = item?.settlement?.cost_usd;
  const usd = typeof r.cost_usd === "number" ? r.cost_usd : typeof settled === "number" ? settled : null;
  return {
    receipt_id: r.id ?? "", ts: r.ts ?? "", model: r.model ?? "", cost_usd: r.cost_usd ?? null,
    settled_cost_usd: typeof settled === "number" ? settled : null, usd_known: usd,
    unknown: usd === null, blocked: Boolean(r.blocked), outcome: r.outcome ?? null, reason: r.reason ?? null,
  };
}

export function summarizeRuns(items) {
  const runs = new Map();
  for (const item of items) {
    const r = item?.receipt ?? item;
    if (!r || !Number.isFinite(Date.parse(r.ts))) continue;
    const id = typeof r.run_id === "string" && r.run_id ? r.run_id : NO_RUN;
    const row = runDetailRow(item);
    let run = runs.get(id);
    if (!run) runs.set(id, run = { run_id: id, first_ts: r.ts, last_ts: r.ts, calls: 0, usd_known: 0, unknown_count: 0, blocked_count: 0, models: new Map() });
    if (Date.parse(r.ts) < Date.parse(run.first_ts)) run.first_ts = r.ts;
    if (Date.parse(r.ts) > Date.parse(run.last_ts)) run.last_ts = r.ts;
    run.calls += 1;
    if (row.blocked) run.blocked_count += 1;
    if (row.unknown) run.unknown_count += 1; else run.usd_known += row.usd_known;
    const key = row.model || "unknown";
    const m = run.models.get(key) ?? { model: key, calls: 0, usd_known: 0 };
    m.calls += 1;
    if (!row.unknown) m.usd_known += row.usd_known;
    run.models.set(key, m);
  }
  return [...runs.values()].map((run) => ({
    ...run, usd_known: round6(run.usd_known), cost_complete: run.unknown_count === 0,
    models: [...run.models.values()].map((m) => ({ ...m, usd_known: round6(m.usd_known) })).sort((a, b) => a.model.localeCompare(b.model)),
  })).sort(compareRuns);
}

// Newest first by last_ts, ties broken by run_id descending.
function compareRuns(a, b) {
  return Date.parse(b.last_ts) - Date.parse(a.last_ts) || (a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0);
}

const encodeCursor = (run) => Buffer.from(JSON.stringify([run.last_ts, run.run_id])).toString("base64url");
function decodeCursor(cursor) {
  try {
    const [last_ts, run_id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof last_ts !== "string" || typeof run_id !== "string" || !Number.isFinite(Date.parse(last_ts))) throw new Error();
    return { last_ts, run_id };
  } catch { const err = new Error("Invalid cursor"); err.status = 400; throw err; }
}

export function parseRunsQuery(params) {
  const bad = (msg) => { const err = new Error(msg); err.status = 400; throw err; };
  const out = { limit: RUNS_DEFAULT_LIMIT };
  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1) bad("limit must be a positive integer");
    out.limit = Math.min(Number(limit), RUNS_MAX_LIMIT);
  }
  const since = params.get("since");
  if (since !== null) {
    const ms = /^\d+$/.test(since) ? Number(since) : Date.parse(since);
    if (!Number.isFinite(ms)) bad("since must be an ISO date or epoch ms");
    out.since = ms;
  }
  const cursor = params.get("cursor");
  if (cursor !== null) out.cursor = decodeCursor(cursor);
  return out;
}

// Keyset pagination over summarizeRuns() output. `cutoff` (plan retention, epoch
// ms or null) and `since` drop receipts before grouping, so a run partly outside
// the window shows only its visible receipts.
export function pageRuns(items, { limit = RUNS_DEFAULT_LIMIT, since, cursor, cutoff = null } = {}) {
  const floor = Math.max(cutoff ?? -Infinity, since ?? -Infinity);
  const visible = items.filter((item) => !(Date.parse((item?.receipt ?? item)?.ts) < floor));
  let runs = summarizeRuns(visible);
  if (cursor) runs = runs.filter((run) => compareRuns(run, cursor) > 0);
  const page = runs.slice(0, limit);
  const next = runs.length > limit ? encodeCursor(page[page.length - 1]) : null;
  return { runs: page, next_cursor: next };
}

export function runReceipts(items, runId, { cutoff = null } = {}) {
  const rows = items
    .filter((item) => { const r = item?.receipt ?? item; return ((r?.run_id || NO_RUN) === runId) && !(Date.parse(r?.ts) < (cutoff ?? -Infinity)); })
    .map(runDetailRow)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.receipt_id.localeCompare(b.receipt_id));
  return rows;
}
