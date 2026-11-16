// GitHub Action outputs and job summary for `costcap check --github-output`.
// Values use heredoc delimiter syntax so newlines or `%` cannot break the file.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const OUTPUT_NAMES = Object.freeze(["verdict", "spent-usd", "cap-usd", "day-spent-usd", "month-spent-usd", "unknown-receipts", "receipts-count", "run-id"]);

const usd = (n) => (n == null ? "" : String(Number(Number(n).toFixed(6))));

export function checkOutputs(result, caps = {}) {
  const unknown = result.unknown_cost_count > 0;
  const accounting = unknown || result.hit?.scope === "accounting" || result.hit?.reason === "accounting_unavailable";
  const verdict = accounting ? "accounting_unavailable" : result.ok ? "ok" : "budget_exceeded";
  const ledgerUnknown = unknown || result.ledger_unknown_cost_count > 0;
  const out = {
    verdict,
    "spent-usd": unknown ? "" : usd(result.total_usd),
    "cap-usd": usd(caps.run),
    "day-spent-usd": ledgerUnknown ? "" : usd(result.spend?.day),
    "month-spent-usd": ledgerUnknown ? "" : usd(result.spend?.month),
    "unknown-receipts": String(result.unknown_cost_count),
    "receipts-count": String(result.receipt_count),
  };
  // Only run-scoped checks emit run-id, so ledger-wide output stays unchanged.
  if (result.run_id != null) out["run-id"] = String(result.run_id);
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

const cell = (v) => String(v === "" ? "unknown" : v).replace(/[|\r\n]/g, " ");

export function formatSummary(outputs) {
  const rows = OUTPUT_NAMES.filter((k) => k !== "run-id" || outputs[k] != null).map((k) => `| ${k} | ${cell(outputs[k])} |`).join("\n");
  const unknown = Number(outputs["unknown-receipts"]) > 0;
  return `## CostCap budget check: ${cell(outputs.verdict)}\n\n| Field | Value |\n| --- | --- |\n${rows}\n\n` +
    "Totals are estimates from receipts metered through the CostCap proxy, not provider invoices.\n" +
    (unknown ? `${outputs["unknown-receipts"]} receipt(s) have unknown cost, so spend is unknown (not $0). Reconcile before relying on this result.\n`
      : "No receipts have unknown cost.\n");
}

export function writeGithubOutputs(result, caps, env = process.env) {
  const outputs = checkOutputs(result, caps);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, formatOutputFile(outputs));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, formatSummary(outputs));
  return outputs;
}
