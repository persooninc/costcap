// Issue #224: weekly spend digest — pure unit tests (math, lower-bound honesty,
// ISO weeks in the org timezone incl. DST, rendering, idempotency, missed slots).
import test from "node:test";
import assert from "node:assert/strict";
import { buildDigest, digestDue, digestKey, digestSettingsError, resolveDigest, newOrgDigest, DEFAULT_DIGEST, weekLabel, parseWeek, weekBounds, previousWeek, digestSlot, digestText, digestHtml, digestSlack, digestWebhookPayload, digestSubject, spendText, DIGEST_GRACE_MS } from "../src/hosted/digest.js";
import { createDigestDelivery, verifyWebhookSignature } from "../src/hosted/delivery.js";

const H = 3600_000, DAY = 24 * H;
const ORG = "org-a";
const NOW = Date.parse("2026-11-16T09:00:00Z"); // Monday, W47 (UTC)
const at = (s) => new Date(Date.parse(s)).toISOString();
let n = 0;
const rec = (agentId, ts, cost_usd, model, orgId = ORG) => [`${agentId}:r${++n}`, { orgId, agentId, receipt: { id: `r${n}`, ts: at(ts), cost_usd, model } }];

// Fixture: 3 agents, 2 teams, 2 models across two weeks, one unsettled unknown-cost receipt.
export function fixtureState() {
  return {
    orgs: { [ORG]: { id: ORG, name: "acme.test" }, "org-b": { id: "org-b", name: "other" } },
    agents: {
      a1: { id: "a1", orgId: ORG, name: "alpha", policy: { version: 1, caps: { month: 100 } } },
      a2: { id: "a2", orgId: ORG, name: "beta", policy: { version: 1, caps: {} } },
      a3: { id: "a3", orgId: ORG, name: "gamma", policy: { version: 1, caps: { day: 5 } } },
      x1: { id: "x1", orgId: "org-b", name: "intruder", policy: { version: 1, caps: {} } },
    },
    teams: { "org-a:core": { orgId: ORG, name: "core", agents: ["a1", "a2"], month: 50 }, "org-a:ops": { orgId: ORG, name: "ops", agents: ["a3"] } },
    receipts: Object.fromEntries([
      // W46 (Nov 9-15): alpha 10 gpt + 5 claude, beta 3 claude, gamma 1 gpt + unknown claude.
      rec("a1", "2026-11-09T10:00:00Z", 10, "gpt-4o"), rec("a1", "2026-11-15T23:59:00Z", 5, "claude"),
      rec("a2", "2026-11-11T10:00:00Z", 3, "claude"),
      rec("a3", "2026-11-12T10:00:00Z", 1, "gpt-4o"), rec("a3", "2026-11-13T10:00:00Z", null, "claude"),
      // W45 (Nov 2-8): alpha 4, beta 2.
      rec("a1", "2026-11-02T00:00:00Z", 4, "gpt-4o"), rec("a2", "2026-11-08T12:00:00Z", 2, "claude"),
      // Outside both weeks, and another org's receipt in the week.
      rec("a1", "2026-11-16T00:30:00Z", 50, "gpt-4o"), rec("x1", "2026-11-10T10:00:00Z", 999, "gpt-4o", "org-b"),
    ]),
    alerts: {
      x: { id: "x", orgId: ORG, kind: "cap_approaching", fired_at: at("2026-11-10T00:00:00Z") },
      y: { id: "y", orgId: ORG, kind: "spend_anomaly", fired_at: at("2026-11-12T00:00:00Z") },
      z: { id: "z", orgId: ORG, kind: "spend_anomaly", fired_at: at("2026-11-13T00:00:00Z") },
      old: { id: "old", orgId: ORG, kind: "cap_hit", fired_at: at("2026-11-05T00:00:00Z") },
      other: { id: "other", orgId: "org-b", kind: "cap_hit", fired_at: at("2026-11-10T00:00:00Z") },
    },
  };
}

test("AC1: buildDigest totals, delta, top lists, headroom and lower bound", () => {
  const d = buildDigest(fixtureState(), ORG, { week: "2026-W46", nowMs: NOW, dashboardUrl: "https://app.costcap.dev" });
  assert.equal(d.week_start, "2026-11-09T00:00:00.000Z");
  assert.equal(d.week_end, "2026-11-16T00:00:00.000Z");
  assert.deepEqual(d.total, { usd_known: 19, unknown_count: 1, lower_bound: true, calls: 5 });
  assert.deepEqual(d.previous, { week: "2026-W45", usd_known: 6, unknown_count: 0, lower_bound: false, calls: 2 });
  assert.deepEqual(d.change, { usd: 13, pct: 216.7, lower_bound: true });
  assert.deepEqual(d.top_agents.map((a) => [a.name, a.usd_known, a.lower_bound]), [["alpha", 15, false], ["beta", 3, false], ["gamma", 1, true]]);
  assert.deepEqual(d.top_teams.map((t) => [t.name, t.usd_known, t.lower_bound]), [["core", 18, false], ["ops", 1, true]]);
  assert.deepEqual(d.top_models.map((m) => [m.model, m.usd_known, m.lower_bound]), [["gpt-4o", 11, false], ["claude", 8, true]]);
  // Headroom in the current period at NOW (Nov 16 09:00Z): alpha month = 10+5+4+50.
  assert.deepEqual(d.headroom.map((h) => [h.type, h.name, h.scope, h.cap_usd, h.spent_usd, h.headroom_usd, h.lower_bound]), [
    ["agent", "alpha", "month", 100, 69, 31, false],
    ["agent", "gamma", "day", 5, 0, 5, false],
    ["team", "core", "month", 50, 74, -24, false],
  ]);
  assert.deepEqual(d.unknown, { count: 1, lower_bound: true });
  assert.deepEqual(d.alerts, { total: 3, by_kind: { cap_approaching: 1, spend_anomaly: 2 } });
  assert.equal(d.dashboard_url, "https://app.costcap.dev");
  assert.equal(JSON.stringify(d).includes("intruder"), false, "other org never leaks");
  const text = digestText(d);
  assert.match(text, /Spend: at least \$19\.00/);
  assert.match(text, /gamma: at least \$1\.00/);
  assert.match(text, /claude: at least \$8\.00/);
  assert.match(text, /1 receipt with unknown cost not yet settled/);
  assert.match(text, /team core: over by \$24\.00 of \$50\.00 month cap/);
  assert.match(text, /spend_anomaly: 2/);
  assert.match(text, /\+\$13\.00 \(\+216\.7%\) vs \$6\.00 the week before \(known cost only\)/);
});

test("AC1: unknown-only spend is never rendered as $0; settled unknown cost counts", () => {
  const s = fixtureState();
  s.receipts = Object.fromEntries([rec("a3", "2026-11-12T10:00:00Z", null, "claude")]);
  const d = buildDigest(s, ORG, { week: "2026-W46", nowMs: NOW });
  assert.equal(spendText(d.total), "unknown cost");
  assert.equal(d.top_agents[0].lower_bound, true);
  const text = digestText(d);
  assert.doesNotMatch(text, /Spend: \$0\.00/);
  assert.doesNotMatch(text, /gamma: \$0\.00/);
  assert.match(text, /gamma: unknown cost/);
  assert.equal(d.change.pct, null);
  assert.match(text, /\(none\)|Top teams:\n- ops: unknown cost/);
  // Settled: counts at its settled value, no lower bound.
  const key = Object.keys(s.receipts)[0];
  s.receipts[key].settlement = { cost_usd: 2.5 };
  const settled = buildDigest(s, ORG, { week: "2026-W46", nowMs: NOW });
  assert.deepEqual(settled.total, { usd_known: 2.5, unknown_count: 0, lower_bound: false, calls: 1 });
  assert.equal(spendText(settled.total), "$2.50");
  // Empty org: no top rows, "none".
  const empty = buildDigest({ orgs: { [ORG]: { id: ORG } } }, ORG, { week: "2026-W46", nowMs: NOW });
  assert.equal(empty.total.usd_known, 0);
  assert.match(digestText(empty), /Top agents:\n- none/);
  assert.match(digestText(empty), /\+\$0\.00 vs \$0\.00/);
});

test("digest settings validation and resolution", () => {
  assert.equal(digestSettingsError({ enabled: true, weekday: 0, hour: 23, channels: ["email", "slack", "webhook"] }), null);
  assert.equal(digestSettingsError({}), null);
  for (const bad of [null, [], "x", { weekday: 7 }, { weekday: -1 }, { weekday: 1.5 }, { hour: 24 }, { hour: "9" }, { enabled: "yes" }, { channels: ["sms"] }, { channels: "email" }, { channels: ["email", "email"] }, { cadence: "daily" }]) {
    assert.ok(digestSettingsError(bad), JSON.stringify(bad));
  }
  assert.deepEqual(resolveDigest(undefined), { enabled: false, weekday: 1, hour: 9, channels: ["email"] });
  assert.deepEqual(resolveDigest(newOrgDigest()), { enabled: true, weekday: 1, hour: 9, channels: ["email"] });
  assert.deepEqual(resolveDigest({ enabled: true, weekday: 1, hour: 9, channels: ["email"] }, { channels: ["webhook", "email"], hour: 7 }), { enabled: true, weekday: 1, hour: 7, channels: ["email", "webhook"] });
  assert.equal(DEFAULT_DIGEST.enabled, false);
});

test("ISO weeks in the org timezone, year boundaries and DST", () => {
  assert.equal(weekLabel(NOW), "2026-W47");
  assert.equal(weekLabel(Date.parse("2026-11-16T02:00:00Z")), "2026-W47");
  assert.equal(weekLabel(Date.parse("2026-11-16T02:00:00Z"), "America/New_York"), "2026-W46");
  assert.equal(weekLabel(Date.parse("2027-01-01T12:00:00Z")), "2026-W53");
  assert.equal(weekLabel(Date.parse("2025-12-29T12:00:00Z")), "2026-W01");
  assert.deepEqual(parseWeek("2026-W53"), { year: 2026, week: 53 });
  for (const bad of ["2025-W53", "2026-W00", "2026-W54", "2026-46", "x", null]) assert.equal(parseWeek(bad), null, String(bad));
  assert.equal(previousWeek("2027-W01"), "2026-W53");
  assert.equal(previousWeek("2026-W01"), "2025-W52");
  assert.throws(() => weekBounds("nope"), /YYYY-Www/);
  // New York: W45 starts after DST ended (EST, UTC-5).
  const ny = weekBounds("2026-W45", "America/New_York");
  assert.equal(new Date(ny.weekStart).toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(ny.weekEnd - ny.weekStart, 7 * DAY);
  // W44 contains the DST change (Nov 1): the local week is 7 days + 1 hour long.
  const dst = weekBounds("2026-W44", "America/New_York");
  assert.equal(new Date(dst.weekStart).toISOString(), "2026-10-26T04:00:00.000Z");
  assert.equal(dst.weekEnd - dst.weekStart, 7 * DAY + H);
  // Spring forward week (Mar 8 2026): 7 days - 1 hour.
  const spring = weekBounds("2026-W10", "America/New_York");
  assert.equal(spring.weekEnd - spring.weekStart, 7 * DAY - H);
  // A receipt late Sunday night local time stays in its local week.
  const s = fixtureState();
  s.orgs[ORG].budgetPeriod = { timezone: "America/New_York", monthStartDay: 1 };
  s.receipts = Object.fromEntries([rec("a1", "2026-11-16T03:00:00Z", 7, "m")]); // Sun Nov 15 22:00 EST
  assert.equal(buildDigest(s, ORG, { week: "2026-W46", nowMs: NOW }).total.usd_known, 7);
  assert.equal(buildDigest(s, ORG, { week: "2026-W46", nowMs: NOW }).timezone, "America/New_York");
  assert.equal(buildDigest(s, ORG, { week: "2026-W47", nowMs: NOW }).total.usd_known, 0);
});

test("send slot: configured weekday/hour of the following week, DST-safe", () => {
  const mon9 = { weekday: 1, hour: 9 };
  assert.equal(new Date(digestSlot("2026-W46", mon9)).toISOString(), "2026-11-16T09:00:00.000Z");
  assert.equal(new Date(digestSlot("2026-W46", mon9, "America/New_York")).toISOString(), "2026-11-16T14:00:00.000Z");
  assert.equal(new Date(digestSlot("2026-W46", { weekday: 0, hour: 0 })).toISOString(), "2026-11-22T00:00:00.000Z");
  assert.equal(new Date(digestSlot("2026-W42", mon9, "America/New_York")).toISOString(), "2026-10-19T13:00:00.000Z"); // EDT
  // Sunday Nov 1 2026, 09:00 local on the day clocks fall back: 14:00Z (EST).
  assert.equal(new Date(digestSlot("2026-W43", { weekday: 0, hour: 9 }, "America/New_York")).toISOString(), "2026-11-01T14:00:00.000Z");
  // Sunday Mar 8 2026, 09:00 local on spring-forward day: 13:00Z (EDT).
  assert.equal(new Date(digestSlot("2026-W09", { weekday: 0, hour: 9 }, "America/New_York")).toISOString(), "2026-03-08T13:00:00.000Z");
});

test("idempotency key and missed-slot logic", () => {
  const on = { enabled: true, weekday: 1, hour: 9, channels: ["email"] };
  const slot = Date.parse("2026-11-16T09:00:00Z");
  assert.equal(digestKey(ORG, "2026-W46"), "org-a:2026-W46");
  assert.deepEqual(digestDue(slot - 1, { ...on, enabled: false }, ORG), { action: "wait", week: null, slot: null });
  assert.deepEqual(digestDue(slot, on, ORG), { action: "send", week: "2026-W46", slot });
  assert.equal(digestDue(slot + DIGEST_GRACE_MS - 1, on, ORG).action, "send");
  assert.equal(digestDue(slot + 25 * H, on, ORG).action, "skip");
  assert.equal(digestDue(slot, on, ORG, { [digestKey(ORG, "2026-W46")]: { delivery: "accepted" } }).action, "done");
  // Before this week's slot: last week's slot is the latest; already sent -> done.
  assert.deepEqual(digestDue(slot - 1, on, ORG, { [digestKey(ORG, "2026-W45")]: {} }), { action: "done", week: "2026-W45", slot: slot - 7 * DAY });
  // Slots that predate the org (or enabling the digest) are ignored.
  assert.equal(digestDue(slot - 1, on, ORG, {}, "UTC", { since: slot - 2 * DAY }).action, "wait");
  assert.equal(digestDue(slot + 25 * H, on, ORG, {}, "UTC", { since: slot - DAY }).action, "skip");
  // Sunday digest on Monday: the current week's slot is in the future, last week's is 1 day old.
  const sun = { ...on, weekday: 0, hour: 9 };
  assert.deepEqual(digestDue(Date.parse("2026-11-16T08:00:00Z"), sun, ORG), { action: "send", week: "2026-W45", slot: Date.parse("2026-11-15T09:00:00Z") });
});

test("rendering: HTML escapes, Slack blocks, signed webhook payload", async () => {
  const s = fixtureState();
  s.agents.a1.name = "<script>x</script>";
  const d = buildDigest(s, ORG, { week: "2026-W46", nowMs: NOW, dashboardUrl: "https://app.costcap.dev" });
  const html = digestHtml(d);
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /at least \$19\.00/);
  const slack = digestSlack(d);
  assert.equal(slack.text, digestSubject(d));
  assert.equal(slack.blocks[0].type, "header");
  assert.ok(slack.blocks.some((b) => b.text?.text?.includes("*Top models*")));
  assert.ok(slack.blocks.at(-1).elements[0].text.includes("https://app.costcap.dev"));
  const payload = digestWebhookPayload(d);
  assert.equal(payload.type, "costcap.digest");
  assert.equal(payload.id, "org-a:2026-W46");
  assert.equal(payload.total.lower_bound, true);

  // Delivery adapter: fake fetch + DNS; secrets are fixtures, never real.
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: !String(url).includes("fail"), status: String(url).includes("fail") ? 500 : 202 }; };
  const secret = "whsec_" + "0".repeat(48);
  const nowMs = () => NOW;
  const send = createDigestDelivery({ emailKey: "fixture-key", emailFrom: "CostCap <alerts@example.invalid>", fetchImpl, lookup: async () => [{ address: "93.184.216.34" }], nowMs });
  const dest = { emails: ["owner@example.invalid"], slackWebhook: "https://hooks.slack.com/services/T0/B0/xyz", webhook: { url: "https://hooks.example.com/costcap", secret } };
  const result = await send(d, dest, { channels: ["email", "slack", "webhook"] });
  assert.deepEqual(result.map((r) => [r.channel, r.status]), [["email", "accepted"], ["slack", "accepted"], ["webhook", "accepted"]]);
  const email = JSON.parse(calls[0].init.body);
  assert.match(email.textContent, /at least \$19\.00/);
  assert.match(email.htmlContent, /<h2>CostCap weekly spend digest/);
  assert.equal(email.subject, digestSubject(d));
  assert.deepEqual(JSON.parse(calls[1].init.body).blocks[0].type, "header");
  const hook = calls[2];
  assert.equal(JSON.parse(hook.init.body).type, "costcap.digest");
  assert.equal(verifyWebhookSignature(secret, hook.init.body, hook.init.headers["x-costcap-signature"], { nowMs: NOW }), true);
  // Only requested channels are sent; failures and unconfigured are per channel.
  calls.length = 0;
  const partial = await send(d, { ...dest, slackWebhook: "https://hooks.slack.com/services/T0/B0/fail" }, { channels: ["slack"] });
  assert.deepEqual(partial.map((r) => [r.channel, r.status]), [["slack", "failed"]]);
  assert.equal(calls.length, 1);
  const none = await send(d, { emails: [], slackWebhook: null, webhook: null }, { channels: ["email", "slack", "webhook"] });
  assert.deepEqual(none.map((r) => r.status), ["unconfigured", "unconfigured", "unconfigured"]);
  // A webhook resolving to a private address fails at send time (SSRF guard).
  const priv = createDigestDelivery({ fetchImpl, lookup: async () => [{ address: "10.0.0.1" }], nowMs });
  assert.equal((await priv(d, dest, { channels: ["webhook"] }))[0].status, "failed");
});

// #294 AC5: org forecast for the current budget month in the digest and its bodies.
test("#294 AC5: digest forecast, Projected this budget month line, ≥ with unsettled unknown", () => {
  const DAY10 = Date.parse("2026-11-11T00:00:00Z");
  const state = {
    orgs: { [ORG]: { id: ORG, name: "acme.test" }, "org-b": { id: "org-b", name: "other" } },
    agents: { A: { id: "A", orgId: ORG, name: "A", policy: { version: 1, caps: {} } }, B: { id: "B", orgId: ORG, name: "B", policy: { version: 1, caps: {} } } },
    receipts: Object.fromEntries([rec("A", "2026-11-02T00:00:00Z", 30, "m"), rec("B", "2026-11-05T00:00:00Z", 10, "m"), rec("x", "2026-11-05T00:00:00Z", 999, "m", "org-b")]),
  };
  const d = buildDigest(state, ORG, { week: "2026-W45", nowMs: DAY10 });
  assert.deepEqual(d.forecast, { period_end: "2026-12-01T00:00:00.000Z", period_end_local: "2026-12-01", projected_usd: 120, lower_bound: false });
  assert.match(digestText(d), /Projected this budget month: \$120\.00/);
  assert.match(digestHtml(d), /Projected this budget month: \$120\.00/);
  assert.match(JSON.stringify(digestSlack(d)), /Projected this budget month: \$120\.00/);
  Object.assign(state.receipts, Object.fromEntries([rec("B", "2026-11-06T00:00:00Z", null, "m")]));
  const lb = buildDigest(state, ORG, { week: "2026-W45", nowMs: DAY10 });
  assert.equal(lb.forecast.lower_bound, true);
  assert.match(digestText(lb), /Projected this budget month: ≥ \$120\.00/);
  const early = buildDigest(state, ORG, { week: "2026-W44", nowMs: Date.parse("2026-11-01T12:00:00Z") });
  assert.equal(early.forecast.projected_usd, null);
  assert.doesNotMatch(digestText(early), /Projected this budget month/);
});
