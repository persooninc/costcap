// Issue #272: --preflight checks fleet tag caps and hosted model caps (day/week/month)
// against fleet-wide synced spend plus this host's unsynced receipts.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeteringProxy } from "../src/proxy.js";
import { createFleetClient } from "../src/hosted/client.js";
import { cachedFleetTagRemaining } from "../src/hosted/tag-caps.js";
import { cachedFleetModelRemaining, withFleetModelCaps } from "../src/hosted/model-caps.js";
import { withFleetTagCaps, createTagCaps, fleetPreflightHit } from "../src/tag-cap.js";
import { createModelCaps } from "../src/model-cap.js";
import { blocksInCurrentPeriod, evaluateTagAlerts } from "../src/hosted/alerts.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const TODAY = "2026-11-15T08:00:00Z";
const tagPolicy = (rules, spend, extra = {}) => ({ rules, spend: { customer: spend }, truncated: false, as_of: TODAY, ...extra });
const e = (day, month = day, extra = {}) => ({ day, month, unknown: 0, ...extra });

test("unit #272: cachedFleetTagRemaining synced, pending, stale as_of, merged local cap, unknown", () => {
  const p = tagPolicy([{ key: "customer", scope: "day", usd: 5 }], { acme: e(4.5) });
  assert.deepEqual(cachedFleetTagRemaining(p, [], { customer: "acme" }, [], NOW), [{ tag_key: "customer", tag_value: "acme", scope: "day", cap_usd: 5, remaining_usd: 0.5, fleet: true }]);
  assert.equal(cachedFleetTagRemaining(p, [], { customer: "globex" }, [], NOW)[0].remaining_usd, 5);
  // pending only: $1 unsynced lowers the remainder by $1; blocked and other values ignored.
  const pend = [{ id: "u", ts: TODAY, cost_usd: 1, tags: { customer: "acme" } }, { id: "b", ts: TODAY, cost_usd: 9, blocked: true, tags: { customer: "acme" } }, { id: "g", ts: TODAY, cost_usd: 9, tags: { customer: "globex" } }];
  assert.equal(cachedFleetTagRemaining(tagPolicy(p.rules, {}), [], { customer: "acme" }, pend, NOW)[0].remaining_usd, 4);
  // stale: as_of in the previous day counts $0 toward the day rule.
  assert.equal(cachedFleetTagRemaining({ ...p, as_of: "2026-11-14T20:00:00Z" }, [], { customer: "acme" }, [], NOW)[0].remaining_usd, 5);
  // a tighter local rule binds: fleet:false.
  const local = cachedFleetTagRemaining(tagPolicy(p.rules, { acme: e(1.5) }), [{ key: "customer", scope: "day", cap: 4 }], { customer: "acme" }, [], NOW);
  assert.deepEqual([local[0].remaining_usd, local[0].cap_usd, local[0].fleet], [2.5, 4, false]);
  // unknown cost is never treated as $0: the rule is left out (check() refuses it).
  assert.deepEqual(cachedFleetTagRemaining(tagPolicy(p.rules, { acme: { ...e(0), unknown: 1 } }), [], { customer: "acme" }, [], NOW), []);
  assert.deepEqual(cachedFleetTagRemaining(tagPolicy(p.rules, {}), [], { customer: "acme" }, [{ ts: TODAY, cost_usd: null, tags: { customer: "acme" } }], NOW), []);
  assert.deepEqual(cachedFleetTagRemaining(null, [], {}, [], NOW), []);
  // over the cap: remainder floors at 0.
  assert.equal(cachedFleetTagRemaining(tagPolicy(p.rules, { acme: e(7) }), [], { customer: "acme" }, [], NOW)[0].remaining_usd, 0);
});

test("unit #272 AC2/AC5: week across a month and the truncated-payload floor", () => {
  const dec2 = Date.parse("2026-12-02T12:00:00Z");
  const wk = { rules: [{ key: "customer", scope: "week", usd: 10 }], spend: { customer: { acme: { day: 0, week: 8, month: 0, unknown: 0, unknown_week: 0 } } }, truncated: false, as_of: "2026-11-30T18:00:00Z" };
  const r = cachedFleetTagRemaining(wk, [], { customer: "acme" }, [], dec2);
  assert.deepEqual([r[0].scope, r[0].remaining_usd], ["week", 2]);
  const trunc = tagPolicy([{ key: "customer", scope: "month", usd: 10 }], { a: e(3), b: e(6) }, { truncated: true });
  // unlisted value uses the lowest listed spend ($3) as the floor, minus $1 pending.
  const left = cachedFleetTagRemaining(trunc, [], { customer: "zeta" }, [{ ts: TODAY, cost_usd: 1, tags: { customer: "zeta" } }], NOW);
  assert.equal(left[0].remaining_usd, 6);
});

test("unit #272 AC3: cachedFleetModelRemaining with dotted OpenRouter id, week rule, no snapshot", () => {
  const spend = { as_of: TODAY, models: { "claude-opus-4-8": { day: 4.5, week: 4.5, month: 4.5, unknown: 0, unknown_week: 0 } } };
  const rules = [{ model: "claude-opus-4-8", scope: "day", usd: 5 }, { model: "claude-opus-4-8", scope: "week", usd: 6 }, { model: "claude-opus-4-8", scope: "hour", usd: 1 }];
  const r = cachedFleetModelRemaining(spend, rules, ["anthropic/claude-opus-4.8"], [], NOW);
  assert.deepEqual(r.map((x) => [x.scope, x.remaining_usd, x.fleet]), [["day", 0.5, true], ["week", 1.5, true]]);
  assert.deepEqual(cachedFleetModelRemaining(spend, rules, ["gpt-4o"], [], NOW), []);
  assert.deepEqual(cachedFleetModelRemaining(null, rules, ["claude-opus-4-8"], [], NOW), []);
  assert.deepEqual(cachedFleetModelRemaining({ as_of: TODAY, models: {} }, rules, ["claude-opus-4-8"], [{ ts: TODAY, model: "claude-opus-4-8", cost_usd: 1 }], NOW).map((x) => x.remaining_usd), [4, 5]);
  assert.deepEqual(cachedFleetModelRemaining({ as_of: TODAY, models: { "claude-opus-4-8": { ...spend.models["claude-opus-4-8"], unknown: 1 } } }, rules, ["claude-opus-4-8"], [], NOW), []);
  assert.deepEqual(cachedFleetModelRemaining({ ...spend, as_of: "2026-11-14T20:00:00Z" }, rules.slice(0, 1), ["claude-opus-4-8"], [], NOW)[0].remaining_usd, 5);
});

test("unit #272: fleetPreflightHit and the wrappers (local first, then fleet; fallback before a snapshot)", () => {
  const entries = [{ tag_key: "customer", tag_value: "acme", scope: "day", cap_usd: 5, remaining_usd: 2.5, fleet: true }];
  assert.equal(fleetPreflightHit(entries, 2), null);
  assert.equal(fleetPreflightHit(entries, 2, () => 1).remaining_usd, 1.5);
  assert.equal(fleetPreflightHit(undefined, 2), null);
  const hit = fleetPreflightHit(entries, 3);
  assert.deepEqual([hit.reason, hit.estimate, hit.estimate_usd, hit.remaining_usd, hit.fleet], ["preflight_estimate", true, 3, 2.5, true]);
  const fleet = { tagRemaining: () => entries, tagCheck: () => null };
  const w = withFleetTagCaps(null, fleet, []);
  assert.equal(w.preflight({ customer: "acme" }, 3).remaining_usd, 2.5);
  assert.equal(w.remaining({ customer: "acme" }).length, 1);
  // A local rule that cannot fit wins first.
  const local = createTagCaps({ rules: [{ key: "customer", scope: "day", cap: 1 }] });
  assert.equal(withFleetTagCaps(local, fleet, []).preflight({ customer: "acme" }, 3).cap_usd, 1);
  assert.equal(withFleetTagCaps(null, {}, []).preflight({ customer: "acme" }, 3), null);
  // Model wrapper: fallback before a snapshot (unchanged), fleet remainders after.
  const fb = createModelCaps({ rules: [{ model: "claude-opus-4-8", scope: "day", cap: 5 }] });
  const lc = createModelCaps({ rules: [] });
  let snap = null;
  const mf = { agentSpend: () => snap, modelRemaining: () => [{ model: "claude-opus-4-8", scope: "day", cap_usd: 5, remaining_usd: 0.5, fleet: true }] };
  const mw = withFleetModelCaps(lc, fb, mf);
  assert.equal(mw.preflight(["claude-opus-4-8"], 3), null);
  assert.equal(mw.preflight(["claude-opus-4-8"], 6).remaining_usd, 5);
  snap = { models: {} };
  const mh = mw.preflight(["claude-opus-4-8"], 3);
  assert.deepEqual([mh.reason, mh.remaining_usd, mh.fleet], ["preflight_estimate", 0.5, true]);
  assert.equal(mw.remaining(["claude-opus-4-8"]).length, 1);
});

// ---- regression: real fleet client from a cached enrollment, real proxy ----
const COMPLETION = JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 10 } });
const BIG = JSON.stringify({ model: "gpt-4o", max_tokens: 300_000, messages: [{ role: "user", content: "hi" }] }); // ~$3 worst case

function enrolled({ tagCaps = null, agentSpend = null, modelCaps = [], modelCapsWeek = null, receipts = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "cc-pf-272-"));
  const path = join(dir, "enrollment.json"), receiptsPath = join(dir, "r.jsonl");
  writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:9", token: "t", agentId: "a1", policy: { version: 1, caps: {}, killed: false, ...(modelCaps.length ? { modelCaps } : {}) }, syncedIds: [], ...(tagCaps ? { tagCaps } : {}), ...(agentSpend ? { agentSpend } : {}), ...(modelCapsWeek ? { modelCapsWeek } : {}) }), { mode: 0o600 });
  writeFileSync(receiptsPath, receipts.map((r) => JSON.stringify(r)).join("\n") + (receipts.length ? "\n" : ""));
  return createFleetClient({ path, receiptsPath });
}

async function setup(t, opts, delayMs = 0) {
  const up = { hits: 0 };
  await new Promise((res) => {
    up.server = http.createServer((q, s) => { up.hits += 1; q.resume(); q.on("end", () => setTimeout(() => s.writeHead(200, { "content-type": "application/json" }).end(COMPLETION), delayMs)); });
    up.server.listen(0, "127.0.0.1", res);
  });
  t.after(() => up.server.close());
  const receipts = [];
  const { server, port } = await startMeteringProxy({ upstreams: { openai: `http://127.0.0.1:${up.server.address().port}` }, onReceipt: (x) => receipts.push(x), ...opts });
  t.after(() => server.close());
  const call = (body = BIG) => fetch(`http://127.0.0.1:${port}/openai/chat/completions`, { method: "POST", body });
  return { up, call, receipts };
}

const nowIso = () => new Date().toISOString();

test("regression #272 AC1/AC6: fleet customer:day $5 with $4.50 synced refuses acme, forwards globex, never pages", async (t) => {
  const fleet = enrolled({ tagCaps: { rules: [{ key: "customer", scope: "day", usd: 5 }], spend: { customer: { acme: e(4.5) } }, truncated: false, as_of: nowIso() } });
  const acme = await setup(t, { preflight: true, tags: { customer: "acme" }, tagCaps: withFleetTagCaps(null, fleet, []) });
  const r = await acme.call();
  const b = await r.json();
  assert.deepEqual([r.status, b.error, b.reason, b.fleet, b.scope, b.remaining_usd], [429, "tag_budget_exceeded", "preflight_estimate", true, "day", 0.5]);
  assert.ok(b.estimate_usd >= 3 && b.estimate_usd < 3.01);
  assert.equal(acme.up.hits, 0);
  assert.deepEqual([acme.receipts[0].blocked, acme.receipts[0].cost_usd, acme.receipts[0].reason], [true, 0, "preflight_estimate"]);
  // AC6: the preflight receipt is not a tag_budget_exceeded block, so it raises no cap_hit.
  const hits = blocksInCurrentPeriod(acme.receipts, { reason: "tag_budget_exceeded", nowMs: Date.now() });
  assert.deepEqual(evaluateTagAlerts({ orgId: "o", rules: [{ key: "customer", scope: "day", usd: 5, warnFractions: [] }], spend: { customer: { acme: e(0) } }, blockedHits: hits }), []);
  const globex = await setup(t, { preflight: true, tags: { customer: "globex" }, tagCaps: withFleetTagCaps(null, fleet, []) });
  assert.equal((await globex.call()).status, 200);
  assert.equal(globex.up.hits, 1);
});

test("regression #272 AC1: a tighter local --tag-cap binds with fleet:false", async (t) => {
  const fleet = enrolled({ tagCaps: { rules: [{ key: "customer", scope: "day", usd: 5 }], spend: { customer: { acme: e(1.5) } }, truncated: false, as_of: nowIso() } });
  const localRules = [{ key: "customer", scope: "day", cap: 4 }];
  const { up, call } = await setup(t, { preflight: true, tags: { customer: "acme" }, tagCaps: withFleetTagCaps(createTagCaps({ rules: localRules }), fleet, localRules) });
  const b = await (await call()).json();
  assert.deepEqual([b.reason, b.remaining_usd, b.fleet], ["preflight_estimate", 2.5, false]);
  assert.equal(up.hits, 0);
});

test("regression #272 AC3/AC7: hosted model cap refuses gpt-4o with $0.50 fleet headroom; no preflight → forwarded", async (t) => {
  const spend = (d) => ({ spent: { day: 0, month: 0 }, unknown: 0, as_of: nowIso(), models: { "gpt-4o": { day: d, week: d, month: d, unknown: 0, unknown_week: 0 } } });
  const fleet = enrolled({ agentSpend: spend(4.5), modelCaps: [{ model: "gpt-4o", scope: "day", usd: 5 }] });
  const modelCaps = withFleetModelCaps(createModelCaps({ rules: [] }), createModelCaps({ rules: [] }), fleet);
  const a = await setup(t, { preflight: true, modelCaps });
  const r = await a.call();
  const b = await r.json();
  assert.deepEqual([r.status, b.error, b.reason, b.fleet, b.scope, b.remaining_usd], [429, "model_budget_exceeded", "preflight_estimate", true, "day", 0.5]);
  assert.equal(a.up.hits, 0);
  const off = await setup(t, { preflight: false, modelCaps });
  assert.equal((await off.call()).status, 200);
  // model_caps_week behaves the same with scope week.
  const wf = enrolled({ agentSpend: spend(4.5), modelCapsWeek: [{ model: "gpt-4o", scope: "week", usd: 5 }] });
  const w = await setup(t, { preflight: true, modelCaps: withFleetModelCaps(createModelCaps({ rules: [] }), createModelCaps({ rules: [] }), wf) });
  const wb = await (await w.call()).json();
  assert.deepEqual([wb.reason, wb.scope, wb.remaining_usd], ["preflight_estimate", "week", 0.5]);
});

test("regression #272 AC4: --max-concurrent 3 with a fleet remainder of 2.5x the estimate → [200, 200, 429]", async (t) => {
  for (const kind of ["tag", "model"]) {
    // ~$3 estimate, remainder ~$7.55.
    const fleet = kind === "tag"
      ? enrolled({ tagCaps: { rules: [{ key: "customer", scope: "day", usd: 10 }], spend: { customer: { acme: e(2.45) } }, truncated: false, as_of: nowIso() } })
      : enrolled({ agentSpend: { spent: { day: 0, month: 0 }, unknown: 0, as_of: nowIso(), models: { "gpt-4o": { day: 2.45, week: 2.45, month: 2.45, unknown: 0, unknown_week: 0 } } }, modelCaps: [{ model: "gpt-4o", scope: "day", usd: 10 }] });
    const opts = kind === "tag"
      ? { tags: { customer: "acme" }, tagCaps: withFleetTagCaps(null, fleet, []) }
      : { modelCaps: withFleetModelCaps(createModelCaps({ rules: [] }), createModelCaps({ rules: [] }), fleet) };
    const { call, up } = await setup(t, { preflight: true, maxConcurrent: 3, ...opts }, 150);
    const rs = await Promise.all([call(), call(), call()]);
    const bodies = await Promise.all(rs.map((r) => r.json()));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 429], kind);
    assert.equal(bodies.find((b) => b.error).reason, "preflight_estimate");
    assert.equal(up.hits, 2);
  }
});
