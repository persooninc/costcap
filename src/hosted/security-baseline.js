// Security baseline for the hosted app (persooninc/go-to-market#17).
// Default headers go on every response through res.setHeader, so a route that
// passes its own value to writeHead (for example a stricter page CSP) wins.
// GET/HEAD /.well-known/security.txt is answered before any auth or routing.
export const HSTS = "max-age=63072000; includeSubDomains";
export const BASELINE_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";
export const SECURITY_CONTACT = "mailto:r@persooninc.com";
const YEAR_MS = 365 * 86_400_000;

export function baselineHeaders({ hsts = HSTS } = {}) {
  return {
    ...(hsts ? { "strict-transport-security": hsts } : {}),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": BASELINE_CSP,
  };
}

// RFC 9116: Contact + Expires required; Expires should be under a year out.
// It is computed from the clock and rounded to the day, so it never goes stale.
export function securityTxt(canonicalOrigin, nowMs = Date.now()) {
  const expires = new Date(Math.floor((nowMs + YEAR_MS - 86_400_000) / 86_400_000) * 86_400_000).toISOString();
  return [
    `Contact: ${SECURITY_CONTACT}`,
    `Expires: ${expires}`,
    "Preferred-Languages: en",
    `Canonical: ${canonicalOrigin.replace(/\/$/, "")}/.well-known/security.txt`,
    "",
  ].join("\n");
}

// Returns true when it fully answered the request.
// Pass hsts: false (or another value) when the process is not behind HTTPS.
export function applySecurityBaseline(req, res, { canonicalOrigin, now = Date.now, hsts = HSTS } = {}) {
  for (const [k, v] of Object.entries(baselineHeaders({ hsts }))) res.setHeader(k, v);
  let path = "/";
  try { path = new URL(req.url ?? "/", "http://x").pathname; } catch { /* keep "/" */ }
  if (path !== "/.well-known/security.txt" || !["GET", "HEAD"].includes(req.method)) return false;
  const body = securityTxt(canonicalOrigin, now());
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
