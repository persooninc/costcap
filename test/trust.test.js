import test from "node:test";
import assert from "node:assert/strict";
import { uiResponse } from "../src/hosted/ui.js";
import { TRUST_ROUTES, trustDocument } from "../src/hosted/trust.js";

test("trust pages render with stable headings, footer links and no certification claims", () => {
  const headings = { "/privacy": "Privacy", "/terms": "Terms of use", "/security": "Security" };
  for (const { path } of TRUST_ROUTES) {
    const r = uiResponse(path, "", "https://costcap.dev");
    assert.ok(r, path);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.match(r.body, new RegExp(`<h1>${headings[path]}</h1>`));
    assert.match(r.body, new RegExp(`rel="canonical" href="https://costcap.dev${path}"`));
    for (const href of ["/privacy", "/terms", "/security"]) assert.match(r.body, new RegExp(`<footer>[\\s\\S]*href="${href}"`));
    assert.doesNotMatch(r.body, /<script>(?!<\/script>)/);
    // Honesty: say we hold no certification, and never claim one.
    assert.doesNotMatch(r.body.replace(/hold no SOC 2 or ISO certification and do not claim one/, ""), /SOC ?2|ISO 27001|HIPAA|GDPR[- ]compliant/i);
  }
  const privacy = trustDocument("/privacy").sections.flatMap((s) => s.items).join(" ");
  assert.match(privacy, /never contain request or response bodies/);
  assert.match(privacy, /authorization headers/);
  assert.match(privacy, /single server/);
  assert.match(privacy, /delete/i);
  const terms = trustDocument("/terms").sections.flatMap((s) => s.items).join(" ");
  assert.match(terms, /one accepted call can exceed the remaining cap/);
  assert.match(terms, /not your provider's bill/);
  assert.equal(trustDocument("/nope"), null);
});

test("landing, cli and checkout screen link the trust pages; contact is injectable", () => {
  for (const path of ["/", "/cli"]) {
    const html = uiResponse(path, "", "https://costcap.dev").body;
    assert.match(html, /<footer>[\s\S]*href="\/privacy"[\s\S]*href="\/terms"[\s\S]*href="\/security"/);
  }
  const checkout = uiResponse("/", "", "https://costcap.dev", false, "test", { checkout: true }).body;
  assert.match(checkout, /id="checkoutTerms"[^]*href="\/terms"/);
  const custom = uiResponse("/privacy", "", "https://costcap.dev", false, "test", { contact: { label: "Email", url: "https://example.test/contact" }, operator: "Example Co" }).body;
  assert.match(custom, /<a href="https:\/\/example.test\/contact" rel="noopener">/);
  assert.match(custom, /run by Example Co/);
});
