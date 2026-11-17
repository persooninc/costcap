#!/usr/bin/env node
// costcap CLI. `costcap wrap [--cap USD] [--hour-cap USD] [--day-cap USD] [--week-cap USD] [--month-cap USD] [--receipts FILE] -- <command...>`
// starts the local metering proxy with a hard spend cap, points the wrapped
// process's provider base URLs at it, and exits with the child's exit code.
// Guardrails, not guarantees: only traffic through the proxy is metered.

import { reconcileFiles, applyReconciliation } from "./reconcile.js";
import { billCheckCommand } from "./bill-check.js";
import { serveMcp } from "./mcp.js";
import { parseTagList } from "./tags.js";
import { createTagCaps, parseTagCaps, withFleetTagCaps } from "./tag-cap.js";
import { createModelCaps, parseModelCaps, mergeModelCapRules } from "./model-cap.js";
import { fleetModelRules, withFleetModelCaps } from "./hosted/model-caps.js";
import { enroll, createFleetClient, requestRaise } from "./hosted/client.js";
import { resolvePolicy } from "./hosted/policy.js";
import { lockLedger, openSharedLedger } from "./ledger-lock.js";
import { spawn } from "node:child_process";
import { startMeteringProxy, baseUrlOverrides } from "./proxy.js";
import { createCapEngine, loadSettledReceipts, loadEvents } from "./cap.js";
import { createSettler } from "./settle.js";
import { DEFAULT_WARN_AT, createCapWarner, parseWarnAt } from "./cap-warn.js";
import { createVelocityBreaker } from "./velocity.js";
import { createRateLimiter, minLimit } from "./rate-limit.js";
import { assertAgentPolicy, createAgentBudgets, intersectModels, isMaxConcurrent, MAX_CONCURRENT_LIMIT } from "./agent-budget.js";
import { guardedAgentStatus, guardedBudgetStatus } from "./check.js";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { buildRunSummary, rollupLine, runsCommand, writeRunSummary, runEndRecord } from "./run-summary.js";
import { createKillCheck, hostKillFile, kill, killStatus, recordKillEvent, resume, DEFAULT_KILL_FILE } from "./kill.js";
import { VERSION } from "./version.js";
import { writeGithubOutputs } from "./github-output.js";
import { summaryCommand, diffCommand, summarizeLedger, stableStringify, readSummary, diffSummaries, formatDiffText, parseThresholds } from "./cost-diff.js";
import { assertTableIntegrity } from "./pricing.js";
import { pricingCommand } from "./pricing-cli.js";
import { receiptsCommand } from "./receipts-cli.js";
import { createResponseCache, parseTtl } from "./response-cache.js";
import { dirname, join } from "node:path";
import { unpricedDiscountWarnings } from "./price-overrides.js";
import { loadUpstreamPrices, parseUpstreams, upstreamEnv } from "./upstreams.js";
import { awsCredentials } from "./sigv4.js";
import { createDowngrader, mergeDowngrade, parseDowngradeAt, parseDowngradeMap, scopeUsage } from "./downgrade.js";
import { isPricedModel } from "./pricing.js";
import { createOtlpExporter, parseOtlpHeaders, parseOtlpUrl } from "./otlp.js";

const USAGE = "usage: costcap wrap [--cap USD] [--hour-cap USD] [--day-cap USD] [--week-cap USD] [--month-cap USD] [--max-steps N] [--rpm N] [--tpm N] [--max-concurrent N] [--velocity-multiple X] [--models ID,ID] [--unknown-models refuse|fallback] [--receipts FILE] [--enrollment FILE] [--kill-file FILE] [--agent ID] [--run-id ID] [--tag KEY=VALUE]... [--tag-cap KEY:hour|day|month=USD]... [--model-cap MODEL:hour|day|month=USD]... [--policy FILE] [--shared-ledger] [--preflight] [--timeout SECONDS] [--warn-at F,F|off] [--downgrade FROM=TO[,FROM=TO]] [--downgrade-at F] [--cache TTL] [--cache-dir DIR] [--cache-max-mb N] [--upstream NAME=URL[,env=VAR][,insecure]]... [--upstream-prices FILE] [--otlp URL] -- <command...>\n" +
  "       (--upstream URL is the base your SDK would use without costcap, the same value you would put in base_url, e.g. http://127.0.0.1:8000/v1 for vLLM)\n" +
  "       (wrap limits: --timeout or COSTCAP_UPSTREAM_TIMEOUT_S = wait for the first response byte, default 600s; COSTCAP_STREAM_IDLE_TIMEOUT_S = max gap between stream chunks, default 300s; COSTCAP_MAX_REQUEST_MB = request body limit, default 32)\n" +
  "       costcap check [--cap USD] [--hour-cap USD] [--day-cap USD] [--week-cap USD] [--month-cap USD] [--models ID,ID] [--run-id ID] [--receipts FILE] [--warn-at F,F|off] [--github-output] [--baseline FILE] [--max-increase-pct N] [--max-increase-usd N] [--summary-out FILE]\n" +
  "       costcap summary [--receipts FILE] [--run-id ID] --json\n" +
  "       costcap diff --baseline FILE --current FILE [--max-increase-pct N] [--max-increase-usd N] [--markdown] [--json]\n" +
  "       costcap reconcile --receipts FILE --provider FILE [--apply]\n" +
  "       costcap bill-check --receipts FILE --provider openai|anthropic (--provider-export FILE | --fetch) [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--tolerance-pct 5] [--project ID] [--workspace ID] [--json]\n" +
  "       costcap enroll --url URL --name NAME [--enrollment FILE]\n" +
  "       costcap request-raise --scope run|hour|day|month --amount USD --hours N --reason TEXT [--enrollment FILE]\n" +
  "       costcap mcp [--cap USD] [--receipts FILE] [--policy FILE] [--kill-file FILE] [--enrollment FILE]\n" +
  "       costcap agent-status --agent ID --policy FILE [--run-id ID] [--receipts FILE] [--kill-file FILE] [--enrollment FILE]\n" +
  "       costcap runs [--json] [--receipts FILE]\n" +
  "       costcap receipts [--receipts FILE] [--since 14d|24h|ISO] [--until ISO] [--agent ID] [--run-id ID] [--tag KEY=VALUE]... [--json] [--export csv]\n" +
  "       costcap pricing verify [--receipts FILE] [--prices FILE] [--json] | costcap pricing show [model] [--prices FILE]\n" +
  "       costcap kill [note] [--host] [--kill-file FILE] [--receipts FILE] | costcap kill --status | costcap resume [--host] [--kill-file FILE] [--receipts FILE]\n" +
  "       (--host uses $COSTCAP_HOME/KILL, default ~/.costcap/KILL, and freezes every wrapped agent on this machine)\n" +
  "       costcap --version | costcap --help";

export function parseWrapArgs(argv) {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) throw new Error("usage: costcap wrap [--cap USD] [--hour-cap USD] [--day-cap USD] [--week-cap USD] [--month-cap USD] [--max-steps N] [--velocity-multiple X] [--receipts FILE] [--upstream NAME=URL[,env=VAR]]... -- <command...>\n  (--upstream URL is the base your SDK would use without costcap, the same value you would put in base_url)");
  const flags = argv.slice(0, sep);
  const command = argv.slice(sep + 1);
  const opts = { caps: {}, maxSteps: undefined, velocityMultiple: undefined, receiptsPath: ".costcap/receipts.jsonl", warnAt: [...DEFAULT_WARN_AT], killFile: DEFAULT_KILL_FILE, command };
  const money = (name, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of USD, got "${v}"`);
    return n;
  };
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === "--shared-ledger") { opts.sharedLedger = true; continue; }
    if (f === "--preflight") { opts.preflight = true; continue; }
    if (f === "--github-output") { opts.githubOutput = true; continue; }
    const v = flags[++i];
    if (v === undefined) throw new Error(`${f} needs a value`);
    if (f === "--cap") opts.caps.run = money(f, v);
    else if (f === "--hour-cap") opts.caps.hour = money(f, v);
    else if (f === "--day-cap") opts.caps.day = money(f, v);
    else if (f === "--week-cap") opts.caps.week = money(f, v);
    else if (f === "--month-cap") opts.caps.month = money(f, v);
    else if (f === "--max-steps") {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--max-steps must be a positive integer, got "${v}"`);
      opts.maxSteps = n;
    } else if (f === "--rpm" || f === "--tpm") {
      // #192: requests / tokens per rolling 60 s.
      const n = Number(v);
      if (!/^\d+$/.test(v) || !Number.isInteger(n) || n <= 0) throw new Error(`${f} must be a positive integer, got "${v}"`);
      opts[f.slice(2)] = n;
    } else if (f === "--max-concurrent") {
      // #249: up to N upstream calls in flight per wrapper (default 1: serialized).
      const n = Number(v);
      if (!/^\d+$/.test(v) || !isMaxConcurrent(n)) throw new Error(`--max-concurrent must be an integer from 1 to ${MAX_CONCURRENT_LIMIT}, got "${v}"`);
      opts.maxConcurrent = n;
    } else if (f === "--velocity-multiple") {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 1) throw new Error(`--velocity-multiple must be a number greater than 1, got "${v}"`);
      opts.velocityMultiple = n;
    } else if (f === "--models") {
      // #153: exact model ids, comma separated; most restrictive wins with fleet/agent policy.
      const list = v.split(",").map((m) => m.trim()).filter(Boolean);
      if (!list.length) throw new Error(`--models needs at least one model id, got "${v}"`);
      opts.models = [...new Set(list)];
    } else if (f === "--unknown-models") {
      if (v !== "refuse" && v !== "fallback") throw new Error(`--unknown-models must be refuse or fallback, got "${v}"`);
      opts.unknownModels = v;
    } else if (f === "--timeout") opts.timeoutS = positiveNumber(f, v);
    else if (f === "--warn-at") opts.warnAt = parseWarnAt(v);
    else if (f === "--downgrade") opts.downgradeMap = parseDowngradeMap(v);
    else if (f === "--downgrade-at") opts.downgradeAt = parseDowngradeAt(v);
    else if (f === "--receipts") opts.receiptsPath = v;
    else if (f === "--enrollment") opts.enrollmentPath = v;
    else if (f === "--kill-file") opts.killFile = v;
    else if (f === "--agent") opts.agentId = v;
    else if (f === "--run-id") opts.runId = v;
    else if (f === "--tag-cap") opts.tagCapSpecs = [...(opts.tagCapSpecs ?? []), v];
    else if (f === "--model-cap") opts.modelCapSpecs = [...(opts.modelCapSpecs ?? []), v];
    else if (f === "--tag") opts.tagPairs = [...(opts.tagPairs ?? []), v];
    else if (f === "--policy") opts.policyPath = v;
    else if (f === "--cache") opts.cacheTtlMs = parseTtl(v);
    else if (f === "--cache-dir") opts.cacheDir = v;
    else if (f === "--cache-max-mb") opts.cacheMaxMb = positiveNumber(f, v);
    else if (f === "--upstream") opts.upstreamSpecs = [...(opts.upstreamSpecs ?? []), v];
    else if (f === "--upstream-prices") opts.upstreamPricesPath = v;
    else if (f === "--otlp") opts.otlpEndpoint = v;
    else if (f === "--baseline") opts.baselinePath = v;
    else if (f === "--summary-out") opts.summaryOut = v;
    else if (f === "--max-increase-pct" || f === "--max-increase-usd") Object.assign(opts.thresholds ??= {}, parseThresholds((n) => (n === f ? v : undefined)));
    else throw new Error(`unknown flag ${f}`);
  }
  // #169: validated here so a bad --tag exits 2 before anything is spawned.
  if ((opts.cacheDir !== undefined || opts.cacheMaxMb !== undefined) && opts.cacheTtlMs === undefined) throw new Error("--cache-dir and --cache-max-mb need --cache TTL");
  if (opts.tagPairs) { opts.tags = parseTagList(opts.tagPairs); delete opts.tagPairs; }
  // #191: per-tag caps are validated before anything is spawned.
  if (opts.tagCapSpecs) { opts.tagCaps = parseTagCaps(opts.tagCapSpecs); delete opts.tagCapSpecs; }
  // #238: per-model caps are validated before anything is spawned.
  if (opts.modelCapSpecs) { opts.modelCaps = parseModelCaps(opts.modelCapSpecs); delete opts.modelCapSpecs; }
  // #186: custom upstreams and their prices are validated before anything is spawned.
  opts.upstreams = parseUpstreams(opts.upstreamSpecs ?? []);
  // #239: --otlp (or COSTCAP_OTLP_ENDPOINT) is validated before anything is spawned.
  const otlpRaw = opts.otlpEndpoint ?? process.env.COSTCAP_OTLP_ENDPOINT;
  delete opts.otlpEndpoint;
  if (otlpRaw) opts.otlp = parseOtlpUrl(otlpRaw);
  delete opts.upstreamSpecs;
  if (opts.upstreamPricesPath) opts.userPrices = loadUpstreamPrices(opts.upstreamPricesPath, opts.upstreams.map((u) => u.name));
  // #207: a downgrade target must have a rate, so spend stays known after the switch.
  for (const to of Object.values(opts.downgradeMap ?? {})) {
    const userPriced = Object.values(opts.userPrices?.upstreams ?? {}).some((t) => t && typeof t === "object" && Object.hasOwn(t, to));
    if (!isPricedModel(to) && !userPriced) throw new Error(`--downgrade target "${to}" has no published rate; add it to --upstream-prices or pick a priced model`);
  }
  return opts;
}

function positiveNumber(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${v}"`);
  return n;
}

/** #154: proxy timeouts and body limit from --timeout and env, with SDK-matching defaults. */
export function proxyLimits({ timeoutS } = {}, env = process.env) {
  const fromEnv = (key) => (env[key] === undefined || env[key] === "" ? undefined : positiveNumber(key, env[key]));
  const upstreamS = timeoutS ?? fromEnv("COSTCAP_UPSTREAM_TIMEOUT_S") ?? 600;
  const idleS = fromEnv("COSTCAP_STREAM_IDLE_TIMEOUT_S") ?? 300;
  const maxMb = fromEnv("COSTCAP_MAX_REQUEST_MB") ?? 32;
  return { timeoutMs: Math.round(upstreamS * 1000), streamIdleMs: Math.round(idleS * 1000), maxBodyBytes: Math.round(maxMb * 1024 * 1024) };
}

function parseKillArgs(argv) {
  const opts = { file: DEFAULT_KILL_FILE, receipts: ".costcap/receipts.jsonl", words: [], host: false, status: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--kill-file") opts.file = argv[++i];
    else if (argv[i] === "--host") opts.host = true;
    else if (argv[i] === "--status") opts.status = true;
    else if (argv[i] === "--receipts") opts.receipts = argv[++i];
    else opts.words.push(argv[i]);
  }
  return opts;
}

const loadPolicy = (path) => assertAgentPolicy(JSON.parse(readFileSync(path, "utf8")));

export async function wrap(argv) {
  const { caps, maxSteps, models, unknownModels, velocityMultiple, receiptsPath, killFile, command, enrollmentPath, agentId, runId, policyPath, sharedLedger: shared, preflight: preflightFlag, timeoutS, warnAt, tags, cacheTtlMs, cacheDir, cacheMaxMb, upstreams: customList, userPrices, tagCaps: tagCapRules, modelCaps: modelCapRules, rpm, tpm, maxConcurrent: maxConcurrentFlag, downgradeMap, downgradeAt, otlp } = parseWrapArgs(argv);
  for (const w of unpricedDiscountWarnings(userPrices)) console.error(w);
  for (const u of customList) if (u.insecure) console.error(`costcap: warning: custom upstream "${u.name}" uses plain http to a non-loopback host (${u.url})`);
  if (otlp?.insecure) console.error(`costcap: warning: --otlp uses plain http to a non-loopback host (${new URL(otlp.url).host})`);
  const otlpHeaders = otlp ? parseOtlpHeaders(process.env.COSTCAP_OTLP_HEADERS) : null;
  const limits = proxyLimits({ timeoutS });
  // Never price from a tampered table (#122): refuse before spawning anything.
  assertTableIntegrity();
  // --preflight or COSTCAP_PREFLIGHT=1 (CC-9): refuse calls whose estimated worst case cannot fit.
  const preflight = Boolean(preflightFlag) || /^(1|true|on)$/i.test(process.env.COSTCAP_PREFLIGHT ?? "");
  if (policyPath && !agentId) throw new Error("--policy needs --agent");
  const policy = policyPath ? loadPolicy(policyPath) : null;
  // The wrapper assigns the run id, so the wrapped agent cannot pick a fresh one.
  // #170: every receipt carries run_id, with or without --agent.
  const who = { ...(agentId ? { agent_id: agentId } : {}), run_id: runId ?? randomUUID() };
  // --shared-ledger (CC-5): several wrappers on one host share day/month caps.
  let cap, agentBudgets, tagCaps = null, modelCaps = null, hostedModelCaps = null;
  let proxySettle = () => {}; // #171: bound once the proxy is listening
  // #176: fleet and shared-ledger settlements share one helper (batch_pending aware).
  // #178: settlements of this run's receipts also feed the run summary.
  const runSettlements = [];
  // #181: bound once the proxy is listening; capWarner once created.
  let checkWarnings = () => {};
  let capWarner = null;
  let downgrader = null;
  const settleWithWarnings = createSettler({ cap: () => cap, agentBudgets: () => agentBudgets, proxySettle: () => proxySettle, tagCaps: () => tagCaps, modelCaps: () => modelCaps,
    onSettled: (e) => { if (e.run_id === who.run_id) runSettlements.push(e); } });
  const settleReceipt = (s, r) => { const applied = settleWithWarnings(s, r); if (applied) checkWarnings(); return applied; };
  const sharedLedger = shared ? openSharedLedger(receiptsPath, {
    onExternal: (r) => { cap.record(r, { external: true }); agentBudgets?.record(r); tagCaps?.record(r); modelCaps?.record(r); checkWarnings(); },
    onExternalWarning: (e) => { capWarner?.note(e); downgrader?.note(e); },
    // #174: another wrapper (or reconcile --apply) settled a receipt we hold as unknown.
    // A batch_pending receipt was never counted as unknown, so its cost is recorded instead.
    onExternalSettle: (s, r) => settleReceipt(s, r),
  }) : null;
  const release = sharedLedger ? sharedLedger.close : lockLedger(receiptsPath);
  try {
  const history = sharedLedger ? sharedLedger.history() : loadSettledReceipts(receiptsPath);
  cap = createCapEngine({ caps, history, runId: who.run_id });
  if (tagCapRules?.length) tagCaps = createTagCaps({ rules: tagCapRules, history });
  // #238: always built when enrolled, so fleet modelCaps can arrive on any sync.
  if (modelCapRules?.length || enrollmentPath) modelCaps = createModelCaps({ rules: modelCapRules ?? [], history });
  // #244: hosted day/month rules are enforced fleet-wide from agent_spend.models; this
  // engine only covers them (UTC, local ledger) until the server sends that snapshot.
  if (enrollmentPath) hostedModelCaps = createModelCaps({ rules: [], history });
  const velocity = createVelocityBreaker({ maxSteps, ...(velocityMultiple ? { multiple: velocityMultiple } : {}) });
  let fleet;
  let fleetPolicy;
  let fleetModels = models ?? null;
  // #192: effective rate limit = min(flag, --policy agent/default, fleet); re-applied on each fleet sync.
  const rateLimit = createRateLimiter();
  let fleetRate = {};
  let effectiveConcurrent = 1;
  const applyRate = () => {
    const own = agentBudgets?.limitsFor(who.agent_id ?? "unknown") ?? null;
    rateLimit.setLimits({ rpm: minLimit(rpm, own?.rpm, fleetRate.rpm), tpm: minLimit(tpm, own?.tpm, fleetRate.tpm) });
    // #249: effective concurrency = min(flag, --policy agent/default, fleet ceiling); default 1.
    effectiveConcurrent = minLimit(maxConcurrentFlag, own?.maxConcurrent, fleetRate.maxConcurrent) ?? 1;
  };
  // #207: local --downgrade / --downgrade-at merged with the fleet downgrade (local only adds or lowers).
  const localDowngrade = downgradeMap ? { map: downgradeMap, at: downgradeAt } : downgradeAt != null ? { at: downgradeAt } : null;
  let downgradeConfig = mergeDowngrade(null, localDowngrade);
  let raiseTimer = null;
  const setPolicy = (p) => {
    fleetPolicy = p;
    // #208: a cap raise expires offline: re-resolve the cached policy at expires_at.
    clearTimeout(raiseTimer);
    if (fleet && p.raiseExpiresAt != null) { raiseTimer = setTimeout(() => setPolicy(fleet.policy()), Math.max(0, p.raiseExpiresAt - Date.now()) + 5); raiseTimer.unref?.(); }
    downgradeConfig = mergeDowngrade(p.downgrade ?? null, localDowngrade);
    const resolved = resolvePolicy({ local: { ...caps, maxSteps, models }, lastKnown: { version: p.version, caps: p.caps, killed: p.killed, maxSteps: p.maxSteps ?? undefined, models: p.models ?? undefined } });
    cap.updateCaps(resolved.caps);
    checkWarnings();
    velocity.setMaxSteps(resolved.maxSteps);
    fleetModels = resolved.models;
    fleetRate = { rpm: p.rpm, tpm: p.tpm, maxConcurrent: p.maxConcurrent };
    // #244: hosted hour rules stay local; hosted day/month rules go fleet-wide.
    const hosted = p.modelCaps ?? [];
    modelCaps?.setRules(mergeModelCapRules(hosted.filter((r) => r.scope === "hour"), modelCapRules ?? []));
    hostedModelCaps?.setRules(fleetModelRules(hosted).map((r) => ({ model: r.model, scope: r.scope, cap: r.usd })));
    applyRate();
  };
  if (enrollmentPath) {
    fleet = createFleetClient({ path: enrollmentPath, receiptsPath, onPolicy: setPolicy, onSettle: (r) => settleReceipt(r) });
    modelCaps = withFleetModelCaps(modelCaps, hostedModelCaps, fleet);
    setPolicy(fleet.policy());
    const result = await fleet.sync();
    if (!result.online) console.error("costcap: fleet offline; cached policy enforced");
  }
  const localKill = createKillCheck(killFile);
  const combinedKill = () => localKill() || (fleetPolicy?.killed || fleet?.revoked() ? { reason: "killed", note: "fleet policy or revoked credentials" } : null);
  const testUpstreams = Object.fromEntries([["openai", process.env.COSTCAP_TEST_OPENAI_UPSTREAM], ["gemini", process.env.COSTCAP_TEST_GEMINI_UPSTREAM], ["anthropic", process.env.COSTCAP_TEST_ANTHROPIC_UPSTREAM], ["openrouter", process.env.COSTCAP_TEST_OPENROUTER_UPSTREAM], ["bedrock", process.env.COSTCAP_TEST_BEDROCK_UPSTREAM], ["vertex", process.env.COSTCAP_TEST_VERTEX_UPSTREAM]].filter(([, v]) => v));
  const upstreams = Object.keys(testUpstreams).length ? testUpstreams : undefined; // test hook
  agentBudgets = policy ? createAgentBudgets({ policy, history }) : undefined;
  applyRate();
  const runReceipts = [];
  const summaryRunId = who.run_id;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const exporter = otlp ? createOtlpExporter({ url: otlp.url, headers: otlpHeaders, runId: summaryRunId }) : null;
  let priorEvents = [];
  try { priorEvents = loadEvents(receiptsPath); } catch { /* corrupt lines already fail history load */ }
  capWarner = createCapWarner({ fractions: warnAt, events: priorEvents, runId: summaryRunId, agentId: who.agent_id ?? null });
  // #207: trigger order: local caps, --policy agent and team budgets, enrolled fleet agent and team caps.
  const downgradeUsage = () => {
    const rows = scopeUsage(cap.limits(), cap.spend());
    if (agentBudgets) {
      const id = who.agent_id ?? "unknown";
      const limits = agentBudgets.limitsFor(id);
      if (limits) rows.push(...scopeUsage(limits, agentBudgets.spend(who), "agent"));
      const team = agentBudgets.teamFor?.(id);
      if (team) rows.push(...scopeUsage(team, agentBudgets.teamSpend(who), `team ${team.team}`));
    }
    const fr = fleet?.preflightRemaining?.();
    const spentOf = (caps, left) => Object.fromEntries(Object.entries(left ?? {}).filter(([k, v]) => caps?.[k] != null && typeof v === "number").map(([k, v]) => [k, Math.max(caps[k] - v, 0)]));
    if (fr?.agent) rows.push(...scopeUsage(fleetPolicy?.caps, spentOf(fleetPolicy?.caps, fr.agent), "fleet"));
    const team = fleet?.team?.();
    if (fr?.team && team) { const tc = team.caps ?? {}; rows.push(...scopeUsage(tc, spentOf(tc, fr.team), `team ${team.name}`)); }
    const org = fleet?.orgBudget?.();
    if (fr?.org && org) rows.push(...scopeUsage(org.caps, spentOf(org.caps, fr.org), "org"));
    return rows;
  };
  downgrader = createDowngrader({ config: () => downgradeConfig, usage: downgradeUsage, lowerBound: () => cap.spend().unknown > 0, events: priorEvents, runId: summaryRunId, agentId: who.agent_id ?? null });
  // #184: opt-in response cache, default <ledger-dir>/cache.
  const cache = cacheTtlMs ? createResponseCache({ dir: cacheDir ?? join(dirname(receiptsPath), "cache"), ttlMs: cacheTtlMs, ...(cacheMaxMb ? { maxMb: cacheMaxMb } : {}) }) : null;
  const { server, port } = await startMeteringProxy({ cache, onReceipt: (r, meta) => { runReceipts.push(r); exporter?.add(r, meta); }, receiptsPath, cap, upstreams, velocity, killCheck: combinedKill, who, agentBudgets, teamCheck: fleet ? () => fleet.fleetCheck() : undefined, fleetRemaining: fleet ? () => fleet.preflightRemaining() : null, sharedLedger, capWarner, downgrader, preflight, tags: tags ?? null, tagCaps: fleet ? withFleetTagCaps(tagCaps, fleet, tagCapRules ?? []) : tagCaps, modelCaps, rateLimit, maxConcurrent: () => effectiveConcurrent, ...limits,
    customUpstreams: Object.fromEntries(customList.map((u) => [u.name, u.url])), userPrices: userPrices ?? null,
    // #153: local --models ∩ synced fleet models ∩ agent policy (agent ∩ team ∩ default), re-read per call.
    allowedModels: () => intersectModels(fleetModels, agentBudgets?.modelsFor(who.agent_id) ?? null), unknownModels });
  proxySettle = (r) => server.settle(r);
  checkWarnings = () => server.checkWarnings();
  // #187: fractions already reached at startup (incl. a cached fleet cap) warn once, deduped by the ledger.
  checkWarnings();
  const env = { ...process.env };
  for (const line of baseUrlOverrides(port)) {
    const [k, ...v] = line.split("=");
    env[k] = v.join("=");
  }
  // #216: boto3 / AWS SDK v3 Converse callers read the service-specific endpoint variable.
  if (process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME) console.error("costcap: warning: AWS_ENDPOINT_URL_BEDROCK_RUNTIME is already set; AWS SDK Bedrock calls go there and are not metered by this wrap.");
  else env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = `http://127.0.0.1:${port}/bedrock`;
  // #188: the proxy re-signs SigV4 Bedrock calls only with static credentials from this env.
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1" && !awsCredentials(process.env) && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    console.error("costcap: note: CLAUDE_CODE_USE_BEDROCK=1 but no static AWS credentials or AWS_BEARER_TOKEN_BEDROCK are set; signed Bedrock calls will be refused. Run: eval \"$(aws configure export-credentials --format env)\"");
  }
  const custom = upstreamEnv(customList, port);
  for (const note of custom.notes) console.error(note);
  Object.assign(env, custom.env);
  const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" });
  // Kill switch also stops the wrapped child: SIGTERM, then SIGKILL after 5s.
  const killCheck = combinedKill;
  const syncTimer = fleet ? setInterval(() => fleet.sync(), Number(process.env.COSTCAP_SYNC_MS) || 60_000) : null; // COSTCAP_SYNC_MS: test hook
  let killedByCostcap = false, killInfo = null;
  const watcher = setInterval(() => {
    if (killedByCostcap) return;
    const k = killCheck();
    if (!k) return;
    killedByCostcap = true;
    killInfo = k;
    console.error("costcap: kill file present, stopping wrapped process");
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  }, Number(process.env.COSTCAP_KILL_POLL_MS) || 500);
  let exitSignal = null;
  const code = await new Promise((resolve) => {
    child.on("exit", (c, sig) => { exitSignal = sig ?? null; resolve(killedByCostcap ? 143 : (c ?? (sig ? 1 : 0))); });
    child.on("error", (e) => { console.error(`costcap: failed to start ${command[0]}: ${e.message}`); resolve(127); });
  });
  clearInterval(watcher);
  if (syncTimer) clearInterval(syncTimer);
  const s = cap.spend();
  const summary = buildRunSummary({ run_id: summaryRunId, started_at: startedAt, ended_at: new Date().toISOString(), exit_code: code,
    receipts: [...runReceipts, ...runSettlements], caps: cap.limits(), spend: s, killed: killedByCostcap, kill: killInfo, warnings: capWarner.emitted, cacheEnabled: Boolean(cache), signal: killedByCostcap ? null : exitSignal, maxConcurrent: effectiveConcurrent });
  // #225: the run-end record goes up with the final receipt sync (retried on later syncs if it fails).
  if (fleet) { fleet.queueRunEnd(runEndRecord(summary)); await fleet.sync({ wait: true }); }
  server.closeAllConnections();
  server.close();
  // #239: final OTLP flush, capped at 5 s; failures never change the exit code.
  if (exporter) summary.otlp = await exporter.finish(summary, { startMs: startedMs });
  console.error(`costcap: run spend $${s.run.toFixed(4)}${caps.run != null ? ` of $${caps.run} cap` : ""}`);
  try { writeRunSummary(receiptsPath, summary); } catch (e) { console.error(`costcap: warning: run summary not written: ${e.code ?? e.message}`); }
  console.error(rollupLine(summary));
  return code;
  } finally { release(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    process.exit(0);
  } else if (cmd === "--help" || cmd === "-h" || cmd === "help" || cmd === undefined) {
    console.log(USAGE);
    process.exit(0);
  } else if (cmd === "wrap") {
    wrap(rest).then((c) => process.exit(c), (e) => { console.error(`costcap: ${e.message}`); process.exit(2); });
  } else if (cmd === "check" || cmd === "mcp") {
    try {
      const parsed = parseWrapArgs([...rest, "--", "unused"]);
      const options = { receiptsPath: parsed.receiptsPath, caps: parsed.caps, ...(parsed.tagCaps ? { tagCaps: parsed.tagCaps } : {}), ...(parsed.modelCaps ? { modelCaps: parsed.modelCaps } : {}), warnAt: parsed.warnAt, policy: parsed.policyPath ? loadPolicy(parsed.policyPath) : undefined, ...(parsed.models ? { models: parsed.models } : {}) };
      if (cmd === "check" && parsed.runId !== undefined) options.runId = parsed.runId;
      if (cmd === "mcp") serveMcp({ ...options, killFile: parsed.killFile, enrollmentPath: parsed.enrollmentPath });
      else {
        // The host kill file always applies; the project kill file only with an explicit --kill-file.
        const result = guardedBudgetStatus({ ...options, killFile: rest.includes("--kill-file") ? parsed.killFile : null });
        // #229: optional cost diff vs a baseline summary, plus the current summary for the next baseline.
        let diff = null;
        if (parsed.thresholds && !parsed.baselinePath) throw new Error("--max-increase-pct/--max-increase-usd need --baseline FILE");
        if (parsed.baselinePath || parsed.summaryOut) {
          const current = summarizeLedger(parsed.receiptsPath, parsed.runId !== undefined ? { runId: parsed.runId } : {});
          if (parsed.summaryOut) writeFileSync(parsed.summaryOut, stableStringify(current));
          if (parsed.baselinePath) diff = diffSummaries(readSummary(parsed.baselinePath, "baseline"), current, parsed.thresholds ?? {});
        }
        if (parsed.githubOutput) writeGithubOutputs(result, parsed.caps, process.env, diff);
        if (diff) console.error(formatDiffText(diff));
        console.log(JSON.stringify(diff ? { ...result, cost_diff: { verdict: diff.verdict, delta_usd: diff.total.delta, delta_pct: String(diff.total.pct), baseline_usd: diff.total.baseline, reasons: diff.reasons, warnings: diff.warnings } } : result));
        process.exitCode = result.ok && (!diff || diff.verdict === "ok") ? 0 : 1;
      }
    } catch (err) { console.error(`costcap: ${err.message}`); process.exitCode = 2; }
  } else if (cmd === "agent-status") {
    try {
      const parsed = parseWrapArgs([...rest, "--", "unused"]);
      if (!parsed.policyPath) throw new Error("--policy is required");
      const result = guardedAgentStatus({ receiptsPath: parsed.receiptsPath, policy: loadPolicy(parsed.policyPath), agent_id: parsed.agentId, run_id: parsed.runId ?? null, killFile: parsed.killFile, enrollmentPath: parsed.enrollmentPath });
      console.log(JSON.stringify(result));
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) { console.error(`costcap: ${err.message}`); process.exitCode = 2; }
  } else if (cmd === "enroll") {
    const option = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
    enroll({ url: option("--url"), name: option("--name"), token: process.env.COSTCAP_ENROLL_TOKEN, path: option("--enrollment") ?? ".costcap/enrollment.json" })
      .then(({ agentId }) => console.error(`costcap: enrolled ${agentId}. Use --enrollment with wrap.`), (e) => { console.error(`costcap: ${e.message}`); process.exitCode = 2; });
  } else if (cmd === "request-raise") {
    const option = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
    requestRaise({ path: option("--enrollment") ?? ".costcap/enrollment.json", scope: option("--scope"), amountUsd: Number(option("--amount")), durationHours: Number(option("--hours")), reason: option("--reason") })
      .then((r) => { console.log(JSON.stringify({ request_id: r.id, status: r.status, scope: r.scope, amount_usd: r.amount_usd, duration_hours: r.duration_hours })); console.error("costcap: cap raise requested; an admin can approve it in the dashboard."); }, (e) => { console.error(`costcap: ${e.message}`); process.exitCode = 2; });
  } else if (cmd === "bill-check") {
    billCheckCommand(rest).then((c) => { process.exitCode = c; });
  } else if (cmd === "reconcile") {
    try {
      const option = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
      const receiptsPath = option("--receipts");
      const providerPath = option("--provider");
      if (!receiptsPath || !providerPath) throw new Error("usage: costcap reconcile --receipts FILE --provider FILE [--apply]");
      if (rest.includes("--apply")) {
        // Settle unknown-cost receipts from provider evidence (append-only, never $0 without a charge).
        const result = applyReconciliation({ receiptsPath, providerPath });
        console.log(JSON.stringify(result));
        if (result.still_unknown.length) console.error(`costcap: still unknown (no provider cost): ${result.still_unknown.join(", ")}`);
        process.exitCode = result.still_unknown.length ? 1 : 0;
      } else {
        const result = reconcileFiles({ receiptsPath, providerPath });
        console.log(JSON.stringify(result));
        process.exitCode = result.ok ? 0 : 1;
      }
    } catch (err) { console.error(`costcap: ${err.message}`); process.exitCode = 2; }
  } else if (cmd === "pricing") {
    try {
      const { code, out, err } = pricingCommand(rest);
      if (out) console.log(out);
      if (err) console.error(err);
      process.exitCode = code;
    } catch (err) { console.error(`costcap: ${err.message}`); process.exitCode = 2; }
  } else if (cmd === "receipts") {
    process.exitCode = receiptsCommand(rest);
  } else if (cmd === "summary") {
    process.exitCode = summaryCommand(rest);
  } else if (cmd === "diff") {
    process.exitCode = diffCommand(rest);
  } else if (cmd === "runs") {
    runsCommand(rest);
  } else if (cmd === "kill" || cmd === "resume") {
    const { file: projectFile, receipts, words, host, status } = parseKillArgs(rest);
    if (status) {
      console.log(JSON.stringify(killStatus(projectFile, hostKillFile())));
    } else {
    const file = host ? hostKillFile() : projectFile;
    const scope = host ? "host" : "project";
    const logEvent = (note) => {
      // The kill state already changed, so a ledger failure is a warning, not a failure.
      try { recordKillEvent(receipts, cmd, file, note, undefined, scope); }
      catch (err) { console.error(`costcap: warning: ${cmd} took effect but was not recorded in ${receipts}: ${err.code ?? err.message}`); }
    };
    if (cmd === "kill") {
      const note = words.join(" ");
      kill(file, note);
      logEvent(note);
      console.error(host
        ? `costcap: killed (host). Every wrapped agent on this machine is refused until \`costcap resume --host\` (${file}).`
        : `costcap: killed. Wrapped agents sharing ${file} are refused until \`costcap resume\`.`);
    } else if (resume(file)) {
      logEvent(words.join(" "));
      console.error(`costcap: resumed (${scope}).`);
    } else console.error("costcap: nothing to resume (not killed).");
    }
  } else {
    console.error(`costcap: unknown command "${cmd}"\n${USAGE}`);
    process.exit(2);
  }
}
