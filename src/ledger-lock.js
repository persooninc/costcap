// Receipt ledger locking.
// - lockLedger: one wrapped process owns the ledger (default mode).
// - openSharedLedger: several wrappers on ONE host share a ledger (CC-5). Every
//   decision and every append runs inside a short critical section that first
//   folds in receipts other wrappers appended, so day/month caps are shared.
//   Documented overshoot: at most one in-flight call per wrapper.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, openSync, readSync, fstatSync, closeSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

const readOwner = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

// True only when the owner is on this host and its PID is provably gone.
export function ownerIsDead(owner, host = hostname()) {
  if (!owner || owner.host !== host || !Number.isInteger(owner.pid)) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (err) { return err.code === "ESRCH"; }
}

// Shared wrappers still registered and not provably dead on this host.
function liveSharedWrappers(path) {
  const dir = `${path}.shared`;
  if (!existsSync(dir)) return [];
  const live = [];
  for (const name of readdirSync(dir)) {
    const owner = readOwner(join(dir, name));
    if (ownerIsDead(owner)) rmSync(join(dir, name), { force: true });
    else live.push(owner ?? { pid: "?", host: "?" });
  }
  return live;
}

export function lockLedger(path) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Never auto-delete an ambiguous lock or a lock on another host.
    const owner = readOwner(`${lock}/owner.json`);
    throw new Error(`Receipt ledger is locked${owner ? ` by PID ${owner.pid} on ${owner.host}` : ""}. Confirm the owner stopped before removing ${lock}.`);
  }
  try {
    writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, host: hostname() }), { mode: 0o600 });
    const shared = liveSharedWrappers(path);
    if (shared.length) throw new Error(`Receipt ledger is shared by ${shared.length} wrapper(s) (--shared-ledger). Use --shared-ledger too, or stop them.`);
  } catch (err) { rmSync(lock, { recursive: true, force: true }); throw err; }
  return () => rmSync(lock, { recursive: true, force: true });
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Short critical section on `${path}.cs`. A holder that is provably dead on this
// host is reclaimed (under a break lock so two waiters cannot both reclaim).
// Anything else (another host, unreadable owner) is waited on and then refused:
// fail closed, never delete a lock that might be live.
export function acquireCriticalSection(path, { timeoutMs = 5000, host = hostname() } = {}) {
  const lock = `${path}.cs`;
  const deadline = Date.now() + timeoutMs;
  let delay = 1;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try { writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, host }), { mode: 0o600 }); }
      catch (err) { rmSync(lock, { recursive: true, force: true }); throw err; }
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    if (ownerIsDead(readOwner(`${lock}/owner.json`), host)) breakStale(lock, host);
    if (Date.now() >= deadline) {
      const owner = readOwner(`${lock}/owner.json`);
      throw new Error(`Receipt ledger critical section held${owner ? ` by PID ${owner.pid} on ${owner.host}` : ""} past ${timeoutMs}ms. Confirm the owner stopped before removing ${lock}.`);
    }
    sleepSync(delay);
    delay = Math.min(delay * 2, 20);
  }
}

function breakStale(lock, host) {
  const brk = `${lock}.break`;
  try { mkdirSync(brk, { mode: 0o700 }); } catch { return; } // someone else is reclaiming
  try {
    // Re-check under the break lock: the lock may have been reclaimed and re-taken.
    if (ownerIsDead(readOwner(`${lock}/owner.json`), host)) rmSync(lock, { recursive: true, force: true });
  } finally { rmSync(brk, { recursive: true, force: true }); }
}

// Shared-ledger handle. onExternal(receipt) is called for every receipt another
// wrapper appended since this wrapper last looked (never for its own).
export function openSharedLedger(path, { onExternal = () => {}, timeoutMs } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const dir = `${path}.shared`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const me = join(dir, `${hostname()}-${process.pid}.json`);
  // Register first, then look for an exclusive owner (lockLedger does the reverse).
  writeFileSync(me, JSON.stringify({ pid: process.pid, host: hostname() }), { mode: 0o600 });
  const unregister = () => rmSync(me, { force: true });
  if (existsSync(`${path}.lock`)) {
    unregister();
    const owner = readOwner(`${path}.lock/owner.json`);
    throw new Error(`Receipt ledger is locked${owner ? ` by PID ${owner.pid} on ${owner.host}` : ""} by a non-shared wrapper. Confirm the owner stopped before removing ${path}.lock.`);
  }
  let offset = 0;
  let pending = "";
  const readNew = () => {
    if (!existsSync(path)) return [];
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size < offset) throw new Error("Receipt ledger shrank while shared; reconcile before running");
      const buf = Buffer.alloc(size - offset);
      if (buf.length) readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const text = pending + buf.toString("utf8");
      const end = text.lastIndexOf("\n");
      // A partial trailing line (crashed writer) is held back, never parsed.
      pending = text.slice(end + 1);
      return text.slice(0, end + 1).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } finally { closeSync(fd); }
  };
  return {
    // Reads the full ledger under the critical section and starts tracking from there.
    history() {
      const release = acquireCriticalSection(path, { timeoutMs });
      try { return readNew().filter((r) => !r.event); } finally { release(); }
    },
    // Folds other wrappers' receipts in, then runs fn, all inside the critical section.
    withLock(fn) {
      const release = acquireCriticalSection(path, { timeoutMs });
      try {
        for (const r of readNew()) if (!r.event) onExternal(r);
        const out = fn();
        // Our own append (if any) is already accounted for by the caller.
        if (existsSync(path)) { const size = statSync(path).size; if (size > offset) { offset = size; pending = ""; } }
        return out;
      } finally { release(); }
    },
    close: unregister,
  };
}

// Documented worst-case recorded spend for N wrappers sharing one cap.
export const maxSharedSpend = (cap, wrappers, maxCallCost) => cap + wrappers * maxCallCost;
