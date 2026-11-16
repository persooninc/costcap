// #144 regression/e2e: one `costcap kill --host` freezes two real `costcap wrap`
// processes running in different directories with separate project kill files.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const CLI = path.resolve("src/cli.js");

test("#144 costcap kill --host blocks and stops wrappers in two directories; upstream sees no calls after", async (t) => {
  let calls = 0, killedAt = null, callsAfterKill = 0;
  const up = http.createServer((req, res) => {
    calls++; if (killedAt) callsAfterKill++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  t.after(() => up.close());
  const root = mkdtempSync(path.join(tmpdir(), "cc-hostkill-"));
  const home = path.join(root, "home");
  const env = { ...process.env, COSTCAP_HOME: home, COSTCAP_KILL_POLL_MS: "100", COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.address().port}` };
  // Calls until it sees a 429, prints it, then idles so only costcap's SIGTERM ends it.
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    let first = true;
    for (;;) {
      const r = await fetch(u, { method: "POST", body: JSON.stringify({ n: Math.random() }) });
      if (first) { console.log("ready " + r.status); first = false; }
      if (r.status === 429) { console.log("blocked " + JSON.stringify(await r.json())); break; }
      await new Promise((s) => setTimeout(s, 50));
    }
    setInterval(() => {}, 1000);`;
  const wraps = ["a", "b"].map((name) => {
    const cwd = path.join(root, name);
    mkdirSync(cwd, { recursive: true });
    const c = spawn(process.execPath, [CLI, "wrap", "--receipts", path.join(cwd, ".costcap", "r.jsonl"), "--", process.execPath, "--input-type=module", "-e", script], { cwd, env });
    const w = { cwd, out: "", err: "" };
    c.stdout.on("data", (d) => (w.out += d));
    c.stderr.on("data", (d) => (w.err += d));
    w.exit = new Promise((r) => c.on("exit", (code) => r(code)));
    w.ready = new Promise((r) => { const i = setInterval(() => { if (w.out.includes("ready")) { clearInterval(i); r(); } }, 20); });
    t.after(() => c.kill("SIGKILL"));
    return w;
  });
  await Promise.all(wraps.map((w) => w.ready));
  assert.ok(calls >= 2);
  const k = spawnSync(process.execPath, [CLI, "kill", "--host", "runaway", "--receipts", path.join(root, "ev.jsonl")], { cwd: root, env, encoding: "utf8" });
  assert.equal(k.status, 0, k.stderr);
  killedAt = Date.now();
  const codes = await Promise.all(wraps.map((w) => w.exit));
  // In-flight requests that had already passed the kill check may land just after the file appears.
  assert.ok(callsAfterKill <= 2, `upstream calls after kill: ${callsAfterKill}`);
  const hostFile = path.join(home, "KILL");
  for (const [i, w] of wraps.entries()) {
    assert.equal(codes[i], 143, w.err);
    assert.match(w.err, /kill file present, stopping wrapped process/);
    const lines = readFileSync(path.join(w.cwd, ".costcap", "r.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const blocked = lines.filter((l) => l.blocked && l.reason === "killed");
    if (blocked.length) assert.deepEqual([blocked[0].kill_scope, blocked[0].kill_file], ["host", hostFile]);
    const runsDir = path.join(w.cwd, ".costcap", "runs");
    const summary = JSON.parse(readFileSync(path.join(runsDir, readdirSync(runsDir)[0]), "utf8"));
    assert.deepEqual([summary.stopped_by, summary.kill_scope, summary.kill_file], ["killed", "host", hostFile]);
  }
  const blockedOut = wraps.filter((w) => w.out.includes("blocked "));
  for (const w of blockedOut) assert.match(w.out, /"kill_scope":"host"/);
});

test("#144 project kill records kill_scope project in the run summary", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cc-projkill-"));
  const env = { ...process.env, COSTCAP_HOME: path.join(root, "home"), COSTCAP_KILL_POLL_MS: "100" };
  const c = spawn(process.execPath, [CLI, "wrap", "--", process.execPath, "-e", "setInterval(()=>{},1000)"], { cwd: root, env });
  c.stderr.on("data", () => {});
  await new Promise((r) => setTimeout(r, 500));
  spawnSync(process.execPath, [CLI, "kill", "stop"], { cwd: root, env });
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 143);
  const runsDir = path.join(root, ".costcap", "runs");
  const summary = JSON.parse(readFileSync(path.join(runsDir, readdirSync(runsDir)[0]), "utf8"));
  assert.deepEqual([summary.stopped_by, summary.kill_scope, summary.kill_file], ["killed", "project", ".costcap/KILL"]);
});
