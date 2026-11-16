// Issue #130: the one path format every receipt stores (success, blocked, unknown outcome).
// Path plus query, with credential-like query parameters redacted. Upstream forwarding
// still uses the original URL; only what is persisted goes through this helper.
export const CREDENTIAL_PARAMS = Object.freeze(["key", "api_key", "apikey", "access_token", "token", "sig", "signature", "api-key"]);
export const REDACTED = "REDACTED";
const isCredential = (name) => CREDENTIAL_PARAMS.includes(name.toLowerCase());

export function redactQuery(search) {
  if (!search || search === "?") return "";
  const parts = search.replace(/^\?/, "").split("&").map((part) => {
    const eq = part.indexOf("=");
    const raw = eq < 0 ? part : part.slice(0, eq);
    let name = raw;
    try { name = decodeURIComponent(raw.replace(/\+/g, " ")); } catch { /* keep raw */ }
    return isCredential(name) ? `${raw}=${REDACTED}` : part;
  });
  return `?${parts.join("&")}`;
}

export function receiptPath(pathname, search = "") {
  return `${pathname}${redactQuery(search)}`;
}

// Backstop for stored or uploaded receipts: redact any credential parameter in a path string.
export function scrubReceiptPath(path) {
  if (typeof path !== "string") return path;
  const q = path.indexOf("?");
  return q < 0 ? path : receiptPath(path.slice(0, q), path.slice(q));
}
