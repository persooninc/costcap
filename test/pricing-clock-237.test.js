// #237: COSTCAP_PRICING_CLOCK pins the pricing clock so test expectations for dated rows
// (gemini-2.5-pro/2.5-flash from 2026-12-01, 3.8/3.6 Flash from 2027-01-01) do not flip with
// the wall clock. An explicit `at` always wins; the proxy prices at the pinned instant.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { costForUsage, dayOf, lookupPrice, pricingAt } from "../src/pricing.js";
import { foldBatchResults } from "../src/batch.js";
import { startMeteringProxy } from "../src/proxy.js";

const KEY = "COSTCAP_PRICING_CLOCK";
const M = { input_tokens: 100_000, output_tokens: 100_000 }; // below the 200K long-context tier

function withClock(t, value) {
  const prev = process.env[KEY];
  if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value;
  t.after(() => { if (prev === undefined) delete process.env[KEY]; else process.env[KEY] = prev; });
}

test("npm test pins the pricing clock before any dated row takes effect", () => {
  assert.ok(process.env[KEY], "run through npm test, which sets COSTCAP_PRICING_CLOCK");
  assert.ok(dayOf() < "2026-12-01");
});

test("pricingAt returns the pin when set, else the given instant", (t) => {
  withClock(t, undefined);
  assert.equal(pricingAt(123), 123);
  assert.equal(pricingAt(undefined), undefined);
  withClock(t, "2026-11-16T12:00:00Z");
  assert.equal(pricingAt(123), "2026-11-16T12:00:00Z");
});

test("dayOf: unpinned uses wall clock; pinned uses the pin; explicit at always wins", (t) => {
  withClock(t, undefined);
  assert.equal(dayOf(), new Date().toISOString().slice(0, 10));
  withClock(t, "2027-02-01T00:00:00Z");
  assert.equal(dayOf(), "2027-02-01");
  assert.equal(dayOf(null), "2027-02-01");
  assert.equal(dayOf("2026-11-01T00:00:00Z"), "2026-11-01");
  withClock(t, "not-a-date");
  assert.throws(() => dayOf(), /invalid pricing instant/);
});

test("costForUsage/lookupPrice/foldBatchResults without at follow the pin", (t) => {
  withClock(t, "2026-11-30T23:59:59Z");
  assert.equal(costForUsage("gemini-2.5-pro", M).cost_usd, 1.125);
  assert.equal(lookupPrice("gemini-3.8-flash").input, 0.75);
  withClock(t, "2027-01-01T00:00:00Z");
  assert.equal(costForUsage("gemini-2.5-pro", M).billed_as, "gemini-3.8-flash");
  assert.equal(lookupPrice("gemini-3.8-flash").input, 1.5);
  // explicit at is never overridden by the pin
  assert.equal(costForUsage("gemini-2.5-pro", M, { at: "2026-11-01T00:00:00Z" }).cost_usd, 1.125);
  const line = JSON.stringify({ key: "a", response: { modelVersion: "gemini-3.8-flash", usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 0 } } });
  assert.equal(foldBatchResults("gemini", line).cost_usd, 0.75); // 2027 rate 1.50 x batch 0.5 (2026 would be 0.375)
});

async function proxyCost(t, opts) {
  const body = JSON.stringify({ modelVersion: "gemini-3.8-flash", usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 0 } });
  const up = await new Promise((r) => { const s = http.createServer((q, res) => { q.resume(); q.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(body)); }); s.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => { up.closeAllConnections(); up.close(); });
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { gemini: `http://127.0.0.1:${up.address().port}` }, onReceipt: (r) => receipts.push(r), ...opts });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const res = await fetch(`http://127.0.0.1:${port}/gemini/v1beta/models/gemini-3.8-flash:generateContent`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await res.text();
  await new Promise((r) => setImmediate(r));
  return receipts[0].cost_usd;
}

test("proxy with its default clock prices at the pin", async (t) => {
  withClock(t, "2027-02-01T00:00:00Z");
  assert.equal(await proxyCost(t, {}), 1.5);
  withClock(t, "2026-11-16T12:00:00Z");
  assert.equal(await proxyCost(t, {}), 0.75);
});

test("proxy with an injected now() prices at it, not the pin", async (t) => {
  withClock(t, "2026-11-16T12:00:00Z");
  assert.equal(await proxyCost(t, { now: () => Date.parse("2027-02-01T00:00:00Z") }), 1.5);
});

test("#257 cache storage is priced on the response's own times, never the pinned clock", async (t) => {
  const { cacheStorageCost } = await import("../src/pricing.js");
  withClock(t, "2026-11-16T12:00:00Z");
  assert.equal(cacheStorageCost("gemini-2.5-pro", 100000, "2026-12-02T12:00:00Z", "2026-12-02T14:00:00Z").cost_usd, 0.1);
  withClock(t, "2027-02-01T00:00:00Z");
  assert.equal(cacheStorageCost("gemini-2.5-pro", 100000, "2026-11-30T12:00:00Z", "2026-11-30T14:00:00Z").cost_usd, 0.9);
});
