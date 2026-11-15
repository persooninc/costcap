import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createKillCheck, kill, recordKillEvent, resume } from "../src/kill.js";
import { createCapEngine, loadEvents, loadReceipts } from "../src/cap.js";
import { startMeteringProxy } from "../src/proxy.js";

test("kill writes the file, check sees it, resume clears it", () => {
  const f = join(mkdtempSync(join(tmpdir(), "cc-")), "sub", "KILL");
  const check = createKillCheck(f);
  assert.equal(check(), null);
  kill(f, "runaway");
  assert.equal(check().reason, "killed");
  assert.equal(check().note, "runaway");
  assert.equal(resume(f), true);
  assert.equal(check(), null);
  assert.equal(resume(f), false);
});

test("hand-touched kill file also kills", () => {
  const f = join(mkdtempSync(join(tmpdir(), "cc-")), "KILL");
  writeFileSync(f, "");
  assert.equal(createKillCheck(f)().reason, "killed");
});

test("proxy refuses while killed and recovers after resume, upstream untouched", async () => {
  let calls = 0;
  const up = http.createServer((req, res) => { calls++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "m", usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const f = join(mkdtempSync(join(tmpdir(), "cc-")), "KILL");
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.address().port}` }, killCheck: createKillCheck(f) });
  const call = () => fetch(`http://127.0.0.1:${port}/openai/v1/x`, { method: "POST", body: JSON.stringify({ n: Math.random() }) });
  assert.equal((await call()).status, 200);
  kill(f);
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, "killed");
  assert.equal(calls, 1);
  resume(f);
  assert.equal((await call()).status, 200);
  server.close(); up.close();
});

test("cli kill and resume subcommands", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const f = join(dir, "KILL");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const k = spawnSync("node", [cli, "kill", "--kill-file", f]);
  assert.equal(k.status, 0);
  assert.ok(existsSync(f));
  spawnSync("node", [cli, "resume", "--kill-file", f]);
  assert.ok(!existsSync(f));
});

test("wrap SIGTERMs the child when the kill file appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const f = join(dir, "KILL");
  process.env.COSTCAP_KILL_POLL_MS = "50";
  const { wrap } = await import("../src/cli.js");
  const run = wrap(["--receipts", join(dir, "r.jsonl"), "--kill-file", f, "--", "node", "-e", "setInterval(()=>{},1000)"]);
  setTimeout(() => kill(f, "test"), 300);
  const code = await Promise.race([run, new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
  assert.equal(code, 143);
});

test("kill and resume events are recorded with note and time, and are not spend", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const receipts = join(dir, "receipts.jsonl");
  const killFile = join(dir, "KILL");
  writeFileSync(receipts, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", cost_usd: 1.5 })}\n`);
  const cli = (...args) => spawnSync(process.execPath, ["src/cli.js", ...args, "--kill-file", killFile, "--receipts", receipts], { encoding: "utf8" });
  assert.equal(cli("kill", "runaway", "agent").status, 0);
  assert.equal(existsSync(killFile), true);
  assert.equal(cli("resume", "reviewed").status, 0);
  assert.equal(cli("resume").status, 0);
  const events = loadEvents(receipts);
  assert.deepEqual(events.map((e) => [e.event, e.note, e.kill_file]), [["kill", "runaway agent", killFile], ["resume", "reviewed", killFile]]);
  assert.ok(events.every((e) => Number.isFinite(Date.parse(e.ts))));
  const history = loadReceipts(receipts);
  assert.equal(history.length, 1);
  assert.doesNotThrow(() => createCapEngine({ caps: { day: 5 }, history }));
});

test("a ledger write failure warns and leaves the kill file in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "");
  const killFile = join(dir, "KILL");
  const result = spawnSync(process.execPath, ["src/cli.js", "kill", "stop", "--kill-file", killFile, "--receipts", join(blocker, "receipts.jsonl")], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /was not recorded/);
  assert.equal(existsSync(killFile), true);
});

test("recordKillEvent throws so the caller decides what a failure means", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const blocker = join(dir, "file");
  writeFileSync(blocker, "");
  assert.throws(() => recordKillEvent(join(blocker, "r.jsonl"), "kill", "KILL"));
});
