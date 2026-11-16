// #169: cost attribution tags: parsing, CLI, local and hosted CSV, hosted ingest and /v1/spend?group_by=tag.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTagHeader, parseTagList, mergeTags, validTags, tagsCell, tagsMatch } from "../src/tags.js";
import { parseWrapArgs } from "../src/cli.js";
import { receiptsCommand } from "../src/receipts-cli.js";
import { receiptsCsv } from "../src/hosted/receipts-csv.js";
import { parseSpendQuery, spendBreakdown } from "../src/hosted/spend.js";
import { createHostedServer } from "../src/hosted/server.js";

test("tag parsing rules, merge order, validation, CSV cell and match", () => {
  assert.deepEqual(parseTagHeader("customer=acme, env=prod"), { customer: "acme", env: "prod" });
  assert.equal(parseTagHeader(undefined), null);
  for (const bad of ["Bad=x", "k=", "=v", "nokv", `k=${"x".repeat(65)}`, `${"k".repeat(33)}=v`, "k=café", Array.from({ length: 11 }, (_, i) => `k${i}=v`).join(",")]) {
    assert.throws(() => parseTagHeader(bad), /\[a-z0-9_.-\]\{1,32\}/, bad);
  }
  assert.deepEqual(mergeTags({ env: "prod" }, { env: "dev", c: "a" }), { c: "a", env: "prod" });
  assert.equal(mergeTags(null, null), null);
  assert.throws(() => mergeTags(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`w${i}`, "v"])), Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`r${i}`, "v"]))));
  assert.equal(validTags(undefined), true);
  assert.equal(validTags({ a: "b" }), true);
  for (const bad of [null, [], "x", { A: "b" }, { a: 1 }, { a: "" }, Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]))]) assert.equal(validTags(bad), false);
  assert.equal(tagsCell({ z: "1", a: "2" }), "a=2;z=1");
  assert.equal(tagsCell(undefined), "");
  assert.equal(tagsMatch({ a: "1", b: "2" }, { a: "1" }), true);
  assert.equal(tagsMatch(undefined, { a: "1" }), false);
  assert.deepEqual(parseTagList(["a=1", "a=2"]), { a: "2" });
});

test("wrap --tag is repeatable; a bad --tag exits 2 naming the rule", () => {
  assert.deepEqual(parseWrapArgs(["--tag", "feature=search", "--tag", "env=prod", "--", "true"]).tags, { feature: "search", env: "prod" });
  assert.equal(parseWrapArgs(["--", "true"]).tags, undefined);
  assert.throws(() => parseWrapArgs(["--tag", "Feature=x", "--", "true"]), /invalid tag key/);
  const r = spawnSync(process.execPath, ["src/cli.js", "wrap", "--tag", "bad key=x", "--", "true"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[a-z0-9_.-\]\{1,32\}/);
});

test("wrap --tag stamps every receipt in the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tag-wrap-"));
  const ledger = join(dir, "r.jsonl");
  // The child makes one call to an unknown provider path (404, no receipt) and one blocked by a bad header.
  const child = `const u=process.env.OPENAI_BASE_URL;fetch(u+'/chat/completions',{method:'POST',headers:{'x-costcap-tag':'BAD'},body:'{}'}).then(r=>process.exit(r.status===400?0:1))`;
  const r = spawnSync(process.execPath, ["src/cli.js", "wrap", "--receipts", ledger, "--tag", "feature=search", "--tag", "env=prod", "--", process.execPath, "-e", child], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => !l.event && l.reason);
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.deepEqual(l.tags, { feature: "search", env: "prod" });
});

const NOW = new Date("2026-11-16T12:00:00Z");
test("costcap receipts --tag filters; CSV has a sorted, formula-escaped tags column; untagged rows unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tag-rcpt-"));
  const file = join(dir, "r.jsonl");
  writeFileSync(file, [
    { id: "a", ts: "2026-11-16T01:00:00Z", model: "m", cost_usd: 0.1, tags: { customer: "acme", env: "prod" } },
    { id: "b", ts: "2026-11-16T02:00:00Z", model: "m", cost_usd: 0.2, tags: { customer: "=evil" } },
    { id: "c", ts: "2026-11-16T03:00:00Z", model: "m", cost_usd: 0.3 },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const run = (argv) => { const out = [], err = []; const code = receiptsCommand(argv, { log: (s) => out.push(s), warn: (s) => err.push(s), now: NOW }); return { code, out: out.join("\n"), err: err.join("\n") }; };
  const j = run(["--receipts", file, "--tag", "customer=acme", "--json"]);
  assert.deepEqual(JSON.parse(j.out).map((x) => x.receipt_id), ["a"]);
  assert.equal(run(["--receipts", file, "--tag", "BAD"]).code, 2);
  const csv = run(["--receipts", file, "--export", "csv"]).out.split("\n");
  assert.match(csv[0], /,outcome,tags$/);
  assert.match(csv[1], /,customer=acme;env=prod$/);
  assert.match(csv[2], /,customer==evil$/);
  assert.match(csv[3], /,$/);
  assert.equal("tags" in JSON.parse(run(["--receipts", file, "--json"]).out)[2], false);
  // Hosted CSV helper: a value that would start a formula is escaped.
  const body = receiptsCsv([{ ts: "t", tags: { a: "1" } }, { ts: "u", tags: null }]).body.split("\n");
  assert.match(body[1], /,a=1$/);
  assert.match(body[2], /,$/);
  assert.match(receiptsCsv([{ ts: "t", tags: { "=": "x" } }]).body, /'==x/);
});

test("spendBreakdown group_by=tag: per value, (untagged), unknown and settled cost; tag_key validation", () => {
  const items = [
    { agentId: "a", receipt: { id: "1", ts: "2026-11-16T01:00:00Z", cost_usd: 1, tags: { customer: "acme" } } },
    { agentId: "a", receipt: { id: "2", ts: "2026-11-16T02:00:00Z", cost_usd: null, tags: { customer: "acme" } } },
    { agentId: "a", receipt: { id: "3", ts: "2026-11-16T03:00:00Z", cost_usd: null, tags: { customer: "beta" } }, settlement: { cost_usd: 2 } },
    { agentId: "a", receipt: { id: "4", ts: "2026-11-16T04:00:00Z", cost_usd: 0.5, tags: { env: "prod" } } },
    { agentId: "a", receipt: { id: "5", ts: "2026-11-16T05:00:00Z", cost_usd: 0.25 } },
  ];
  const out = spendBreakdown(items, { groupBy: "tag", tagKey: "customer" });
  assert.equal(out.tag_key, "customer");
  assert.deepEqual(out.buckets.map((b) => [b.key, b.usd_known, b.unknown_count, b.cost_complete]),
    [["beta", 2, 0, true], ["acme", 1, 1, false], ["(untagged)", 0.75, 0, true]]);
  assert.equal(out.total.cost_complete, false);
  assert.throws(() => spendBreakdown(items, { groupBy: "tag" }), /tag_key/);
  const q = (s) => parseSpendQuery(new URLSearchParams(s));
  assert.equal(q("group_by=tag&tag_key=customer").tagKey, "customer");
  for (const s of ["group_by=tag", "group_by=tag&tag_key=", "group_by=tag&tag_key=Bad"]) assert.throws(() => q(s), (e) => e.status === 400, s);
  assert.equal(q("group_by=day").tagKey, undefined);
});

async function serve(t) {
  let code;
  const service = createHostedServer({ storePath: join(mkdtempSync(join(tmpdir(), "cc-tag-hosted-")), "store.json"), origin: "http://localhost", secureCookies: false, stripeEnv: {},
    verifyChallenge: async () => true, sendCode: async (d) => { code = d.code; }, sendInvite: async () => {} });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text(), cookie: r.headers.get("set-cookie")?.split(";")[0], get body() { return JSON.parse(this.text); } };
  };
  const login = async (email) => { const c = await request("/auth/request", { email, turnstileToken: "x" }); return (await request("/auth/verify", { challengeId: c.body.challengeId, code })).cookie; };
  const agent = async (cookie, name) => { const tok = await request("/v1/enrollment-tokens", {}, cookie); return (await request("/v1/enroll", { name }, null, tok.body.token)).body; };
  return { request, login, agent };
}

test("hosted: ingest validates tags, /v1/spend?group_by=tag is org-scoped and viewer-readable, CSV has tags", async (t) => {
  const f = await serve(t);
  const owner = await f.login("tag-owner@example.invalid"), outsider = await f.login("tag-out@example.invalid");
  const a = await f.agent(owner, "w"), o = await f.agent(outsider, "theirs");
  const ts = new Date().toISOString();
  for (const bad of [{ A: "x" }, { a: "" }, { a: "x".repeat(65) }, ["a"], Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]))]) {
    const r = await f.request("/v1/receipts", { receipts: [{ id: "bad", ts, cost_usd: 1, tags: bad }] }, null, a.token);
    assert.equal(r.status, 400); assert.match(r.text, /Invalid receipt/);
  }
  assert.equal((await f.request("/v1/receipts", { receipts: [
    { id: "r1", ts, cost_usd: 1, tags: { customer: "acme" } },
    { id: "r2", ts, cost_usd: null, tags: { customer: "acme" } },
    { id: "r3", ts, cost_usd: 0.5 },
  ] }, null, a.token)).status, 200);
  assert.equal((await f.request("/v1/receipts", { receipts: [{ id: "o1", ts, cost_usd: 9, tags: { customer: "acme" } }] }, null, o.token)).status, 200);
  const s = await f.request("/v1/spend?group_by=tag&tag_key=customer", undefined, owner);
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(s.body.buckets.map((b) => [b.key, b.usd_known, b.unknown_count, b.cost_complete]), [["acme", 1, 1, false], ["(untagged)", 0.5, 0, true]]);
  assert.equal((await f.request("/v1/spend?group_by=tag&tag_key=customer", undefined, outsider)).body.buckets[0].usd_known, 9);
  assert.equal((await f.request("/v1/spend?group_by=tag", undefined, owner)).status, 400);
  assert.equal((await f.request("/v1/spend?group_by=tag&tag_key=Nope", undefined, owner)).status, 400);
  assert.equal((await f.request("/v1/spend?group_by=tag&tag_key=customer")).status, 401);
  await f.request("/v1/invitations", { email: "tag-viewer@example.invalid", role: "viewer" }, owner);
  const viewer = await f.login("tag-viewer@example.invalid");
  assert.equal((await f.request("/v1/spend?group_by=tag&tag_key=customer", undefined, viewer)).status, 200);
  const csv = (await f.request("/v1/receipts.csv", undefined, owner)).text.split("\n");
  assert.match(csv[0], /,tags$/);
  assert.ok(csv.some((l) => l.includes("r1") && l.endsWith(",customer=acme")));
  assert.ok(csv.some((l) => l.includes("r3") && l.endsWith(",")));
});
