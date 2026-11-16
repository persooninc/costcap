// #192: request/token rate limits (RPM/TPM) over a rolling 60 s window.
// Pure, in-process, injected clock. Refuses with a retry hint; never queues and never latches.
// RPM counts requests admitted to the upstream (a slot is reserved before forwarding).
// TPM adds metered tokens when a call completes and is checked before each call,
// so one in-flight call can overshoot it.

export const RATE_WINDOW_MS = 60_000;
export const RATE_KEYS = Object.freeze(["rpm", "tpm"]);

export const isRateLimit = (v) => Number.isInteger(v) && v > 0;

// Sum of the token fields a receipt's usage meters (unknown/missing fields add 0).
export function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  let n = 0;
  for (const k of ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "cache_write_1h_input_tokens", "output_tokens"]) {
    const v = usage[k];
    if (Number.isFinite(v) && v > 0) n += v;
  }
  return n;
}

// Minimum of the given limits, ignoring null/undefined. null when none applies.
export function minLimit(...values) {
  const vals = values.filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
}

export function createRateLimiter({ rpm = null, tpm = null, now = () => Date.now() } = {}) {
  let limits = { rpm, tpm };
  const requests = []; // admission timestamps (ms), oldest first
  const tokens = []; // [ts, n], oldest first
  const evict = (t) => {
    while (requests.length && t - requests[0] >= RATE_WINDOW_MS) requests.shift();
    while (tokens.length && t - tokens[0][0] >= RATE_WINDOW_MS) tokens.shift();
  };
  const secondsUntil = (t, ts) => Math.max(1, Math.ceil((ts + RATE_WINDOW_MS - t) / 1000));
  return {
    limits: () => ({ ...limits }),
    setLimits(next = {}) { limits = { rpm: next.rpm ?? null, tpm: next.tpm ?? null }; },
    // null when the next call may proceed, else the refusal detail.
    check() {
      const t = now();
      evict(t);
      if (limits.rpm != null && requests.length >= limits.rpm) {
        // The slot frees when enough admissions age out to drop below the limit.
        const ts = requests[requests.length - limits.rpm];
        return { limit: "rpm", limit_value: limits.rpm, observed: requests.length, retry_after_s: secondsUntil(t, ts) };
      }
      if (limits.tpm != null) {
        let sum = tokens.reduce((s, [, n]) => s + n, 0);
        if (sum >= limits.tpm) {
          const observed = sum;
          let i = 0;
          while (sum >= limits.tpm) sum -= tokens[i++][1];
          return { limit: "tpm", limit_value: limits.tpm, observed, retry_after_s: secondsUntil(t, tokens[i - 1][0]) };
        }
      }
      return null;
    },
    // Reserve an RPM slot for a request about to be forwarded.
    admit() { requests.push(now()); },
    // Metered tokens of a completed call.
    record(n) { if (n > 0) tokens.push([now(), n]); },
  };
}

export function rateLimitedBody(hit) {
  return { error: { type: "rate_limited", source: "costcap", limit: hit.limit, limit_value: hit.limit_value, observed: hit.observed, window_s: 60, retry_after_s: hit.retry_after_s,
    message: `CostCap: ${hit.limit === "rpm" ? "requests" : "tokens"} per minute limit ${hit.limit_value} reached (${hit.observed} in the last 60 s). Retry after ${hit.retry_after_s} s. The upstream call was not made.` } };
}
