// #184: opt-in local response cache for deterministic requests (`costcap wrap --cache TTL`).
// Only POST, non-streaming, temperature-0 generations (and embeddings) are eligible.
// Entries hold only the response (status, content-type, body), model, original cost,
// source receipt id and a timestamp: never request bodies, headers or key material.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CACHE_HEADER = "x-costcap-cache";
export const MAX_TTL_MS = 7 * 86_400_000;
export const DEFAULT_CACHE_MAX_MB = 256;
const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s" | "10m" | "24h" | "7d" -> milliseconds. At most 7d. Throws on anything else. */
export function parseTtl(v) {
  const m = /^([1-9]\d*)([smhd])$/.exec(String(v ?? ""));
  if (!m) throw new Error(`--cache must be a TTL like 30s, 10m, 24h or 7d, got "${v}"`);
  const ms = Number(m[1]) * UNITS[m[2]];
  if (ms > MAX_TTL_MS) throw new Error(`--cache TTL must be at most 7d, got "${v}"`);
  return ms;
}

const KEY_HEADERS = ["anthropic-version", "anthropic-beta", "openai-organization", "openai-project"];
const AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key"];
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** SHA-256 over provider, upstream base, method, path+query, exact body bytes, version headers and an auth identity hash. */
export function cacheKey({ provider, upstream, method, path, body, headers = {} }) {
  const h = (k) => { const v = headers[k]; return Array.isArray(v) ? v.join(",") : (v ?? ""); };
  let queryKey = "";
  try { queryKey = new URL(path, "http://x").searchParams.get("key") ?? ""; } catch { /* path is relative */ }
  const auth = sha(JSON.stringify([...AUTH_HEADERS.map(h), queryKey]));
  const hash = createHash("sha256");
  hash.update(JSON.stringify([provider, upstream, method, path, ...KEY_HEADERS.map(h), auth]));
  hash.update("\n");
  hash.update(body ?? Buffer.alloc(0));
  return hash.digest("hex");
}

/**
 * True when a request may be served from / stored in the cache.
 * opts: { embeddings, countTokens, files, batch } flags computed by the proxy.
 */
export function isCacheable(provider, method, rawUrl, parsedBody, { embeddings = false, countTokens = false, files = false, batch = false } = {}) {
  if (method !== "POST" || countTokens || files || batch) return false;
  const url = String(rawUrl ?? "");
  const [pathname, query = ""] = url.split("?", 2);
  if (/:streamGenerateContent/.test(pathname) || /(?:^|&)alt=sse(?:&|$)/.test(query)) return false;
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) return false;
  if (parsedBody.stream === true) return false;
  if (typeof parsedBody.n === "number" && parsedBody.n > 1) return false;
  if (embeddings) return true;
  const temperature = provider === "gemini" ? parsedBody.generationConfig?.temperature : parsedBody.temperature;
  return temperature === 0;
}

export function createResponseCache({ dir, ttlMs, maxBytes = DEFAULT_CACHE_MAX_MB * 1024 * 1024, now = () => Date.now() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = (key) => join(dir, `${key}.json`);
  const entries = () => {
    let names;
    try { names = readdirSync(dir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)); } catch { return []; }
    const out = [];
    for (const n of names) {
      try { const st = statSync(join(dir, n)); out.push({ path: join(dir, n), size: st.size, used: st.mtimeMs }); } catch { /* raced */ }
    }
    return out;
  };
  return {
    dir, ttlMs, maxBytes,
    get(key) {
      let e;
      try { e = JSON.parse(readFileSync(file(key), "utf8")); } catch { return null; }
      if (!e || typeof e.stored_at !== "number" || now() - e.stored_at > ttlMs || typeof e.cost_usd !== "number") {
        try { unlinkSync(file(key)); } catch { /* already gone */ }
        return null;
      }
      // LRU: mtime is the last-used time.
      try { const t = new Date(now()); utimesSync(file(key), t, t); } catch { /* best effort */ }
      return { status: e.status, content_type: e.content_type, body: Buffer.from(e.body_b64, "base64"), model: e.model, cost_usd: e.cost_usd, receipt_id: e.receipt_id, stored_at: e.stored_at };
    },
    put(key, { status, contentType, body, model, cost_usd, receipt_id }) {
      const data = JSON.stringify({ status, content_type: contentType, body_b64: Buffer.from(body).toString("base64"), model, cost_usd, receipt_id, stored_at: now() });
      const size = Buffer.byteLength(data);
      if (size > maxBytes / 10) return false;
      const list = entries().filter((e) => e.path !== file(key)).sort((a, b) => a.used - b.used);
      let total = list.reduce((n, e) => n + e.size, 0);
      while (list.length && total + size > maxBytes) {
        const victim = list.shift();
        try { unlinkSync(victim.path); } catch { /* raced */ }
        total -= victim.size;
      }
      const tmp = join(dir, `.tmp-${randomUUID()}`);
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, file(key));
      const t = new Date(now());
      try { utimesSync(file(key), t, t); } catch { /* best effort */ }
      return true;
    },
  };
}
