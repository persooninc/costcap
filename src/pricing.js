// Versioned model pricing with a declared fallback rate.
// Unknown models bill at the fallback, flagged and never free.
// The fallback is a floor for unknown models, not the highest published rate.
// The table version and SHA-256 digest are returned with every lookup so receipts can pin them.
// The table is checked against its committed digest sidecar (#122); a tampered
// table is never priced from: lookups throw and `costcap wrap` refuses to start.
// COSTCAP_PRICING_TABLE overrides the table path (its sidecar sits next to it).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { digestPathFor, verifyTableDigest } from "./pricing-digest.js";

export const DEFAULT_TABLE_PATH = fileURLToPath(new URL("./pricing-table.json", import.meta.url));

export function loadPricingTable(tablePath = process.env.COSTCAP_PRICING_TABLE || DEFAULT_TABLE_PATH) {
  const table = JSON.parse(readFileSync(tablePath, "utf8"));
  let recorded = null;
  try { recorded = JSON.parse(readFileSync(digestPathFor(tablePath), "utf8")); } catch { recorded = null; }
  const verification = verifyTableDigest(table, recorded);
  return { table, tablePath, digestPath: digestPathFor(tablePath), verification };
}

const loaded = loadPricingTable();
const table = loaded.table;

export const TABLE_VERSION = table.version;
export const TABLE_SHA256 = loaded.verification.actual;
export const TABLE_PATH = loaded.tablePath;

export function tableIntegrity() { return loaded.verification; }

export function integrityError(v = loaded.verification, path = loaded.tablePath) {
  return `pricing table ${path} failed verification (${v.reason}): sha256 ${v.actual}, expected ${v.expected ?? "none"}. Refusing to price from an unverified table; run \`costcap pricing verify\`.`;
}

export function assertTableIntegrity() {
  if (!loaded.verification.ok) throw new Error(integrityError());
}

export function lookupPrice(model) {
  assertTableIntegrity();
  // OpenAI returns dated snapshot ids (gpt-4o-mini-2024-07-18); price them as their base model.
  const base = typeof model === "string" ? model.replace(/-\d{4}-\d{2}-\d{2}$/, "") : model;
  const entry = table.models[model] ?? table.models[base];
  const pin = { table_version: table.version, table_sha256: TABLE_SHA256 };
  if (entry) return { model, ...entry, ...pin, fallback: false };
  return { model, ...table.fallback, ...pin, fallback: true };
}

export function costForUsage(model, { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0, cache_write_1h_input_tokens = 0 } = {}) {
  const price = lookupPrice(model);
  // A cache write with no published rate is unpriced, not guessed at another rate.
  const unpriced = (cache_write_input_tokens > 0 && price.cache_write == null) || (cache_write_1h_input_tokens > 0 && price.cache_write_1h == null);
  const cost =
    (input_tokens * price.input +
      cached_input_tokens * price.cached_input +
      cache_write_input_tokens * (price.cache_write ?? 0) +
      cache_write_1h_input_tokens * (price.cache_write_1h ?? 0) +
      output_tokens * price.output) / 1_000_000;
  return {
    model,
    cost_usd: unpriced ? null : Number(cost.toFixed(6)),
    ...(unpriced ? { reason: "cache_write_unpriced" } : {}),
    input_tokens,
    output_tokens,
    cached_input_tokens,
    cache_write_input_tokens,
    cache_write_1h_input_tokens,
    table_version: price.table_version,
    table_sha256: price.table_sha256,
    fallback: price.fallback,
  };
}
