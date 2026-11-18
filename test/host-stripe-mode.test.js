import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// costcap#252: the host .env gets a COSTCAP_STRIPE_MODE that matches the key already there.
const script = new URL('../scripts/host-stripe-mode.py', import.meta.url).pathname;
const LIVE = 'rk_live_' + 'x'.repeat(24);
const TEST = 'sk_test_' + 'y'.repeat(24);
const envFile = (body) => { const dir = mkdtempSync(join(tmpdir(), 'cc-mode-')); const p = join(dir, '.env'); writeFileSync(p, body, { mode: 0o600 }); return { dir, p }; };
const run = (...args) => spawnSync('python3', [script, ...args], { encoding: 'utf8' });

test('live key + live mode: appends the mode, keeps every other line, backs up, 0600, prints no value', () => {
  const body = `COSTCAP_ORIGIN=https://app.costcap.dev\nCOSTCAP_BILLING=enabled\nCOSTCAP_STRIPE_SECRET_KEY=${LIVE}\n`;
  const { dir, p } = envFile(body);
  const r = run('live', p);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(p, 'utf8');
  assert.equal(out, body + 'COSTCAP_STRIPE_MODE=live\n');
  assert.equal(statSync(p).mode & 0o777, 0o600);
  const backups = readdirSync(dir).filter((n) => n.startsWith('.env.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), body);
  assert.doesNotMatch(r.stdout + r.stderr, /rk_live_x/);
});

test('replaces an existing mode line instead of duplicating it', () => {
  const { p } = envFile(`COSTCAP_STRIPE_MODE=test\nCOSTCAP_STRIPE_SECRET_KEY=${LIVE}\n`);
  assert.equal(run('live', p).status, 0);
  const out = readFileSync(p, 'utf8');
  assert.equal(out.match(/COSTCAP_STRIPE_MODE=/g).length, 1);
  assert.match(out, /^COSTCAP_STRIPE_MODE=live$/m);
});

test('already set: unchanged, no backup', () => {
  const body = `COSTCAP_STRIPE_SECRET_KEY=${TEST}\nCOSTCAP_STRIPE_MODE=test\n`;
  const { dir, p } = envFile(body);
  const r = run('test', p);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already test/);
  assert.equal(readFileSync(p, 'utf8'), body);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith('.env.bak-')).length, 0);
});

test('refuses a mode that does not match the key, leaving the file untouched', () => {
  for (const [key, mode] of [[LIVE, 'test'], [TEST, 'live']]) {
    const body = `COSTCAP_STRIPE_SECRET_KEY=${key}\n`;
    const { p } = envFile(body);
    const r = run(mode, p);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /would not match/);
    assert.equal(readFileSync(p, 'utf8'), body);
    assert.doesNotMatch(r.stdout + r.stderr, /_[xy]{8}/);
  }
});

test('refuses without a Stripe key, a bad mode, or a missing file', () => {
  const { p } = envFile('COSTCAP_BILLING=enabled\n');
  assert.equal(run('live', p).status, 2);
  assert.equal(readFileSync(p, 'utf8'), 'COSTCAP_BILLING=enabled\n');
  assert.equal(run('prod', p).status, 2);
  assert.equal(run('live', join(tmpdir(), 'no-such-dir-cc', '.env')).status, 2);
});

test('parses like the deploy preflight: a quoted key is not a live key there, so it is refused here', () => {
  const body = `# comment=COSTCAP_STRIPE_SECRET_KEY=${LIVE}\nCOSTCAP_STRIPE_SECRET_KEY="${LIVE}"\n`;
  const { p } = envFile(body);
  assert.equal(run('live', p).status, 2);
  assert.equal(readFileSync(p, 'utf8'), body);
});

test('an rk_test_ key is not a test key for the preflight, so test is refused', () => {
  const { p } = envFile('COSTCAP_STRIPE_SECRET_KEY=rk_test_' + 'z'.repeat(24) + '\n');
  assert.equal(run('test', p).status, 2);
});

test('workflow: dispatch-only, pinned host key, sends no Stripe secret', () => {
  const wf = readFileSync(new URL('../.github/workflows/host-stripe-mode.yml', import.meta.url), 'utf8');
  assert.match(wf, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(wf, /push:|workflow_run:|schedule:/);
  assert.match(wf, /StrictHostKeyChecking=yes/);
  assert.match(wf, /UserKnownHostsFile=\$PWD\/infra\/ssh\/costcap-deploy\.known_hosts/);
  assert.doesNotMatch(wf, /secrets\.COSTCAP_STRIPE/);
  assert.match(wf, /options: \[live, test\]/);
});
