// #278: non-Anthropic Bedrock models (Nova, Llama, Mistral, DeepSeek, gpt-oss, Qwen) priced per region
// from the table's bedrock_models section, plus bedrock/vertex --upstream-prices override keys.
// Local stub only: no AWS, no live calls.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMeteringProxy } from "../src/proxy.js";
import { bedrockBaseId, converseEventFrame, mapCloudModel } from "../src/cloud.js";
import { signRequest } from "../src/sigv4.js";
import { bedrockModels, bedrockRow, costForUsage, lookupPrice } from "../src/pricing.js";
import { createCapEngine } from "../src/cap.js";
import { createModelCaps, normalizeModel, parseModelCaps } from "../src/model-cap.js";
import { loadUpstreamPrices } from "../src/upstreams.js";
import { builtinOverride, cloudOverridePrice, costForCloud, hasAbsoluteCloudPrice, unpricedDiscountWarnings, OVERRIDE_PROVIDERS } from "../src/price-overrides.js";
import { buildSection, regionRows, MODELS, REGIONS } from "../scripts/bedrock-prices.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TABLE = JSON.parse(readFileSync(path.join(ROOT, "src/pricing-table.json"), "utf8"));
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"; // AWS documentation example key
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET };
const env = (region) => ({ AWS_ACCESS_KEY_ID: CREDS.accessKeyId, AWS_SECRET_ACCESS_KEY: SECRET, AWS_REGION: region });
const NOVA = "amazon.nova-pro-v1:0";
const SONNET_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const enc = (id) => encodeURIComponent(id);
const cUsage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 };
const converseBody = { output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: cUsage };
const streamFrames = [
  converseEventFrame("messageStart", { role: "assistant" }),
  converseEventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hi" } }),
  converseEventFrame("messageStop", { stopReason: "end_turn" }),
  converseEventFrame("metadata", { usage: cUsage, metrics: { latencyMs: 5 } }),
];
const body = JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }] });
const rate = (region, m = NOVA) => TABLE.bedrock_models.models[m][region];
const expected = (r, u = cUsage) => Number(((u.inputTokens * r.input + u.outputTokens * r.output) / 1e6).toFixed(6));

async function stub() {
  const hits = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push(req.url);
      if (req.url.endsWith("/converse-stream")) {
        res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
        res.end(Buffer.concat(streamFrames));
      } else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(converseBody));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, url: `http://127.0.0.1:${server.address().port}` };
}

async function proxyFor(t, region, opts = {}) {
  const up = await stub();
  const dir = mkdtempSync(path.join(tmpdir(), "cc-bedrock-278-"));
  const receipts = [];
  const { server, port } = await startMeteringProxy({ receiptsPath: path.join(dir, "r.jsonl"), upstreams: { bedrock: up.url, vertex: up.url }, cloudEnv: env(region),
    onReceipt: (r) => receipts.push(r), onWarning: () => {}, ...opts });
  t.after(() => { server.close(); up.server.close(); });
  const post = async (modelId, b = body, { verb = "converse", signRegion = region, provider = "bedrock", pathname } = {}) => {
    const p = pathname ?? `/${provider}/model/${enc(modelId)}/${verb}`;
    const headers = signRequest({ method: "POST", path: p, headers: { "content-type": "application/json" }, body: b, host: `127.0.0.1:${port}`, region: signRegion, service: "bedrock" }, CREDS);
    delete headers.host;
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers, body: b });
    await r.arrayBuffer();
    return r;
  };
  return { up, receipts, post, port };
}

function pricesFile(doc) {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-bedrock-278-prices-"));
  const f = path.join(dir, "prices.json");
  writeFileSync(f, JSON.stringify(doc));
  return f;
}

// ---- table ----

test("bedrock_models: every family in at least us-east-1, us-west-2, eu-west-1; every row sourced and positive", () => {
  const s = TABLE.bedrock_models;
  assert.equal(s.unit, "usd_per_1m_tokens");
  assert.equal(s.tier, "on_demand_standard");
  const regions = new Set(Object.values(s.models).flatMap((r) => Object.keys(r)));
  for (const r of ["us-east-1", "us-west-2", "eu-west-1"]) assert.ok(regions.has(r), r);
  for (const fam of ["amazon.nova-", "meta.llama", "mistral.", "deepseek.", "openai.gpt-oss-", "qwen."]) assert.ok(bedrockModels().some((m) => m.startsWith(fam)), fam);
  for (const r of regions) {
    const src = s.sources.find((x) => x.region === r);
    assert.ok(src, `source for ${r}`);
    assert.match(src.url, /^https:\/\/pricing\.us-east-1\.amazonaws\.com\/offers\/v1\.0\/aws\/AmazonBedrock\/current\//);
    assert.match(src.retrieved, /^\d{4}-\d{2}-\d{2}$/);
  }
  for (const [m, byRegion] of Object.entries(s.models)) {
    assert.ok(!m.startsWith("anthropic."), m);
    for (const [r, row] of Object.entries(byRegion)) {
      for (const k of ["input", "output"]) assert.ok(Number.isFinite(row[k]) && row[k] > 0, `${m}/${r}/${k}`);
      if (row.cached_input !== undefined) assert.ok(row.cached_input > 0 && row.cached_input < row.input, `${m}/${r} cache read`);
      // Only a published $0 cache write (Nova) is kept.
      if (row.cache_write !== undefined) assert.ok(m.startsWith("amazon.nova") && row.cache_write === 0, `${m}/${r} cache write`);
      for (const k of Object.keys(row)) assert.ok(["input", "output", "cached_input", "cache_write"].includes(k), `${m}/${r}: ${k}`);
    }
  }
  // AC1: the us-east-1 Nova Pro rate is the AWS Price List value ($0.0008 / $0.0032 per 1K).
  assert.deepEqual(rate("us-east-1"), { input: 0.8, output: 3.2, cached_input: 0.2, cache_write: 0 });
});

test("generator: Price List offer JSON -> per-1M rows; skips batch/flex/priority/cross-region SKUs and non-token units", () => {
  const sku = (u, usd, unit = "1K tokens") => [u, { attributes: { usagetype: u } }, { T: { priceDimensions: { D: { unit, pricePerUnit: { USD: String(usd) } } } } }];
  const rows = [
    sku("USE1-NovaPro-input-tokens", 0.0008), sku("USE1-NovaPro-output-tokens", 0.0032),
    sku("USE1-NovaPro-cache-read-input-token-count", 0.0002), sku("USE1-NovaPro-cache-write-input-token-count", 0),
    sku("USE1-NovaPro-input-tokens-batch", 0.0004), sku("USE1-NovaCanvas-T2I-1024-Standard", 0.04, "image"),
    sku("USE1-Llama3-8B-input-tokens", 0.0003), // no output rate: not listed
    sku("USE1-Qwen3-32B-input-tokens", 0.00015), sku("USE1-Qwen3-32B-output-tokens", 0.0006),
    sku("USE1-Qwen3-32B-cache-read-input-token-count", 0), // a $0 cache read is never kept
  ];
  const offer = { publicationDate: "2026-11-11T01:30:37Z", products: Object.fromEntries(rows.map(([u, p]) => [u, p])), terms: { OnDemand: Object.fromEntries(rows.map(([u, , t]) => [u, t])) } };
  const r = regionRows(offer);
  assert.deepEqual(r, { "amazon.nova-pro-v1:0": { input: 0.8, output: 3.2, cached_input: 0.2, cache_write: 0 }, "qwen.qwen3-32b-v1:0": { input: 0.15, output: 0.6 } });
  const s = buildSection({ "us-east-1": offer }, "2026-11-17");
  assert.deepEqual(s.sources, [{ region: "us-east-1", url: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json", retrieved: "2026-11-17", publication_date: "2026-11-11T01:30:37Z" }]);
  assert.deepEqual(Object.keys(s.models), ["amazon.nova-pro-v1:0", "qwen.qwen3-32b-v1:0"]);
  assert.deepEqual(REGIONS, ["us-east-1", "us-west-2", "eu-west-1"]);
  for (const id of bedrockModels()) assert.ok(Object.hasOwn(MODELS, id), `${id} comes from the generator`);
});

// ---- mapping ----

test("mapCloudModel: geo prefix, region row, ARN, global., unlisted", () => {
  assert.equal(bedrockBaseId("us.amazon.nova-pro-v1:0"), NOVA);
  assert.equal(bedrockBaseId("arn:aws:bedrock:us-east-1:1:inference-profile/x"), null);
  assert.equal(bedrockBaseId(""), null);
  assert.equal(mapCloudModel("bedrock", NOVA, { region: "us-east-1" }), NOVA);
  for (const g of ["us", "eu", "apac"]) assert.equal(mapCloudModel("bedrock", `${g}.${NOVA}`, { region: "us-west-2" }), NOVA);
  assert.equal(mapCloudModel("bedrock", NOVA), NOVA, "no region (cap normalisation): any listed row");
  assert.equal(mapCloudModel("bedrock", NOVA, { region: "ap-southeast-3" }), null);
  assert.equal(mapCloudModel("bedrock", `global.${NOVA}`, { region: "us-east-1" }), null);
  assert.equal(mapCloudModel("bedrock", "meta.unlisted-v1:0", { region: "us-east-1" }), null);
  assert.equal(mapCloudModel("bedrock", `arn:aws:bedrock:us-east-1:123:application-inference-profile/abc`, { region: "us-east-1" }), null);
  assert.equal(mapCloudModel("bedrock", "amazon.nova-premier-v1:0", { region: "eu-west-1" }), null, "Premier has no eu-west-1 row");
  // Claude ids are unchanged and never region-gated.
  assert.equal(mapCloudModel("bedrock", SONNET_ID, { region: "ap-southeast-3" }), "claude-sonnet-4-5");
  assert.equal(normalizeModel(NOVA), NOVA);
});

test("lookupPrice/costForUsage price a region row; no regional premium; no row -> not a region price", () => {
  assert.equal(bedrockRow(NOVA, "nowhere-1"), null);
  assert.equal(bedrockRow(42, "us-east-1"), null);
  const p = lookupPrice(NOVA, undefined, { bedrock: "eu-west-1" });
  assert.deepEqual([p.input, p.output, p.fallback, p.bedrock_region], [0.92, 3.68, false, "eu-west-1"]);
  const u = { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 2000, cache_write_input_tokens: 300 };
  const c = costForUsage(NOVA, u, { bedrock: "us-east-1", regional: true });
  assert.equal(c.cost_usd, Number(((1000 * 0.8 + 500 * 3.2 + 2000 * 0.2) / 1e6).toFixed(6)));
  assert.equal(c.regional_multiplier, undefined);
  assert.equal(c.bedrock_region, "us-east-1");
  assert.equal(c.cost_source, "table");
  // A Llama row publishes no cache-read rate: unknown, never $0.
  assert.equal(costForUsage("meta.llama3-3-70b-instruct-v1:0", { input_tokens: 1, cached_input_tokens: 5 }, { bedrock: "us-east-1" }).cost_usd, null);
});

// ---- e2e through the proxy (AC1-AC3) ----

test("AC1 Converse + ConverseStream on Nova Pro (us-east-1) are priced from the table and the run continues", async (t) => {
  const { up, receipts, post } = await proxyFor(t, "us-east-1");
  const r = await post(NOVA);
  assert.equal(r.status, 200);
  const s = await post(NOVA, body, { verb: "converse-stream" });
  assert.equal(s.status, 200);
  const third = await post(NOVA);
  assert.equal(third.status, 200, "run not paused");
  assert.equal(up.hits.length, 3);
  for (const rc of receipts.slice(0, 2)) {
    assert.equal(rc.provider, "bedrock");
    assert.equal(rc.model, NOVA);
    assert.equal(rc.cost_usd, expected(rate("us-east-1")));
    assert.equal(rc.reason, undefined);
    assert.equal(rc.fallback, false);
    assert.equal(rc.bedrock_region, "us-east-1");
  }
});

test("AC2 geo profile priced at the request region; unknown region/model/ARN/global/priority tier are unpriced (never $0, never fallback)", async (t) => {
  const west = await proxyFor(t, "us-west-2");
  await west.post(`us.${NOVA}`);
  assert.equal(west.receipts[0].cost_usd, expected(rate("us-west-2")));
  assert.equal(west.receipts[0].bedrock_region, "us-west-2");

  const eu = await proxyFor(t, "eu-west-1");
  await eu.post(`eu.${NOVA}`);
  assert.equal(eu.receipts[0].cost_usd, expected(rate("eu-west-1")));

  const cases = [
    ["ap-southeast-3", NOVA, undefined, "cloud_model_unpriced"],
    ["us-east-1", "meta.unlisted-v1:0", undefined, "cloud_model_unpriced"],
    ["us-east-1", "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc", undefined, "cloud_model_unpriced"],
    ["us-east-1", `global.${NOVA}`, undefined, "cloud_model_unpriced"],
    ["us-east-1", NOVA, JSON.stringify({ messages: [], serviceTier: { type: "priority" } }), "service_tier_unpriced"],
    ["us-east-1", NOVA, JSON.stringify({ messages: [], serviceTier: { type: "flex" } }), "service_tier_unpriced"],
  ];
  for (const [region, id, b, reason] of cases) {
    const p = await proxyFor(t, region);
    const r = await p.post(id, b);
    assert.equal(r.status, 200, `${region} ${id}`);
    const rc = p.receipts[0];
    assert.equal(rc.cost_usd, null, `${region} ${id}`);
    assert.equal(rc.reason, reason, `${region} ${id}`);
    assert.notEqual(rc.cost_source, "fallback");
    assert.ok(!rc.fallback, `${region} ${id}`);
    // The run pauses until the unknown call is reconciled.
    const next = await p.post(NOVA);
    assert.notEqual(next.status, 200, `${region} ${id}: paused`);
  }
  // serviceTier default is the standard rate.
  const d = await proxyFor(t, "us-east-1");
  await d.post(NOVA, JSON.stringify({ messages: [], serviceTier: { type: "default" } }));
  assert.equal(d.receipts[0].cost_usd, expected(rate("us-east-1")));
});

test("AC3 preflight, --unknown-models refuse and --model-cap on a priced Nova model", async (t) => {
  const pf = await proxyFor(t, "us-east-1", { preflight: true, cap: createCapEngine({ caps: { run: 0.01 } }) });
  const big = await pf.post(NOVA, JSON.stringify({ messages: [], inferenceConfig: { maxTokens: 100000 } }));
  assert.equal(big.status, 429);
  assert.equal(pf.up.hits.length, 0);
  const small = await pf.post(NOVA, JSON.stringify({ messages: [], inferenceConfig: { maxTokens: 10 } }));
  assert.equal(small.status, 200);
  // A region with no row: preflight cannot price it.
  const pfx = await proxyFor(t, "ap-southeast-3", { preflight: true, cap: createCapEngine({ caps: { run: 10 } }) });
  const u = await pfx.post(NOVA, JSON.stringify({ messages: [], inferenceConfig: { maxTokens: 10 } }));
  assert.equal(u.status, 429);
  assert.equal(pfx.up.hits.length, 0);

  const refuse = await proxyFor(t, "us-east-1", { unknownModels: "refuse" });
  assert.equal((await refuse.post(`us.${NOVA}`)).status, 200);
  assert.equal((await refuse.post("meta.unlisted-v1:0")).status, 403);
  assert.equal(refuse.up.hits.length, 1);

  const modelCaps = createModelCaps({ rules: parseModelCaps([`${NOVA}:day=0.01`]) });
  const mc = await proxyFor(t, "us-east-1", { modelCaps });
  for (let i = 0; i < 5; i++) await mc.post(NOVA);
  const stopped = await mc.post(NOVA);
  assert.equal(stopped.status, 429);
  assert.equal(mc.receipts.at(-1).reason, "model_budget_exceeded");
  const other = await mc.post("openai.gpt-oss-20b-1:0");
  assert.equal(other.status, 200, "only the capped model stops");
});

// ---- --upstream-prices bedrock / vertex (AC4) ----

test("AC4 bedrock/vertex override keys: absolute prices an unlisted id, discount scales a row, validation exits before spawn", async (t) => {
  assert.ok(OVERRIDE_PROVIDERS.includes("bedrock") && OVERRIDE_PROVIDERS.includes("vertex"));
  const f = pricesFile({ version: "t1", upstreams: { bedrock: { "meta.llama-x-v1:0": { input: 1, output: 2 }, [NOVA]: { discount: 0.5 } }, vertex: { "*": { discount: 0.2 } } } });
  const prices = loadUpstreamPrices(f, []);
  const p = await proxyFor(t, "us-east-1", { userPrices: prices, unknownModels: "refuse", preflight: true, cap: createCapEngine({ caps: { run: 10 } }) });
  assert.equal((await p.post("us.meta.llama-x-v1:0")).status, 200);
  const abs = p.receipts[0];
  assert.deepEqual([abs.model, abs.cost_usd, abs.cost_source, abs.prices_version], ["meta.llama-x-v1:0", Number(((1000 * 1 + 500 * 2) / 1e6).toFixed(6)), "user_prices", "t1"]);
  assert.equal((await p.post(NOVA)).status, 200);
  assert.equal(p.receipts[1].cost_usd, Number((expected(rate("us-east-1")) * 0.5).toFixed(6)));
  assert.equal(p.receipts[1].cost_source, "user_prices");
  assert.equal(p.receipts[1].discount, 0.5);
  // An ARN and a global. profile never take an absolute rate keyed by base id.
  assert.equal((await p.post("global.meta.llama-x-v1:0")).status, 403);

  // Vertex Gemini receipt discounted 20%.
  const v = await proxyFor(t, "us-east-1", { userPrices: prices });
  const gBody = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
  const vp = "/vertex/v1/projects/p/locations/global/publishers/google/models/gemini-2.5-pro:generateContent";
  const vUp = v.up;
  vUp.server.removeAllListeners("request");
  vUp.server.on("request", (req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, totalTokenCount: 1500 } }))); });
  const r = await fetch(`http://127.0.0.1:${v.port}${vp}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test" }, body: gBody });
  await r.arrayBuffer();
  assert.equal(r.status, 200);
  const base = costForUsage("gemini-2.5-pro", { input_tokens: 1000, output_tokens: 500 }, { vertex: true, at: v.receipts[0].ts }).cost_usd;
  assert.equal(v.receipts[0].cost_source, "user_prices");
  assert.equal(v.receipts[0].cost_usd, Number((base * 0.8).toFixed(6)));

  for (const bad of [{ bedrock: { [NOVA]: { input: 0, output: 1 } } }, { bedrock: { [NOVA]: { input: -1, output: 1 } } }, { bedrock: { "*": { input: 1, output: 1 } } }, { vertex: { "*": { input: 1, output: 1 } } }]) {
    assert.throws(() => loadUpstreamPrices(pricesFile({ upstreams: bad }), []), /--upstream-prices/);
  }
});

test("override helpers: Claude-on-Bedrock receipts unchanged without an entry; warnings; preflight rows", () => {
  const u = { input_tokens: 1000, output_tokens: 500 };
  const opts = { regional: true, undated: true };
  assert.deepEqual(costForCloud(null, "bedrock", "claude-sonnet-4-5", u, opts), costForUsage("claude-sonnet-4-5", u, opts));
  assert.equal(costForCloud(null, "bedrock", "claude-sonnet-4-5", u, opts).regional_multiplier, 1.1);
  const prices = { version: "v", sha256: "s", upstreams: { bedrock: { [NOVA]: { discount: 0.5 }, "meta.nope-v1:0": { discount: 0.1 }, "x.abs-v1:0": { input: 1, output: 2, cached_input: 0.5 } } } };
  assert.deepEqual(unpricedDiscountWarnings(prices), ["costcap: warning: discount ignored: bedrock/meta.nope-v1:0 is not in the pricing table; add absolute rates"]);
  assert.equal(hasAbsoluteCloudPrice(prices, "bedrock", "x.abs-v1:0"), true);
  assert.equal(hasAbsoluteCloudPrice(prices, "bedrock", NOVA), false);
  assert.equal(hasAbsoluteCloudPrice(prices, "bedrock", null), false);
  assert.equal(builtinOverride(prices, "bedrock", "meta.nope-v1:0", { priced: false }), null);
  const row = lookupPrice(NOVA, undefined, { bedrock: "us-east-1" });
  assert.equal(cloudOverridePrice(prices, "bedrock", NOVA, row).input, 0.4);
  assert.equal(cloudOverridePrice(null, "bedrock", NOVA, row), row);
  assert.deepEqual(cloudOverridePrice(prices, "bedrock", "x.abs-v1:0", null), { model: "x.abs-v1:0", input: 1, output: 2, cached_input: 0.5, fallback: false, user_prices: true });
  const abs = costForCloud(prices, "bedrock", "x.abs-v1:0", { ...u, cached_input_tokens: 100 }, { bedrock: "us-east-1" }, { tablePriced: false });
  assert.equal(abs.cost_usd, Number(((1000 + 500 * 2 + 100 * 0.5) / 1e6).toFixed(6)));
  // A cache write the absolute entry doesn't price is unknown.
  assert.equal(costForCloud(prices, "bedrock", "x.abs-v1:0", { ...u, cache_write_input_tokens: 5 }, { bedrock: "us-east-1" }, { tablePriced: false }).reason, "user_price_unpriced");
  // Vertex Claude takes a vertex discount on the regional rate.
  const vp = { version: "v", sha256: "s", upstreams: { vertex: { "*": { discount: 0.2 } } } };
  assert.equal(costForCloud(vp, "vertex", "claude-sonnet-4-5", u, opts).cost_usd, Number((costForUsage("claude-sonnet-4-5", u, opts).cost_usd * 0.8).toFixed(6)));
  assert.equal(costForCloud(vp, "vertex", "claude-sonnet-4-5", u, { at: undefined, undated: true }, { tablePriced: true }).cost_source, "user_prices");
});

test("costcap pricing show lists Bedrock rows per region; a geo id resolves to its base rows", async () => {
  const { pricingCommand } = await import("../src/pricing-cli.js");
  const one = pricingCommand(["show", `us.${NOVA}`]);
  assert.equal(one.code, 0);
  assert.match(one.out, /bedrock\/amazon\.nova-pro-v1:0 \(us-east-1\): input \$0\.8, cached_input \$0\.2, cache_write \$0, .*output \$3\.2/);
  assert.match(one.out, /\(eu-west-1\): input \$0\.92/);
  assert.equal(pricingCommand(["show", `bedrock/${NOVA}`]).out, one.out);
  const all = pricingCommand(["show"]).out.split("\n");
  assert.equal(all.filter((l) => l.startsWith("bedrock/")).length, Object.values(TABLE.bedrock_models.models).reduce((n, r) => n + Object.keys(r).length, 0));
  assert.match(all.at(-1), /^fallback/);
});
