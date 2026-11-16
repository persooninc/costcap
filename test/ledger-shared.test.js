// CC-5 (#116): several wrappers on one host share one ledger's day/month caps.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockLedger, openSharedLedger, acquireCriticalSection, ownerIsDead, maxSharedSpend } from "../src/ledger-lock.js";
import { createCapEngine } from "../src/cap.js";
import { parseWrapArgs } from "../src/cli.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "cc-shared-")), "r.jsonl");
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;
const CALL_COST = 0.00015; // gpt-4o-mini, 1000 input tokens

// ---- unit: primitive ----
test("maxSharedSpend is cap plus one in-flight call per wrapper", () => {
  assert.equal(maxSharedSpend(1, 4, 0.25), 2);
  assert.equal(maxSharedSpend(0.03, 1, 0), 0.03);
});

test("critical section is exclusive and re-acquirable after release", () => {
  const path = tmp();
  const release = acquireCriticalSection(path);
  assert.throws(() => acquireCriticalSection(path, { timeoutMs: 30 }), /critical section held by PID \d+/);
  release();
  acquireCriticalSection(path)();
});

test("a provably dead same-host holder is reclaimed; another host's lock is refused (fail closed)", () => {
  const path = tmp();
  mkdirSync(`${path}.cs`);
  writeFileSync(`${path}.cs/owner.json`, JSON.stringify({ pid: deadPid(), host: "h1" }));
  acquireCriticalSection(path, { host: "h1" })();
  mkdirSync(`${path}.cs`);
  writeFileSync(`${path}.cs/owner.json`, JSON.stringify({ pid: deadPid(), host: "other-host" }));
  assert.throws(() => acquireCriticalSection(path, { host: "h1", timeoutMs: 30 }), /held by PID .* on other-host/);
  assert.ok(existsSync(`${path}.cs`), "never deletes another host's lock");
});

test("an unreadable owner is never reclaimed", () => {
  const path = tmp();
  mkdirSync(`${path}.cs`);
  assert.throws(() => acquireCriticalSection(path, { timeoutMs: 30 }), /held past 30ms/);
});

test("a reclaim already in progress is not duplicated", () => {
  const path = tmp();
  mkdirSync(`${path}.cs`);
  writeFileSync(`${path}.cs/owner.json`, JSON.stringify({ pid: deadPid(), host: "h1" }));
  mkdirSync(`${path}.cs.break`);
  assert.throws(() => acquireCriticalSection(path, { host: "h1", timeoutMs: 30 }), /held/);
});

test("ownerIsDead only trusts same-host, integer, gone PIDs", () => {
  assert.equal(ownerIsDead(null), false);
  assert.equal(ownerIsDead({ pid: process.pid, host: "h" }, "h"), false);
  assert.equal(ownerIsDead({ pid: "x", host: "h" }, "h"), false);
  assert.equal(ownerIsDead({ pid: deadPid(), host: "h" }, "h"), true);
});

test("shared and exclusive wrappers refuse each other", () => {
  const path = tmp();
  const shared = openSharedLedger(path);
  assert.throws(() => lockLedger(path), /shared by 1 wrapper/);
  const second = openSharedLedger(path); // shared + shared is fine
  shared.close(); second.close();
  const release = lockLedger(path);
  assert.throws(() => openSharedLedger(path), /non-shared wrapper/);
  release();
});

test("a dead shared registration does not block an exclusive wrapper", () => {
  const path = tmp();
  mkdirSync(`${path}.shared`, { recursive: true });
  const os = spawnSync(process.execPath, ["-p", "require('os').hostname()"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(`${path}.shared/x.json`, JSON.stringify({ pid: deadPid(), host: os }));
  lockLedger(path)();
});

test("withLock folds in only other wrappers' receipts and holds back a partial line", () => {
  const path = tmp();
  appendFileSync(path, JSON.stringify({ id: "a", ts: new Date().toISOString(), cost_usd: 1 }) + "\n" + JSON.stringify({ event: "kill" }) + "\n");
  const seen = [];
  const led = openSharedLedger(path, { onExternal: (r) => seen.push(r.id) });
  assert.deepEqual(led.history().map((r) => r.id), ["a"]);
  led.withLock(() => appendFileSync(path, JSON.stringify({ id: "mine", ts: new Date().toISOString(), cost_usd: 1 }) + "\n"));
  appendFileSync(path, JSON.stringify({ id: "b", cost_usd: 1 }) + "\n" + '{"id":"c"');
  led.withLock(() => {});
  assert.deepEqual(seen, ["b"]);
  appendFileSync(path, ',"cost_usd":1}\n');
  led.withLock(() => {});
  assert.deepEqual(seen, ["b", "c"]);
  led.close();
});

test("withLock refuses a ledger that shrank underneath it", () => {
  const path = tmp();
  appendFileSync(path, '{"id":"a","cost_usd":1}\n');
  const led = openSharedLedger(path);
  led.history();
  writeFileSync(path, "");
  assert.throws(() => led.withLock(() => {}), /shrank/);
  led.close();
});

test("external receipts count toward day/month but not this wrapper's run", () => {
  const cap = createCapEngine({ caps: { run: 1, day: 2 } });
  cap.record({ ts: new Date().toISOString(), cost_usd: 1.5 }, { external: true });
  assert.equal(cap.spend().run, 0);
  assert.equal(cap.spend().day, 1.5);
  cap.record({ ts: new Date().toISOString(), cost_usd: null }, { external: true });
  assert.equal(cap.check().reason, "unreconciled_receipt");
});

test("parseWrapArgs reads --shared-ledger as a boolean flag", () => {
  assert.equal(parseWrapArgs(["--shared-ledger", "--day-cap", "1", "--", "x"]).sharedLedger, true);
  assert.equal(parseWrapArgs(["--day-cap", "1", "--shared-ledger", "--", "x"]).sharedLedger, true);
  assert.equal(parseWrapArgs(["--", "x"]).sharedLedger, undefined);
});

// ---- integration / regression: real node wrapper processes ----
async function fakeUpstream(t) {
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => {
      let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
        const usage = b.includes("poison") ? undefined : { prompt_tokens: 1000, completion_tokens: 0 };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage }));
      });
    });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  return up;
}

function runWrap(args, script, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...args, "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, ...env } });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => resolve({ code, out, err }));
  });
}

test("N wrappers on one ledger share the day cap within the documented overshoot (500+ calls, valid NDJSON)", { timeout: 120_000 }, async (t) => {
  const up = await fakeUpstream(t);
  const path = tmp();
  const N = 4, CALLS = 140, DAY = 0.03;
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const out = [];
    for (let n = 0; n < ${CALLS}; n++) { const r = await fetch(u,{method:"POST",body:JSON.stringify({n, w: process.pid})}); const j = await r.json(); out.push(r.status === 200 ? 200 : j.error?.type ?? j.error); }
    console.log(JSON.stringify(out));`;
  const runs = await Promise.all(Array.from({ length: N }, () =>
    runWrap(["--shared-ledger", "--day-cap", String(DAY), "--receipts", path], script, { COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` })));
  for (const r of runs) {
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /locked/);
    const statuses = JSON.parse(r.out);
    assert.equal(statuses.at(-1), "budget_exceeded");
    // Once refused, never allowed again.
    assert.ok(statuses.slice(statuses.indexOf("budget_exceeded")).every((s) => s === "budget_exceeded"));
  }
  const lines = readFileSync(path, "utf8").split("\n");
  assert.equal(lines.pop(), "");
  const receipts = lines.map((l) => JSON.parse(l)); // throws on interleaved/partial lines
  assert.ok(receipts.length >= 500, `only ${receipts.length} receipts`);
  const spent = receipts.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  assert.ok(spent >= DAY, `spent ${spent}`);
  assert.ok(spent <= maxSharedSpend(DAY, N, CALL_COST) + 1e-9, `spent ${spent} over cap+overshoot`);
});

test("an unknown-cost receipt from one wrapper blocks every wrapper sharing the ledger", { timeout: 60_000 }, async (t) => {
  const up = await fakeUpstream(t);
  const dir = mkdtempSync(join(tmpdir(), "cc-shared-"));
  const path = join(dir, "r.jsonl"), go = join(dir, "go");
  const env = { COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}`, GO_FILE: go, LEDGER: path };
  const victim = `
    import { existsSync } from "node:fs";
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const a = await fetch(u,{method:"POST",body:"{}"});
    while (!existsSync(process.env.GO_FILE)) await new Promise((r) => setTimeout(r, 20));
    const b = await fetch(u,{method:"POST",body:'{"n":2}'});
    const j = await b.json();
    console.log(a.status, b.status, j.error.type, j.error.scope);`;
  const poisoner = `
    import { writeFileSync, readFileSync } from "node:fs";
    // Wait until both victims' first (priced) calls are in the ledger, not a fixed delay.
    const priced = () => { try { return readFileSync(process.env.LEDGER, "utf8").split("\\n").filter((l) => l && JSON.parse(l).cost_usd > 0).length; } catch { return 0; } };
    while (priced() < 2) await new Promise((r) => setTimeout(r, 20));
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const a = await fetch(u,{method:"POST",body:'{"poison":1}'});
    writeFileSync(process.env.GO_FILE, "1");
    console.log(a.status);`;
  const args = ["--shared-ledger", "--day-cap", "5", "--receipts", path];
  const [v1, v2, p] = await Promise.all([runWrap(args, victim, env), runWrap(args, victim, env), runWrap(args, poisoner, env)]);
  assert.equal(p.out.trim(), "200");
  for (const v of [v1, v2]) assert.equal(v.out.trim(), "200 429 budget_exceeded accounting", v.err);
  assert.ok(readFileSync(path, "utf8").split("\n").filter(Boolean).some((l) => JSON.parse(l).cost_usd === null));
});

test("a holder SIGKILLed inside the critical section does not deadlock other wrappers", { timeout: 60_000 }, async (t) => {
  const up = await fakeUpstream(t);
  const path = tmp();
  const holder = spawn(process.execPath, ["--input-type=module", "-e",
    `import { acquireCriticalSection } from ${JSON.stringify(new URL("../src/ledger-lock.js", import.meta.url).href)};
     acquireCriticalSection(${JSON.stringify(path)}); console.log("held"); setInterval(() => {}, 1000);`]);
  await new Promise((r) => holder.stdout.once("data", r));
  holder.kill("SIGKILL");
  await new Promise((r) => holder.once("exit", r));
  assert.ok(existsSync(`${path}.cs`), "lock left behind by the crashed holder");
  const script = `const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const r = await Promise.all([1,2,3].map((n) => fetch(u,{method:"POST",body:JSON.stringify({n})}))); console.log(r.map((x) => x.status).join(" "));`;
  const runs = await Promise.all([1, 2].map(() => runWrap(["--shared-ledger", "--day-cap", "5", "--receipts", path], script, { COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` })));
  for (const r of runs) assert.equal(r.out.trim(), "200 200 200", r.err);
  assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 6);
});
