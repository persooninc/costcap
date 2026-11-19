import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = new URL('../.github/workflows/', import.meta.url);
const config = readFileSync(new URL('../.github/actionlint.yaml', import.meta.url), 'utf8');

test('every self-hosted runner label used by a workflow is declared for actionlint', () => {
  const declared = new Set([...config.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1]));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/runs-on:\s*\[self-hosted,\s*([^\]]+)\]/g)) {
      for (const label of m[1].split(',').map((s) => s.trim())) {
        assert.ok(declared.has(label), `${f}: runner label ${label} is not declared in .github/actionlint.yaml`);
      }
    }
  }
});

test('regression: host-fix-routing retry loop has no unused loop variable', () => {
  const src = readFileSync(new URL('host-fix-routing.yml', dir), 'utf8');
  assert.doesNotMatch(src, /for i in \$\(seq/);
});

// Red main 2026-11-19 (run 44470107827): e2e failed in `playwright install --with-deps` because another
// job's apt-get held the apt lock on the shared runner. The step now retries; run its real script here.
function e2eInstallScript() {
  const src = readFileSync(new URL('ci.yml', dir), 'utf8');
  const lines = src.split('\n');
  const at = lines.findIndex((l) => l.includes('name: install chromium and its system deps'));
  assert.ok(at >= 0, 'ci.yml e2e has the retrying install step');
  assert.match(lines[at + 1], /^\s+run: \|$/);
  const indent = lines[at + 2].match(/^\s*/)[0];
  const body = [];
  for (const l of lines.slice(at + 2)) {
    if (l.trim() && !l.startsWith(indent)) break;
    body.push(l.slice(indent.length));
  }
  return body.join('\n');
}

function runInstall(failures) {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-pw-install-'));
  const count = join(tmp, 'count');
  writeFileSync(count, '0');
  writeFileSync(join(tmp, 'npx'), `#!/bin/sh
n=$(($(cat "${count}") + 1)); echo "$n" > "${count}"
[ "$*" = "playwright install --with-deps chromium" ] || exit 9
if [ "$n" -le ${failures} ]; then echo "E: Could not get lock /var/lib/apt/lists/lock" >&2; exit 100; fi
exit 0
`);
  chmodSync(join(tmp, 'npx'), 0o755);
  const r = spawnSync('bash', ['-e', '-c', e2eInstallScript()], {
    env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, PW_INSTALL_RETRY_SECONDS: '0' },
    encoding: 'utf8',
  });
  const calls = Number(readFileSync(count, 'utf8'));
  rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, calls, out: r.stdout };
}

test('e2e browser install retries while the shared runner holds the apt lock', () => {
  assert.deepEqual(runInstall(0).status, 0);
  assert.equal(runInstall(0).calls, 1);
  const flaky = runInstall(2);
  assert.equal(flaky.status, 0);
  assert.equal(flaky.calls, 3);
  assert.match(flaky.out, /attempt 2 of 5/);
  const down = runInstall(99);
  assert.equal(down.status, 1);
  assert.equal(down.calls, 5);
  assert.match(down.out, /::error::npx playwright install --with-deps chromium failed 5 times/);
  // The 30 s default wait stays in the workflow; only the test shortens it.
  assert.match(e2eInstallScript(), /PW_INSTALL_RETRY_SECONDS:-30/);
});
