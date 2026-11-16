// Kill switch: a kill file freezes every wrapped agent that shares it.
// While the file exists the proxy refuses all upstream calls (429 killed).
// `costcap kill` writes it, `costcap resume` removes it. Touching the file
// by hand works too. Local enforcement only: traffic outside the proxy is
// not stopped.

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_KILL_FILE = ".costcap/KILL";

// Host kill file: $COSTCAP_HOME/KILL (COSTCAP_HOME defaults to ~/.costcap).
// It freezes every wrapped agent on this machine, whatever its working directory.
export function hostKillFile(env = process.env) {
  return join(env.COSTCAP_HOME || join(homedir(), ".costcap"), "KILL");
}

// One file's state. A stat error other than "not found" means the state is
// unknown, so it kills (fail closed).
export function readKillFile(file, scope) {
  try { statSync(file); }
  catch (err) {
    if (err.code === "ENOENT") return null;
    return { reason: "killed", kill_scope: scope, kill_file: file, note: `kill state unknown: ${err.code}` };
  }
  let reason = "";
  try { reason = readFileSync(file, "utf8").trim(); } catch { /* unreadable (e.g. a directory): still killed */ }
  return { reason: "killed", kill_scope: scope, kill_file: file, note: reason || undefined };
}

// Host OR project: either file present means killed. Host is checked first.
// Pass killFile = null to check only the host file.
export function createKillCheck(killFile = DEFAULT_KILL_FILE, { hostFile = hostKillFile() } = {}) {
  return () => (hostFile ? readKillFile(hostFile, "host") : null) || (killFile ? readKillFile(killFile, "project") : null);
}

export function killStatus(killFile = DEFAULT_KILL_FILE, hostFile = hostKillFile()) {
  const one = (file, scope) => {
    const k = readKillFile(file, scope);
    return { killed: Boolean(k), file, note: k?.note ?? null };
  };
  return { host: one(hostFile, "host"), project: one(killFile, "project") };
}

export function kill(killFile = DEFAULT_KILL_FILE, note = "") {
  mkdirSync(dirname(killFile), { recursive: true });
  writeFileSync(killFile, note ? `${note}\n` : "");
  return killFile;
}

// Returns true if the file existed.
export function resume(killFile = DEFAULT_KILL_FILE) {
  const had = existsSync(killFile);
  rmSync(killFile, { force: true });
  return had;
}

// A wrapper may hold the ledger lock for as long as it runs, and kill must still
// work then, so this appends one line without taking the lock. The kill file is
// the control and the event is the record: callers change the file first, so a
// ledger failure can't undo a kill.
export function recordKillEvent(receiptsPath, event, killFile, note = "", now = () => new Date(), scope = "project") {
  mkdirSync(dirname(receiptsPath), { recursive: true });
  const line = { event, ts: now().toISOString(), scope, kill_file: killFile };
  if (note) line.note = note;
  appendFileSync(receiptsPath, `${JSON.stringify(line)}\n`);
}
