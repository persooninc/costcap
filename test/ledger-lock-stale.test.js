import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { lockLedger } from "../src/ledger-lock.js";

const fresh = () => join(mkdtempSync(join(tmpdir(), "cc-stale-")), "ledger");
const plant = (path, owner) => { mkdirSync(`${path}.lock`, { recursive: true }); writeFileSync(`${path}.lock/owner.json`, JSON.stringify(owner)); };
const deadPid = () => { const c = spawn(process.execPath, ["-e", ""]); return new Promise((r) => c.on("exit", () => r(c.pid))); };

test("stale same-host lock whose PID is gone is reclaimed with one log line", async () => {
  const path = fresh();
  plant(path, { pid: await deadPid(), host: hostname() });
  const logs = [];
  const release = lockLedger(path, { log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /reclaiming stale/);
  release();
  release(); // idempotent
  assert.equal(existsSync(`${path}.lock`), false);
});

test("same-host lock naming our own PID (previous PID 1 incarnation) is reclaimed", () => {
  const path = fresh();
  plant(path, { pid: process.pid, host: hostname() });
  const release = lockLedger(path, { log: () => {} });
  assert.throws(() => lockLedger(path, { log: () => {} }), /locked/); // but not while we hold it
  release();
});

test("live same-host lock still throws", () => {
  const path = fresh();
  plant(path, { pid: process.ppid, host: hostname() });
  assert.throws(() => lockLedger(path, { log: () => {} }), /locked by PID/);
});

test("other-host and unreadable locks still throw", async () => {
  const a = fresh();
  plant(a, { pid: await deadPid(), host: "some-other-host" });
  assert.throws(() => lockLedger(a, { log: () => {} }), /locked by PID/);
  const b = fresh();
  mkdirSync(`${b}.lock`, { recursive: true });
  writeFileSync(`${b}.lock/owner.json`, "{not json");
  assert.throws(() => lockLedger(b, { log: () => {} }), /locked/);
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`${sig} to costcap wrap forwards to the child and releases the ledger lock`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sig-"));
    const receipts = join(dir, "r.jsonl");
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--receipts", receipts, "--kill-file", join(dir, "KILL"), "--",
      process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    const deadline = Date.now() + 15000;
    while (!existsSync(`${receipts}.lock/owner.json`) ) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(existsSync(`${receipts}.lock`), "lock should be held while running");
    c.kill(sig);
    const code = await new Promise((r) => c.on("exit", (code) => r(code)));
    assert.equal(code, 128 + { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[sig], err);
    assert.equal(existsSync(`${receipts}.lock`), false, err);
  });
}
