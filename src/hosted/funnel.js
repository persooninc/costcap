// Server-side GA4 funnel events (go-to-market#14, METRICS-EVENTS.md).
//
// sign_up, activation (first_receipt), begin_checkout and purchase go out through the
// GA4 Measurement Protocol. Nothing is sent unless both GA4_MEASUREMENT_ID (or
// GA_MEASUREMENT_ID) and GA4_API_SECRET are set, so tests, previews and local runs
// stay silent. No PII: the account is an opaque sha256(id)[:16] and only the
// allowlisted params below are forwarded. A send never throws and never blocks the
// request for long (2 s timeout).
import { createHash } from 'node:crypto';

export const PRODUCT = 'costcap';
const MP_URL = 'https://www.google-analytics.com/mp/collect';
const EVENTS = new Set(['sign_up', 'activation', 'begin_checkout', 'purchase']);
const PARAMS = new Set(['product', 'method', 'account_id', 'activation_kind', 'plan', 'currency', 'value', 'transaction_id']);
const ONCE = new Set(['sign_up', 'activation']);
const sent = new Set();

/** Opaque, non-reversible account id: sha256(internal id) first 16 hex chars. */
export function accountId(id) {
  return createHash('sha256').update(String(id ?? '').trim().toLowerCase()).digest('hex').slice(0, 16);
}

export function funnelConfig(env = process.env) {
  const measurementId = String(env.GA4_MEASUREMENT_ID || env.GA_MEASUREMENT_ID || '').trim();
  const apiSecret = String(env.GA4_API_SECRET || '').trim();
  if (!/^G-[A-Z0-9]{4,}$/.test(measurementId) || !apiSecret) return null;
  return { measurementId, apiSecret };
}

/** The Measurement Protocol body, or null for an unknown event. Drops non-allowlisted params. */
export function buildEvent(name, params = {}) {
  if (!EVENTS.has(name)) return null;
  const clean = { product: PRODUCT };
  for (const [k, v] of Object.entries(params)) {
    if (!PARAMS.has(k) || v === undefined || v === null || v === '') continue;
    clean[k] = typeof v === 'number' ? v : String(v).slice(0, 100);
  }
  const clientId = clean.account_id || 'server';
  return { client_id: `${clientId}.0`, non_personalized_ads: true, events: [{ name, params: clean }] };
}

/**
 * Send one funnel event. Resolves { sent, reason? }; never rejects.
 * `claim`/`release` (optional, once-events only) make the dedupe durable (#175):
 * claim() resolves true to send, false when another instance already sent it,
 * null when there is no durable store (memory dedupe only). A failed send
 * (network or non-2xx) calls release() so a later call can retry.
 */
export async function trackFunnel(name, params = {}, { env = process.env, fetchImpl = globalThis.fetch, claim = null, release = null } = {}) {
  const body = buildEvent(name, params);
  if (!body) return { sent: false, reason: 'unknown_event' };
  const config = funnelConfig(env);
  if (!config) return { sent: false, reason: 'not_configured' };
  const key = ONCE.has(name) ? `${name}:${body.events[0].params.account_id ?? ''}` : null;
  if (key && sent.has(key)) return { sent: false, reason: 'duplicate' };
  if (key) sent.add(key);
  let claimed = false;
  if (key && claim) {
    let won;
    try {
      won = await claim();
    } catch {
      sent.delete(key);
      return { sent: false, reason: 'claim_failed' };
    }
    if (won === false) return { sent: false, reason: 'duplicate' };
    claimed = won === true;
  }
  const releaseClaim = async () => {
    if (!claimed || !release) return;
    try { await release(); } catch { /* best-effort; the claim stays */ }
  };
  const url = `${MP_URL}?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    if (res?.ok) return { sent: true };
    await releaseClaim();
    if (key) sent.delete(key);
    return { sent: false, reason: `http_${res?.status}` };
  } catch {
    await releaseClaim();
    if (key) sent.delete(key);
    return { sent: false, reason: 'network' };
  }
}

/** purchase params from a verified checkout.session.completed object. */
export function purchaseParams(session, plan) {
  return {
    account_id: accountId(session?.client_reference_id || session?.metadata?.email || session?.customer || ''),
    plan,
    currency: String(session?.currency || 'usd').toUpperCase(),
    value: Number.isFinite(session?.amount_total) ? session.amount_total / 100 : undefined,
    transaction_id: session?.id,
  };
}

export function resetFunnelForTests() {
  sent.clear();
}
