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

test("#150 wrap: GOOGLE_GEMINI_BASE_URL and GEMINI_BASE_URL point at the proxy; SDK-shaped Gemini calls are metered and capped", async (t) => {
  const seen = [];
  const up = await new Promise((r) => {
    const s = http.createServer((req, res) => { seen.push({ url: req.url, key: req.headers["x-goog-api-key"] }); res.setHeader("content-type", "application/json"); res.end('{"modelVersion":"gemini-2.5-pro","usageMetadata":{"promptTokenCount":1000000,"candidatesTokenCount":0}}'); });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-150-"));
  const receipts = path.join(dir, "r.jsonl");
  // Built the way go-genai / @google/genai build it: <base>/v1beta/models/<model>:generateContent, key in header.
  const script = `
    console.log("ENV", JSON.stringify({ g: process.env.GOOGLE_GEMINI_BASE_URL, l: process.env.GEMINI_BASE_URL }));
    const u = process.env.GOOGLE_GEMINI_BASE_URL + "/v1beta/models/gemini-2.5-pro:generateContent";
    const opt = { method: "POST", headers: { "x-goog-api-key": "k", "content-type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }) };
    const a = await fetch(u, opt);
    const b = await fetch(u, opt);
    console.log("STATUS", a.status, b.status, (await b.json()).error?.type);`;
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--cap", "0.10", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com", COSTCAP_TEST_GEMINI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "") }));
  });
  const env = JSON.parse(res.out.match(/^ENV (.*)$/m)[1]);
  assert.match(env.g, /^http:\/\/127\.0\.0\.1:\d+\/gemini$/);
  assert.equal(env.l, env.g);
  assert.match(res.out, /^STATUS 200 429 budget_exceeded$/m);
  assert.deepEqual(seen, [{ url: "/v1beta/models/gemini-2.5-pro:generateContent", key: "k" }]);
  const lines = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((r) => r.provider === "gemini" && r.cost_usd > 0), "gemini receipt written");
});

test("#163: wrap meters Gemini audio at the audio rate, check --cap trips on it, pricing show lists it", async (t) => {
  const up = await new Promise((r) => {
    const s = http.createServer((req, res) => res.end(JSON.stringify({ modelVersion: "gemini-2.5-flash",
      usageMetadata: { promptTokenCount: 101000, candidatesTokenCount: 500, promptTokensDetails: [{ modality: "TEXT", tokenCount: 1000 }, { modality: "AUDIO", tokenCount: 100000 }] } })));
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-163w-"));
  const receipts = path.join(dir, "r.jsonl");
  const script = `const a = await fetch(process.env.GEMINI_BASE_URL + "/v1beta/models/gemini-2.5-flash:generateContent",{method:"POST",body:"{}"}); console.log(a.status);`;
  await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--receipts", receipts, "--", process.execPath, "--input-type=module", "-e", script],
      { env: { ...process.env, COSTCAP_TEST_GEMINI_UPSTREAM: `http://127.0.0.1:${up.port}` } });
    c.stdout.on("data", () => {}); c.stderr.on("data", () => {}); c.on("exit", resolve);
  });
  const rec = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.provider === "gemini");
  assert.equal(rec.cost_usd, 0.10155);
  // Text-priced this would be ~$0.0316, under a $0.05 cap; audio-priced it trips.
  const chk = spawnSync(process.execPath, ["src/cli.js", "check", "--cap", "0.05", "--receipts", receipts], { encoding: "utf8" });
  assert.notEqual(chk.status, 0);
  const show = spawnSync(process.execPath, ["src/cli.js", "pricing", "show", "gemini-2.5-flash"], { encoding: "utf8" });
  assert.match(show.stdout, /gemini-2\.5-flash \(audio\): input \$1, cached_input \$0\.1/);
});

// #184: --cache flags.
test("#184 parseWrapArgs reads --cache, --cache-dir and --cache-max-mb", () => {
  const o = parseWrapArgs(["--cache", "24h", "--cache-dir", "/tmp/x", "--cache-max-mb", "16", "--", "node"]);
  assert.equal(o.cacheTtlMs, 86_400_000);
  assert.equal(o.cacheDir, "/tmp/x");
  assert.equal(o.cacheMaxMb, 16);
  assert.equal(parseWrapArgs(["--", "node"]).cacheTtlMs, undefined);
  assert.throws(() => parseWrapArgs(["--cache", "8d", "--", "x"]), /at most 7d/);
  assert.throws(() => parseWrapArgs(["--cache", "soon", "--", "x"]), /duration/);
  assert.throws(() => parseWrapArgs(["--cache", "1h", "--cache-max-mb", "0", "--", "x"]), /positive/);
  assert.throws(() => parseWrapArgs(["--cache-dir", "/tmp/x", "--", "x"]), /need --cache/);
});

test("#184 wrap with a bad --cache TTL exits 2", () => {
  const r = spawnSync(process.execPath, ["src/cli.js", "wrap", "--cache", "forever", "--", process.execPath, "-e", "1"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--cache must be/);
});

// #186 AC1/AC6: wrap --upstream end to end against a local fake OpenAI-compatible upstream.
test("wrap --upstream routes the child through GROQ_BASE_URL, prices from --upstream-prices, and caps", async (t) => {
  const hits = [];
  const up = await new Promise((r) => {
    const s = http.createServer((q, res) => { hits.push(q.url); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "llama-3.3-70b", usage: { prompt_tokens: 100_000, completion_tokens: 100_000 } })); });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
  t.after(() => up.s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const prices = path.join(dir, "prices.json");
  writeFileSync(prices, JSON.stringify({ version: "p1", upstreams: { groq: { "llama-3.3-70b": { input: 0.5, output: 0.5 } } } }));
  const script = `
    const u = process.env.GROQ_BASE_URL + "/v1/chat/completions";
    console.log(process.env.GROQ_BASE_URL === process.env.COSTCAP_UPSTREAM_GROQ_BASE_URL, /\\/u\\/groq$/.test(process.env.GROQ_BASE_URL));
    const a = await fetch(u,{method:"POST",body:JSON.stringify({model:"llama-3.3-70b"})});
    const b = await fetch(u,{method:"POST",body:JSON.stringify({model:"llama-3.3-70b"})});
    console.log(a.status, b.status);`;
  const receipts = path.join(dir, "r.jsonl");
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", "--cap", "0.05", "--receipts", receipts, "--upstream", `groq=http://127.0.0.1:${up.port}/openai,env=GROQ_BASE_URL`, "--upstream-prices", prices, "--", process.execPath, "--input-type=module", "-e", script]);
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(res.code, 0);
  assert.equal(res.out.trim(), "true true\n200 429");
  assert.deepEqual(hits, ["/openai/v1/chat/completions"]);
  const first = readFileSync(receipts, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.provider === "u/groq" && !r.blocked);
  assert.equal(first.cost_usd, 0.1);
  assert.equal(first.cost_source, "user_prices");
});

test("wrap exits 2 and spawns nothing for a bad --upstream or prices file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const marker = path.join(dir, "spawned");
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, "{");
  for (const args of [["--upstream", "Bad=https://x"], ["--upstream", "a=https://x", "--upstream", "a=https://y"], ["--upstream", "openai=https://x"],
    ["--upstream", "a=http://10.1.2.3"], ["--upstream", "a=https://x,env=lower"], ["--upstream", "a=https://x", "--upstream-prices", bad]]) {
    const r = spawnSync(process.execPath, ["src/cli.js", "wrap", ...args, "--receipts", path.join(dir, "r.jsonl"), "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /costcap: .*upstream/);
  }
  assert.throws(() => readFileSync(marker));
});

// #188: spawned wrap against local fake Bedrock / Vertex upstreams.
const SIGV4 = new URL("../src/sigv4.js", import.meta.url).href;
async function fakeBedrock(t) {
  const { verifyRequest } = await import(SIGV4);
  const hits = [];
  const s = http.createServer((q, res) => {
    const chunks = []; q.on("data", (c) => chunks.push(c));
    q.on("end", () => {
      const [p, qs = ""] = q.url.split("?");
      const v = verifyRequest({ method: q.method, path: p, search: qs ? `?${qs}` : "", headers: q.headers, body: Buffer.concat(chunks) },
        { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" });
      hits.push({ url: q.url, ok: v.ok, region: v.region });
      res.writeHead(v.ok ? 200 : 403, { "content-type": "application/json" })
        .end(JSON.stringify(v.ok ? { usage: { input_tokens: 40_000, output_tokens: 1000 } } : { message: "bad signature" }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  return { hits, url: `http://127.0.0.1:${s.address().port}` };
}
function cloudWrap(args, env, script) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AWS_|^CLAUDE_CODE_USE_/.test(k)));
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["src/cli.js", "wrap", ...args, "--", process.execPath, "--input-type=module", "-e", script], { env: { ...base, ...env } });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "").trim(), err }));
  });
}
const signedCallScript = (ids) => `
  import { signRequest } from ${JSON.stringify(SIGV4)};
  const base = new URL(process.env.ANTHROPIC_BEDROCK_BASE_URL);
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const out = [process.env.ANTHROPIC_BEDROCK_BASE_URL.endsWith("/bedrock"), process.env.ANTHROPIC_VERTEX_BASE_URL.endsWith("/vertex/v1")];
  for (const id of ${JSON.stringify(ids)}) {
    const path = base.pathname + "/model/" + encodeURIComponent(id) + "/invoke";
    const body = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 1000, messages: [] });
    const headers = signRequest({ method: "POST", path, headers: { "content-type": "application/json" }, body, host: base.host, region: "us-east-1", service: "bedrock" }, creds);
    delete headers.host;
    const r = await fetch(base.origin + path, { method: "POST", headers, body });
    out.push(r.status);
  }
  console.log(out.join(" "));`;

test("#188 wrap: child sees the Bedrock/Vertex base URLs, SigV4 call is re-signed and priced 1.1x/1.0x, cap hit is 429", async (t) => {
  const up = await fakeBedrock(t);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const receipts = path.join(dir, "r.jsonl");
  const id = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const res = await cloudWrap(["--cap", "0.25", "--receipts", receipts],
    { COSTCAP_TEST_BEDROCK_UPSTREAM: up.url, AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    signedCallScript([id, id.replace(/^us\./, "global."), id]));
  assert.equal(res.out, "true true 200 200 429");
  assert.deepEqual(up.hits.map((h) => [h.ok, h.region]), [[true, "us-east-1"], [true, "us-east-1"]]);
  const rows = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse).filter((r) => "cost_usd" in r);
  // 40k in * $3 + 1k out * $15 = $0.135 global; regional is 1.1x.
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.provider, r.model, r.endpoint_scope, r.cost_usd]),
    [["bedrock", "claude-sonnet-4-5", "regional", 0.1485], ["bedrock", "claude-sonnet-4-5", "global", 0.135]]);
  assert.equal(rows[2].reason, "budget_exceeded");
  assert.ok(!readFileSync(receipts, "utf8").includes("wJalrXUtnFEMI"));
});

test("#188 wrap: CLAUDE_CODE_USE_BEDROCK without static creds prints a note; a signed call gets 502 and never reaches the fake", async (t) => {
  const up = await fakeBedrock(t);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const res = await cloudWrap(["--receipts", path.join(dir, "r.jsonl")],
    { COSTCAP_TEST_BEDROCK_UPSTREAM: up.url, AWS_REGION: "us-east-1", CLAUDE_CODE_USE_BEDROCK: "1" },
    signedCallScript(["us.anthropic.claude-sonnet-4-5-20250929-v1:0"]));
  assert.equal(res.out, "true true 502");
  assert.match(res.err, /CLAUDE_CODE_USE_BEDROCK=1 but no static AWS credentials/);
  assert.match(res.err, /aws configure export-credentials/);
  assert.equal(up.hits.length, 0);
  const quiet = await cloudWrap(["--receipts", path.join(dir, "r2.jsonl")], { COSTCAP_TEST_BEDROCK_UPSTREAM: up.url, CLAUDE_CODE_USE_BEDROCK: "1", AWS_BEARER_TOKEN_BEDROCK: "x" }, "console.log(1)");
  assert.doesNotMatch(quiet.err, /CLAUDE_CODE_USE_BEDROCK/);
});

test("#188 wrap: Vertex rawPredict through COSTCAP_TEST_VERTEX_UPSTREAM keeps the path and Authorization", async (t) => {
  const hits = [];
  const s = http.createServer((q, res) => { q.resume(); hits.push([q.url, q.headers.authorization]);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } })); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  const dir = mkdtempSync(path.join(tmpdir(), "cc-"));
  const receipts = path.join(dir, "r.jsonl");
  const res = await cloudWrap(["--receipts", receipts], { COSTCAP_TEST_VERTEX_UPSTREAM: `http://127.0.0.1:${s.address().port}` }, `
    const r = await fetch(process.env.ANTHROPIC_VERTEX_BASE_URL + "/projects/p/locations/global/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict",
      { method: "POST", headers: { authorization: "Bearer ya29.x" }, body: "{}" });
    console.log(r.status);`);
  assert.equal(res.out, "200");
  assert.deepEqual(hits, [["/v1/projects/p/locations/global/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict", "Bearer ya29.x"]]);
  const row = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse).find((r) => r.provider === "vertex");
  assert.deepEqual([row.model, row.endpoint_scope, row.regional_multiplier], ["claude-haiku-4-5", "global", undefined]);
});
