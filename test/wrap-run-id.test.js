// #170 e2e: wrap stamps run_id on every receipt with or without --agent. Local fake upstream, no paid calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeRuns } from "../src/hosted/runs.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;

async function upstream(t) {
  const s = http.createServer((q, res) => { q.resume(); q.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }))); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return `http://127.0.0.1:${s.address().port}`;
}
function wrap(up, receipts, flags, calls) {
  const code = `for (let i = 0; i < ${calls}; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini" }) }); console.log(r.status); }`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "wrap", ...flags, "--receipts", receipts, "--kill-file", join(receipts, "..", "KILL"), "--", process.execPath, "--input-type=module", "-e", code],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: up } });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("exit", (status) => resolve({ status, err }));
  });
}
const cli = (args) => { const e = { ...process.env }; delete e.GITHUB_OUTPUT; delete e.GITHUB_STEP_SUMMARY; return spawnSync(process.execPath, [CLI, ...args], { env: e, encoding: "utf8" }); };
const metered = (f) => readFileSync(f, "utf8").trim().split("\n").map(JSON.parse).filter((l) => !l.event);

test("#170 AC1-3: wrap without --agent stamps a generated run_id that runs lists and check --run-id finds", async (t) => {
  const up = await upstream(t);
  const r = join(mkdtempSync(join(tmpdir(), "cc-wri-")), "r.jsonl");
  const a = await wrap(up, r, ["--cap", "5"], 2);
  assert.equal(a.status, 0, a.err);
  const rows = metered(r);
  assert.equal(rows.length, 2);
  const id = rows[0].run_id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.ok(rows.every((x) => x.run_id === id && !("agent_id" in x)));
  const runs = JSON.parse(cli(["runs", "--receipts", r, "--json"]).stdout);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_id, id);
  const chk = cli(["check", "--receipts", r, "--run-id", id, "--cap", "5"]);
  assert.equal(chk.status, 0, chk.stderr);
  assert.match(chk.stdout + chk.stderr, /"scope":\s*"run"/);
  assert.match(chk.stdout + chk.stderr, /0\.3/);
  // AC5: hosted run grouping sees one run, not the no-run bucket.
  const [run] = summarizeRuns(rows);
  assert.equal(run.run_id, id); assert.equal(run.calls, 2); assert.equal(run.usd_known, 0.3);
});

test("#170 AC4: wrap --run-id R1 without --agent stamps R1; receipts --run-id R1 lists them", async (t) => {
  const up = await upstream(t);
  const r = join(mkdtempSync(join(tmpdir(), "cc-wri-")), "r.jsonl");
  const a = await wrap(up, r, ["--run-id", "R1"], 2);
  assert.equal(a.status, 0, a.err);
  assert.deepEqual(metered(r).map((x) => x.run_id), ["R1", "R1"]);
  const list = cli(["receipts", "--receipts", r, "--run-id", "R1", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal((list.stdout.match(/"R1"/g) ?? []).length >= 2, true, list.stdout);
  const runs = JSON.parse(cli(["runs", "--receipts", r, "--json"]).stdout);
  assert.equal(runs[0].run_id, "R1");
});

test("#170 AC6: --policy still needs --agent", () => {
  const res = cli(["wrap", "--policy", "p.json", "--", "true"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--policy needs --agent/);
});
