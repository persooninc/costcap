// Issue #184: opt-in local response cache for deterministic requests.
// Pure keying/eligibility helpers plus a small disk store (dir 0700, entries 0600,
// temp file + rename, LRU eviction by size). Entries never hold request bodies,
// headers or key material: only status, content-type, body, model, cost and source id.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CACHE_HEADER = "x-costcap-cache";
export const MAX_TTL_MS = 7 * 86_400_000;
export const DEFAULT_MAX_MB = 256;
const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const KEY_HEADERS = ["anthropic-version", "anthropic-beta", "openai-organization", "openai-project"];
const AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key"];

/** "30s" | "10m" | "24h" | "7d" -> ms. Throws on anything else or above 7d. */
export function parseTtl(v) {
  const m = /^(\d+)([smhd])$/.exec(String(v ?? ""));
  const ms = m ? Number(m[1]) * UNITS[m[2]] : NaN;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`--cache must be a duration like 30s, 10m, 24h or 7d, got "${v}"`);
  if (ms > MAX_TTL_MS) throw new Error(`--cache must be at most 7d, got "${v}"`);
  return ms;
}

const isEmbeddings = (path) => /\/embeddings(\?|$)|:(batchE|e)mbedContents?(\?|$)/.test(path);

/**
 * Is this request eligible? Returns true only for POST, non-streaming, temperature 0
 * generation (or embeddings). Streams, batches, files, count-tokens and n>1 are not.
 */
export function isCacheable({ method, path, body }) {
  if (method !== "POST") return false;
  if (/:streamGenerateContent|[?&]alt=sse/.test(path)) return false;
  if (/\/batches|\/files|count_tokens|:countTokens|:batchGenerateContent/.test(path)) return false;
  let b;
  try { b = JSON.parse(body.toString("utf8")); } catch { return false; }
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  if (b.stream === true) return false;
  if (b.n != null && b.n !== 1) return false;
  if (isEmbeddings(path)) return true;
  const t = b.generationConfig?.temperature ?? b.temperature;
  return t === 0;
}

/** Streams are bypassed outright (never looked up, never stored). */
export function isStreamRequest({ path, body }) {
  if (/:streamGenerateContent|[?&]alt=sse/.test(path)) return true;
  try { return JSON.parse(body.toString("utf8"))?.stream === true; } catch { return false; }
}

const sha = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) { const buf = Buffer.isBuffer(p) ? p : Buffer.from(String(p ?? "")); h.update(String(buf.length)); h.update(":"); h.update(buf); }
  return h.digest("hex");
};

/** SHA-256 cache key. `path` includes the query (Gemini ?key= included). */
export function cacheKey({ provider, upstream, method, path, body, headers = {} }) {
  const q = new URL(path, "http://x").searchParams;
  const auth = sha(...AUTH_HEADERS.map((h) => headers[h] ?? ""), q.get("key") ?? "");
  return sha(provider, upstream, method, path, body, ...KEY_HEADERS.map((h) => headers[h] ?? ""), auth);
}

/** Disk store. now() injectable for TTL tests. */
export function createResponseCache({ dir, ttlMs, maxMb = DEFAULT_MAX_MB, now = () => Date.now() }) {
  if (!dir) throw new Error("response cache needs a dir");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const maxBytes = Math.round(maxMb * 1024 * 1024);
  const file = (key) => join(dir, `${key}.json`);
  const stats = { hits: 0, misses: 0, saved_usd: 0 };
  const entries = () => {
    let names = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
    return names.flatMap((n) => { try { const s = statSync(join(dir, n)); return [{ path: join(dir, n), size: s.size, atime: s.mtimeMs }]; } catch { return []; } });
  };
  return {
    dir, ttlMs, maxBytes, stats,
    get(key) {
      let e;
      try { e = JSON.parse(readFileSync(file(key), "utf8")); } catch { return null; }
      if (!e || typeof e.stored_at !== "number" || now() - e.stored_at >= ttlMs) {
        try { unlinkSync(file(key)); } catch { /* already gone */ }
        return null;
      }
      // LRU: mtime marks last use.
      try { const t = new Date(now()); utimesSync(file(key), t, t); } catch { /* best effort */ }
      return { ...e, body: Buffer.from(e.body_b64, "base64") };
    },
    /** Stores an entry; returns false when too large (> 1/10 of the cap). */
    set(key, { status, contentType, body, model, cost_usd, receipt_id }) {
      const data = JSON.stringify({ status, content_type: contentType, body_b64: Buffer.from(body).toString("base64"), model, cost_usd, receipt_id, stored_at: now() });
      const size = Buffer.byteLength(data);
      if (size > maxBytes / 10) return false;
      const list = entries().filter((e) => e.path !== file(key)).sort((a, b) => a.atime - b.atime);
      let total = list.reduce((n, e) => n + e.size, 0);
      while (list.length && total + size > maxBytes) {
        const victim = list.shift();
        try { unlinkSync(victim.path); } catch { /* raced */ }
        total -= victim.size;
      }
      const tmp = join(dir, `.${randomUUID()}.tmp`);
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, file(key));
      const t = new Date(now());
      try { utimesSync(file(key), t, t); } catch { /* best effort */ }
      return true;
    },
    hit(saved) { stats.hits += 1; stats.saved_usd = Number((stats.saved_usd + saved).toFixed(6)); },
    miss() { stats.misses += 1; },
  };
}
