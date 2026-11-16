// Issue #175: the dashboard agent card must round-trip caps.hour so an
// unrelated "Save caps" never silently deletes an API-set hour cap.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiResponse } from "../src/hosted/ui.js";
import { createHostedServer } from "../src/hosted/server.js";

// Pull caps()/capInputs() out of the shipped dashboard bundle and run them on a tiny fake DOM.
function cardFns() {
  const js = uiResponse("/assets/app.js").body;
  const grab = (name) => { const i = js.indexOf(`function ${name}(`); let d = 0, j = js.indexOf("){", i) + 1; for (; j < js.length; j++) { if (js[j] === "{") d++; else if (js[j] === "}" && --d === 0) break; } return js.slice(i, j + 1); };
  const elem = (tag, text) => ({ tag, text, children: [], name: undefined, value: "", append(...c) { this.children.push(...c); } });
  // eslint-disable-next-line no-new-func
  return new Function("elem", `${grab("caps")}\n${grab("capInputs")}\nreturn { caps, capInputs };`)(elem);
}
function renderCard(policy) {
  const { caps, capInputs } = cardFns();
  const form = { children: [], append(c) { this.children.push(c); }, elements: {} };
  capInputs(form, policy.caps, policy.maxSteps);
  const inputs = form.children[0].children.map((l) => l.children[0]);
  for (const i of inputs) form.elements[i.name] = i;
  return { form, inputs, save: () => caps(form) };
}

test("#175 card renders an Hour field pre-filled from policy.caps.hour and round-trips it", () => {
  const card = renderCard({ caps: { hour: 5, day: 50 } });
  assert.deepEqual(card.inputs.map((i) => i.name), ["run", "hour", "day", "month", "maxSteps"]);
  assert.equal(card.form.elements.hour.value, 5);
  card.form.elements.hour.value = String(card.form.elements.hour.value); // as a browser input reports it
  card.form.elements.day.value = String(card.form.elements.day.value);
  assert.deepEqual(card.save(), { hour: 5, day: 50 });
});

test("#175 clearing the Hour field removes caps.hour; untouched keeps it", () => {
  const card = renderCard({ caps: { hour: 5, day: 50 } });
  card.form.elements.day.value = "50";
  card.form.elements.hour.value = "5";
  assert.equal(card.save().hour, 5);
  card.form.elements.hour.value = "";
  assert.deepEqual(card.save(), { day: 50 });
});

async function fixture(t) {
  const codes = {};
  const storePath = join(mkdtempSync(join(tmpdir(), "cc-175-")), "store.json");
  const origin = "http://localhost";
  const service = createHostedServer({ storePath, origin, secureCookies: false, stripeEnv: {}, verifyChallenge: async () => true, sendCode: async (d) => { codes[d.email] = d.code; }, sendInvite: async () => {}, deliverAlert: async () => [{ status: "accepted" }] });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const request = async (path, body, cookie, auth) => {
    const r = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => {
    const c = await request("/auth/request", { email, turnstileToken: "x" });
    return (await request("/auth/verify", { challengeId: c.body.challengeId, code: codes[email] })).cookie;
  };
  return { request, login };
}

test("#175 integration: a models-only dashboard Save keeps an API-set caps.hour and audits no caps change", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("hour-owner@example.invalid");
  const token = (await f.request("/v1/enrollment-tokens", { caps: { day: 50 } }, owner)).body.token;
  const agent = (await f.request("/v1/enroll", { name: "runner" }, null, token)).body;
  const policyUrl = `/v1/agents/${agent.agentId}/policy`;
  assert.equal((await f.request(policyUrl, { caps: { hour: 5, day: 50 } }, owner)).status, 200);
  // Simulate the dashboard: render the card from the current policy, change only models, Save.
  const card = renderCard({ caps: { hour: 5, day: 50 } });
  for (const i of card.inputs) i.value = i.value === "" ? "" : String(i.value);
  const saved = await f.request(policyUrl, { caps: card.save(), maxSteps: null, silentAfterHours: null, models: ["gpt-4o-mini"] }, owner);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.caps, { hour: 5, day: 50 });
  assert.deepEqual(saved.body.models, ["gpt-4o-mini"]);
  const ev = (await f.request("/v1/evidence.json", undefined, owner)).body;
  const change = ev.audit.filter((e) => e.action === "policy.change").at(-1);
  assert.deepEqual(change.detail.previous.caps, change.detail.policy.caps);
  assert.equal(change.detail.policy.caps.hour, 5);
  // Clearing Hour in the card and saving removes it (caps replaces the whole object).
  card.form.elements.hour.value = "";
  const cleared = await f.request(policyUrl, { caps: card.save() }, owner);
  assert.deepEqual(cleared.body.caps, { day: 50 });
  // Omitting caps keeps them.
  assert.deepEqual((await f.request(policyUrl, { killed: false }, owner)).body.caps, { day: 50 });
});
