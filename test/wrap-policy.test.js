import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("wrapper cannot loosen a cached fleet policy", async () => {
  let hits = 0;
  let servedPolicy = { version: 1, caps: { run: 100 }, killed: false };
  const up = http.createServer((req, res) => {
    hits++;
    res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));
  });
  const fleet = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/policy") res.end(JSON.stringify(servedPolicy));
      else if (req.url === "/v1/receipts") res.end(JSON.stringify({ acceptedIds: JSON.parse(text).receipts.map((r) => r.id) }));
      else { res.statusCode = 404; res.end("{}"); }
    });
  });
  const upPort = await listen(up);
  const fleetPort = await listen(fleet);
  const dir = mkdtempSync(join(tmpdir(), "cc-policy-"));
  const enrollment = join(dir, "enrollment.json");
  const receipts = join(dir, "r.jsonl");
  writeFileSync(enrollment, JSON.stringify({
    url: `http://127.0.0.1:${fleetPort}`,
    token: "agent-token",
    agentId: "agent-1",
    policy: { version: 1, caps: { run: 0.10 }, killed: false },
    syncedIds: [],
  }), { mode: 0o600 });
  const script = `for (let i = 0; i < 3; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: JSON.stringify({ n: i }) }); console.log(r.status); if (r.status === 429) break; }`;
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "wrap", ...args, "--enrollment", enrollment, "--receipts", receipts, "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}` } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out, err }));
  });
  const loose = await run(["--cap", "50"]);
  assert.equal(loose.code, 0, loose.err);
  assert.equal(loose.out.replace(/\x1b\[[0-9;]*m/g, "").trim(), "200\n429");
  assert.equal(hits, 1);
  const cached = JSON.parse(readFileSync(enrollment, "utf8"));
  assert.equal(cached.policy.caps.run, 0.10);
  servedPolicy = { version: 2, caps: { run: 10 }, killed: false };
  writeFileSync(enrollment, JSON.stringify({ ...cached, policy: { version: 1, caps: { run: 10 }, killed: false }, syncedIds: [] }));
  hits = 0;
  const tightened = await run(["--cap", "0.05"]);
  assert.equal(tightened.code, 0, tightened.err);
  assert.equal(tightened.out.replace(/\x1b\[[0-9;]*m/g, "").trim(), "200\n429");
  assert.equal(hits, 1);
  const updated = JSON.parse(readFileSync(enrollment, "utf8"));
  assert.equal(updated.policy.version, 2);
  assert.equal(updated.policy.caps.run, 10);
  up.close();
  fleet.close();
});

test("#114 enrolled wrapper enforces the cached hosted maxSteps per run, offline, tighter wins", async () => {
  let hits = 0;
  const up = http.createServer((req, res) => {
    hits++;
    res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 0 } }));
  });
  const upPort = await listen(up);
  // The hosted API is stopped: grab a port, then close it so every sync fails.
  const dead = http.createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => dead.close(r));
  const dir = mkdtempSync(join(tmpdir(), "cc-steps-"));
  const enrollment = join(dir, "enrollment.json");
  const receipts = join(dir, "r.jsonl");
  writeFileSync(enrollment, JSON.stringify({
    url: `http://127.0.0.1:${deadPort}`, token: "agent-token", agentId: "agent-1",
    policy: { version: 2, caps: {}, killed: false, maxSteps: 5 }, syncedIds: [],
  }), { mode: 0o600 });
  const script = `for (let i = 0; i < 8; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: "{}" }); console.log(r.status); if (r.status === 429) { const b = await r.json(); console.log(b.error + "/" + b.reason); break; } }`;
  const run = (args = []) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "wrap", ...args, "--enrollment", enrollment, "--receipts", receipts, "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}` } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n"), err }));
  });
  const first = await run();
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /fleet offline; cached policy enforced/);
  assert.deepEqual(first.out, ["200", "200", "200", "200", "200", "429", "breaker_open/step_budget"]);
  assert.equal(hits, 5);
  const blocked = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.blocked);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, "step_budget");
  assert.equal(blocked[0].max_steps, 5);
  // A new run starts at 0 again.
  hits = 0;
  assert.equal((await run()).out.filter((s) => s === "200").length, 5);
  // Local 3 tightens; local 10 cannot loosen.
  assert.equal((await run(["--max-steps", "3"])).out.filter((s) => s === "200").length, 3);
  assert.equal((await run(["--max-steps", "10"])).out.filter((s) => s === "200").length, 5);
  up.close();
});

// #265: a hosted caps.total refuses the next call once synced (all-time) spend
// plus this host's unsynced spend reaches it; no Retry-After, upstream untouched.
// A local --policy file accepts `total` for agents too.
test("#265 enrolled wrapper refuses at caps.total with scope total and no Retry-After; local policy total", async () => {
  let hits = 0;
  const now = new Date().toISOString();
  const servedPolicy = { version: 2, caps: { total: 10, month: 100 }, killed: false, agent_spend: { spent: { day: 0, week: 0, month: 3, total: 9.5 }, unknown: 0, pending_batches: 0, as_of: now } };
  const up = http.createServer((req, res) => {
    hits++;
    res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));
  });
  const fleet = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/policy") res.end(JSON.stringify(servedPolicy));
      else if (req.url === "/v1/receipts") res.end(JSON.stringify({ acceptedIds: [] })); // never synced: counts as unsynced
      else { res.statusCode = 404; res.end("{}"); }
    });
  });
  const upPort = await listen(up);
  const fleetPort = await listen(fleet);
  const dir = mkdtempSync(join(tmpdir(), "cc-total-"));
  const enrollment = join(dir, "enrollment.json");
  writeFileSync(enrollment, JSON.stringify({ url: `http://127.0.0.1:${fleetPort}`, token: "agent-token", agentId: "agent-1", policy: { version: 1, caps: {}, killed: false }, syncedIds: [] }), { mode: 0o600 });
  const script = `for (let i = 0; i < 3; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: JSON.stringify({ n: i }) }); const b = await r.json(); console.log(r.status, r.headers.get("retry-after"), b.scope ?? b.error?.scope ?? "", b.message ?? b.error?.message ?? ""); if (r.status === 429) break; }`;
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.js", "wrap", ...args, "--receipts", join(dir, `r-${args.length}.jsonl`), "--kill-file", join(dir, "KILL"), "--", process.execPath, "--input-type=module", "-e", script], { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${upPort}` } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n"), err }));
  });
  try {
    // gpt-4o-mini: 1M input tokens = $0.15; $9.50 + $0.15 < $10 -> first call goes, then 429.
    servedPolicy.agent_spend.spent.total = 9.9;
    const hosted = await run(["--enrollment", enrollment]);
    assert.equal(hosted.code, 0, hosted.err);
    assert.match(hosted.out[0], /^200 /);
    assert.match(hosted.out[1], /^429 null total .*never resets/);
    assert.equal(hits, 1);
    // Local --policy file with an agent total.
    hits = 0;
    const policy = join(dir, "policy.json");
    writeFileSync(policy, JSON.stringify({ agents: { local: { total: 0.1 } } }));
    const local = await run(["--policy", policy, "--agent", "local"]);
    assert.equal(local.code, 0, local.err);
    assert.match(local.out[0], /^200 /);
    assert.match(local.out[1], /^429 null total .*never resets/);
    assert.equal(hits, 1);
  } finally {
    up.close();
    fleet.close();
  }
});
