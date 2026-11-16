// #242: OpenRouter's exact usage.cost settles modality_unpriced and user_price_unpriced receipts.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createCapEngine } from "../src/cap.js";
import { loadUpstreamPrices } from "../src/upstreams.js";

const IMAGE = { model: "google/gemini-2.5-flash-image", usage: { prompt_tokens: 50, completion_tokens: 1300, completion_tokens_details: { image_tokens: 1290 }, cost: 0.0387 } };
const AUDIO = { model: "openai/gpt-4o", usage: { prompt_tokens: 2000, completion_tokens: 10, prompt_tokens_details: { audio_tokens: 1500 }, cost: 0.0123 } };
const TEXT = (model) => ({ model, usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.006 } });
const strip = (b) => { const c = structuredClone(b); delete c.usage.cost; return c; };

// Upstream returns bodies[i] for call i (last one repeats); stream=true sends SSE with usage on the final chunk.
async function proxy(t, provider, bodies, { stream = false, userPrices = null } = {}) {
  let n = 0;
  const up = http.createServer((req, res) => {
    const b = bodies[Math.min(n++, bodies.length - 1)];
    if (stream) {
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ model: b.model, choices: [{ delta: { content: "x" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model: b.model, choices: [], usage: b.usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); }
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const file = join(mkdtempSync(join(tmpdir(), "cc-242-")), "receipts.jsonl");
  const { server, port } = await startMeteringProxy({ upstreams: { [provider]: `http://127.0.0.1:${up.address().port}` }, cap: createCapEngine({ caps: { run: 100 } }), receiptsPath: file, userPrices });
  t.after(() => { server.closeAllConnections(); server.close(); up.closeAllConnections(); up.close(); });
  const path = provider === "openrouter" ? "/openrouter/api/v1/chat/completions" : `/${provider}/v1/chat/completions`;
  const call = async () => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify({ model: bodies[0].model, stream }) }); await r.text(); return r.status; };
  return { call, receipts: () => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) };
}

for (const stream of [false, true]) {
  for (const [name, body] of [["image output", IMAGE], ["audio input", AUDIO]]) {
    test(`#242 AC1/AC4: OpenRouter ${name} usage.cost settles modality (stream=${stream}), next call runs`, async (t) => {
      const f = await proxy(t, "openrouter", [body, TEXT(body.model)], { stream });
      assert.equal(await f.call(), 200);
      assert.equal(await f.call(), 200);
      const [r, r2] = f.receipts();
      assert.equal(r.cost_usd, body.usage.cost);
      assert.equal(r.cost_source, "provider");
      assert.equal(r.reason, undefined);
      assert.equal(r2.cost_usd, 0.006);
    });

    test(`#242 AC3: OpenRouter ${name} without usage.cost stays modality_unpriced and latches (stream=${stream})`, async (t) => {
      const f = await proxy(t, "openrouter", [strip(body), TEXT(body.model)], { stream });
      assert.equal(await f.call(), 200);
      assert.equal(await f.call(), 429);
      const [r] = f.receipts();
      assert.equal(r.cost_usd, null);
      assert.equal(r.reason, "modality_unpriced");
    });
  }
}

test("#242 AC3: a non-numeric usage.cost does not settle", async (t) => {
  const f = await proxy(t, "openrouter", [{ ...IMAGE, usage: { ...IMAGE.usage, cost: "0.0387" } }, TEXT(IMAGE.model)]);
  assert.equal(await f.call(), 200);
  assert.equal(await f.call(), 429);
  assert.equal(f.receipts()[0].reason, "modality_unpriced");
});

function overrides() {
  const f = join(mkdtempSync(join(tmpdir(), "cc-242p-")), "prices.json");
  writeFileSync(f, JSON.stringify({ version: "t", upstreams: { openrouter: { "openai/gpt-4o": { input: 2, output: 8 } } } }));
  return loadUpstreamPrices(f, []);
}
const CACHE_WRITE = { model: "openai/gpt-4o", usage: { prompt_tokens: 2000, completion_tokens: 10, prompt_tokens_details: { cache_write_tokens: 1500 }, cost: 0.0123 } };

for (const stream of [false, true]) {
  test(`#242 AC2: OpenRouter --price gap (user_price_unpriced) settles from usage.cost (stream=${stream})`, async (t) => {
    const f = await proxy(t, "openrouter", [CACHE_WRITE, TEXT("openai/gpt-4o")], { stream, userPrices: overrides() });
    assert.equal(await f.call(), 200);
    assert.equal(await f.call(), 200);
    const [r] = f.receipts();
    assert.equal(r.cost_usd, 0.0123);
    assert.equal(r.cost_source, "provider");
    assert.equal(r.reason, undefined);
  });
}

test("#242 AC3: OpenRouter --price gap without usage.cost stays user_price_unpriced and latches", async (t) => {
  const f = await proxy(t, "openrouter", [strip(CACHE_WRITE), TEXT("openai/gpt-4o")], { userPrices: overrides() });
  assert.equal(await f.call(), 200);
  assert.equal(await f.call(), 429);
  assert.equal(f.receipts()[0].reason, "user_price_unpriced");
});

test("#242 AC5: direct OpenAI audio tokens stay modality_unpriced even if the body carries a cost field", async (t) => {
  const f = await proxy(t, "openai", [{ ...AUDIO, model: "gpt-4o" }, TEXT("gpt-4o")]);
  assert.equal(await f.call(), 200);
  assert.equal(await f.call(), 429);
  const [r] = f.receipts();
  assert.equal(r.cost_usd, null);
  assert.equal(r.reason, "modality_unpriced");
});
