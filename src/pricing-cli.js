// `costcap pricing verify [--receipts FILE] [--json]` and `costcap pricing show [model]` (#122).
// Returns { code, out, err } so it is testable without spawning; table path injectable.

import { readFileSync } from "node:fs";
import { loadPricingTable } from "./pricing.js";
import { auditReceipts } from "./pricing-digest.js";

function option(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").map((l) => { try { return l.trim() ? JSON.parse(l) : null; } catch { return null; } });
}

const fmt = (n) => (n == null ? "n/a" : `$${n}`);

export const PRICING_USAGE = "usage: costcap pricing verify [--receipts FILE] [--json] | costcap pricing show [model]";

export function pricingCommand(args, { tablePath } = {}) {
  const [sub, ...rest] = args;
  if (sub !== "verify" && sub !== "show") return { code: 2, out: "", err: PRICING_USAGE };
  const { table, tablePath: path, verification: v } = loadPricingTable(tablePath);
  if (sub === "verify") {
    const lines = [];
    let code = 0;
    if (v.ok) lines.push(`ok: pricing table ${table.version} sha256 ${v.actual} matches its committed digest`);
    else { code = 1; lines.push(`MISMATCH: pricing table ${path} (${v.reason}): sha256 ${v.actual}, expected ${v.expected ?? "none"}`); }
    const receiptsPath = option(rest, "--receipts");
    let audit;
    if (receiptsPath) {
      audit = auditReceipts(readJsonl(receiptsPath), v.actual);
      lines.push(`receipts: ${audit.total} priced, ${audit.matching} matching, ${audit.different} different, ${audit.unknown} unknown (no table_sha256)`);
      for (const [d, n] of Object.entries(audit.by_digest)) lines.push(`  different digest ${d}: ${n}`);
      for (const m of audit.mismatched) lines.push(`  line ${m.line}: ${m.status} (table_version ${m.table_version ?? "none"}, table_sha256 ${m.table_sha256 ?? "none"})`);
      if (!audit.ok) code = 1;
    }
    if (rest.includes("--json")) return { code, out: JSON.stringify({ ok: code === 0, table: { path, version: table.version, ...v }, ...(audit ? { receipts: audit } : {}) }), err: "" };
    return { code, out: code === 0 ? lines.join("\n") : "", err: code === 0 ? "" : lines.join("\n") };
  }
  const model = rest.find((a) => !a.startsWith("--"));
  const head = `pricing table ${table.version} (${table.currency}) sha256 ${v.actual}${v.ok ? "" : " UNVERIFIED"}`;
  const row = (name, r, tag = "") => `${name}${tag}: input ${fmt(r.input)}, cached_input ${fmt(r.cached_input)}, cache_write ${fmt(r.cache_write)}, cache_write_1h ${fmt(r.cache_write_1h)}, output ${fmt(r.output)}`;
  // A long-context tier (#151) prints as a second row for the same model.
  const rowsFor = (name, r) => [row(name, r), ...(r.long_context ? [row(name, r.long_context, ` (>${r.long_context.threshold_input_tokens} input tokens)`)] : [])];
  if (!model) {
    const rows = Object.entries(table.models).flatMap(([k, r]) => rowsFor(k, r));
    return { code: 0, out: [head, ...rows, row("fallback", table.fallback, " (fallback for unknown models)")].join("\n"), err: "" };
  }
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const entry = table.models[model] ?? table.models[base];
  return { code: 0, out: [head, entry ? rowsFor(model, entry).join("\n") : row(model, table.fallback, " (fallback: unknown model, billed at the declared fallback rate)")].join("\n"), err: "" };
}
