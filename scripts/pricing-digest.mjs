#!/usr/bin/env node
// Regenerate or check the committed digest sidecar for src/pricing-table.json (#122).
//   node scripts/pricing-digest.mjs           write src/pricing-table.sha256.json
//   node scripts/pricing-digest.mjs --check   exit 1 if the sidecar is stale (CI guard)
// Writing refuses when rates changed but "version" did not: bump the version first.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { digestPathFor, tableDigest, verifyTableDigest } from "../src/pricing-digest.js";

export function run(args, tablePath = fileURLToPath(new URL("../src/pricing-table.json", import.meta.url))) {
  const table = JSON.parse(readFileSync(tablePath, "utf8"));
  const sidecar = digestPathFor(tablePath);
  let recorded = null;
  try { recorded = JSON.parse(readFileSync(sidecar, "utf8")); } catch { recorded = null; }
  const v = verifyTableDigest(table, recorded);
  if (args.includes("--check")) {
    if (v.ok) return { code: 0, message: `pricing table ${table.version} sha256 ${v.actual} OK` };
    return { code: 1, message: `pricing table digest stale (${v.reason}): sha256 ${v.actual}, recorded ${v.expected ?? "none"}. Bump "version" and run node scripts/pricing-digest.mjs` };
  }
  if (v.ok) return { code: 0, message: `pricing table ${table.version} already up to date` };
  if (recorded && recorded.sha256 !== v.actual && recorded.version === table.version) {
    return { code: 1, message: `pricing table changed but version is still ${table.version}; bump "version" before regenerating the digest` };
  }
  writeFileSync(sidecar, JSON.stringify({ version: table.version, sha256: tableDigest(table) }, null, 2) + "\n");
  return { code: 0, message: `wrote ${sidecar}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, message } = run(process.argv.slice(2));
  (code ? console.error : console.log)(message);
  process.exitCode = code;
}
