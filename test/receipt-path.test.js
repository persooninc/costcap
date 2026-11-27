import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL_PARAMS, receiptPath, redactQuery, scrubReceiptPath } from "../src/receipt-path.js";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";

test("#130 receiptPath redacts credential params case-insensitively and keeps the rest", () => {
  assert.equal(receiptPath("/a", ""), "/a");
  assert.equal(receiptPath("/a", "?"), "/a");
  assert.equal(redactQuery("?key=S&alt=sse&API_KEY=S&access_token=S&Token=S&sig=S&signature=S&apikey=S&flag"), "?key=REDACTED&alt=sse&API_KEY=REDACTED&access_token=REDACTED&Token=REDACTED&sig=REDACTED&signature=REDACTED&apikey=REDACTED&flag");
  assert.equal(redactQuery("?%6Bey=S"), "?%6Bey=REDACTED");
  assert.equal(redactQuery("?%E0=1"), "?%E0=1");
  assert.equal(redactQuery("?key"), "?key=REDACTED");
  assert.equal(scrubReceiptPath("/x"), "/x");
  assert.equal(scrubReceiptPath(null), null);
  assert.equal(scrubReceiptPath("/x?key=S"), "/x?key=REDACTED");
});

const URL_PATH = "/gemini/v1beta/models/gemini-test:generateContent?key=SECRET123&alt=json";
async function gemini(t, options, handler) {
  const seen = [];
  const up = http.createServer((req, res) => { seen.push(req.url); handler ? handler(req, res) : res.end('{"modelVersion":"gemini-test","usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}'); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "cc-130-"));
  const receiptsPath = join(dir, "receipts.jsonl");
  const p = await startMeteringProxy({ upstreams: { gemini: options.upstream ?? `http://127.0.0.1:${up.address().port}` }, receiptsPath, ...options });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = () => fetch(`http://127.0.0.1:${p.port}${URL_PATH}`, { method: "POST", body: '{"contents":[]}' });
  const receipts = () => readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { call, receipts, seen, receiptsPath, dir };
}
const EXPECTED = "/v1beta/models/gemini-test:generateContent?key=REDACTED&alt=json";

test("#130 success, blocked (cap) and unknown-outcome receipts share one redacted path; upstream gets the full query", async (t) => {
  const ok = await gemini(t, { cap: createCapEngine({ caps: { run: 100 } }) });
  assert.equal((await ok.call()).status, 200);
  assert.deepEqual(ok.seen, [URL_PATH.replace("/gemini", "")]);
  const blocked = await gemini(t, { cap: createCapEngine({ caps: { run: 0.000001 } }) });
  await blocked.call();
  assert.equal((await blocked.call()).status, 429);
  const unknown = await gemini(t, { upstream: "http://127.0.0.1:1" });
  await unknown.call();
  const paths = [ok, blocked, unknown].map((f) => f.receipts().at(-1).path);
  assert.deepEqual(paths, [EXPECTED, EXPECTED, EXPECTED]);
  assert.equal(blocked.receipts().at(-1).blocked, true);
  assert.equal(unknown.receipts().at(-1).reason, "upstream_outcome_unknown");
  for (const f of [ok, blocked, unknown]) assert.doesNotMatch(readFileSync(f.receiptsPath, "utf8"), /SECRET123/);
});

test("#130 kill refusal does not persist the key", async (t) => {
  const f = await gemini(t, { killCheck: () => ({ reason: "killed", source: "file" }), cap: createCapEngine({ caps: { run: 100 } }) });
  assert.equal((await f.call()).status, 429);
  assert.equal(f.receipts().at(-1).blocked, true);
  assert.equal(f.receipts().at(-1).path, EXPECTED);
  assert.equal(f.seen.length, 0);
});

test("#186: Azure api-key query parameter is redacted", () => {
  assert.ok(CREDENTIAL_PARAMS.includes("api-key"));
  assert.equal(receiptPath("/openai/deployments/d/chat/completions", "?api-version=2024-10-21&api-key=s3cret"), "/openai/deployments/d/chat/completions?api-version=2024-10-21&api-key=REDACTED");
});

test("#188: presigned SigV4 query parameters are redacted", () => {
  for (const p of ["x-amz-signature", "x-amz-security-token", "x-amz-credential"]) assert.ok(CREDENTIAL_PARAMS.includes(p));
  assert.equal(receiptPath("/model/m/invoke", "?X-Amz-Signature=abc&X-Amz-Credential=AKID%2F20260101&X-Amz-Security-Token=tok&X-Amz-Date=1"),
    "/model/m/invoke?X-Amz-Signature=REDACTED&X-Amz-Credential=REDACTED&X-Amz-Security-Token=REDACTED&X-Amz-Date=1");
});
