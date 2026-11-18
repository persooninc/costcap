import test from 'node:test';
import assert from 'node:assert/strict';
import { uiResponse } from '../src/hosted/ui.js';
import { isApexHost, llmsTxt } from '../src/hosted/seo.js';

const APP = 'https://app.costcap.dev';
const apex = (path, publicPricing = false) => uiResponse(path, '', APP, false, 'live', { host: 'costcap.dev', publicPricing });

test('apex root is a crawlable marketing page with og, twitter and robots tags', () => {
  const r = apex('/');
  assert.match(r.headers['content-type'], /text\/html/);
  for (const re of [/<meta name="robots" content="index, follow/, /<link rel="canonical" href="https:\/\/costcap\.dev">/,
    /property="og:title"/, /property="og:description"/, /property="og:url" content="https:\/\/costcap\.dev"/,
    /property="og:image" content="https:\/\/costcap\.dev\/og\.png"/, /name="twitter:card" content="summary_large_image"/,
    /name="twitter:title"/, /name="twitter:description"/, /name="twitter:image" content="https:\/\/costcap\.dev\/og\.png"/,
    /href="https:\/\/app\.costcap\.dev\/"/]) assert.match(r.body, re);
  assert.doesNotMatch(r.body, /id="request"/, 'no sign-in form on the apex');
});

test('app homepage carries robots meta, og:image and twitter tags', () => {
  const body = uiResponse('/', '', APP).body;
  assert.match(body, /<meta name="robots" content="index, follow/);
  assert.match(body, /property="og:image" content="https:\/\/app\.costcap\.dev\/og\.png"/);
  assert.match(body, /name="twitter:card" content="summary_large_image"/);
});

test('/og.png is a 1200x630 PNG on both hosts', () => {
  for (const r of [apex('/og.png'), uiResponse('/og.png', '', APP)]) {
    assert.equal(r.headers['content-type'], 'image/png');
    assert.deepEqual([...r.body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(r.body.readUInt32BE(16), 1200);
    assert.equal(r.body.readUInt32BE(20), 630);
  }
});

test('/llms.txt is plain text on both hosts', () => {
  for (const r of [apex('/llms.txt'), uiResponse('/llms.txt', '', APP)]) {
    assert.match(r.headers['content-type'], /^text\/plain/);
    assert.match(r.body, /^# CostCap\n\n> /);
  }
  assert.match(llmsTxt(APP), /https:\/\/app\.costcap\.dev\/cli/);
});

test('apex sitemap lists / and /pricing only when pricing is public; robots points at it', () => {
  const off = apex('/sitemap.xml').body;
  assert.deepEqual([...off.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), ['https://costcap.dev']);
  const on = apex('/sitemap.xml', true).body;
  assert.deepEqual([...on.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), ['https://costcap.dev', 'https://costcap.dev/pricing']);
  assert.match(apex('/robots.txt').body, /^Sitemap: https:\/\/costcap\.dev\/sitemap\.xml$/m);
});

test('apex answers only its own paths; app-only paths are not served there', () => {
  assert.equal(apex('/cli'), null);
  assert.equal(apex('/ui/config'), null);
  assert.ok(apex('/assets/app.css'));
  assert.ok(isApexHost('www.costcap.dev:443'));
  assert.ok(!isApexHost('app.costcap.dev'));
});
