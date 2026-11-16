// `costcap bill-check` (#221): compare CostCap's metered spend with the provider's
// daily cost export (OpenAI Costs API, Anthropic Cost Report) per UTC day and model.
// Unknown-cost receipts are counted, never treated as $0. Unmapped line items are
// reported, never dropped. Admin keys come from env only and are never echoed.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { loadLedgerLines, applySettlements } from "./cap.js";

export const PROVIDERS = Object.freeze(["openai", "anthropic"]);
export const KEY_ENV = Object.freeze({ openai: "COSTCAP_OPENAI_ADMIN_KEY", anthropic: "COSTCAP_ANTHROPIC_ADMIN_KEY" });
export const BASE_ENV = Object.freeze({ openai: "COSTCAP_OPENAI_ADMIN_BASE_URL", anthropic: "COSTCAP_ANTHROPIC_ADMIN_BASE_URL" });
const DEFAULT_BASE = Object.freeze({ openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Dated model snapshots meter under the same model the bill names.
export function normalizeModel(model) {
  if (typeof model !== "string") return null;
  const m = model.trim().toLowerCase().replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  return m || null;
}

function dayOf(value) {
  const d = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function money(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("Provider export amount must be a finite number");
  return n;
}

function pagesOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === "object") return [doc];
  throw new Error("Provider export must be a JSON object or a list of pages");
}

// OpenAI GET /v1/organization/costs (group_by=line_item). amount.value is USD.
// #227: a project/workspace filter needs the export grouped by that id; the providers
// return the id as null otherwise, so filtering an ungrouped export would drop every row.
function assertGrouped(results, field, id, grouped) {
  if (!id || grouped || !results.length) return;
  if (results.every((r) => r?.[field] === null || r?.[field] === undefined)) {
    const flag = field === "project_id" ? "--project" : "--workspace";
    const by = field === "project_id" ? "group_by=project_id" : "group_by[]=workspace_id";
    throw new Error(`${flag} needs an export grouped by ${field.replace("_id", "")} (${by}); no row has ${field}. Re-export grouped by ${field.replace("_id", "")} or use --fetch`);
  }
}

export function parseOpenAICosts(doc, { project, grouped = false } = {}) {
  const rows = [];
  const all = [];
  for (const page of pagesOf(doc)) {
    if (!Array.isArray(page?.data)) throw new Error("OpenAI costs export needs a data list");
    for (const bucket of page.data) {
      const day = dayOf(bucket?.start_time);
      if (!day) throw new Error("OpenAI costs bucket needs a start_time");
      for (const r of bucket.results ?? []) {
        all.push(r);
        if (project && r.project_id !== project) continue;
        const currency = String(r.amount?.currency ?? "usd").toLowerCase();
        if (currency !== "usd") throw new Error(`Unsupported currency ${currency}`);
        const usd = money(r.amount?.value ?? 0);
        const line = typeof r.line_item === "string" ? r.line_item : "";
        const m = /^([^,]+),\s*\S/.exec(line);
        rows.push({ day, model: m ? normalizeModel(m[1]) : null, line_item: line || null, usd });
      }
    }
  }
  assertGrouped(all, "project_id", project, grouped);
  return rows;
}

// Anthropic GET /v1/organizations/cost_report. amount is a decimal string in cents.
export function parseAnthropicCostReport(doc, { workspace, grouped = false } = {}) {
  const rows = [];
  const all = [];
  for (const page of pagesOf(doc)) {
    if (!Array.isArray(page?.data)) throw new Error("Anthropic cost report needs a data list");
    for (const bucket of page.data) {
      const day = dayOf(bucket?.starting_at);
      if (!day) throw new Error("Anthropic cost report bucket needs starting_at");
      for (const r of bucket.results ?? []) {
        all.push(r);
        if (workspace && r.workspace_id !== workspace) continue;
        const currency = String(r.currency ?? "USD").toUpperCase();
        if (currency !== "USD") throw new Error(`Unsupported currency ${currency}`);
        const usd = money(r.amount ?? 0) / 100;
        rows.push({ day, model: normalizeModel(r.model), line_item: r.description ?? r.cost_type ?? null, usd });
      }
    }
  }
  assertGrouped(all, "workspace_id", workspace, grouped);
  return rows;
}

export function parseExport(provider, doc, filters = {}) {
  if (provider === "openai") return parseOpenAICosts(doc, { project: filters.project, grouped: filters.grouped });
  if (provider === "anthropic") return parseAnthropicCostReport(doc, { workspace: filters.workspace, grouped: filters.grouped });
  throw new Error("--provider must be openai or anthropic");
}

const inWindow = (day, since, until) => day && (!since || day >= since) && (!until || day <= until);
const round = (n) => Math.round(n * 1e6) / 1e6;
const key = (day, model) => `${day}\u0000${model}`;

// receipts: ledger receipts with settlements already applied.
export function billCheck({ receipts, billed, provider, since, until, tolerancePct = 5 }) {
  if (!PROVIDERS.includes(provider)) throw new Error("--provider must be openai or anthropic");
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0) throw new Error("--tolerance-pct must be a number >= 0");
  for (const d of [since, until]) if (d !== undefined && !DAY_RE.test(d)) throw new Error("--since/--until must be YYYY-MM-DD (UTC day)");
  const cells = new Map();
  const cell = (day, model) => {
    const k = key(day, model);
    if (!cells.has(k)) cells.set(k, { day, model, metered_usd: 0, billed_usd: 0, metered: false, billed: false, unknown_count: 0 });
    return cells.get(k);
  };
  let unknownCount = 0;
  for (const r of receipts) {
    if (!r || r.provider !== provider) continue;
    const day = dayOf(r.ts);
    if (!inWindow(day, since, until)) continue;
    // #226: a settled batch is attributed per model from its results (day = create day).
    const split = r.settled?.by_model;
    if (split && typeof r.cost_usd === "number" && typeof split === "object") {
      for (const [m, usd] of Object.entries(split)) {
        const sc = cell(day, (m === "unknown" ? null : normalizeModel(m)) ?? "unknown");
        sc.metered = true;
        sc.metered_usd += usd;
      }
      continue;
    }
    const c = cell(day, normalizeModel(r.model) ?? "unknown");
    c.metered = true;
    if (r.cost_usd === null || r.cost_usd === undefined) { c.unknown_count += 1; unknownCount += 1; continue; }
    if (typeof r.cost_usd !== "number" || !Number.isFinite(r.cost_usd)) throw new Error("Receipt cost must be a number or null");
    c.metered_usd += r.cost_usd;
  }
  const unmapped = [];
  for (const b of billed) {
    if (!inWindow(b.day, since, until)) continue;
    if (!b.model) { unmapped.push({ day: b.day, line_item: b.line_item, usd: round(b.usd) }); continue; }
    const c = cell(b.day, b.model);
    c.billed = true;
    c.billed_usd += b.usd;
  }
  const within = (metered, billedUsd) => {
    const delta = metered - billedUsd;
    if (Math.abs(delta) < 1e-9) return true;
    const base = Math.max(Math.abs(billedUsd), Math.abs(metered));
    return base > 0 && (Math.abs(delta) / Math.abs(billedUsd || base)) * 100 <= tolerancePct + 1e-9;
  };
  const rows = [...cells.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.model < b.model ? -1 : 1)).map((c) => {
    const delta = c.metered_usd - c.billed_usd;
    let status;
    if (c.unknown_count) status = "incomplete";
    else if (!c.billed) status = "metered_only";
    else if (!c.metered) status = "billed_only";
    else if (within(c.metered_usd, c.billed_usd)) status = "match";
    else status = delta > 0 ? "over_metered" : "unmetered_spend";
    return { day: c.day, model: c.model, metered_usd: round(c.metered_usd), billed_usd: round(c.billed_usd), delta_usd: round(delta),
      delta_pct: c.billed_usd ? round((delta / c.billed_usd) * 100) : null, unknown_count: c.unknown_count, status };
  });
  const metered = rows.reduce((s, r) => s + r.metered_usd, 0);
  const billedMapped = rows.reduce((s, r) => s + r.billed_usd, 0);
  const unmappedUsd = unmapped.reduce((s, u) => s + u.usd, 0);
  const billedTotal = billedMapped + unmappedUsd;
  const delta = metered - billedTotal;
  let verdict;
  if (unknownCount) verdict = "incomplete";
  else if (within(metered, billedTotal) && rows.every((r) => r.status === "match" || Math.abs(r.delta_usd) < 1e-9)) verdict = "match";
  else if (rows.some((r) => r.status === "unmetered_spend" || r.status === "billed_only") || delta < 0) verdict = "unmetered_spend";
  else verdict = "over_metered";
  // Unmapped USD beyond tolerance can never be called a match.
  if (verdict === "match" && unmappedUsd > 0 && !within(billedMapped, billedTotal)) verdict = "unmetered_spend";
  return { ok: verdict === "match", verdict, provider, since: since ?? null, until: until ?? null, tolerance_pct: tolerancePct, rows,
    unmapped, totals: { metered_usd: round(metered), billed_usd: round(billedTotal), unmapped_usd: round(unmappedUsd), delta_usd: round(delta),
      delta_pct: billedTotal ? round((delta / billedTotal) * 100) : null, unknown_count: unknownCount }, estimate_only: false };
}

export function billCheckFiles({ receiptsPath, exportDoc, provider, since, until, tolerancePct, project, workspace, grouped = false }) {
  const receipts = applySettlements(loadLedgerLines(receiptsPath));
  const billed = parseExport(provider, exportDoc, { project, workspace, grouped });
  const result = billCheck({ receipts, billed, provider, since, until, tolerancePct });
  const filter = provider === "openai" ? project : workspace;
  if (filter && !billed.some((b) => inWindow(b.day, since, until))) {
    const unfiltered = parseExport(provider, exportDoc, {}).filter((b) => inWindow(b.day, since, until));
    if (unfiltered.length) {
      // #227: a mistyped id (or Anthropic's default workspace, reported as null) is not pricing drift.
      result.filter_note = `filter matched no billed rows (${provider === "openai" ? "--project" : "--workspace"} ${filter}; export has ${unfiltered.length} rows in the period)`;
      result.verdict = "incomplete";
      result.ok = false;
    }
  }
  return result;
}

export function readExportFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        // Never follow a redirect: the key would travel to another origin (#138 rule).
        if (res.statusCode >= 300 && res.statusCode < 400) return reject(new Error(`provider API redirected (HTTP ${res.statusCode}); not followed`));
        if (res.statusCode !== 200) return reject(new Error(`provider API returned HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("provider API returned invalid JSON")); }
      });
    });
    req.on("error", (e) => reject(new Error(`provider API request failed: ${e.code ?? "error"}`)));
    req.end();
  });
}

// Fetch every page of the provider's cost export. Returns the list of pages.
export async function fetchExport({ provider, env = process.env, since, until, project, workspace, maxPages = 100 }) {
  if (!PROVIDERS.includes(provider)) throw new Error("--provider must be openai or anthropic");
  const apiKey = env[KEY_ENV[provider]];
  if (!apiKey) throw new Error(`--fetch needs ${KEY_ENV[provider]} in the environment`);
  if (!since) throw new Error("--fetch needs --since YYYY-MM-DD");
  const base = env[BASE_ENV[provider]] || DEFAULT_BASE[provider];
  const start = new Date(`${since}T00:00:00Z`);
  const end = until ? new Date(Date.parse(`${until}T00:00:00Z`) + 86400000) : null;
  const pages = [];
  let page;
  for (let i = 0; i < maxPages; i++) {
    let url;
    let headers;
    if (provider === "openai") {
      url = new URL("/v1/organization/costs", base);
      url.searchParams.set("start_time", String(Math.floor(start.getTime() / 1000)));
      if (end) url.searchParams.set("end_time", String(Math.floor(end.getTime() / 1000)));
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.append("group_by", "line_item");
      if (project) url.searchParams.append("group_by", "project_id");
      url.searchParams.set("limit", "180");
      headers = { authorization: `Bearer ${apiKey}` };
    } else {
      url = new URL("/v1/organizations/cost_report", base);
      url.searchParams.set("starting_at", start.toISOString());
      if (end) url.searchParams.set("ending_at", end.toISOString());
      url.searchParams.append("group_by[]", "description");
      if (workspace) url.searchParams.append("group_by[]", "workspace_id");
      url.searchParams.set("limit", "31");
      headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    }
    if (page) url.searchParams.set("page", page);
    const doc = await getJson(url, headers);
    pages.push(doc);
    if (!doc?.has_more || !doc.next_page) return pages;
    page = doc.next_page;
  }
  throw new Error(`provider API pagination exceeded ${maxPages} pages`);
}

export function parseBillCheckArgs(argv) {
  const opts = { tolerancePct: 5, json: false, fetch: false };
  const take = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--fetch") opts.fetch = true;
    else if (a === "--receipts") opts.receiptsPath = take(i++);
    else if (a === "--provider-export") opts.exportPath = take(i++);
    else if (a === "--provider") opts.provider = take(i++);
    else if (a === "--since") opts.since = take(i++);
    else if (a === "--until") opts.until = take(i++);
    else if (a === "--project") opts.project = take(i++);
    else if (a === "--workspace") opts.workspace = take(i++);
    else if (a === "--tolerance-pct") { opts.tolerancePct = Number(take(i++)); if (!Number.isFinite(opts.tolerancePct) || opts.tolerancePct < 0) throw new Error("--tolerance-pct must be a number >= 0"); }
    else throw new Error(`unknown option ${a}`);
  }
  if (!PROVIDERS.includes(opts.provider)) throw new Error("--provider must be openai or anthropic");
  if (!opts.receiptsPath) throw new Error("--receipts is required");
  if (opts.fetch === Boolean(opts.exportPath)) throw new Error("give exactly one of --provider-export FILE or --fetch");
  return opts;
}

export function formatBillCheck(r) {
  const usd = (n) => `$${n.toFixed(2)}`;
  const lines = [`costcap bill-check ${r.provider}: ${r.verdict} (tolerance ${r.tolerance_pct}%)`];
  if (r.filter_note) lines.push(`  ${r.filter_note}`);
  for (const row of r.rows) lines.push(`  ${row.day} ${row.model}: metered ${usd(row.metered_usd)} billed ${usd(row.billed_usd)} delta ${usd(row.delta_usd)}${row.delta_pct === null ? "" : ` (${row.delta_pct.toFixed(1)}%)`} ${row.status}${row.unknown_count ? ` unknown=${row.unknown_count}` : ""}`);
  for (const u of r.unmapped) lines.push(`  ${u.day} unmapped "${u.line_item ?? ""}": ${usd(u.usd)}`);
  const t = r.totals;
  lines.push(`  total: metered ${usd(t.metered_usd)} billed ${usd(t.billed_usd)} delta ${usd(t.delta_usd)} unmapped ${usd(t.unmapped_usd)} unknown=${t.unknown_count}`);
  return lines.join("\n");
}

// Returns an exit code: 0 match, 1 anything else, 2 usage/input error.
export async function billCheckCommand(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  try {
    const o = parseBillCheckArgs(argv);
    const exportDoc = o.fetch ? await fetchExport({ provider: o.provider, env, since: o.since, until: o.until, project: o.project, workspace: o.workspace }) : readExportFile(o.exportPath);
    const result = billCheckFiles({ receiptsPath: o.receiptsPath, exportDoc, provider: o.provider, since: o.since, until: o.until, tolerancePct: o.tolerancePct, project: o.project, workspace: o.workspace, grouped: o.fetch });
    out(o.json ? JSON.stringify(result) : formatBillCheck(result));
    return result.ok ? 0 : 1;
  } catch (e) {
    err(`costcap: ${e.message}`);
    return 2;
  }
}
