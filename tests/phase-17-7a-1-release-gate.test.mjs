// Phase 17.7a-1 release guard: the phase cannot be declared production ready while
// finding F-4 is neither resolved nor explicitly neutralized by a recorded decision.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const gate = JSON.parse(
  await readFile(new URL('docs/phase-17-7a-1-release-gate.json', root), 'utf8'),
);
const CLOSED = new Set(['resolved', 'neutralized']);

test('F-4 is a declared blocker of Phase 17.7a-1', async () => {
  const f4 = gate.blockers.find((item) => item.id === 'F-4');
  assert.ok(f4, 'F-4 must stay listed as a blocker');
  await access(new URL(f4.document, root));
});

test('production ready requires every blocker closed by a recorded decision', () => {
  const open = gate.blockers.filter(
    (item) => !CLOSED.has(item.status) || typeof item.decision !== 'string' || !item.decision,
  );
  if (open.length) {
    assert.equal(gate.productionReady, false, `open blockers: ${open.map((item) => item.id)}`);
  }
});

test('the product check ships disabled (migration default and gate agree)', async () => {
  const migration = await readFile(
    new URL(
      'supabase/migrations/20261002120000_phase_17_7a_1_owned_product_recall_checks.sql',
      root,
    ),
    'utf8',
  );
  assert.match(migration, /add column product_check_enabled boolean not null default false/u);
  assert.match(migration, /F-4/u);
  assert.equal(gate.productCheckEnabledByDefault, false);
});

test('no migration, script, or function enables product checks', async () => {
  const { readdir } = await import('node:fs/promises');
  const enabling = /product_check_enabled\s*=\s*true/u;
  const offenders = [];
  for (const directory of [
    'supabase/migrations',
    'supabase/functions/check-owned-product',
    'supabase/functions/process-owned-product-checks',
    'supabase/functions/_shared/productCheck',
  ]) {
    for (const name of await readdir(new URL(`${directory}/`, root))) {
      const text = await readFile(new URL(`${directory}/${name}`, root), 'utf8');
      if (enabling.test(text)) offenders.push(`${directory}/${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});
