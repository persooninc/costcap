// Single-process durable beta datastore. Never run multiple replicas against it.
// Store interface (shared with store-postgres.js): mode, read(fn), transaction(fn), flush().
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const EMPTY_STATE = Object.freeze({ version: 1, orgs: {}, users: {}, sessions: {}, challenges: {}, enrollments: {}, agents: {}, receipts: {}, audit: [], alerts: {} });

/**
 * In-memory state with synchronous, all-or-nothing transactions. `commit(next)` runs
 * inside the transaction before the new state is published; if it throws, nothing changes.
 */
export function memoryCore(initial, commit = () => {}) {
  let state = initial;
  let busy = false;
  return {
    read(fn) { return fn(structuredClone(state)); },
    transaction(fn) {
      if (busy) throw new Error("Nested transactions are refused");
      busy = true;
      try {
        const next = structuredClone(state);
        const result = fn(next);
        if (result?.then) throw new Error("Transactions must be synchronous");
        commit(next);
        state = next;
        return result;
      } finally { busy = false; }
    },
  };
}

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : structuredClone(EMPTY_STATE);
  if (state.version !== 1) throw new Error("Unknown store version");
  if (existsSync(path)) chmodSync(path, 0o600);
  const core = memoryCore(state, (next) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flush: true });
    renameSync(temporary, path);
  });
  return {
    mode: "single-process-file",
    ...core,
    // Writes are synchronous; there is never anything pending.
    async flush() {},
    healthy() { return true; },
  };
}
