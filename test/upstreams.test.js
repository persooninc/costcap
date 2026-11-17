// #190: custom-upstream 404 hint and route-not-found classification.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isRouteNotFound, startMeteringProxy } from "../src/proxy.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadUpstreamPrices, parseUpstreamFlag } from "../src/upstreams.js";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

test("isRouteNotFound: unserved-route bodies are not billed, anything with usage stays unknown", () => {
  assert.equal(isRouteNotFound(Buffer.from('{"detail":"Not Found"}')), true);
  assert.equal(isRouteNotFound(Buffer.from("Not Found")), true);
  assert.equal(isRouteNotFound(Buffer.from("<html>404</html>")), true);
  assert.equal(isRouteNotFound(Buffer.from('{"usage":{"prompt_tokens":1}}')), false);
  assert.equal(isRouteNotFound(Buffer.from('{"usageMetadata":{}}')), false);
  assert.equal(isRouteNotFound(Buffer.from("[1]")), false);
  assert.equal(isRouteNotFound(Buffer.from("null")), false);
  assert.equal(isRouteNotFound(Buffer.from("bad usage text")), false);
});

async function proxyWith(t, handler) {
  const up = http.createServer(handler);
  const upPort = await listen(up);
  const warnings = [], receipts = [];
  const { server, port } = await startMeteringProxy({ onReceipt: (r) => receipts.push(r), onWarning: (l) => warnings.push(l),
    customUpstreams: { a: `http://127.0.0.1:${upPort}`, b: `http://127.0.0.1:${upPort}` } });
  t.after(() => { up.close(); server.close(); });
  const call = (name, p) => fetch(`http://127.0.0.1:${port}/u/${name}${p}`, { method: "POST", body: JSON.stringify({ model: "m" }) }).then((r) => r.status);
  return { call, warnings, receipts };
}

test("#190 the 404 hint fires once per name, only when the first response is a 404", async (t) => {
  const { call, warnings, receipts } = await proxyWith(t, (q, res) => {
    if (q.url.startsWith("/ok")) { res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"bad key"}}'); return; }
    res.writeHead(404, { "content-type": "application/json" }).end('{"detail":"Not Found"}');
  });
  assert.equal(await call("a", "/chat/completions"), 404);
  assert.equal(await call("a", "/chat/completions"), 404);
  assert.equal(await call("b", "/ok"), 401);
  assert.equal(await call("b", "/chat/completions"), 404);
  assert.deepEqual(warnings, ['costcap: upstream "a" returned 404 for /chat/completions; does --upstream URL need a /v1 suffix?']);
  assert.ok(receipts.filter((r) => r.status === 404).every((r) => r.cost_usd === 0 && r.reason === "upstream_rejected"));
});

test("#190 a broken onWarning never breaks the proxied response", async (t) => {
  const up = http.createServer((q, res) => res.writeHead(404).end("nope"));
  const upPort = await listen(up);
  const { server, port } = await startMeteringProxy({ onWarning: () => { throw new Error("stderr gone"); }, customUpstreams: { a: `http://127.0.0.1:${upPort}` } });
  t.after(() => { up.close(); server.close(); });
  const r = await fetch(`http://127.0.0.1:${port}/u/a/x`, { method: "POST", body: "{}" });
  assert.equal(r.status, 404);
});

test("#278 bedrock / vertex are override keys in --upstream-prices, not --upstream names", () => {
  assert.throws(() => parseUpstreamFlag("bedrock=https://x.example"), /built-in provider/);
  const f = path.join(mkdtempSync(path.join(tmpdir(), "cc-up-")), "p.json");
  writeFileSync(f, JSON.stringify({ upstreams: { bedrock: { "meta.llama-x-v1:0": { input: 1, output: 2 } }, vertex: { "*": { discount: 0.2 } } } }));
  const p = loadUpstreamPrices(f, []);
  assert.deepEqual(Object.keys(p.upstreams), ["bedrock", "vertex"]);
  writeFileSync(f, JSON.stringify({ upstreams: { bedrock: { "meta.llama-x-v1:0": { input: 0, output: 2 } } } }));
  assert.throws(() => loadUpstreamPrices(f, []), /never \$0/);
});
