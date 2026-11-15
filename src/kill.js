// Kill switch: a kill file freezes every wrapped agent that shares it.
// While the file exists the proxy refuses all upstream calls (429 killed).
// `costcap kill` writes it, `costcap resume` removes it. Touching the file
// by hand works too. Local enforcement only: traffic outside the proxy is
// not stopped.

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_KILL_FILE = ".costcap/KILL";

export function createKillCheck(killFile = DEFAULT_KILL_FILE) {
  return () => {
    // A stat error other than "not found" means the state is unknown, so it kills.
    try { statSync(killFile); }
    catch (err) {
      if (err.code === "ENOENT") return null;
      return { reason: "killed", kill_file: killFile, note: `kill state unknown: ${err.code}` };
    }
    let reason = "";
    try { reason = readFileSync(killFile, "utf8").trim(); } catch { /* unreadable: still killed */ }
    return { reason: "killed", kill_file: killFile, note: reason || undefined };
  };
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
export function recordKillEvent(receiptsPath, event, killFile, note = "", now = () => new Date()) {
  mkdirSync(dirname(receiptsPath), { recursive: true });
  const line = { event, ts: now().toISOString(), kill_file: killFile };
  if (note) line.note = note;
  appendFileSync(receiptsPath, `${JSON.stringify(line)}\n`);
}
