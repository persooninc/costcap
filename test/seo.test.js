import test from 'node:test';
import assert from 'node:assert/strict';
import { uiResponse } from '../src/hosted/ui.js';
import { PUBLIC_ROUTES, CONTENT_LASTMOD, jsonLd, robotsTxt, sitemapXml, absoluteUrl } from '../src/hosted/seo.js';

test('public allowlist is the landing and /cli; discovery files omit private routes', () => {
  assert.deepEqual(PUBLIC_ROUTES.map((r) => r.path), ['/', '/cli']);
  const robots = robotsTxt('https://costcap.dev');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/costcap\.dev\/sitemap\.xml$/m);
  assert.match(robots, /^Disallow: \/auth\/$/m);
  assert.match(robots, /^Disallow: \/v1\/$/m);
  assert.match(robots, /^Disallow: \/api\/health\/$/m);
  const xml = sitemapXml('https://costcap.dev', '2026-10-09');
  assert.match(xml, /<loc>https:\/\/costcap\.dev<\/loc>/);
  assert.match(xml, /<loc>https:\/\/costcap\.dev\/cli<\/loc>/);
  assert.notEqual(CONTENT_LASTMOD, '2026-10-09');
  assert.match(sitemapXml('https://costcap.dev'), new RegExp(`<lastmod>${CONTENT_LASTMOD}</lastmod>`));
  for (const loc of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    assert.ok(PUBLIC_ROUTES.some((r) => absoluteUrl('https://costcap.dev', r.path) === loc[1]));
  }
  assert.ok(!xml.includes('/auth'));
  assert.ok(!xml.includes('/v1'));
  assert.ok(!xml.includes('/health'));
  const graph = jsonLd('https://costcap.dev')['@graph'];
  assert.ok(graph.some((n) => n['@type'] === 'WebSite' && n.url === 'https://costcap.dev'));
  assert.ok(graph.some((n) => n['@type'] === 'SoftwareApplication' && n.name === 'CostCap'));
});

test('IndexNow key file is served as exactly the key, text/plain', () => {
  const k = '8459b118d7f227de932db7f94357f430';
  const r = uiResponse(`/${k}.txt`);
  assert.equal(r.body, k);
  assert.match(r.headers['content-type'], /^text\/plain/);
  assert.equal(uiResponse('/other-key.txt'), null);
});

test('public HTML never pairs a zero-price offer with the $19 plan (#89)', () => {
  for (const [billing, mode] of [[false, 'live'], [false, 'test'], [true, 'live']]) {
    const html = uiResponse('/', '', 'https://app.costcap.dev', billing, mode).body;
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
    const app = ld['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
    assert.ok(!(html.includes('price":"0"') && html.includes('$19')), `billing=${billing} mode=${mode}`);
    if (billing) {
      assert.equal(app.offers, undefined);
      assert.match(app.description, /Free CLI/);
      assert.match(app.description, /Optional \$19\/month/);
      assert.match(app.description, /not a provider-bill guarantee/);
      assert.match(html, /<meta name="description" content="[^"]*Optional \$19\/month/);
    } else {
      assert.equal(app.offers.price, '0');
      assert.equal(html.includes('$19'), false);
    }
  }
});

const og = (html, property) => html.match(new RegExp(`<meta property="${property}" content="([^"]*)">`))?.[1];

test('landing head has Open Graph tags naming a spend cap for AI agents and links /cli from the hero', () => {
  const html = uiResponse('/', '', 'https://costcap.dev').body;
  const title = html.match(/<title>([^<]+)<\/title>/)[1];
  assert.notEqual(title, 'CostCap | Fleet guardrails');
  assert.match(title, /spend cap/i);
  assert.match(og(html, 'og:title'), /spend cap for AI agents/i);
  assert.match(og(html, 'og:description'), /spend cap/i);
  assert.match(og(html, 'og:description'), /agent/i);
  assert.equal(og(html, 'og:url'), 'https://costcap.dev');
  const hero = html.match(/<section id="login" class="hero">([\s\S]*?)<\/section>/)[1];
  assert.match(hero, /href="\/cli"/);
});

test('/cli is public HTML with the wrap command and enforcement limits, without bill-guarantee wording', () => {
  const r = uiResponse('/cli', '', 'https://costcap.dev');
  assert.match(r.headers['content-type'], /^text\/html/);
  const html = r.body;
  assert.match(html, /rel="canonical" href="https:\/\/costcap\.dev\/cli"/);
  assert.equal(og(html, 'og:url'), 'https://costcap.dev/cli');
  assert.match(og(html, 'og:title'), /spend cap/i);
  assert.ok(og(html, 'og:description'));
  assert.match(html, /node src\/cli\.js wrap --cap \d+[^<]* -- node your-agent\.js/);
  assert.match(html, /git clone https:\/\/github\.com\/persooninc\/costcap\.git/);
  assert.match(html, /Only proxy-routed calls are capped/);
  assert.match(html, /One accepted call can exceed the remaining cap/);
  assert.match(html, /Prices are estimates/);
  assert.ok(!/bill guarantee|guaranteed? (bill|spend|cost)/i.test(html));
  assert.ok(!/id="login"|\/auth\//.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[^<]+/.test(html));
});
