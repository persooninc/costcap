#!/usr/bin/env node
// #278: regenerates the pricing table's `bedrock_models` section from the public AWS Price List
// bulk JSON (no credentials). On-demand standard text rates only: batch, flex, priority,
// latency-optimized, cross-region and mantle SKUs are skipped. Rates are USD per 1M tokens.
// Usage: node scripts/bedrock-prices.mjs [--from DIR] [--write]
//   --from DIR  read DIR/<region>.json instead of fetching (offline / reproducible)
//   --write     update src/pricing-table.json (then run scripts/pricing-digest.mjs --write)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REGIONS = ["us-east-1", "us-west-2", "eu-west-1"];
export const offerUrl = (r) => `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/${r}/index.json`;

// Bedrock model id -> Price List usagetype stem (after the region prefix, before -input-tokens).
export const MODELS = {
  "amazon.nova-micro-v1:0": "NovaMicro",
  "amazon.nova-lite-v1:0": "NovaLite",
  "amazon.nova-pro-v1:0": "NovaPro",
  "amazon.nova-premier-v1:0": "NovaPremier",
  "amazon.nova-2-lite-v1:0": "Nova2.0Lite",
  "meta.llama3-8b-instruct-v1:0": "Llama3-8B",
  "meta.llama3-70b-instruct-v1:0": "Llama3-70B",
  "meta.llama3-1-8b-instruct-v1:0": "Llama3-1-8B",
  "meta.llama3-1-70b-instruct-v1:0": "Llama3-1-70B",
  "meta.llama3-2-1b-instruct-v1:0": "Llama3-2-1B",
  "meta.llama3-2-3b-instruct-v1:0": "Llama3-2-3B",
  "meta.llama3-2-11b-instruct-v1:0": "Llama3-2-11B",
  "meta.llama3-2-90b-instruct-v1:0": "Llama3-2-90B",
  "meta.llama3-3-70b-instruct-v1:0": "Llama3-3-70B",
  "meta.llama4-scout-17b-instruct-v1:0": "Llama4-Scout-17B",
  "meta.llama4-maverick-17b-instruct-v1:0": "Llama4-Maverick-17B",
  "mistral.mistral-7b-instruct-v0:2": "Mistral7B",
  "mistral.mistral-small-2402-v1:0": "MistralSmall",
  "mistral.mistral-large-2402-v1:0": "MistralLarge",
  "deepseek.r1-v1:0": "DeepSeek-R1",
  "openai.gpt-oss-20b-1:0": "gpt-oss-20b",
  "openai.gpt-oss-120b-1:0": "gpt-oss-120b",
  "qwen.qwen3-32b-v1:0": "Qwen3-32B",
  "qwen.qwen3-coder-30b-a3b-v1:0": "Qwen3Coder-30B-A3B",
};

const COMPONENTS = { input: "input-tokens", output: "output-tokens", cached_input: "cache-read-input-token-count", cache_write: "cache-write-input-token-count" };
// AWS publishes Nova cache writes at an explicit $0; only that published zero is kept (never an inferred one).
const ZERO_OK = new Set(["cache_write"]);

/** Rows for one region's offer file: {modelId: {input, output, cached_input?}} (USD / 1M tokens). */
export function regionRows(offer) {
  const byUsage = new Map();
  for (const [sku, p] of Object.entries(offer.products)) {
    const u = p.attributes?.usagetype;
    if (!u) continue;
    for (const term of Object.values(offer.terms?.OnDemand?.[sku] ?? {})) {
      for (const d of Object.values(term.priceDimensions)) {
        if (!/^1k tokens$/i.test(d.unit)) continue;
        byUsage.set(u.replace(/^[A-Z0-9]+-/, ""), Number(d.pricePerUnit.USD));
      }
    }
  }
  const out = {};
  for (const [id, stem] of Object.entries(MODELS)) {
    const row = {};
    for (const [k, suffix] of Object.entries(COMPONENTS)) {
      const v = byUsage.get(`${stem}-${suffix}`);
      if (Number.isFinite(v) && (v > 0 || (v === 0 && ZERO_OK.has(k)))) row[k] = Number((v * 1000).toFixed(6));
    }
    if (row.input && row.output) out[id] = row;
  }
  return out;
}

export function buildSection(offers, retrieved) {
  const models = {};
  for (const [region, offer] of Object.entries(offers)) {
    for (const [id, row] of Object.entries(regionRows(offer))) (models[id] ??= {})[region] = row;
  }
  const sorted = Object.fromEntries(Object.keys(models).sort().map((id) => [id, models[id]]));
  return {
    unit: "usd_per_1m_tokens", tier: "on_demand_standard",
    sources: Object.keys(offers).map((r) => ({ region: r, url: offerUrl(r), retrieved, publication_date: offers[r].publicationDate ?? null })),
    models: sorted,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : null;
  const offers = {};
  for (const r of REGIONS) offers[r] = from ? JSON.parse(readFileSync(`${from}/${r}.json`, "utf8")) : await (await fetch(offerUrl(r))).json();
  const section = buildSection(offers, new Date().toISOString().slice(0, 10));
  if (args.includes("--write")) {
    const path = fileURLToPath(new URL("../src/pricing-table.json", import.meta.url));
    const t = JSON.parse(readFileSync(path, "utf8"));
    t.bedrock_models = section;
    writeFileSync(path, JSON.stringify(t, null, 2) + "\n");
  } else console.log(JSON.stringify(section, null, 2));
}
