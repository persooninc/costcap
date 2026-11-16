#!/usr/bin/env node
// costcap CLI. `costcap wrap [--cap USD] [--day-cap USD] [--month-cap USD] [--receipts FILE] -- <command...>`
// starts the local metering proxy with a hard spend cap, points the wrapped
// process's provider base URLs at it, and exits with the child's exit code.
// Guardrails, not guarantees: only traffic through the proxy is metered.

import { checkBudget } from "./check.js";
import { reconcileFiles, applyReconciliation } from "./reconcile.js";
import { serveMcp } from "./mcp.js";
import { enroll, createFleetClient } from "./hosted/client.js";
import { resolvePolicy } from "./hosted/policy.js";
import { lockLedger, openSharedLedger } from "./ledger-lock.js";
import { spawn } from "node:child_process";
import { startMeteringProxy, baseUrlOverrides } from "./proxy.js";
import { createCapEngine, loadSettledReceipts } from "./cap.js";
import { createVelocityBreaker } from "./velocity.js";
import { assertAgentPolicy, createAgentBudgets } from "./agent-budget.js";
import { guardedAgentStatus } from "./check.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildRunSummary, rollupLine, runsCommand, writeRunSummary } from "./run-summary.js";
import { createKillCheck, kill, recordKillEvent, resume, DEFAULT_KILL_FILE } from "./kill.js";
import { VERSION } from "./version.js";
import { writeGithubOutputs } from "./github-output.js";
import { assertTableIntegrity } from "./pricing.js";
import { pricingCommand } from "./pricing-cli.js";
import { receiptsCommand } from "./receipts-cli.js";

const USAGE = "usage: costcap wrap [--cap USD] [--day-cap USD] [--month-cap USD] [--max-steps N] [--velocity-multiple X] [--receipts FILE] [--enrollment FILE] [--kill-file FILE] [--agent ID] [--run-id ID] [--policy FILE] [--shared-ledger] [--preflight] -- <command...>\n" +
  "       costcap check [--cap USD] [--day-cap USD] [--month-cap USD] [--run-id ID] [--receipts FILE] [--github-output]\n" +
  "       costcap reconcile --receipts FILE --provider FILE [--apply]\n" +
  "       costcap enroll --url URL --name NAME [--enrollment FILE]\n" +
  "       costcap mcp [--cap USD] [--receipts FILE] [--policy FILE] [--kill-file FILE] [--enrollment FILE]\n" +
  "       costcap agent-status --agent ID --policy FILE [--run-id ID] [--receipts FILE] [--kill-file FILE] [--enrollment FILE]\n" +
  "       costcap runs [--json] [--receipts FILE]\n" +
  "       costcap receipts [--receipts FILE] [--since 14d|24h|ISO] [--until ISO] [--agent ID] [--run-id ID] [--json] [--export csv]\n" +
  "       costcap pricing verify [--receipts FILE] [--json] | costcap pricing show [model]\n" +
  "       costcap kill [note] [--kill-file FILE] [--receipts FILE] | costcap resume [--kill-file FILE] [--receipts FILE]\n" +
  "       costcap --version | costcap --help";

export function parseWrapArgs(argv) {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) throw new Error("usage: costcap wrap [--cap USD] [--day-cap USD] [--month-cap USD] [--max-steps N] [--velocity-multiple X] [--receipts FILE] -- <command...>");
  const flags = argv.slice(0, sep);
  const command = argv.slice(sep + 1);
  const opts = { caps: {}, maxSteps: undefined, velocityMultiple: undefined, receiptsPath: ".costcap/receipts.jsonl", killFile: DEFAULT_KILL_FILE, command };
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
    else if (f === "--day-cap") opts.caps.day = money(f, v);
    else if (f === "--month-cap") opts.caps.month = money(f, v);
    else if (f === "--max-steps") {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--max-steps must be a positive integer, got "${v}"`);
      opts.maxSteps = n;
    } else if (f === "--velocity-multiple") {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 1) throw new Error(`--velocity-multiple must be a number greater than 1, got "${v}"`);
      opts.velocityMultiple = n;
    } else if (f === "--receipts") opts.receiptsPath = v;
    else if (f === "--enrollment") opts.enrollmentPath = v;
    else if (f === "--kill-file") opts.killFile = v;
    else if (f === "--agent") opts.agentId = v;
    else if (f === "--run-id") opts.runId = v;
    else if (f === "--policy") opts.policyPath = v;
    else throw new Error(`unknown flag ${f}`);
  }
  return opts;
}

function parseKillArgs(argv) {
  const opts = { file: DEFAULT_KILL_FILE, receipts: ".costcap/receipts.jsonl", words: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--kill-file") opts.file = argv[++i];
    else if (argv[i] === "--receipts") opts.receipts = argv[++i];
    else opts.words.push(argv[i]);
  }
  return opts;
}

const loadPolicy = (path) => assertAgentPolicy(JSON.parse(readFileSync(path, "utf8")));

export async function wrap(argv) {
  const { caps, maxSteps, velocityMultiple, receiptsPath, killFile, command, enrollmentPath, agentId, runId, policyPath, sharedLedger: shared, preflight: preflightFlag } = parseWrapArgs(argv);
  // Never price from a tampered table (#122): refuse before spawning anything.
  assertTableIntegrity();
  // --preflight or COSTCAP_PREFLIGHT=1 (CC-9): refuse calls whose estimated worst case cannot fit.
  const preflight = Boolean(preflightFlag) || /^(1|true|on)$/i.test(process.env.COSTCAP_PREFLIGHT ?? "");
  if (policyPath && !agentId) throw new Error("--policy needs --agent");
  const policy = policyPath ? loadPolicy(policyPath) : null;
  // The wrapper assigns the run id, so the wrapped agent cannot pick a fresh one.
  const who = agentId ? { agent_id: agentId, run_id: runId ?? randomUUID() } : {};
  // --shared-ledger (CC-5): several wrappers on one host share day/month caps.
  let cap, agentBudgets;
  const sharedLedger = shared ? openSharedLedger(receiptsPath, { onExternal: (r) => { cap.record(r, { external: true }); agentBudgets?.record(r); } }) : null;
  const release = sharedLedger ? sharedLedger.close : lockLedger(receiptsPath);
  try {
  const history = sharedLedger ? sharedLedger.history() : loadSettledReceipts(receiptsPath);
  cap = createCapEngine({ caps, history });
  const velocity = createVelocityBreaker({ maxSteps, ...(velocityMultiple ? { multiple: velocityMultiple } : {}) });
  let fleet;
  let fleetPolicy;
  const setPolicy = (p) => {
    fleetPolicy = p;
    const resolved = resolvePolicy({ local: { ...caps, maxSteps }, lastKnown: { version: p.version, caps: p.caps, killed: p.killed, maxSteps: p.maxSteps ?? undefined } });
    cap.updateCaps(resolved.caps);
    velocity.setMaxSteps(resolved.maxSteps);
  };
  if (enrollmentPath) {
    fleet = createFleetClient({ path: enrollmentPath, receiptsPath, onPolicy: setPolicy });
    setPolicy(fleet.policy());
    const result = await fleet.sync();
    if (!result.online) console.error("costcap: fleet offline; cached policy enforced");
  }
  const localKill = createKillCheck(killFile);
  const combinedKill = () => localKill() || (fleetPolicy?.killed || fleet?.revoked() ? { reason: "killed", note: "fleet policy or revoked credentials" } : null);
  const testUpstreams = Object.fromEntries([["openai", process.env.COSTCAP_TEST_OPENAI_UPSTREAM], ["gemini", process.env.COSTCAP_TEST_GEMINI_UPSTREAM], ["anthropic", process.env.COSTCAP_TEST_ANTHROPIC_UPSTREAM]].filter(([, v]) => v));
  const upstreams = Object.keys(testUpstreams).length ? testUpstreams : undefined; // test hook
  agentBudgets = policy ? createAgentBudgets({ policy, history }) : undefined;
  const runReceipts = [];
  const summaryRunId = who.run_id ?? randomUUID();
  const startedAt = new Date().toISOString();
  const { server, port } = await startMeteringProxy({ onReceipt: (r) => { runReceipts.push(r); }, receiptsPath, cap, upstreams, velocity, killCheck: combinedKill, who, agentBudgets, teamCheck: fleet ? () => fleet.agentCheck() ?? fleet.teamCheck() : undefined, sharedLedger, preflight });
  const env = { ...process.env };
  for (const line of baseUrlOverrides(port)) {
    const [k, ...v] = line.split("=");
    env[k] = v.join("=");
  }
  const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" });
  // Kill switch also stops the wrapped child: SIGTERM, then SIGKILL after 5s.
  const killCheck = combinedKill;
  const syncTimer = fleet ? setInterval(() => fleet.sync(), 60_000) : null;
  let killedByCostcap = false;
  const watcher = setInterval(() => {
    if (killedByCostcap || !killCheck()) return;
    killedByCostcap = true;
    console.error("costcap: kill file present, stopping wrapped process");
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  }, Number(process.env.COSTCAP_KILL_POLL_MS) || 500);
  const code = await new Promise((resolve) => {
    child.on("exit", (c, sig) => resolve(killedByCostcap ? 143 : (c ?? (sig ? 1 : 0))));
    child.on("error", (e) => { console.error(`costcap: failed to start ${command[0]}: ${e.message}`); resolve(127); });
  });
  clearInterval(watcher);
  if (syncTimer) clearInterval(syncTimer);
  if (fleet) await fleet.sync();
  server.closeAllConnections();
  server.close();
  const s = cap.spend();
  console.error(`costcap: run spend $${s.run.toFixed(4)}${caps.run != null ? ` of $${caps.run} cap` : ""}`);
  const summary = buildRunSummary({ run_id: summaryRunId, started_at: startedAt, ended_at: new Date().toISOString(), exit_code: code,
    receipts: runReceipts, caps: cap.limits(), spend: s, killed: killedByCostcap });
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
      const options = { receiptsPath: parsed.receiptsPath, caps: parsed.caps, policy: parsed.policyPath ? loadPolicy(parsed.policyPath) : undefined };
      if (cmd === "check" && parsed.runId !== undefined) options.runId = parsed.runId;
      if (cmd === "mcp") serveMcp({ ...options, killFile: parsed.killFile, enrollmentPath: parsed.enrollmentPath });
      else {
        const result = checkBudget(options);
        if (parsed.githubOutput) writeGithubOutputs(result, parsed.caps);
        console.log(JSON.stringify(result));
        process.exitCode = result.ok ? 0 : 1;
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
  } else if (cmd === "runs") {
    runsCommand(rest);
  } else if (cmd === "kill" || cmd === "resume") {
    const { file, receipts, words } = parseKillArgs(rest);
    const logEvent = (note) => {
      // The kill state already changed, so a ledger failure is a warning, not a failure.
      try { recordKillEvent(receipts, cmd, file, note); }
      catch (err) { console.error(`costcap: warning: ${cmd} took effect but was not recorded in ${receipts}: ${err.code ?? err.message}`); }
    };
    if (cmd === "kill") {
      const note = words.join(" ");
      kill(file, note);
      logEvent(note);
      console.error(`costcap: killed. Wrapped agents sharing ${file} are refused until \`costcap resume\`.`);
    } else if (resume(file)) {
      logEvent(words.join(" "));
      console.error("costcap: resumed.");
    } else console.error("costcap: nothing to resume (not killed).");
  } else {
    console.error(`costcap: unknown command "${cmd}"\n${USAGE}`);
    process.exit(2);
  }
}
