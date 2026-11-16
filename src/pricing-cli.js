// `costcap pricing verify [--receipts FILE] [--json]` and `costcap pricing show [model]` (#122).
// Returns { code, out, err } so it is testable without spawning; table path injectable.

import { readFileSync } from "node:fs";
import { loadPricingTable, datedRow, dayOf } from "./pricing.js";
import { auditReceipts } from "./pricing-digest.js";
import { loadUpstreamPrices } from "./upstreams.js";
import { builtinOverride, effectivePrice, OVERRIDE_PROVIDERS } from "./price-overrides.js";

function option(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").map((l) => { try { return l.trim() ? JSON.parse(l) : null; } catch { return null; } });
}

const fmt = (n) => (n == null ? "n/a" : `$${Number(n.toFixed(6))}`);

export const PRICING_USAGE = "usage: costcap pricing verify [--receipts FILE] [--prices FILE] [--json] | costcap pricing show [model] [--at YYYY-MM-DD] [--prices FILE]";

export function pricingCommand(args, { tablePath } = {}) {
  const [sub, ...rest] = args;
  if (sub !== "verify" && sub !== "show") return { code: 2, out: "", err: PRICING_USAGE };
  const { table, tablePath: path, verification: v } = loadPricingTable(tablePath);
  const pricesPath = option(rest, "--prices");
  let prices;
  if (pricesPath) {
    try { prices = loadUpstreamPrices(pricesPath, []); } catch (e) { return { code: 2, out: "", err: e.message }; }
  }
  if (sub === "verify") {
    const lines = [];
    let code = 0;
    if (v.ok) lines.push(`ok: pricing table ${table.version} sha256 ${v.actual} matches its committed digest`);
    else { code = 1; lines.push(`MISMATCH: pricing table ${path} (${v.reason}): sha256 ${v.actual}, expected ${v.expected ?? "none"}`); }
    const receiptsPath = option(rest, "--receipts");
    let audit;
    if (receiptsPath) {
      audit = auditReceipts(readJsonl(receiptsPath), v.actual, prices?.sha256);
      lines.push(`receipts: ${audit.total} priced, ${audit.matching} matching, ${audit.different} different, ${audit.unknown} unknown (no table_sha256), ${audit.user_prices} user_prices${prices ? ` (${audit.prices_mismatched} not matching ${pricesPath})` : ""}`);
      for (const [d, n] of Object.entries(audit.by_digest)) lines.push(`  different digest ${d}: ${n}`);
      for (const m of audit.mismatched) lines.push(m.status === "prices_different" ? `  line ${m.line}: prices_different (prices_version ${m.prices_version ?? "none"}, prices_sha256 ${m.prices_sha256 ?? "none"})`
        : `  line ${m.line}: ${m.status} (table_version ${m.table_version ?? "none"}, table_sha256 ${m.table_sha256 ?? "none"})`);
      if (!audit.ok) code = 1;
    }
    if (rest.includes("--json")) return { code, out: JSON.stringify({ ok: code === 0, table: { path, version: table.version, ...v }, ...(audit ? { receipts: audit } : {}) }), err: "" };
    return { code, out: code === 0 ? lines.join("\n") : "", err: code === 0 ? "" : lines.join("\n") };
  }
  const model = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--prices" && rest[i - 1] !== "--at");
  // #236: --at YYYY-MM-DD prints the row in effect on that UTC day (default: today).
  const atArg = option(rest, "--at");
  if (atArg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(atArg)) return { code: 2, out: "", err: `--at must be YYYY-MM-DD, got ${atArg}` };
  let day;
  try { day = dayOf(atArg === undefined ? undefined : `${atArg}T00:00:00Z`); } catch { return { code: 2, out: "", err: `--at must be a valid date, got ${atArg}` }; }
  const head = `pricing table ${table.version} (${table.currency}) sha256 ${v.actual}${v.ok ? "" : " UNVERIFIED"}`;
  const row = (name, r, tag = "") => `${name}${tag}: input ${fmt(r.input)}, cached_input ${fmt(r.cached_input)}, cache_write ${fmt(r.cache_write)}, cache_write_1h ${fmt(r.cache_write_1h)}, output ${fmt(r.output)}`;
  // A long-context tier (#151) prints as a second row for the same model.
  // Premium speed / service tiers (#155) print as (fast) / (priority) rows.
  // #198: per-minute / per-character audio models print their unit rate instead of token rates.
  const unitRow = (name, r) => (Number.isFinite(r.per_minute) ? `${name}: ${fmt(r.per_minute)} per minute of audio`
    : `${name}: ${fmt(r.per_million_characters)} per 1M characters of input text`);
  const rowsFor = (name, r) => (Number.isFinite(r.per_minute) || Number.isFinite(r.per_million_characters)) && !Number.isFinite(r.input) ? [unitRow(name, r)] : [row(name, r), ...(r.long_context ? [row(name, r.long_context, ` (>${r.long_context.threshold_input_tokens} input tokens)`)] : []),
    ...["fast", "priority", "ultrafast"].filter((t) => r[t]).map((t) => row(name, r[t], ` (${t})`)),
    // Modality rates (#163) print as (audio) / (image) rows; uniform / text-rate notes follow.
    ...Object.entries(r.modalities ?? {}).map(([m, mr]) => `${name} (${m}): input ${fmt(mr.input)}, cached_input ${fmt(mr.cached_input)}, output ${fmt(mr.output)}`),
    ...(r.uniform_modalities ? [`${name}: all input modalities at the input rate`] : []),
    ...(r.text_rate_modalities?.length ? [`${name}: ${r.text_rate_modalities.join("/")} input at the text rate`] : [])];
  if (!model) {
    const rows = Object.entries(table.models).flatMap(([k, r]) => rowsFor(k, r));
    return { code: 0, out: [head, ...rows, row("fallback", table.fallback, " (fallback for unknown models)")].join("\n"), err: "" };
  }
  // #189: with --prices, the effective row for the first built-in provider that overrides the model.
  // A model-specific entry wins over another provider's "*" discount.
  const listed = (p) => [model, model.replace(/-(?:\d{4}-\d{2}-\d{2}|20\d{6})$/, "")].some((id) => Object.hasOwn(prices.upstreams[p] ?? {}, id));
  const provider = prices && (OVERRIDE_PROVIDERS.find((p) => listed(p) && builtinOverride(prices, p, model)) ?? OVERRIDE_PROVIDERS.find((p) => builtinOverride(prices, p, model)));
  if (provider) {
    const o = builtinOverride(prices, provider, model);
    const tag = o.absolute ? ` (user_prices ${prices.sha256.slice(0, 8)})` : ` (discount ${o.discount})`;
    const eff = effectivePrice(prices, provider, model, `${day}T00:00:00Z`);
    return { code: 0, out: [head, ...(o.absolute ? [row(`${provider}/${model}`, eff, tag)] : rowsFor(`${provider}/${model}`, eff).map((l, i) => (i === 0 ? l.replace(":", `${tag}:`) : l)))].join("\n"), err: "" };
  }
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const id = Object.hasOwn(table.models, model) ? model : Object.hasOwn(table.models, base) ? base : null;
  if (id === null) return { code: 0, out: [head, row(model, table.fallback, " (fallback: unknown model, billed at the declared fallback rate)")].join("\n"), err: "" };
  const d = datedRow(table, id, day);
  const lines = rowsFor(model, d.row);
  if (d.billed_as) lines[0] = lines[0].replace(":", ` (billed as ${d.billed_as}):`);
  lines.unshift(`${model} on ${day}${d.rates_effective_from ? ` (rates effective from ${d.rates_effective_from})` : ""}`);
  // Scheduled changes (#236) list after the row: "from 2026-12-01: ...".
  for (const e of table.models[id].effective ?? []) {
    if (e.from <= day) continue;
    if (e.billed_as) { lines.push(`from ${e.from}: billed as ${e.billed_as}`); continue; }
    const after = datedRow(table, id, e.from).row;
    lines.push(`from ${e.from}: input ${fmt(after.input)}, cached_input ${fmt(after.cached_input)}, cache_write ${fmt(after.cache_write)}, cache_write_1h ${fmt(after.cache_write_1h)}, output ${fmt(after.output)}`);
  }
  return { code: 0, out: [head, ...lines].join("\n"), err: "" };
}
