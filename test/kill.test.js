import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
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

// #144 host-wide kill switch
import { hostKillFile, killStatus, readKillFile } from "../src/kill.js";
import { mkdirSync, chmodSync } from "node:fs";
const tdir = () => mkdtempSync(join(tmpdir(), "cc-host-"));

test("#144 hostKillFile honours COSTCAP_HOME and defaults under the home dir", () => {
  assert.equal(hostKillFile({ COSTCAP_HOME: "/tmp/x" }), "/tmp/x/KILL");
  assert.match(hostKillFile({}), /\.costcap[\\/]KILL$/);
});

test("#144 host OR project: either file kills, host checked first, scopes reported", () => {
  const d = tdir(), host = join(d, "home", "KILL"), proj = join(d, "proj", "KILL");
  const check = createKillCheck(proj, { hostFile: host });
  assert.equal(check(), null);
  kill(proj, "p");
  assert.deepEqual([check().kill_scope, check().kill_file, check().note], ["project", proj, "p"]);
  kill(host, "runaway");
  assert.deepEqual([check().kill_scope, check().kill_file, check().note], ["host", host, "runaway"]);
  resume(host);
  assert.equal(check().kill_scope, "project", "project kill still blocks after host resume");
  resume(proj);
  kill(host);
  assert.equal(check().kill_scope, "host", "project resume does not lift a host kill");
  assert.equal(createKillCheck(null, { hostFile: host })().kill_scope, "host");
  assert.equal(createKillCheck(null, { hostFile: null })(), null);
});

test("#144 host stat error other than ENOENT fails closed", { skip: process.getuid?.() === 0 }, () => {
  const d = tdir();
  const blocker = join(d, "file");
  writeFileSync(blocker, "");
  const k = readKillFile(join(blocker, "KILL"), "host"); // ENOTDIR
  assert.equal(k.reason, "killed");
  assert.equal(k.kill_scope, "host");
  assert.match(k.note, /kill state unknown/);
  const asDir = join(d, "KILLDIR");
  mkdirSync(asDir);
  assert.equal(readKillFile(asDir, "host").reason, "killed");
  const locked = join(d, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try { assert.match(readKillFile(join(locked, "KILL"), "host").note, /kill state unknown: EACCES/); }
  finally { chmodSync(locked, 0o700); }
});

test("#144 killStatus reports both scopes in all four combinations", () => {
  const d = tdir(), host = join(d, "h", "KILL"), proj = join(d, "p", "KILL");
  for (const [h, p] of [[false, false], [true, false], [false, true], [true, true]]) {
    resume(host); resume(proj);
    if (h) kill(host, "hn");
    if (p) kill(proj);
    const s = killStatus(proj, host);
    assert.deepEqual(s, { host: { killed: h, file: host, note: h ? "hn" : null }, project: { killed: p, file: proj, note: null } });
  }
});

test("#144 kill/resume --host CLI: separate files, scoped receipts, --status JSON", () => {
  const d = tdir(), home = join(d, "home"), receipts = join(d, "r.jsonl"), proj = join(d, "KILL");
  const env = { ...process.env, COSTCAP_HOME: home };
  const run = (...a) => spawnSync(process.execPath, ["src/cli.js", ...a], { encoding: "utf8", env });
  assert.equal(run("kill", "--host", "runaway", "--receipts", receipts).status, 0);
  assert.equal(existsSync(join(home, "KILL")), true);
  run("kill", "--kill-file", proj, "--receipts", receipts);
  let st = JSON.parse(run("kill", "--status", "--kill-file", proj).stdout);
  assert.equal(st.host.killed && st.project.killed && st.host.note === "runaway", true);
  run("resume", "--kill-file", proj, "--receipts", receipts);
  assert.equal(existsSync(join(home, "KILL")), true, "project resume leaves host file");
  run("kill", "--kill-file", proj, "--receipts", receipts);
  run("resume", "--host", "--receipts", receipts);
  assert.equal(existsSync(join(home, "KILL")), false);
  assert.equal(existsSync(proj), true, "host resume leaves project file");
  st = JSON.parse(run("kill", "--status", "--kill-file", proj).stdout);
  assert.deepEqual([st.host.killed, st.project.killed], [false, true]);
  const events = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => `${e.event}:${e.scope}`), ["kill:host", "kill:project", "resume:project", "kill:project", "resume:host"]);
  assert.equal(events[0].kill_file, join(home, "KILL"));
  assert.equal(events[0].note, "runaway");
});

test("#194 kill closes an open Realtime session mid-stream and refuses new handshakes", async (t) => {
  const { connectRealtime, startRealtimeUpstream } = await import("./fixtures/realtime-upstream.js");
  let conn;
  const up = await startRealtimeUpstream({ onSession: (c) => { conn = c; } });
  const f = join(mkdtempSync(join(tmpdir(), "cc-")), "KILL");
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url }, killCheck: createKillCheck(f), onReceipt: (r) => receipts.push(r) });
  t.after(async () => { server.close(); await up.close(); });
  const c = await connectRealtime(port, "/openai/v1/realtime?model=gpt-realtime");
  while (!conn) await new Promise((r) => setTimeout(r, 10));
  conn.send({ type: "response.created", response: { id: "r_live" } });
  const t0 = Date.now();
  kill(f, "stop");
  await c.closed;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(c.closeCode, 1008);
  assert.ok(receipts.some((r) => r.blocked && r.reason === "killed" && r.transport === "websocket"));
  // The in-flight response is an honest unknown.
  assert.equal(receipts.find((r) => r.response_id === "r_live").reason, "stream_incomplete");
  const again = await connectRealtime(port, "/openai/v1/realtime?model=gpt-realtime");
  assert.equal(again.status, 429);
  assert.equal(up.upgrades, 1);
});

test("#273 kill closes a GPT-Live session within 1 s and still bills its final seconds", async (t) => {
  const { connectRealtime, startRealtimeUpstream } = await import("./fixtures/realtime-upstream.js");
  const up = await startRealtimeUpstream({ onMessage: (conn, m) => {
    if (m.type === "session.start") conn.send({ type: "session.started", session: { id: "ls", model: "gpt-live-1" } });
    if (m.type === "session.close") conn.send({ type: "session.closed", usage: { seconds: 6 } });
  } });
  const f = join(mkdtempSync(join(tmpdir(), "cc-")), "KILL");
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: up.url }, killCheck: createKillCheck(f), onReceipt: (r) => receipts.push(r) });
  t.after(async () => { server.close(); await up.close(); });
  const c = await connectRealtime(port, "/openai/v1/live/sessions");
  c.send({ type: "session.start", session: { model: "gpt-live-1" } });
  await c.waitFor((m) => m.type === "session.started");
  const t0 = Date.now();
  kill(f, "stop");
  await c.closed;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(c.closeCode, 1008);
  const t1 = Date.now();
  while (!receipts.some((r) => r.billed_seconds === 6) && Date.now() - t1 < 3000) await new Promise((r) => setTimeout(r, 10));
  assert.equal(receipts.find((r) => r.billed_seconds === 6).cost_usd, 0.005);
  assert.ok(receipts.some((r) => r.blocked && r.reason === "killed" && r.path === "/v1/live/sessions"));
});
