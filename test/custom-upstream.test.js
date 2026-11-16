// #186: custom OpenAI-compatible upstreams (wrap --upstream NAME=URL, --upstream-prices FILE).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { parseWrapArgs } from "../src/cli.js";
import { costForUserPrices, envKeyFor, loadUpstreamPrices, parseUpstreamFlag, parseUpstreams, upstreamEnv, userPrice } from "../src/upstreams.js";
import { tableDigest } from "../src/pricing-digest.js";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const tmp = () => mkdtempSync(path.join(tmpdir(), "cc-up-"));
const PRICES = { version: "test-1", upstreams: { groq: { "llama-3.3-70b": { input: 0.59, output: 0.79 } }, azure: { "gpt-4o": { input: 2.5, output: 10, cached_input: 1.25 } } } };
function pricesFile(doc = PRICES) {
  const f = path.join(tmp(), "prices.json");
  writeFileSync(f, JSON.stringify(doc));
  return f;
}

test("parseUpstreamFlag accepts https, loopback http, env= and insecure", () => {
  assert.deepEqual(parseUpstreamFlag("groq=https://api.groq.com/openai/"), { name: "groq", url: "https://api.groq.com/openai", insecure: false });
  assert.deepEqual(parseUpstreamFlag("vllm=http://127.0.0.1:8000,env=OPENAI_BASE_URL"), { name: "vllm", url: "http://127.0.0.1:8000", env: "OPENAI_BASE_URL", insecure: false });
  assert.deepEqual(parseUpstreamFlag("box=http://10.0.0.5:8000,insecure"), { name: "box", url: "http://10.0.0.5:8000", insecure: true });
  assert.equal(parseUpstreamFlag("local=http://localhost:1").url, "http://localhost:1");
});

test("parseUpstreamFlag / parseUpstreams reject bad input (AC6)", () => {
  for (const [v, re] of [["Groq=https://x", /must match/], ["-a=https://x", /must match/], ["a".repeat(33) + "=https://x", /must match/],
    ["openai=https://x", /built-in/], ["gemini=https://x", /built-in/], ["noeq", /NAME=URL/], ["=https://x", /NAME=URL/],
    ["g=http://10.0.0.5", /loopback/], ["g=ftp://x", /https/], ["g=not a url", /not a URL/], ["g=https://x,env=bad-name", /env name/],
    ["g=https://x,bogus", /unknown option/], ["g=https://u:p@x", /credentials/], ["g=https://x?key=1", /query/]]) {
    assert.throws(() => parseUpstreamFlag(v), re, v);
  }
  assert.throws(() => parseUpstreams(["a=https://x", "a=https://y"]), /more than once/);
});

test("upstreamEnv sets COSTCAP_UPSTREAM_<NAME>_BASE_URL and env=, noting built-in overrides", () => {
  const { env, notes } = upstreamEnv(parseUpstreams(["my-vllm=http://127.0.0.1:1,env=OPENAI_BASE_URL", "groq=https://g,env=GROQ_BASE_URL"]), 4000);
  assert.equal(envKeyFor("my-vllm"), "COSTCAP_UPSTREAM_MY_VLLM_BASE_URL");
  assert.equal(env.COSTCAP_UPSTREAM_MY_VLLM_BASE_URL, "http://127.0.0.1:4000/u/my-vllm");
  assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:4000/u/my-vllm");
  assert.equal(env.GROQ_BASE_URL, "http://127.0.0.1:4000/u/groq");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /OPENAI_BASE_URL/);
});

test("loadUpstreamPrices validates and pins a digest; malformed files throw (AC6)", () => {
  const p = loadUpstreamPrices(pricesFile(), ["groq", "azure"]);
  assert.equal(p.version, "test-1");
  assert.equal(p.sha256, tableDigest(PRICES));
  assert.throws(() => loadUpstreamPrices(pricesFile(PRICES), ["groq"]), /not declared/);
  const bad = path.join(tmp(), "bad.json"); writeFileSync(bad, "{nope");
  assert.throws(() => loadUpstreamPrices(bad, ["groq"]), /invalid JSON/);
  assert.throws(() => loadUpstreamPrices(path.join(tmp(), "missing.json"), []), /ENOENT/);
  for (const doc of [[], { version: 1 }, { upstreams: [] }, { upstreams: { groq: [] } }, { upstreams: { groq: { m: { input: -1, output: 1 } } } },
    { upstreams: { groq: { m: { input: 1 } } } }, { upstreams: { groq: { m: { input: 1, output: 1, cached_input: "x" } } } }, { upstreams: { groq: { m: null } } }]) {
    assert.throws(() => loadUpstreamPrices(pricesFile(doc), ["groq"]), /upstream-prices/, JSON.stringify(doc));
  }
  assert.equal(loadUpstreamPrices(pricesFile({ upstreams: {} }), []).version, null);
});

test("costForUserPrices prices from the file only; unpriced is null, never table or fallback (AC2)", () => {
  const prices = loadUpstreamPrices(pricesFile(), ["groq", "azure"]);
  const ok = costForUserPrices(prices, "u/azure", "gpt-4o-2024-08-06", { input_tokens: 1000, cached_input_tokens: 1000, output_tokens: 100 });
  assert.equal(ok.cost_usd, Number(((1000 * 2.5 + 1000 * 1.25 + 100 * 10) / 1e6).toFixed(6)));
  assert.equal(ok.cost_source, "user_prices");
  assert.equal(ok.prices_sha256, prices.sha256);
  assert.equal(ok.fallback, false);
  // gpt-4o is in the shipped table but not priced for groq: unknown.
  for (const r of [costForUserPrices(prices, "u/groq", "gpt-4o", { input_tokens: 1, output_tokens: 1 }), costForUserPrices(null, "u/groq", "llama-3.3-70b", { input_tokens: 1, output_tokens: 1 }),
    costForUserPrices(prices, "u/groq", "llama-3.3-70b", { input_tokens: 1, cached_input_tokens: 5, output_tokens: 1 }), costForUserPrices(prices, "u/nope", "x")]) {
    assert.equal(r.cost_usd, null);
    assert.equal(r.reason, "upstream_model_unpriced");
    assert.notEqual(r.fallback, true);
    assert.equal(r.table_sha256, undefined);
  }
  assert.equal(costForUserPrices(prices, "u/groq", "llama-3.3-70b", { modality_tokens: { input: { image: 1 } } }).reason, "modality_unpriced");
  assert.equal(costForUserPrices(prices, "u/groq", "llama-3.3-70b", { service_tier: "priority" }).reason, "service_tier_unpriced");
  assert.equal(costForUserPrices(prices, "u/groq", "llama-3.3-70b", { speed: "fast" }).reason, "service_tier_unpriced");
  assert.equal(userPrice(prices, "openai", "gpt-4o"), null);
  assert.equal(userPrice(prices, "u/groq", ""), null);
});

test("parseWrapArgs wires --upstream and --upstream-prices", () => {
  const f = pricesFile();
  const o = parseWrapArgs(["--upstream", "groq=https://api.groq.com/openai", "--upstream", "azure=https://a.example.com", "--upstream-prices", f, "--", "x"]);
  assert.deepEqual(o.upstreams.map((u) => u.name), ["groq", "azure"]);
  assert.equal(o.userPrices.version, "test-1");
  assert.deepEqual(parseWrapArgs(["--", "x"]).upstreams, []);
  assert.throws(() => parseWrapArgs(["--upstream-prices", f, "--", "x"]), /not declared/);
});

// Fake OpenAI-compatible upstream recording each request.
async function fake(t, respond) {
  const seen = [];
  const up = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      seen.push({ url: req.url, raw, headers: req.headers });
      respond(req, res, raw);
    });
  });
  const port = await listen(up);
  t.after(() => { up.closeAllConnections(); up.close(); });
  return { seen, base: `http://127.0.0.1:${port}` };
}
const json = (body) => (req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

async function proxyFor(t, upstreamBase, opts = {}) {
  const receipts = [];
  const dir = tmp();
  const { server, port } = await startMeteringProxy({ receiptsPath: path.join(dir, "r.jsonl"), onReceipt: (r) => receipts.push(r),
    customUpstreams: { groq: `${upstreamBase}/openai`, azure: upstreamBase }, userPrices: loadUpstreamPrices(pricesFile(), ["groq", "azure"]), ...opts });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = async (p, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body, headers });
    return { status: res.status, body: await res.text() };
  };
  return { receipts, call, ledger: () => readFileSync(path.join(dir, "r.jsonl"), "utf8") };
}

test("/u/<name> routes to the custom URL and prices from user prices (AC1)", async (t) => {
  const up = await fake(t, json({ model: "llama-3.3-70b", usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
  const p = await proxyFor(t, up.base);
  const r = await p.call("/u/groq/v1/chat/completions?x=1", JSON.stringify({ model: "llama-3.3-70b", messages: [] }));
  assert.equal(r.status, 200);
  assert.equal(up.seen[0].url, "/openai/v1/chat/completions?x=1");
  const rc = p.receipts[0];
  assert.equal(rc.provider, "u/groq");
  assert.equal(rc.path, "/v1/chat/completions?x=1");
  assert.equal(rc.model, "llama-3.3-70b");
  assert.equal(rc.cost_usd, Number(((1000 * 0.59 + 500 * 0.79) / 1e6).toFixed(6)));
  assert.equal(rc.cost_source, "user_prices");
  assert.equal(rc.prices_version, "test-1");
});

test("unknown custom names and an empty /u/ path are 404; built-in routing is untouched", async (t) => {
  const up = await fake(t, json({}));
  const p = await proxyFor(t, up.base);
  assert.equal((await p.call("/u/nope/v1/chat/completions", "{}")).status, 404);
  assert.equal((await p.call("/u/groq", "{}")).status, 404);
  assert.equal((await p.call("/u", "{}")).status, 404);
  assert.equal(up.seen.length, 0);
});

test("unpriced custom model is unknown and pauses the next call; table models are not priced (AC2)", async (t) => {
  const up = await fake(t, json({ model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const p = await proxyFor(t, up.base);
  const r = await p.call("/u/groq/v1/chat/completions", JSON.stringify({ model: "gpt-4o" }));
  assert.equal(r.status, 200);
  assert.equal(p.receipts[0].cost_usd, null);
  assert.equal(p.receipts[0].reason, "upstream_model_unpriced");
  assert.notEqual(p.receipts[0].fallback, true);
  const next = await p.call("/u/groq/v1/chat/completions", JSON.stringify({ model: "llama-3.3-70b" }));
  assert.equal(next.status, 429);
  assert.match(next.body, /accounting_unavailable/);
  assert.match(next.body, /--upstream-prices/);
  assert.equal(up.seen.length, 1);
});

test("no prices file at all: every custom response is unknown", async (t) => {
  const up = await fake(t, json({ model: "llama-3.3-70b", usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const p = await proxyFor(t, up.base, { userPrices: null });
  await p.call("/u/groq/v1/chat/completions", JSON.stringify({ model: "llama-3.3-70b" }));
  assert.equal(p.receipts[0].reason, "upstream_model_unpriced");
});

test("Azure-shaped request passes through; api-key never stored; priced from response model (AC4)", async (t) => {
  const up = await fake(t, json({ model: "gpt-4o-2024-08-06", usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  const p = await proxyFor(t, up.base);
  const secret = "azure-test-key-value";
  const r = await p.call(`/u/azure/openai/deployments/my-dep/chat/completions?api-version=2024-10-21&api-key=${secret}`, JSON.stringify({ messages: [] }), { "api-key": secret });
  assert.equal(r.status, 200);
  assert.equal(up.seen[0].url, `/openai/deployments/my-dep/chat/completions?api-version=2024-10-21&api-key=${secret}`);
  assert.equal(up.seen[0].headers["api-key"], secret);
  const rc = p.receipts[0];
  assert.equal(rc.model, "gpt-4o-2024-08-06");
  assert.equal(rc.cost_usd, Number(((100 * 2.5 + 10 * 10) / 1e6).toFixed(6)));
  assert.match(rc.path, /api-key=REDACTED/);
  assert.ok(!p.ledger().includes(secret));
});

test("--models refuses a model-less Azure request before forwarding (AC4)", async (t) => {
  const up = await fake(t, json({}));
  const p = await proxyFor(t, up.base, { allowedModels: () => ["gpt-4o"] });
  const r = await p.call("/u/azure/openai/deployments/my-dep/chat/completions?api-version=2024-10-21", JSON.stringify({ messages: [] }));
  assert.equal(r.status, 403);
  assert.match(r.body, /model_not_allowed/);
  assert.equal(up.seen.length, 0);
});

test("--unknown-models refuse and --preflight refuse unpriced custom models before the upstream (AC5)", async (t) => {
  const up = await fake(t, json({ model: "llama-3.3-70b", usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const refuse = await proxyFor(t, up.base, { unknownModels: "refuse" });
  const a = await refuse.call("/u/groq/v1/chat/completions", JSON.stringify({ model: "gpt-4o" }));
  assert.equal(a.status, 403);
  assert.match(a.body, /model_unpriced/);
  const pf = await proxyFor(t, up.base, { preflight: true });
  const b = await pf.call("/u/groq/v1/chat/completions", JSON.stringify({ model: "gpt-4o" }));
  assert.equal(b.status, 429);
  assert.match(b.body, /preflight_unpriced/);
  assert.equal(up.seen.length, 0);
  // A priced model inside the budget is forwarded under both.
  assert.equal((await refuse.call("/u/groq/v1/chat/completions", JSON.stringify({ model: "llama-3.3-70b" }))).status, 200);
  assert.equal((await pf.call("/u/groq/v1/chat/completions", JSON.stringify({ model: "llama-3.3-70b", max_tokens: 100 }))).status, 200);
  assert.equal(up.seen.length, 2);
});
