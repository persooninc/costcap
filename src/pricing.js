// Versioned model pricing with a declared fallback rate.
// Unknown models bill at the fallback, flagged and never free.
// The fallback is a floor for unknown models, not the highest published rate.
// The table version is returned with every lookup so receipts can pin it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tablePath = fileURLToPath(new URL("./pricing-table.json", import.meta.url));
const table = JSON.parse(readFileSync(tablePath, "utf8"));

export const TABLE_VERSION = table.version;

export function lookupPrice(model) {
  // OpenAI returns dated snapshot ids (gpt-4o-mini-2024-07-18); price them as their base model.
  const base = typeof model === "string" ? model.replace(/-\d{4}-\d{2}-\d{2}$/, "") : model;
  const entry = table.models[model] ?? table.models[base];
  if (entry) return { model, ...entry, table_version: table.version, fallback: false };
  return { model, ...table.fallback, table_version: table.version, fallback: true };
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
    fallback: price.fallback,
  };
}
