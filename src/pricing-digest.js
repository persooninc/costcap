// Canonical SHA-256 digest of a pricing table (#122). Pure, dependency-free, portable.
// Canonical form: JSON with object keys sorted recursively and no whitespace, so
// reformatting the file does not change the digest but editing any value does.

import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function tableDigest(table) {
  return createHash("sha256").update(canonicalize(table)).digest("hex");
}

export function digestPathFor(tablePath) {
  return tablePath.replace(/\.json$/, "") + ".sha256.json";
}

// Compare a table against its recorded { version, sha256 } sidecar.
export function verifyTableDigest(table, recorded) {
  const actual = tableDigest(table);
  if (!recorded || typeof recorded.sha256 !== "string") return { ok: false, actual, expected: null, reason: "digest_missing" };
  if (recorded.sha256 !== actual) return { ok: false, actual, expected: recorded.sha256, reason: "digest_mismatch" };
  if (recorded.version !== table.version) return { ok: false, actual, expected: recorded.sha256, reason: "version_mismatch" };
  return { ok: true, actual, expected: recorded.sha256, version: table.version };
}

// Group receipts by their table_sha256 against the installed digest.
// Receipts without a digest are "unknown", never counted as matching.
// #189: user_prices receipts count in their own bucket; with pricesSha256 each must match it.
export function auditReceipts(receipts, installedSha256, pricesSha256) {
  const out = { total: 0, matching: 0, unknown: 0, different: 0, user_prices: 0, prices_mismatched: 0, by_digest: {}, mismatched: [] };
  receipts.forEach((r, i) => {
    if (!r || (r.table_version === undefined && r.table_sha256 === undefined && typeof r.cost_usd !== "number")) return; // priced receipts only
    out.total += 1;
    if (r.cost_source === "user_prices") {
      out.user_prices += 1;
      if (pricesSha256 !== undefined && r.prices_sha256 !== pricesSha256) {
        out.prices_mismatched += 1;
        out.mismatched.push({ line: i + 1, prices_version: r.prices_version ?? null, prices_sha256: r.prices_sha256 ?? null, status: "prices_different" });
      }
      return;
    }
    const d = r.table_sha256;
    if (typeof d !== "string" || !d) { out.unknown += 1; out.mismatched.push({ line: i + 1, table_version: r.table_version ?? null, table_sha256: null, status: "unknown" }); return; }
    if (d === installedSha256) { out.matching += 1; return; }
    out.different += 1;
    out.by_digest[d] = (out.by_digest[d] ?? 0) + 1;
    out.mismatched.push({ line: i + 1, table_version: r.table_version ?? null, table_sha256: d, status: "different" });
  });
  out.ok = out.unknown === 0 && out.different === 0 && out.prices_mismatched === 0;
  return out;
}
