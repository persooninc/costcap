import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWrapArgs } from "../src/cli.js";

test("costcap --version prints the package.json version and exits 0", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const flag of ["--version", "-v", "version"]) {
    const r = spawnSync(process.execPath, ["src/cli.js", flag], { encoding: "utf8" });
    assert.equal(r.status, 0, `${flag} should exit 0`);
    assert.equal(r.stdout.trim(), pkg.version);
  }
});

test("costcap --help and no args print usage and exit 0", () => {
  for (const argv of [["src/cli.js", "--help"], ["src/cli.js", "-h"], ["src/cli.js"]]) {
    const r = spawnSync(process.execPath, argv, { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /usage: costcap wrap/);
  }
});

test("costcap with an unknown command exits 2 with usage on stderr", () => {
  const r = spawnSync(process.execPath, ["src/cli.js", "bogus"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command "bogus"/);
  assert.match(r.stderr, /usage: costcap wrap/);
});

test("parseWrapArgs reads --cap and the command after --", () => {
  const o = parseWrapArgs(["--cap", "5.00", "--", "node", "-e", "1"]);
  assert.equal(o.caps.run, 5);
  assert.deepEqual(o.command, ["node", "-e", "1"]);
});

test("parseWrapArgs rejects bad caps, unknown flags, and a missing command", () => {
  assert.throws(() => parseWrapArgs(["--cap", "abc", "--", "x"]), /positive number/);
  assert.throws(() => parseWrapArgs(["--cap", "-1", "--", "x"]), /positive number/);
  assert.throws(() => parseWrapArgs(["--bogus", "1", "--", "x"]), /unknown flag/);
  assert.throws(() => parseWrapArgs(["--cap", "1"]), /usage/);
});

test("wrap points the child at the proxy and the cap hard-stops the second call", async (t) => {
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } })));
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  // The child calls the proxy twice; the first call costs $0.45 which exceeds the $0.10 cap.
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const a = await fetch(u,{method:"POST",body:JSON.stringify({n:1})});
    const b = await fetch(u,{method:"POST",body:JSON.stringify({n:2})});
    console.log(a.status, b.status);`;
  // Upstream is real OpenAI by default, so run the proxy against the mock by pre-setting nothing: use env override below.
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--cap", "0.10", "--receipts", path.join(dir, "r.jsonl"), "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(res.code, 0);
  assert.equal(res.out.replace(/\x1b\[[0-9;]*m/g, "").trim(), "200 429");
});

test("parseWrapArgs reads --max-steps and --velocity-multiple and validates them", () => {
  const o = parseWrapArgs(["--max-steps", "40", "--velocity-multiple", "4", "--", "x"]);
  assert.equal(o.maxSteps, 40);
  assert.equal(o.velocityMultiple, 4);
  assert.throws(() => parseWrapArgs(["--max-steps", "0", "--", "x"]), /positive integer/);
  assert.throws(() => parseWrapArgs(["--max-steps", "1.5", "--", "x"]), /positive integer/);
  assert.throws(() => parseWrapArgs(["--velocity-multiple", "1", "--", "x"]), /greater than 1/);
});

test("wrap --max-steps 2 lets two calls through and breaks the third with breaker_open", async (t) => {
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 } })));
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const out = [];
    for (let n = 0; n < 3; n++) { const r = await fetch(u,{method:"POST",body:JSON.stringify({n})}); out.push(r.status); if (r.status===429) out.push((await r.json()).error); }
    console.log(out.join(" "));`;
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--max-steps", "2", "--receipts", path.join(dir, "r.jsonl"), "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(res.code, 0);
  assert.equal(res.out.replace(/\x1b\[[0-9;]*m/g, "").trim(), "200 200 429 breaker_open");
});

test("e2e: unknown-cost receipt blocks the next run until reconcile --apply settles it (costcap#124)", async (t) => {
  const { writeFileSync } = await import("node:fs");
  // Upstream answers with no usage block, so the receipt cost is unknown.
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini" })));
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-settle-"));
  const receipts = path.join(dir, "r.jsonl");
  const script = `const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions",{method:"POST",body:"{}"}); console.log(r.status);`;
  const run = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--day-cap", "5", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "").trim() }));
  });
  const first = await run();
  assert.match(first.out, /200/);
  const unknown = readFileSync(receipts, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.event && r.cost_usd === null);
  assert.equal(unknown.length, 1);
  const second = await run();
  assert.match(second.out, /429/, "next run is refused while cost is unknown");
  const provider = path.join(dir, "provider.jsonl");
  writeFileSync(provider, JSON.stringify({ id: unknown[0].id, cost_usd: 0.42 }) + "\n");
  const ap = spawnSync(process.execPath, ["src/cli.js", "reconcile", "--receipts", receipts, "--provider", provider, "--apply"], { encoding: "utf8" });
  assert.equal(ap.status, 0, ap.stderr);
  assert.deepEqual(JSON.parse(ap.stdout).settled, [{ receipt_id: unknown[0].id, cost_usd: 0.42 }]);
  const third = await run();
  assert.match(third.out, /200/, "settled ledger allows the next run");
  const chk = spawnSync(process.execPath, ["src/cli.js", "check", "--receipts", receipts], { encoding: "utf8" });
  const body = JSON.parse(chk.stdout);
  assert.equal(body.total_usd >= 0.42, true);
});

test("regression #130: wrap blocks a Gemini ?key= call by cap and no file under the receipts dir holds the key", async (t) => {
  const { readdirSync } = await import("node:fs");
  const seen = [];
  const up = await new Promise((r) => {
    const s = http.createServer((req, res) => { seen.push(req.url); res.end('{"modelVersion":"gemini-2.5-pro","usageMetadata":{"promptTokenCount":1000000,"candidatesTokenCount":0}}'); });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-130w-"));
  const script = `
    const u = process.env.GEMINI_BASE_URL + "/v1beta/models/gemini-2.5-pro:generateContent?key=SECRET123";
    const a = await fetch(u,{method:"POST",body:"{}"});
    const b = await fetch(u,{method:"POST",body:"{}"});
    console.log(a.status, b.status);`;
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--cap", "0.10", "--receipts", path.join(dir, "r.jsonl"), "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_GEMINI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(res.out.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").at(-1), "200 429");
  assert.deepEqual(seen, ["/v1beta/models/gemini-2.5-pro:generateContent?key=SECRET123"]);
  const files = readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => { try { readFileSync(f); return true; } catch { return false; } });
  assert.ok(files.length > 0);
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /SECRET123/, f);
  assert.match(readFileSync(path.join(dir, "r.jsonl"), "utf8"), /key=REDACTED/);
});

test("#135 wrap: first call 429 (provider rejected), second 200 with usage; both complete and check reports known spend", async (t) => {
  let n = 0;
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => (n++ === 0
      ? res.writeHead(429, { "content-type": "application/json" }).end('{"error":{"type":"rate_limit_error","message":"slow down"}}')
      : res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1000, completion_tokens: 100 } }))));
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const receipts = path.join(dir, "r.jsonl");
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/chat/completions";
    const a = await fetch(u,{method:"POST",body:JSON.stringify({model:"gpt-4o-mini",n:1})});
    const b = await fetch(u,{method:"POST",body:JSON.stringify({model:"gpt-4o-mini",n:2})});
    console.log(a.status, b.status);`;
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => resolve({ code, out, err }));
  });
  assert.equal(res.code, 0);
  assert.equal(res.out.replace(/\x1b\[[0-9;]*m/g, "").trim(), "429 200");
  assert.match(res.err, /calls=2 rejected=1 refused=0 .*cost=\$0\.\d+/);
  const lines = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse).filter((r) => "cost_usd" in r);
  assert.deepEqual(lines.map((r) => r.reason ?? "metered"), ["upstream_rejected", "metered"]);
  const check = spawnSync(process.execPath, ["src/cli.js", "check", "--cap", "1", "--receipts", receipts], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout + check.stderr, /unknown[^0-9]*0|"unknown_cost_count":\s*0/i);
});

test("#138 wrap: duration-style usage pauses the run, check exits 1 accounting_unavailable, reconcile --apply settles it", async (t) => {
  let n = 0;
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => { n++; q.resume(); res.writeHead(200, { "content-type": "application/json" }).end('{"model":"whisper-1","usage":{"type":"duration","seconds":42}}'); });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const receipts = path.join(dir, "r.jsonl");
  const script = `
    const u = process.env.OPENAI_BASE_URL + "/audio/transcriptions";
    const a = await fetch(u,{method:"POST",body:JSON.stringify({model:"whisper-1"})});
    const b = await fetch(u,{method:"POST",body:JSON.stringify({model:"whisper-1"})});
    console.log(a.status, b.status, (await b.json()).error);`;
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => resolve({ code, out, err }));
  });
  assert.equal(res.out.replace(/\x1b\[[0-9;]*m/g, "").trim(), "200 429 accounting_unavailable");
  assert.equal(n, 1);
  const rows = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse).filter((r) => "cost_usd" in r);
  const unknown = rows.find((r) => r.reason === "usage_unavailable");
  assert.equal(unknown.cost_usd, null);
  const check = spawnSync(process.execPath, ["src/cli.js", "check", "--cap", "1", "--receipts", receipts], { encoding: "utf8" });
  assert.equal(check.status, 1);
  const verdict = JSON.parse(check.stdout);
  assert.deepEqual([verdict.ok, verdict.unknown_cost_count, verdict.hit.scope, verdict.hit.reason], [false, 1, "accounting", "unreconciled_receipt"]);
  const provider = path.join(dir, "provider.jsonl");
  writeFileSync(provider, JSON.stringify({ id: unknown.id, cost_usd: 0.0042 }) + "\n");
  const rec = spawnSync(process.execPath, ["src/cli.js", "reconcile", "--receipts", receipts, "--provider", provider, "--apply"], { encoding: "utf8" });
  assert.equal(rec.status, 0, rec.stdout + rec.stderr);
  assert.deepEqual(JSON.parse(rec.stdout).settled, [{ receipt_id: unknown.id, cost_usd: 0.0042 }]);
  const after = spawnSync(process.execPath, ["src/cli.js", "check", "--cap", "1", "--receipts", receipts], { encoding: "utf8" });
  assert.equal(after.status, 0, after.stdout + after.stderr);
});

test("#142 wrap: count-tokens then a normal call both succeed; an Anthropic web-search call pauses the run (check exits 1)", async (t) => {
  const seen = [];
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => {
      seen.push(q.url); q.resume();
      const body = q.url.endsWith("/count_tokens") ? { input_tokens: 42 }
        : seen.length === 2 ? { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5 } }
        : { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 2 } } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const receipts = path.join(dir, "r.jsonl");
  const script = `
    const b = process.env.ANTHROPIC_BASE_URL + "/v1/messages";
    const post = (u) => fetch(u,{method:"POST",body:JSON.stringify({model:"claude-sonnet-4-6"})});
    const r = [await post(b + "/count_tokens"), await post(b), await post(b), await post(b)];
    console.log(r.map((x) => x.status).join(" "), (await r[3].json()).error);`;
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d));
    c.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(res.out.replace(/\x1b\[[0-9;]*m/g, "").trim(), "200 200 200 429 accounting_unavailable");
  assert.equal(seen.length, 3);
  const rows = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse).filter((r) => "cost_usd" in r);
  assert.deepEqual(rows.slice(0, 3).map((r) => [r.cost_usd === null ? null : r.cost_usd > 0, r.reason ?? null]),
    [[false, "non_billable_request"], [true, null], [null, "tool_use_unpriced"]]);
  const check = spawnSync(process.execPath, ["src/cli.js", "check", "--cap", "1", "--receipts", receipts], { encoding: "utf8" });
  assert.equal(check.status, 1);
  assert.equal(JSON.parse(check.stdout).hit.scope, "accounting");
});

async function embedWrap(t, cap) {
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => {
      q.resume();
      const body = q.url.endsWith("/embeddings") ? { model: "text-embedding-3-large", usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 } }
        : { model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const receipts = path.join(dir, "r.jsonl");
  const script = `
    const b = process.env.OPENAI_BASE_URL;
    const e = () => fetch(b + "/embeddings",{method:"POST",body:JSON.stringify({model:"text-embedding-3-large",input:"x"})}).then((r) => r.status);
    const c = () => fetch(b + "/chat/completions",{method:"POST",body:JSON.stringify({model:"gpt-4o-mini"})}).then((r) => r.status);
    console.log(await e(), await e(), await c());`;
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...(cap ? ["--cap", cap] : []), "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "").trim() }));
  });
  return { res, receipts };
}

test("#145 wrap: two embeddings calls and a chat call are priced; check exits 0 with a non-null total", async (t) => {
  const { res, receipts } = await embedWrap(t);
  assert.equal(res.out, "200 200 200");
  const rows = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse).filter((r) => "cost_usd" in r);
  assert.deepEqual(rows.filter((r) => r.model === "text-embedding-3-large").map((r) => [r.cost_usd, r.output_tokens]), [[0.13, 0], [0.13, 0]]);
  const check = spawnSync(process.execPath, ["src/cli.js", "check", "--cap", "5", "--receipts", receipts], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const v = JSON.parse(check.stdout);
  assert.equal(v.ok, true);
  assert.equal(v.unknown_cost_count ?? 0, 0);
  assert.ok(JSON.stringify(v).includes("0.26"), check.stdout);
});

test("#145 wrap: embeddings spend crosses --cap and the next call is blocked", async (t) => {
  const { res } = await embedWrap(t, "0.2");
  assert.equal(res.out, "200 200 429");
});

for (const [label, cost, expected] of [["with usage.cost 1.5 blocks", 1.5, "200 429"], ["without usage.cost keeps fallback pricing", undefined, "200 200"]]) {
  test(`#148 wrap --cap 1 through OpenRouter ${label}`, async (t) => {
    const up = await new Promise((r) => {
      const s = http.createServer((q, res) => res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ model: "acme/premium", usage: { prompt_tokens: 1000, completion_tokens: 1000, ...(cost !== undefined && { cost }) } })));
      s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
    });
    t.after(() => up.s.close());
    const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
    const script = `
      const u = process.env.OPENROUTER_BASE_URL + "/api/v1/chat/completions";
      const a = await fetch(u,{method:"POST",body:JSON.stringify({model:"acme/premium",n:1})});
      const b = await fetch(u,{method:"POST",body:JSON.stringify({model:"acme/premium",n:2})});
      console.log(a.status, b.status);`;
    const res = await new Promise((resolve) => {
      const c = spawn(process.execPath, ["src/cli.js", "wrap", "--cap", "1", "--receipts", path.join(dir, "r.jsonl"), "--", process.execPath, "--input-type=module", "-e", script],
        { env: { ...process.env, COSTCAP_TEST_OPENROUTER_UPSTREAM: `http://127.0.0.1:${up.port}` } });
      let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
      c.on("exit", (code) => resolve({ code, out }));
    });
    assert.equal(res.out.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").pop(), expected);
    const first = JSON.parse(readFileSync(path.join(dir, "r.jsonl"), "utf8").split("\n")[0]);
    assert.equal(first.cost_source, cost === undefined ? "fallback" : "provider");
    const csv = spawnSync(process.execPath, ["src/cli.js", "receipts", "--receipts", path.join(dir, "r.jsonl"), "--export", "csv"], { encoding: "utf8" });
    assert.match(csv.stdout, /cost_source/);
    assert.match(csv.stdout, cost === undefined ? /,fallback,/ : /,1\.5,provider,/);
  });
}
