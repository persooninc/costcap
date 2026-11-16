// Local fake-provider acceptance. No credentials, external requests or paid calls.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "cc-runaway-"));
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
let hits = 0;
const up = http.createServer(async (req, res) => {
  hits++;
  let body = "";
  for await (const c of req) body += c;
  if (/"stream":true/.test(body)) {
    // CC-6: SSE with gaps so the wrapped client can prove it sees chunks before the end.
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of ['{"model":"gpt-4o-mini","choices":[{"delta":{"content":"a"}}]}', '{"model":"gpt-4o-mini","choices":[{"delta":{"content":"b"}}]}',
      '{"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":0}}', "[DONE]"]) {
      if (res.destroyed) return;
      res.write(`data: ${e}\n\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));
});
await new Promise((r) => up.listen(0, "127.0.0.1", r));

function scenario(name, flags, count, distinct = true, extraEnv = {}, code) {
  hits = 0;
  const receipts = join(root, `${name}.jsonl`);
  const childCode = code ?? `for (let i = 0; i < ${count}; i++) { const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: ${distinct ? "String(i)" : "'same retry'"} }] }) }); console.log(r.status); if (r.status === 429) break; }`;
  const child = spawn(process.execPath, [join(repo, "src/cli.js"), "wrap", ...flags, "--receipts", receipts, "--kill-file", join(root, "KILL"), "--", process.execPath, "--input-type=module", "-e", childCode], {
    env: { ...process.env, COSTCAP_TEST_OPENAI_UPSTREAM: `http://127.0.0.1:${up.address().port}`, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let err = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  return new Promise((resolve) => {
    child.on("exit", (status) => {
      assert.equal(status, 0, err);
      const lines = readFileSync(receipts, "utf8").trim().split("\n").map(JSON.parse);
      // #164: cap_warning event lines are never spend; report them separately.
      const ledger = lines.filter((row) => !row.event);
      const warnings = lines.filter((row) => row.event === "cap_warning");
      assert.equal(ledger.at(-1).blocked, true, name);
      resolve({
        scenario: name,
        upstreamCalls: hits,
        blockedReason: ledger.at(-1).reason,
        scope: ledger.at(-1).scope ?? null,
        statuses: output.trim().split("\n"),
        receiptCount: ledger.length,
        reportedCost: Number(ledger.reduce((n, row) => n + (typeof row.cost_usd === "number" ? row.cost_usd : 0), 0).toFixed(6)),
        unknownCostCount: ledger.filter((row) => row.cost_usd === null).length,
        receipts: ledger,
        warnings,
        stderr: err,
      });
    });
  });
}

try {
  const cap = await scenario("cap", ["--cap", "0.10"], 20);
  assert.equal(cap.upstreamCalls, 1);
  assert.equal(cap.blockedReason, "budget_exceeded");
  // #164: the default 0.8 soft warning fires once before the block.
  assert.deepEqual(cap.warnings.map((w) => [w.scope, w.fraction]), [["run", 0.8]]);
  assert.equal((cap.stderr.match(/costcap: warning: run spend/g) ?? []).length, 1);
  const spiral = await scenario("retry-spiral", [], 20, false);
  assert.equal(spiral.upstreamCalls, 5);
  assert.equal(spiral.blockedReason, "spiral_detected");
  const steps = await scenario("steps", ["--max-steps", "3"], 20);
  assert.equal(steps.upstreamCalls, 3);
  assert.equal(steps.blockedReason, "step_budget");
  const now = new Date();
  const dayReceipts = join(root, "day-cap.jsonl");
  writeFileSync(dayReceipts, JSON.stringify({ id: "seed-day", ts: now.toISOString(), cost_usd: 1, model: "gpt-4o-mini" }) + "\n");
  const day = await scenario("day-cap", ["--day-cap", "0.50"], 5);
  assert.equal(day.upstreamCalls, 0);
  assert.equal(day.scope, "day");
  const monthStamp = now.getUTCDate() === 1 ? now.toISOString() : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString();
  writeFileSync(join(root, "month-cap.jsonl"), JSON.stringify({ id: "seed-month", ts: monthStamp, cost_usd: 1, model: "gpt-4o-mini" }) + "\n");
  const month = await scenario("month-cap", ["--month-cap", "0.50", "--day-cap", "100"], 5);
  assert.equal(month.upstreamCalls, 0);
  assert.equal(month.scope, "month");
  writeFileSync(join(root, "unknown-cost.jsonl"), JSON.stringify({ id: "seed-unknown", ts: now.toISOString(), cost_usd: null, model: "gpt-4o-mini", reason: "usage_unavailable" }) + "\n");
  const unknown = await scenario("unknown-cost", ["--cap", "5"], 5);
  assert.equal(unknown.upstreamCalls, 0);
  assert.equal(unknown.blockedReason, "unreconciled_receipt");
  assert.ok(unknown.unknownCostCount >= 1);
  const streamCode = `for (let i = 0; i < 5; i++) { const t0 = Date.now(); const r = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: String(i) }] }) }); if (r.status !== 200) { console.log(r.status); break; } let first = 0, text = ""; for await (const c of r.body) { if (!first) first = Date.now() - t0; text += Buffer.from(c).toString(); } const total = Date.now() - t0; if (!(first < total - 300) || !text.includes("[DONE]")) { console.error("not streamed", first, total); process.exit(3); } console.log(r.status); }`;
  const streamed = await scenario("stream-cap", ["--cap", "0.10"], 5, true, {}, streamCode);
  assert.equal(streamed.upstreamCalls, 1);
  assert.equal(streamed.blockedReason, "budget_exceeded");
  assert.deepEqual(streamed.statuses, ["200", "429"]);
  assert.ok(streamed.receipts[0].cost_usd > 0.10);
  writeFileSync(join(root, "KILL"), "synthetic frozen");
  // Pin the child-stop watcher off so this scenario proves the proxy 429 path
  // deterministically; watcher SIGTERM (143) is covered in test/kill.test.js.
  const killed = await scenario("kill-file", [], 20, true, { COSTCAP_KILL_POLL_MS: "600000" });
  assert.equal(killed.upstreamCalls, 0);
  assert.equal(killed.blockedReason, "killed");
  const results = [cap, spiral, steps, day, month, unknown, killed, streamed];
  const checkedAt = new Date().toISOString();
  const report = { checkedAt, command: "npm run acceptance:runaway", provider: "local fake OpenAI", paidCalls: 0, results };
  const outDir = join(repo, "docs/verification");
  mkdirSync(outDir, { recursive: true });
  const dayName = checkedAt.slice(0, 10);
  writeFileSync(join(outDir, `${dayName}-runaway.json`), JSON.stringify(report, null, 2) + "\n");
  const lines = results.map((row) => `| ${row.scenario} | ${row.upstreamCalls} | ${row.blockedReason} | ${row.scope ?? ""} | ${row.receiptCount} | ${row.unknownCostCount} |`);
  const markdown = `# Runaway acceptance ${dayName}

Command: \`npm run acceptance:runaway\`

The run uses the CLI wrapper, a local fake OpenAI server, and no credentials. Paid provider calls: 0. Unknown cost stays null. Receipts are in \`${dayName}-runaway.json\`.

| scenario | upstream calls | blocked reason | scope | receipts | unknown-cost receipts |
|---|---:|---|---|---:|---:|
${lines.join("\n")}

Checked at ${checkedAt}. Node ${process.version}.
`;
  writeFileSync(join(outDir, `${dayName}-runaway-acceptance.md`), markdown);
  console.log(JSON.stringify({ checkedAt, provider: report.provider, paidCalls: 0, results: results.map(({ receipts, stderr, ...rest }) => rest) }, null, 2));
} finally {
  up.closeAllConnections();
  up.close();
}
