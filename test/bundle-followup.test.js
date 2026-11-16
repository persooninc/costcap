// Issue #131 follow-up: Team amount in live status, plan switch closes the other
// open Checkout session, test-mode Team by the bundle lookup key, and release /
// Marketplace readiness. Recorded Stripe fixtures only: no network, no card.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openStore } from "../src/hosted/store.js";
import { createStripeBilling, createTestModeStripeBilling, TEAM_BUNDLE_LOOKUP_KEY } from "../src/hosted/billing.js";
import { entitlementsFor } from "../src/billing/index.js";

const recurring = { interval: "month", interval_count: 1, usage_type: "licensed" };
const bundle = (over = {}) => ({ id: "price_bundle", active: true, livemode: true, currency: "usd", unit_amount: 7900,
  lookup_key: TEAM_BUNDLE_LOOKUP_KEY, recurring, product: { active: true }, ...over });
const solo = { id: "price_solo", active: true, livemode: true, currency: "usd", unit_amount: 1900, recurring, product: { active: true, metadata: { app: "costcap" } } };

function liveFixture() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "cc-131-live-")), "s.json"));
  store.transaction((s) => { s.orgs.org1 = { id: "org1" }; });
  const calls = [];
  const sessions = {};
  let n = 0;
  let expireStatus = "expired";
  const sub = { id: "sub_team", livemode: true, customer: "cus_1", status: "active", metadata: { app: "costcap", org_id: "org1" },
    items: { data: [{ price: { id: "price_bundle" }, quantity: 1 }] } };
  const fetchImpl = async (url, opts = {}) => {
    const path = url.replace("https://api.stripe.com/v1", "");
    calls.push({ path, method: opts.method, body: opts.body });
    let data;
    if (path === "/account") data = { id: "acct_1TdlLm0Yt0O6HtVs", charges_enabled: true };
    else if (path === "/prices/price_solo?expand[]=product") data = solo;
    else if (path.startsWith("/prices?")) data = { data: [bundle()] };
    else if (path === "/checkout/sessions" && opts.method === "POST") {
      n += 1;
      data = sessions[`cs_${n}`] = { id: `cs_${n}`, livemode: true, status: "open", url: `https://checkout.stripe.com/c/pay/${n}`,
        client_reference_id: "org1", metadata: { app: "costcap", org_id: "org1" } };
    } else if (/^\/checkout\/sessions\/cs_\d+\/expire$/.test(path)) {
      const id = path.split("/")[3];
      data = sessions[id] = { ...sessions[id], status: expireStatus };
    } else if (path.startsWith("/checkout/sessions/")) data = sessions[path.split("/").pop()];
    else if (path === "/subscriptions/sub_team") data = sub;
    return new Response(JSON.stringify(data ?? {}), { status: data ? 200 : 404 });
  };
  const options = { store, fetchImpl, secretKey: "rk_live_fixture", webhookSecret: "whsec_x", accountId: "acct_1TdlLm0Yt0O6HtVs",
    priceId: "price_solo", teamLookupKey: TEAM_BUNDLE_LOOKUP_KEY, origin: "https://app.costcap.dev", now: () => 1800000000000 };
  return { store, calls, sub, options, setExpireStatus: (v) => { expireStatus = v; } };
}

test("live status reports the $79 amount for a Team (bundle) subscriber and $19 for Solo", async () => {
  const f = liveFixture();
  const billing = await createStripeBilling(f.options);
  assert.equal((await billing.status("org1")).amount, 1900);
  f.store.transaction((s) => { s.orgs.org1.billing = { subscriptionId: "sub_team" }; });
  const team = await billing.status("org1");
  assert.deepEqual([team.plan, team.amount], ["team", 7900]);
  const b = f.store.read((s) => s.orgs.org1.billing);
  assert.deepEqual(Object.values(entitlementsFor({ status: b.status, plan: b.plan, enforced: true }).limits).slice(0, 2), [50, 15]);
  f.sub.items.data[0].price = { id: "price_solo" };
  const soloStatus = await billing.status("org1");
  assert.deepEqual([soloStatus.plan, soloStatus.amount], ["workspace", 1900]);
  f.sub.status = "canceled";
  assert.equal((await billing.status("org1")).amount, 1900);
});

test("live plan switch expires the other plan's open session before a new checkout", async () => {
  const f = liveFixture();
  const billing = await createStripeBilling(f.options);
  const user = { orgId: "org1", email: "o@example.invalid" };
  await billing.checkout(user);
  await billing.checkout(user, { plan: "team" });
  await billing.checkout(user, { plan: "team" }); // same plan reuses the open Team session
  const posts = f.calls.filter((c) => c.path === "/checkout/sessions").map((c) => new URLSearchParams(c.body));
  assert.deepEqual(posts.map((p) => p.get("line_items[0][price]")), ["price_solo", "price_bundle"]);
  const expires = f.calls.filter((c) => c.path.endsWith("/expire"));
  assert.deepEqual(expires.map((c) => [c.path, c.method]), [["/checkout/sessions/cs_1/expire", "POST"]]);
  assert.ok(f.calls.indexOf(expires[0]) < f.calls.findLastIndex((c) => c.path === "/checkout/sessions"));
  assert.equal(f.store.read((s) => s.orgs.org1.billing.checkout.plan), "team");
});

test("live plan switch stops when the open session cannot be closed", async () => {
  const f = liveFixture();
  const billing = await createStripeBilling(f.options);
  const user = { orgId: "org1", email: "o@example.invalid" };
  await billing.checkout(user);
  f.setExpireStatus("open");
  await assert.rejects(billing.checkout(user, { plan: "team" }), (e) => e.status === 503);
  assert.equal(f.calls.filter((c) => c.path === "/checkout/sessions").length, 1);
});

function testModeFixture() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "cc-131-test-")), "s.json"));
  store.transaction((s) => { s.orgs.org1 = { id: "org1" }; });
  const calls = [];
  const logs = [];
  const state = { clock: 1800000000000, list: { data: [] } };
  const fetchImpl = async (url, opts = {}) => {
    const path = url.replace("https://api.stripe.com/v1", "");
    calls.push({ path, method: opts.method, body: opts.body });
    if (path.startsWith("/prices?")) return state.list === "error" ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(state.list));
    if (path === "/checkout/sessions" || path === "/checkout/sessions/cs_t") return new Response(JSON.stringify({ id: "cs_t", livemode: false, status: "open", url: "https://checkout.stripe.com/c/pay/t", client_reference_id: "org1", metadata: { app: "costcap", org_id: "org1" } }));
    if (path === "/subscriptions/sub_t") return new Response(JSON.stringify({ id: "sub_t", livemode: false, customer: "cus_t", status: "active", metadata: { app: "costcap", org_id: "org1" }, items: { data: [{ price: { id: "price_tbundle" }, quantity: 1 }] } }));
    return new Response("{}", { status: 404 });
  };
  const options = { secretKey: "sk_test_x", webhookSecret: "whsec_x", priceId: "price_solo", teamLookupKey: TEAM_BUNDLE_LOOKUP_KEY,
    origin: "https://app.costcap.dev", store, fetchImpl, now: () => state.clock, log: (m) => logs.push(m) };
  return { store, calls, logs, state, options };
}

test("test mode resolves Team by the bundle lookup key; a miss is throttled; live prices are never used", async () => {
  const f = testModeFixture();
  const billing = createTestModeStripeBilling(f.options);
  assert.equal(f.calls.length, 0, "construction does not call Stripe");
  const user = { orgId: "org1", email: "o@example.invalid" };
  await assert.rejects(billing.checkout(user, { plan: "team" }), (e) => e.status === 409);
  assert.deepEqual((await billing.status("org1")).plans, ["workspace"]);
  const lookups = () => f.calls.filter((c) => c.path.startsWith("/prices?"));
  assert.equal(lookups().length, 1, "a miss is not retried on every call");
  const q = new URLSearchParams(lookups()[0].path.split("?")[1]);
  assert.deepEqual([q.get("lookup_keys[]"), q.get("active"), lookups()[0].method], ["guardrails_team_month", "true", "GET"]);
  for (const list of ["error", { data: [bundle()] }, { data: [bundle({ id: "price_tbundle", livemode: false, unit_amount: 2900 })] },
    { data: [bundle({ id: "price_a", livemode: false }), bundle({ id: "price_b", livemode: false })] }, { data: [bundle({ id: "price_solo", livemode: false })] }]) {
    f.state.list = list;
    f.state.clock += 301_000;
    assert.deepEqual((await billing.status("org1")).plans, ["workspace"], JSON.stringify(list));
  }
  assert.match(f.logs.join("\n"), /test-mode Team bundle price readback failed/);
  f.state.list = { data: [bundle({ id: "price_tbundle", livemode: false })] };
  f.state.clock += 301_000;
  await billing.checkout(user, { plan: "team" });
  const form = new URLSearchParams(f.calls.find((c) => c.path === "/checkout/sessions").body);
  assert.deepEqual([form.get("line_items[0][price]"), form.get("metadata[plan]")], ["price_tbundle", "team"]);
  const before = lookups().length;
  assert.deepEqual((await billing.status("org1")).plans, ["workspace", "team"]);
  assert.equal(lookups().length, before, "a resolved price is kept");
  f.store.transaction((s) => { s.orgs.org1.billing.subscriptionId = "sub_t"; });
  const status = await billing.status("org1");
  assert.equal(status.plan, "team");
  assert.equal(entitlementsFor({ status: status.status, plan: status.plan }).limits.seats, 15);
});

test("test mode: a pinned team price wins, and no lookup key means no lookup", async () => {
  for (const extra of [{ teamPriceId: "price_pin" }, { teamLookupKey: undefined }]) {
    const f = testModeFixture();
    const billing = createTestModeStripeBilling({ ...f.options, ...extra });
    await billing.status("org1");
    await billing.checkout({ orgId: "org1", email: "o@example.invalid" }, { plan: "team" }).catch(() => {});
    assert.equal(f.calls.some((c) => c.path.startsWith("/prices?")), false, JSON.stringify(extra));
  }
});

test("release workflow: without NPM_TOKEN a tag push or publish=true becomes a dry run and exits 0", () => {
  const src = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const step = src.slice(src.indexOf("id: mode"), src.indexOf("- name: fail closed without NPM_TOKEN"));
  assert.match(step, /HAS_NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN != '' \}\}/);
  const script = step.slice(step.indexOf("run: |") + "run: |".length).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "cc-131-release-"));
  let i = 0;
  const run = (env) => {
    const out = join(dir, `out-${i += 1}`);
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } });
    return { status: r.status, stdout: r.stdout, output: readFileSync(out, "utf8").trim() };
  };
  for (const env of [{ EVENT: "push", PUBLISH_INPUT: "" }, { EVENT: "workflow_dispatch", PUBLISH_INPUT: "true" }]) {
    const skipped = run({ ...env, HAS_NPM_TOKEN: "false" });
    assert.equal(skipped.status, 0);
    assert.equal(skipped.output, "dry_run=true");
    assert.match(skipped.stdout, /::notice::NPM_TOKEN secret is not set; skipping npm publish/);
    assert.equal(run({ ...env, HAS_NPM_TOKEN: "true" }).output, "dry_run=false");
  }
  assert.equal(run({ EVENT: "workflow_dispatch", PUBLISH_INPUT: "false", HAS_NPM_TOKEN: "true" }).output, "dry_run=true");
  // The real-publish-only steps are gated on dry_run == 'false', so a skipped release never reaches them.
  for (const name of ["fail closed without NPM_TOKEN", "registry readback"]) {
    const block = src.slice(src.indexOf(`- name: ${name}`));
    assert.match(block.split("\n")[1], /if: steps\.mode\.outputs\.dry_run == 'false'/, name);
  }
});

test("action.yml has Marketplace metadata: name, description, author and valid branding", () => {
  const src = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  const field = (k) => src.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim();
  assert.ok(field("name"));
  assert.ok(field("description") && field("description").length <= 125);
  assert.ok(field("author"));
  const branding = src.match(/^branding:\n((?:\s{2}.+\n)+)/m)?.[1] ?? "";
  assert.ok(branding.match(/icon:\s*(\S+)/)?.[1], "branding.icon");
  const color = branding.match(/color:\s*(\S+)/)?.[1];
  assert.ok(["white", "black", "yellow", "blue", "green", "orange", "red", "purple", "gray-dark"].includes(color), `branding.color ${color}`);
  assert.match(src, /^runs:/m);
});
