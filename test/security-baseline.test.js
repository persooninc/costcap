// go-to-market#17: HSTS/CSP/XFO/nosniff on every response + RFC 9116 security.txt.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { applySecurityBaseline, baselineHeaders, securityTxt, HSTS } from "../src/hosted/security-baseline.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");

test("unit: securityTxt has contact, canonical and an Expires under one year out", () => {
  const body = securityTxt("https://costcap.dev/", NOW);
  assert.match(body, /^Contact: mailto:\S+@\S+$/m);
  assert.match(body, /^Canonical: https:\/\/costcap\.dev\/\.well-known\/security\.txt$/m);
  const exp = Date.parse(/^Expires: (.+)$/m.exec(body)[1]);
  assert.ok(exp > NOW && exp - NOW <= 365 * 86_400_000, "Expires within (now, now+1y]");
  assert.equal(new Date(exp).toISOString().slice(11), "00:00:00.000Z", "rounded to the day");
});

test("unit: baseline HSTS is at least one year and CSP denies framing", () => {
  assert.ok(Number(/max-age=(\d+)/.exec(HSTS)[1]) >= 31_536_000);
  const h = baselineHeaders();
  assert.equal(h["x-frame-options"], "DENY");
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.match(h["content-security-policy"], /frame-ancestors 'none'/);
});

test("unit: applySecurityBaseline only answers GET/HEAD security.txt", () => {
  const mk = (method, url) => { const r = { set: {}, status: 0, body: null, setHeader(k, v) { this.set[k] = v; }, writeHead(s, h) { this.status = s; this.head = h; return this; }, end(b) { this.body = b; } }; return [{ method, url }, r]; };
  let [req, res] = mk("POST", "/.well-known/security.txt");
  assert.equal(applySecurityBaseline(req, res, { canonicalOrigin: "https://x.dev", now: () => NOW }), false);
  assert.equal(res.set["strict-transport-security"], HSTS);
  [req, res] = mk("HEAD", "/.well-known/security.txt");
  assert.equal(applySecurityBaseline(req, res, { canonicalOrigin: "https://x.dev", now: () => NOW }), true);
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
  [req, res] = mk("GET", undefined);
  assert.equal(applySecurityBaseline(req, res, { canonicalOrigin: "https://x.dev" }), false);
});

async function serve(t) {
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-sec-")), "store.json");
  const service = createHostedServer({ storePath, origin: "https://costcap.dev", secureCookies: false, now: () => NOW, stripeEnv: {}, verifyChallenge: async () => false, sendCode: async () => {}, sendInvite: async () => {}, deliverAlert: async () => [] });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  return (path, init) => fetch(`http://127.0.0.1:${service.server.address().port}${path}`, init);
}

test("e2e: every response type carries the header baseline", async (t) => {
  const get = await serve(t);
  for (const [path, init] of [["/", undefined], ["/health", undefined], ["/v1/fleet", undefined], ["/nope", undefined], ["/auth/request", { method: "POST", body: "{}" }]]) {
    const r = await get(path, init);
    await r.arrayBuffer();
    assert.ok(Number(/max-age=(\d+)/.exec(r.headers.get("strict-transport-security") ?? "")?.[1]) >= 31_536_000, `${path} HSTS`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", `${path} nosniff`);
    assert.equal(r.headers.get("x-frame-options"), "DENY", `${path} XFO`);
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, `${path} CSP`);
  }
});

test("e2e: GET /.well-known/security.txt is public text/plain with the canonical origin", async (t) => {
  const get = await serve(t);
  const r = await get("/.well-known/security.txt");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/plain/);
  const body = await r.text();
  assert.match(body, /^Canonical: https:\/\/costcap\.dev\/\.well-known\/security\.txt$/m);
  assert.match(body, /^Expires: 2027-11-16T00:00:00\.000Z$/m);
});
