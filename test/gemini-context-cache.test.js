// #257: Gemini context caching (cachedContents). Create and TTL updates bill storage per
// 1M tokens per hour; DELETE and reads are free; unknown storage is never $0.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { geminiCacheRoute, isNonBillableFilesRequest, startMeteringProxy } from "../src/proxy.js";
import { cacheStorageCost } from "../src/pricing.js";
import { pricingCommand } from "../src/pricing-cli.js";

const T0 = "2026-11-16T12:00:00Z";
const plusH = (iso, h) => new Date(Date.parse(iso) + h * 3.6e6).toISOString();
const CREATE = "/gemini/v1beta/cachedContents";
const NAME = "cachedContents/abc123";
const GEN = "/gemini/v1beta/models/gemini-2.5-flash:generateContent";
const GEN_REPLY = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], modelVersion: "gemini-2.5-flash",
  usageMetadata: { promptTokenCount: 20000, cachedContentTokenCount: 19000, candidatesTokenCount: 10, totalTokenCount: 20010 } };
const cacheObj = (over = {}) => ({ name: NAME, model: "models/gemini-2.5-flash", createTime: T0, updateTime: T0, expireTime: plusH(T0, 1),
  usageMetadata: { totalTokenCount: 200000 }, ...over });

async function setup(t, opts = {}, reply = {}) {
  const hits = [];
  const up = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body: b });
      const key = `${req.method} /gemini${req.url.split("?")[0]}`;
      const r = reply[key] ?? (req.url.includes(":generateContent") ? [200, GEN_REPLY] : req.method === "DELETE" ? [200, {}] : [200, cacheObj()]);
      res.writeHead(r[0], { "content-type": "application/json" }).end(JSON.stringify(r[1]));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const receipts = [];
  const p = await startMeteringProxy({ upstreams: { gemini: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r), ...opts });
  t.after(() => { p.server.closeAllConnections(); p.server.close(); up.closeAllConnections(); up.close(); });
  const call = (method, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { call, receipts, hits };
}
const createBody = (model = "models/gemini-2.5-flash") => ({ model, contents: [{ role: "user", parts: [{ text: "big doc" }] }], ttl: "3600s" });

test("#257 AC7 route matchers are exact and hardened", () => {
  assert.equal(geminiCacheRoute("POST", "/gemini/v1beta/cachedContents"), "create");
  assert.equal(geminiCacheRoute("POST", "/gemini/v1/cachedContents?x=1"), "create");
  assert.equal(geminiCacheRoute("PATCH", "/gemini/v1alpha/cachedContents/abc-1_2"), "patch");
  assert.equal(isNonBillableFilesRequest("DELETE", "/gemini/v1beta/cachedContents/abc123"), true);
  for (const u of ["/gemini/v1beta/cachedContents/a%2Fb", "/gemini/v1beta/cachedContents/../models", "/gemini/v1beta/cachedContents/x/y", "/gemini//v1beta/cachedContents"]) {
    for (const m of ["POST", "PATCH"]) assert.equal(geminiCacheRoute(m, u), null, `${m} ${u}`);
    assert.equal(isNonBillableFilesRequest("DELETE", u), false, u);
  }
  assert.equal(geminiCacheRoute("GET", CREATE), null);
  assert.equal(geminiCacheRoute("POST", "/gemini/v1beta/cachedContents/abc"), null);
  assert.equal(geminiCacheRoute("POST", 42), null);
});

test("#257 AC7 look-alike paths are not cache routes and still pause", async (t) => {
  const { call, receipts } = await setup(t);
  await call("PATCH", "/gemini/v1beta/cachedContents/x/y", {});
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [null, "usage_unavailable"]);
  assert.equal((await call("POST", GEN, {})).status, 429);
});

const MODES = {
  "plain wrap": {},
  "--preflight": { preflight: true },
  "--models": { allowedModels: () => ["gemini-2.5-flash"] },
  "--unknown-models refuse": { unknownModels: "refuse" },
};
for (const [mode, opts] of Object.entries(MODES)) {
  test(`#257 AC1/AC2 ${mode}: create bills storage, cached generate, GET/PATCH/DELETE reach upstream`, async (t) => {
    const { call, receipts, hits } = await setup(t, opts, { [`PATCH /gemini/v1beta/cachedContents/abc123`]: [200, cacheObj({ updateTime: plusH(T0, 0.5), expireTime: plusH(T0, 3) })] });
    const c = await call("POST", CREATE, createBody());
    assert.equal(c.status, 200);
    const r = receipts[0];
    assert.deepEqual([r.cost_usd, r.kind, r.cache_name, r.cache_tokens, r.storage_hours, r.model, r.reason], [0.2, "cache_storage", NAME, 200000, 1, "gemini-2.5-flash", undefined]);
    assert.equal(JSON.parse(hits[0].body).model, "models/gemini-2.5-flash", "body forwarded verbatim");
    if (opts.preflight) assert.equal(r.preflight_estimate, false);
    const g = await call("POST", GEN, { cachedContent: NAME, contents: [{ role: "user", parts: [{ text: "q" }] }] });
    assert.equal(g.status, 200);
    assert.equal(typeof receipts[1].cost_usd, "number");
    assert.ok(receipts[1].cost_usd > 0 && !receipts[1].reason);
    assert.equal((await call("GET", `/gemini/v1beta/${NAME}`)).status, 200);
    assert.deepEqual([receipts[2].cost_usd, receipts[2].reason], [0, "non_billable_request"]);
    assert.equal((await call("PATCH", `/gemini/v1beta/${NAME}`, { ttl: "10800s" })).status, 200);
    assert.deepEqual([receipts[3].cost_usd, receipts[3].storage_upper_bound], [0.4, undefined]);
    assert.equal((await call("DELETE", `/gemini/v1beta/${NAME}`)).status, 200);
    assert.deepEqual([receipts[4].cost_usd, receipts[4].reason], [0, "non_billable_request"]);
    assert.equal(hits.length, 5);
  });
}

test("#257 AC2 --models gemini-2.5-pro refuses a 2.5-flash create; nothing forwarded", async (t) => {
  const { call, receipts, hits } = await setup(t, { allowedModels: () => ["gemini-2.5-pro"] });
  const c = await call("POST", CREATE, createBody());
  assert.equal(c.status, 403);
  assert.equal((await c.json()).error, "model_not_allowed");
  assert.equal(receipts[0].model, "gemini-2.5-flash");
  assert.equal(hits.length, 0);
});

test("#257 AC3 PATCH on an unseen cache bills updateTime→expireTime as an upper bound; shorter TTL is $0", async (t) => {
  const { call, receipts } = await setup(t, {}, {
    "PATCH /gemini/v1beta/cachedContents/zzz": [200, cacheObj({ name: "cachedContents/zzz", updateTime: plusH(T0, 1), expireTime: plusH(T0, 3) })],
    "PATCH /gemini/v1beta/cachedContents/abc123": [200, cacheObj({ updateTime: plusH(T0, 0.2), expireTime: plusH(T0, 0.5) })],
  });
  await call("PATCH", "/gemini/v1beta/cachedContents/zzz", { ttl: "7200s" });
  assert.deepEqual([receipts[0].cost_usd, receipts[0].storage_upper_bound, receipts[0].kind], [0.4, true, "cache_storage"]);
  await call("POST", CREATE, createBody());
  await call("PATCH", `/gemini/v1beta/${NAME}`, { ttl: "1800s" });
  assert.deepEqual([receipts[2].cost_usd, receipts[2].reason, receipts[2].storage_upper_bound], [0, undefined, undefined]);
  assert.equal((await call("POST", GEN, {})).status, 200, "run not paused");
});

test("#257 a GET/list response teaches the wrapper a cache's expiry", async (t) => {
  const { call, receipts } = await setup(t, {}, {
    "GET /gemini/v1beta/cachedContents": [200, { cachedContents: [cacheObj({ expireTime: plusH(T0, 2) })] }],
    "PATCH /gemini/v1beta/cachedContents/abc123": [200, cacheObj({ updateTime: plusH(T0, 1), expireTime: plusH(T0, 3) })],
  });
  await call("GET", CREATE);
  await call("PATCH", `/gemini/v1beta/${NAME}`, { ttl: "7200s" });
  assert.deepEqual([receipts[1].cost_usd, receipts[1].storage_upper_bound], [0.2, undefined]);
});

for (const [label, obj] of [
  ["no totalTokenCount", cacheObj({ usageMetadata: {} })],
  ["non-integer totalTokenCount", cacheObj({ usageMetadata: { totalTokenCount: 1.5 } })],
  ["no expireTime", cacheObj({ expireTime: undefined })],
  ["unparseable createTime", cacheObj({ createTime: "yesterday" })],
  ["gemini-4-carbon", cacheObj({ model: "models/gemini-4-carbon" })],
  ["unknown model", cacheObj({ model: "models/gemini-9-mystery" })],
]) {
  test(`#257 AC5 ${label}: cache_storage_unpriced, run paused`, async (t) => {
    const { call, receipts } = await setup(t, {}, { [`POST ${CREATE}`]: [200, obj] });
    assert.equal((await call("POST", CREATE, createBody())).status, 200);
    assert.deepEqual([receipts[0].cost_usd, receipts[0].reason, receipts[0].kind], [null, "cache_storage_unpriced", "cache_storage"]);
    assert.equal((await call("POST", GEN, {})).status, 429);
  });
}

test("#257 AC5 a 400 create is $0 and does not pause the run", async (t) => {
  const { call, receipts } = await setup(t, {}, { [`POST ${CREATE}`]: [400, { error: { code: 400, message: "too few tokens", status: "INVALID_ARGUMENT" } }] });
  assert.equal((await call("POST", CREATE, createBody())).status, 400);
  assert.deepEqual([receipts[0].cost_usd, receipts[0].reason], [0, "upstream_rejected"]);
  assert.equal((await call("POST", GEN, {})).status, 200);
});

test("#257 AC6 --cap 0.15: a $0.20 create makes the next call budget_exceeded", async (t) => {
  const { createCapEngine } = await import("../src/cap.js");
  const { call, receipts } = await setup(t, { cap: createCapEngine({ caps: { run: 0.15 } }) });
  assert.equal((await call("POST", CREATE, createBody())).status, 200);
  assert.equal(receipts[0].cost_usd, 0.2);
  const g = await call("POST", GEN, {});
  assert.equal(g.status, 429);
  assert.equal(receipts[1].reason, "budget_exceeded");
});

test("#257 --downgrade does not rewrite a create (unsupported_route)", async (t) => {
  const downgrader = { decide: (m) => (m === "gemini-2.5-flash" ? { from: m, to: "gemini-2.5-flash-lite", scope: "run", fraction: 0.8 } : null), notice: () => null };
  const { call, receipts, hits } = await setup(t, { downgrader });
  await call("POST", CREATE, createBody());
  assert.equal(receipts[0].downgrade, "unsupported_route");
  assert.equal(JSON.parse(hits[0].body).model, "models/gemini-2.5-flash");
  assert.equal(receipts[0].cost_usd, 0.2);
});

test("#257 AC4 dated rates on the response's own clock, split at boundaries", () => {
  assert.equal(cacheStorageCost("gemini-2.5-pro", 100000, "2026-11-30T12:00:00Z", "2026-11-30T14:00:00Z").cost_usd, 0.9);
  assert.equal(cacheStorageCost("gemini-2.5-pro", 100000, "2026-12-02T12:00:00Z", "2026-12-02T14:00:00Z").cost_usd, 0.1);
  assert.equal(cacheStorageCost("gemini-3.8-flash", 1000000, "2026-12-31T23:00:00Z", "2027-01-01T01:00:00Z").cost_usd, 1.5);
  assert.equal(cacheStorageCost("gemini-2.5-pro", 100000, "2026-11-30T23:00:00Z", "2026-12-01T01:00:00Z").cost_usd, 0.5);
  assert.equal(cacheStorageCost("gemini-2.5-flash", 1000000, "2026-11-16T00:00:00Z", "2026-11-16T00:00:00Z").cost_usd, 0);
  assert.equal(cacheStorageCost("gemini-4-carbon", 1000000, "2026-11-16T00:00:00Z", "2026-11-16T01:00:00Z"), null);
  assert.equal(cacheStorageCost("gemini-4-carbon", 1000000, "2026-11-16T00:00:00Z", "2026-11-16T00:00:00Z"), null);
  assert.equal(cacheStorageCost("nope", 1, "2026-11-16T00:00:00Z", "2026-11-16T01:00:00Z"), null);
  assert.equal(cacheStorageCost("gemini-2.5-flash", -1, "2026-11-16T00:00:00Z", "2026-11-16T01:00:00Z"), null);
  assert.equal(cacheStorageCost("gemini-2.5-flash", 1, "bad", "2026-11-16T01:00:00Z"), null);
  for (const m of ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.1-pro-preview"])
    assert.ok(cacheStorageCost(m, 1000000, "2026-11-16T00:00:00Z", "2026-11-16T01:00:00Z").cost_usd > 0, m);
});

test("#257 AC4 a create at 2026-11-30 is priced at its createTime, not the pinned clock", async (t) => {
  const at = "2026-11-30T12:00:00Z";
  const { call, receipts } = await setup(t, {}, { [`POST ${CREATE}`]: [200, cacheObj({ model: "models/gemini-2.5-pro", createTime: at, expireTime: plusH(at, 2), usageMetadata: { totalTokenCount: 100000 } })] });
  await call("POST", CREATE, createBody("models/gemini-2.5-pro"));
  assert.equal(receipts[0].cost_usd, 0.9);
});

test("#257 costcap pricing show prints the storage rate and its dated change", () => {
  const r = pricingCommand(["show", "gemini-3.8-flash", "--at", "2026-11-16"]);
  assert.match(r.out, /context cache storage \$0\.5 per 1M tokens per hour/);
  assert.match(r.out, /from 2027-01-01: .*cache_storage \$1 per 1M tokens per hour/);
  assert.match(pricingCommand(["show"]).out, /gemini-2\.5-pro: context cache storage \$4\.5 per 1M tokens per hour/);
  assert.doesNotMatch(pricingCommand(["show", "gemini-4-carbon"]).out, /cache storage/);
});
