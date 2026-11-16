// #229: PR cost diff vs a baseline. `costcap summary --json` writes a stable,
// versioned spend summary; `costcap diff` compares two of them and can gate on
// a $ or % increase. Unknown cost is never treated as $0.
import { readFileSync } from "node:fs";
import { loadSettledReceipts } from "./cap.js";

export const SUMMARY_VERSION = 1;
export const MAX_ROWS = 20;
export const EXIT = Object.freeze({ ok: 0, cost_regression: 1, accounting_unavailable: 3 });
const r6 = (n) => Number(Number(n).toFixed(6));

/** Aggregate settled receipts into the v1 summary. Blocked/refused calls are not spend. */
export function buildCostSummary(receipts, { runId } = {}) {
  let total = 0, calls = 0, unknown = 0;
  const tokens = { in: 0, out: 0, cached: 0 };
  const by_model = {}, by_tag = {}, by_tag_unknown = {};
  for (const r of receipts) {
    if (!r || r.event || r.blocked) continue;
    if (runId != null && r.run_id !== runId) continue;
    calls++;
    tokens.in += r.input_tokens ?? 0;
    tokens.out += r.output_tokens ?? 0;
    tokens.cached += r.cached_input_tokens ?? 0;
    const m = (by_model[r.model ?? "unknown"] ??= { calls: 0, cost_usd: 0, unknown_cost_count: 0 });
    m.calls++;
    const known = typeof r.cost_usd === "number" && Number.isFinite(r.cost_usd);
    if (known) { total += r.cost_usd; m.cost_usd = r6(m.cost_usd + r.cost_usd); } else { unknown++; m.unknown_cost_count++; }
    if (r.tags && typeof r.tags === "object") {
      for (const [k, v] of Object.entries(r.tags)) {
        if (known) { const t = (by_tag[k] ??= {}); t[v] = r6((t[v] ?? 0) + r.cost_usd); }
        else { const t = (by_tag_unknown[k] ??= {}); t[v] = (t[v] ?? 0) + 1; }
      }
    }
  }
  const s = { version: SUMMARY_VERSION, total_usd: r6(total), calls, tokens, unknown_cost_count: unknown, by_model, by_tag };
  // #231: per-tag unknown-cost counts; omitted when empty so fully-priced summaries stay byte-identical.
  if (Object.keys(by_tag_unknown).length) s.by_tag_unknown = by_tag_unknown;
  if (runId != null) s.run_id = runId;
  return s;
}

export function summarizeLedger(receiptsPath, opts = {}) {
  return buildCostSummary(loadSettledReceipts(receiptsPath), opts);
}

/** JSON with keys sorted at every level, so the same receipts give byte-identical output. */
export function stableStringify(v) {
  const sort = (x) => (x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : Array.isArray(x) ? x.map(sort) : x);
  return JSON.stringify(sort(v), null, 2) + "\n";
}

export function parseSummary(text, label = "summary") {
  let s;
  try { s = JSON.parse(text); } catch (e) { throw new Error(`${label} is not valid JSON: ${e.message}`); }
  if (!s || s.version !== SUMMARY_VERSION || typeof s.total_usd !== "number" || typeof s.by_model !== "object")
    throw new Error(`${label} is not a costcap summary v${SUMMARY_VERSION} (make it with: costcap summary --json)`);
  return { calls: 0, tokens: {}, unknown_cost_count: 0, by_tag: {}, by_tag_unknown: {}, ...s };
}

export const readSummary = (path, label = path) => parseSummary(readFileSync(path, "utf8"), label);

export function pct(base, cur) {
  if (base === 0) return cur === 0 ? 0 : cur > 0 ? Infinity : -Infinity;
  return Number((((cur - base) / base) * 100).toFixed(1));
}

function delta(base, cur) {
  return { baseline: r6(base), current: r6(cur), delta: r6(cur - base), pct: pct(base, cur) };
}

// #231: b/c map key -> { usd, unknown }. A row with current unknown cost is a lower bound and never "removed";
// a row with baseline-only unknown cost carries baseline_incomplete instead of looking like a plain add/drop.
function rows(kind, b = {}, c = {}) {
  const out = [];
  for (const key of new Set([...Object.keys(b), ...Object.keys(c)])) {
    const inB = Object.hasOwn(b, key), inC = Object.hasOwn(c, key);
    const bu = inB ? b[key].unknown : 0, cu = inC ? c[key].unknown : 0;
    const d = delta(inB ? b[key].usd : 0, inC ? c[key].usd : 0);
    const status = !inB ? "added" : !inC ? "removed" : cu > 0 ? "unknown_cost" : d.delta === 0 && bu === 0 ? "unchanged" : "changed";
    const row = { kind, key, status, ...d, baseline_unknown_count: bu, current_unknown_count: cu, lower_bound: cu > 0 };
    if (bu > 0 && cu === 0) row.baseline_incomplete = true;
    out.push(row);
  }
  return out;
}

const modelUsd = (s) => Object.fromEntries(Object.entries(s.by_model).map(([k, v]) => [k, { usd: v?.cost_usd ?? 0, unknown: v?.unknown_cost_count ?? 0 }]));
function tagUsd(s) {
  const out = {};
  for (const [k, vals] of Object.entries(s.by_tag ?? {})) for (const [v, usd] of Object.entries(vals ?? {})) (out[`${k}=${v}`] ??= { usd: 0, unknown: 0 }).usd = usd;
  for (const [k, vals] of Object.entries(s.by_tag_unknown ?? {})) for (const [v, n] of Object.entries(vals ?? {})) (out[`${k}=${v}`] ??= { usd: 0, unknown: 0 }).unknown = Number(n) || 0;
  return out;
}

function rowCells(r) {
  const ge = r.lower_bound ? "≥" : "";
  const note = r.lower_bound ? ` (${r.current_unknown_count} unknown-cost)` : r.baseline_incomplete ? ` (baseline_incomplete: ${r.baseline_unknown_count} unknown-cost)` : "";
  return { cur: `${ge}${fmtUsd(r.current)}`, change: `${ge}${fmtUsd(r.delta, true)} (${ge}${fmtPct(r.pct)})`, note };
}

/** Compare two summaries. Thresholds are optional; maxPct/maxUsd fail when the increase is strictly greater. */
export function diffSummaries(baseline, current, { maxPct, maxUsd } = {}) {
  const total = delta(baseline.total_usd, current.total_usd);
  const lower_bound = current.unknown_cost_count > 0;
  const baseline_incomplete = baseline.unknown_cost_count > 0;
  const changes = [...rows("model", modelUsd(baseline), modelUsd(current)), ...rows("tag", tagUsd(baseline), tagUsd(current))]
    .filter((r) => r.status !== "unchanged")
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  const warnings = [];
  if (baseline_incomplete) warnings.push("baseline_incomplete");
  const reasons = [];
  if (!lower_bound) {
    if (maxPct != null && !baseline_incomplete && total.pct > maxPct) reasons.push(`increase ${fmtPct(total.pct)} > ${maxPct}%`);
    if (maxUsd != null && total.delta > maxUsd) reasons.push(`increase ${fmtUsd(total.delta, true)} > $${maxUsd}`);
  }
  const verdict = lower_bound ? "accounting_unavailable" : reasons.length ? "cost_regression" : "ok";
  return {
    verdict, exit_code: EXIT[verdict], reasons, warnings, lower_bound, total,
    calls: delta(baseline.calls ?? 0, current.calls ?? 0),
    tokens: Object.fromEntries(["in", "out", "cached"].map((k) => [k, delta(baseline.tokens?.[k] ?? 0, current.tokens?.[k] ?? 0)])),
    changes,
  };
}

export function fmtUsd(n, sign = false) {
  const a = Math.abs(n);
  const v = a >= 0.01 || a === 0 ? a.toFixed(2) : String(Number(a.toFixed(6)));
  return `${sign ? (n < 0 ? "-" : "+") : n < 0 ? "-" : ""}$${v}`;
}

export function fmtPct(p) {
  if (p === Infinity) return "+∞%";
  if (p === -Infinity) return "-∞%";
  return `${p < 0 ? "" : "+"}${p}%`;
}

const fmtNum = (n, sign = false) => `${sign && n >= 0 ? "+" : ""}${n}`;

function verdictLine(d) {
  const lb = d.lower_bound ? " (current has unknown cost; deltas are lower bounds)" : "";
  const why = d.reasons.length ? `: ${d.reasons.join("; ")}` : "";
  const warn = d.warnings.length ? ` [warning: ${d.warnings.join(", ")}${d.warnings.includes("baseline_incomplete") ? "; % change not gated" : ""}]` : "";
  return `verdict: ${d.verdict}${why}${lb}${warn}`;
}

function totalCell(d) {
  const ge = d.lower_bound ? "≥" : "";
  return `${ge}${fmtUsd(d.total.delta, true)} (${ge}${fmtPct(d.total.pct)})`;
}

export function formatDiffText(d) {
  const ge = d.lower_bound ? "≥" : "";
  const lines = [
    `total: ${fmtUsd(d.total.baseline)} -> ${ge}${fmtUsd(d.total.current)}  ${totalCell(d)}`,
    `calls: ${d.calls.baseline} -> ${d.calls.current}  ${fmtNum(d.calls.delta, true)} (${fmtPct(d.calls.pct)})`,
    ...["in", "out", "cached"].map((k) => `tokens ${k}: ${d.tokens[k].baseline} -> ${d.tokens[k].current}  ${fmtNum(d.tokens[k].delta, true)} (${fmtPct(d.tokens[k].pct)})`),
  ];
  for (const r of d.changes.slice(0, MAX_ROWS)) { const c = rowCells(r); lines.push(`${r.kind} ${r.key}: ${r.status} ${c.change}  ${fmtUsd(r.baseline)} -> ${c.cur}${c.note}`); }
  if (d.changes.length > MAX_ROWS) lines.push(`${d.changes.length - MAX_ROWS} more`);
  lines.push(verdictLine(d));
  return lines.join("\n");
}

const md = (s) => String(s).replace(/[|\r\n]/g, " ");

export function formatDiffMarkdown(d) {
  const ge = d.lower_bound ? "≥" : "";
  let out = `## CostCap cost diff: ${d.verdict}\n\n| | Baseline | Current | Change |\n| --- | --- | --- | --- |\n` +
    `| Total | ${fmtUsd(d.total.baseline)} | ${ge}${fmtUsd(d.total.current)} | ${totalCell(d)} |\n` +
    `| Calls | ${d.calls.baseline} | ${d.calls.current} | ${fmtNum(d.calls.delta, true)} (${fmtPct(d.calls.pct)}) |\n` +
    ["in", "out", "cached"].map((k) => `| Tokens ${k} | ${d.tokens[k].baseline} | ${d.tokens[k].current} | ${fmtNum(d.tokens[k].delta, true)} (${fmtPct(d.tokens[k].pct)}) |\n`).join("");
  if (d.changes.length) {
    out += `\n| Kind | Name | Status | Baseline | Current | Change |\n| --- | --- | --- | --- | --- | --- |\n`;
    for (const r of d.changes.slice(0, MAX_ROWS)) { const c = rowCells(r); out += `| ${r.kind} | ${md(r.key)} | ${r.status}${md(c.note)} | ${fmtUsd(r.baseline)} | ${c.cur} | ${c.change} |\n`; }
    if (d.changes.length > MAX_ROWS) out += `\n${d.changes.length - MAX_ROWS} more\n`;
  }
  return out + `\n${md(verdictLine(d))}\n`;
}

function numFlag(name, v) {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
}

export function parseThresholds(get) {
  const o = {};
  if (get("--max-increase-pct") !== undefined) o.maxPct = numFlag("--max-increase-pct", get("--max-increase-pct"));
  if (get("--max-increase-usd") !== undefined) o.maxUsd = numFlag("--max-increase-usd", get("--max-increase-usd"));
  return o;
}

const getter = (argv) => (name) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? "") : undefined; };

/** `costcap summary [--receipts FILE] [--run-id ID] [--json]` → exit code. */
export function summaryCommand(argv, { log = console.log, warn = console.error } = {}) {
  try {
    const get = getter(argv);
    const runId = get("--run-id");
    if (runId === "") throw new Error("--run-id needs a non-empty value");
    log(stableStringify(summarizeLedger(get("--receipts") ?? ".costcap/receipts.jsonl", runId !== undefined ? { runId } : {})).trimEnd());
    return 0;
  } catch (e) { warn(`costcap: ${e.message}`); return 2; }
}

/** `costcap diff --baseline FILE --current FILE [--max-increase-pct N] [--max-increase-usd N] [--markdown] [--json]` → exit code. */
export function diffCommand(argv, { log = console.log, warn = console.error } = {}) {
  try {
    const get = getter(argv);
    if (!get("--baseline") || !get("--current")) throw new Error("usage: costcap diff --baseline FILE --current FILE [--max-increase-pct N] [--max-increase-usd N] [--markdown] [--json]");
    const d = diffSummaries(readSummary(get("--baseline"), "baseline"), readSummary(get("--current"), "current"), parseThresholds(get));
    log(argv.includes("--json") ? JSON.stringify(d, (k, v) => (v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : v)) : argv.includes("--markdown") ? formatDiffMarkdown(d).trimEnd() : formatDiffText(d));
    return d.exit_code;
  } catch (e) { warn(`costcap: ${e.message}`); return 2; }
}
