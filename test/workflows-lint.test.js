import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

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
