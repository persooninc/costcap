// GitHub Action outputs and job summary for `costcap check --github-output`.
// Values use heredoc delimiter syntax so newlines or `%` cannot break the file.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { formatDiffMarkdown } from "./cost-diff.js";

export const OUTPUT_NAMES = Object.freeze(["verdict", "spent-usd", "cap-usd", "hour-spent-usd", "day-spent-usd", "month-spent-usd", "unknown-receipts", "receipts-count", "warnings", "run-id", "tag-caps"]);
export const DIFF_OUTPUT_NAMES = Object.freeze(["delta-usd", "delta-pct", "baseline-usd", "diff-markdown"]);

const usd = (n) => (n == null ? "" : String(Number(Number(n).toFixed(6))));

export function checkOutputs(result, caps = {}) {
  const unknown = result.unknown_cost_count > 0;
  const accounting = unknown || result.hit?.scope === "accounting" || result.hit?.reason === "accounting_unavailable";
  const verdict = accounting ? "accounting_unavailable" : result.ok ? "ok" : result.hit?.reason === "tag_budget_exceeded" ? "tag_budget_exceeded" : "budget_exceeded";
  const ledgerUnknown = unknown || result.ledger_unknown_cost_count > 0;
  const out = {
    verdict,
    "spent-usd": unknown ? "" : usd(result.total_usd),
    "cap-usd": usd(caps.run),
    "hour-spent-usd": ledgerUnknown ? "" : usd(result.spend?.hour),
    "day-spent-usd": ledgerUnknown ? "" : usd(result.spend?.day),
    "month-spent-usd": ledgerUnknown ? "" : usd(result.spend?.month),
    "unknown-receipts": String(result.unknown_cost_count),
    "receipts-count": String(result.receipt_count),
    // #164: e.g. "day:0.8,month:0.5"; empty when nothing is near a cap.
    warnings: (result.warnings ?? []).map((w) => `${w.scope}:${w.fraction}`).join(","),
  };
  // Only run-scoped checks emit run-id, so ledger-wide output stays unchanged.
  if (result.run_id != null) out["run-id"] = String(result.run_id);
  // #191: e.g. "customer=acme:day:1.2/1"; only present when --tag-cap was given.
  if (Array.isArray(result.tag_caps)) out["tag-caps"] = result.tag_caps.map((t) => `${t.key}=${t.value}:${t.scope}:${t.spend_usd}/${t.cap_usd}`).join(",");
  return out;
}

export function formatOutputFile(outputs, delim = () => `costcap_${randomUUID()}`) {
  let out = "";
  for (const [k, raw] of Object.entries(outputs)) {
    const v = String(raw ?? "");
    let d = delim();
    while (v.includes(d)) d = delim();
    out += `${k}<<${d}\n${v}\n${d}\n`;
  }
  return out;
}

const cell = (v, k) => String(v === "" ? (k === "warnings" || k === "tag-caps" ? "none" : "unknown") : v).replace(/[|\r\n]/g, " ");

export function formatSummary(outputs) {
  const rows = OUTPUT_NAMES.filter((k) => (k !== "run-id" && k !== "tag-caps") || outputs[k] != null).map((k) => `| ${k} | ${cell(outputs[k], k)} |`).join("\n");
  const unknown = Number(outputs["unknown-receipts"]) > 0;
  return `## CostCap budget check: ${cell(outputs.verdict)}\n\n| Field | Value |\n| --- | --- |\n${rows}\n\n` +
    "Totals are estimates from receipts metered through the CostCap proxy, not provider invoices.\n" +
    (unknown ? `${outputs["unknown-receipts"]} receipt(s) have unknown cost, so spend is unknown (not $0). Reconcile before relying on this result.\n`
      : "No receipts have unknown cost.\n");
}

// #229: with a baseline diff, add delta outputs; an otherwise-ok verdict becomes cost_regression.
export function diffOutputs(outputs, diff) {
  const out = { ...outputs };
  if (out.verdict === "ok" && diff.verdict !== "ok") out.verdict = diff.verdict;
  const lb = diff.lower_bound ? "" : null;
  out["delta-usd"] = lb ?? usd(diff.total.delta);
  out["delta-pct"] = lb ?? (Number.isFinite(diff.total.pct) ? String(diff.total.pct) : diff.total.pct > 0 ? "inf" : "-inf");
  out["baseline-usd"] = usd(diff.total.baseline);
  out["diff-markdown"] = formatDiffMarkdown(diff);
  return out;
}

export function writeGithubOutputs(result, caps, env = process.env, diff = null) {
  let outputs = checkOutputs(result, caps);
  if (diff) outputs = diffOutputs(outputs, diff);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, formatOutputFile(outputs));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, formatSummary(outputs) + (diff ? "\n" + outputs["diff-markdown"] : ""));
  return outputs;
}
