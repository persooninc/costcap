import test from 'node:test';
import assert from 'node:assert/strict';
import { uiResponse } from '../src/hosted/ui.js';
import { sitemapXml } from '../src/hosted/seo.js';
import { COMPARE_ROWS, BUNDLE_URL } from '../src/hosted/compare.js';

test('/compare renders with canonical, description and OG tags', () => {
  const res = uiResponse('/compare', '', 'https://costcap.dev');
  assert.ok(res, '/compare is served');
  assert.match(res.headers['content-type'], /text\/html/);
  const html = res.body;
  assert.match(html, /<link rel="canonical" href="https:\/\/costcap\.dev\/compare">/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/costcap\.dev\/compare">/);
  assert.match(html, /<meta property="og:title" content="CostCap compared[^"]*">/);
  assert.ok(html.includes(`href="${BUNDLE_URL}"`), 'links to the Guardrails bundle');
  assert.doesNotMatch(html, /\$\d+/, 'no prices');
  assert.match(html, /href="\/privacy"/, 'legal footer present');
});

test('every comparison cites vendor docs and makes no superlative claims', () => {
  const html = uiResponse('/compare', '', 'https://costcap.dev').body;
  assert.ok(COMPARE_ROWS.length >= 3);
  for (const r of COMPARE_ROWS) {
    assert.match(r.source, /^https:\/\/(platform\.openai\.com|docs\.anthropic\.com|docs\.aws\.amazon\.com)\//);
    assert.ok(html.includes(`href="${r.source}"`), r.name);
  }
  assert.doesNotMatch(html.toLowerCase(), /\b(best|fastest|cheapest|guaranteed)\b/);
});

test('/compare is in the sitemap and linked from the footer of public pages', () => {
  assert.match(sitemapXml('https://costcap.dev'), /<loc>https:\/\/costcap\.dev\/compare<\/loc>/);
  assert.match(uiResponse('/cli', '', 'https://costcap.dev').body, /href="\/compare"/);
});
