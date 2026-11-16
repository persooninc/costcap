// Custom OpenAI-compatible upstreams (#186): `wrap --upstream NAME=URL[,env=VAR][,insecure]`.
// Traffic to /u/<NAME>/<rest> is forwarded to URL/<rest> and metered as the OpenAI shape.
// Fail-safe pricing: a custom upstream never prices from the shipped table or the fallback
// rate. Rates come only from --upstream-prices FILE; anything else is unknown (cost_usd null).
import { readFileSync } from "node:fs";
import { tableDigest } from "./pricing-digest.js";
import { OVERRIDE_PROVIDERS, validateBuiltinPrices, validateToolPrices } from "./price-overrides.js";

export const BUILTIN_PROVIDERS = Object.freeze(["openai", "anthropic", "openrouter", "gemini", "bedrock", "vertex"]);
export const BUILTIN_ENV_VARS = Object.freeze(["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL"]);
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export const CUSTOM_PREFIX = "u/";
export const isCustomProvider = (provider) => typeof provider === "string" && provider.startsWith(CUSTOM_PREFIX);

/** Parses one --upstream value. Throws on anything invalid (wrap exits 2 before spawning). */
export function parseUpstreamFlag(value) {
  const [spec, ...opts] = String(value).split(",");
  const eq = spec.indexOf("=");
  if (eq < 1) throw new Error(`--upstream must be NAME=URL, got "${value}"`);
  const name = spec.slice(0, eq);
  const rawUrl = spec.slice(eq + 1);
  if (!NAME.test(name)) throw new Error(`--upstream name "${name}" must match [a-z0-9][a-z0-9-]{0,31}`);
  if (BUILTIN_PROVIDERS.includes(name)) throw new Error(`--upstream name "${name}" is a built-in provider`);
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error(`--upstream ${name}: "${rawUrl}" is not a URL`); }
  let env, insecure = false;
  for (const o of opts) {
    if (o === "insecure") insecure = true;
    else if (o.startsWith("env=")) {
      env = o.slice(4);
      if (!ENV_NAME.test(env)) throw new Error(`--upstream ${name}: env name "${env}" must match [A-Z_][A-Z0-9_]*`);
    } else throw new Error(`--upstream ${name}: unknown option "${o}"`);
  }
  if (url.search || url.hash || url.username || url.password) throw new Error(`--upstream ${name}: URL must not carry credentials, a query or a fragment`);
  if (url.protocol === "http:") {
    if (!LOOPBACK.has(url.hostname) && !insecure) throw new Error(`--upstream ${name}: plain http is only allowed for loopback hosts; add ,insecure to allow ${url.host}`);
  } else if (url.protocol !== "https:") throw new Error(`--upstream ${name}: URL must be https`);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return { name, url: base, ...(env && { env }), insecure: insecure && url.protocol === "http:" && !LOOPBACK.has(url.hostname) };
}

/** Parses every --upstream value; rejects duplicate names. */
export function parseUpstreams(values = []) {
  const out = [];
  for (const v of values) {
    const u = parseUpstreamFlag(v);
    if (out.some((o) => o.name === u.name)) throw new Error(`--upstream name "${u.name}" is given more than once`);
    out.push(u);
  }
  return out;
}

export const envKeyFor = (name) => `COSTCAP_UPSTREAM_${name.toUpperCase().replace(/-/g, "_")}_BASE_URL`;

/** Child env entries for custom upstreams, plus stderr notes for built-in vars overridden by env=. */
export function upstreamEnv(upstreams, port) {
  const env = {}, notes = [];
  for (const u of upstreams) {
    const local = `http://127.0.0.1:${port}/u/${u.name}`;
    env[envKeyFor(u.name)] = local;
    if (u.env) {
      env[u.env] = local;
      if (BUILTIN_ENV_VARS.includes(u.env)) notes.push(`costcap: ${u.env} points at custom upstream "${u.name}" (overrides the built-in route)`);
    }
  }
  return { env, notes };
}

const rateOk = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Loads and validates an --upstream-prices file against the declared upstream names. */
export function loadUpstreamPrices(path, names) {
  let doc;
  try { doc = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`--upstream-prices ${path}: ${e.code ?? "invalid JSON"}`); }
  // #214: a file may carry only a top-level `tools` map (per-call tool rates); upstreams then defaults to {}.
  if (doc && typeof doc === "object" && !Array.isArray(doc) && doc.tools !== undefined && doc.upstreams === undefined) doc = { ...doc, upstreams: {} };
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.upstreams || typeof doc.upstreams !== "object" || Array.isArray(doc.upstreams)) {
    throw new Error(`--upstream-prices ${path}: expected {version, upstreams: {NAME: {MODEL: {input, output, cached_input?}}}}`);
  }
  for (const [name, models] of Object.entries(doc.upstreams)) {
    // #189: built-in provider keys need no --upstream; they override or discount the table.
    if (OVERRIDE_PROVIDERS.includes(name)) { validateBuiltinPrices(path, name, models); continue; }
    if (!names.includes(name)) throw new Error(`--upstream-prices ${path}: upstream "${name}" is not declared with --upstream`);
    if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error(`--upstream-prices ${path}: upstreams.${name} must be an object of models`);
    for (const [model, r] of Object.entries(models)) {
      if (!r || typeof r !== "object" || !rateOk(r.input) || !rateOk(r.output) || (r.cached_input !== undefined && !rateOk(r.cached_input))) {
        throw new Error(`--upstream-prices ${path}: ${name}/${model} needs finite, non-negative input and output (and optional cached_input) USD per 1M tokens`);
      }
    }
  }
  if (doc.tools !== undefined) validateToolPrices(path, doc.tools);
  return { version: doc.version ?? null, sha256: tableDigest(doc), upstreams: doc.upstreams, ...(doc.tools !== undefined && { tools: doc.tools }) };
}

const SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|20\d{6})$/;

/** The user rate for a model on a custom provider ("u/<name>"), or null. Never the shipped table. */
export function userPrice(prices, provider, model) {
  if (!prices || !isCustomProvider(provider) || typeof model !== "string" || !model) return null;
  const table = prices.upstreams[provider.slice(CUSTOM_PREFIX.length)];
  if (!table) return null;
  for (const id of [model, model.replace(SNAPSHOT_SUFFIX, "")]) if (Object.hasOwn(table, id)) return table[id];
  return null;
}

/** Receipt fields for a metered custom-upstream response. Unpriced stays unknown, never $0. */
export function costForUserPrices(prices, provider, model, usage = {}) {
  const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0, modality_tokens, speed, service_tier } = usage;
  const rate = userPrice(prices, provider, model);
  const base = { model, input_tokens, output_tokens, cached_input_tokens, pricing_tier: "standard", fallback: false,
    ...(modality_tokens && { modality_tokens }), ...(typeof speed === "string" && { speed }), ...(typeof service_tier === "string" && { service_tier }) };
  const unpricedReason = !rate || (cached_input_tokens > 0 && rate.cached_input === undefined) ? "upstream_model_unpriced"
    : modality_tokens ? "modality_unpriced"
    : speed === "fast" || service_tier === "priority" ? "service_tier_unpriced" : null;
  if (unpricedReason) return { ...base, cost_usd: null, reason: unpricedReason };
  const cost = (input_tokens * rate.input + cached_input_tokens * (rate.cached_input ?? 0) + output_tokens * rate.output) / 1_000_000;
  return { ...base, cost_usd: Number(cost.toFixed(6)), cost_source: "user_prices", prices_version: prices.version, prices_sha256: prices.sha256 };
}
