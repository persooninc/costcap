import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// costcap#252: the deploy key's public half is shown so it can be authorized on the app host.
const script = new URL('../scripts/deploy-key-info.sh', import.meta.url).pathname;
const pins = new URL('../infra/ssh/costcap-deploy.known_hosts', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'cc-keyinfo-'));
const key = join(dir, 'id');
const gen = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', key]);
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });

test('prints user, host, pin status, fingerprint and the public key, never the private key', { skip: gen.status !== 0 && 'ssh-keygen unavailable' }, () => {
  const r = run(key, 'deployer@157.180.14.21', pins);
  assert.equal(r.status, 0, r.stderr);
  const pub = readFileSync(key + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
  assert.match(r.stdout, /^deploy user: deployer$/m);
  assert.match(r.stdout, /^deploy host: 157\.180\.14\.21 \(pinned in known_hosts: yes\)$/m);
  assert.match(r.stdout, /^deploy key fingerprint: SHA256:\S+$/m);
  assert.ok(r.stdout.includes(`authorized_keys line: ${pub} costcap-deploy`));
  const priv = readFileSync(key, 'utf8');
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE KEY/);
  assert.ok(!(r.stdout + r.stderr).includes(priv.split('\n')[1]));
});

test('an unpinned host (the retired 2.29.29.67 box) is reported as not pinned', { skip: gen.status !== 0 && 'ssh-keygen unavailable' }, () => {
  const r = run(key, 'deployer@2.29.29.67', pins);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pinned in known_hosts: no/);
});

test('refuses a target without user@ and a file that is not a private key', () => {
  assert.equal(run(key, '157.180.14.21', pins).status, 2);
  const junk = join(dir, 'junk'); writeFileSync(junk, 'not a key\n');
  const r = run(junk, 'deployer@157.180.14.21', pins);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a readable private key/);
});

test('workflow: dispatch-only, production environment, removes the key file, sends no Stripe secret, opens no SSH', () => {
  const wf = readFileSync(new URL('../.github/workflows/deploy-key-info.yml', import.meta.url), 'utf8');
  assert.match(wf, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(wf, /push:|workflow_run:|schedule:/);
  assert.match(wf, /environment: production/);
  assert.match(wf, /trap 'rm -f \/tmp\/id-info' EXIT/);
  assert.doesNotMatch(wf, /secrets\.COSTCAP_STRIPE/);
  assert.doesNotMatch(wf, /\bssh (-|")/);
});
