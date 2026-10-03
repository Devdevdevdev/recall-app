// Phase 17.7a-1 release guard. "Production ready" is DERIVED from real artifacts,
// never taken from the JSON alone:
//   - the F-4 fix is committed (git: tracked and identical to HEAD);
//   - a post-install verification record exists for F-4 and for 17.7a-1, and the
//     migration SHA-256 it records equals the migration file in this repository;
//   - the F-4 blocker is closed (resolved / neutralized) by a recorded decision.
// Editing docs/phase-17-7a-1-release-gate.json can never, by itself, pass the gate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const gate = JSON.parse(
  await readFile(new URL('docs/phase-17-7a-1-release-gate.json', root), 'utf8'),
);
const CLOSED = new Set(['resolved', 'neutralized']);
const F4_MIGRATION = 'supabase/migrations/20261002180000_phase_17_7a_f4_automatic_alert_safety.sql';
const P17_MIGRATION =
  'supabase/migrations/20261002120000_phase_17_7a_1_owned_product_recall_checks.sql';
const F4_ARTIFACTS = [
  F4_MIGRATION,
  'supabase/tests/phase-17-7a-f4-automatic-alert-safety.sql',
  'tests/phase-17-7a-f4-safety.test.mjs',
];

function committed(paths) {
  try {
    const cwd = new URL('.', root).pathname;
    for (const path of paths)
      execFileSync('git', ['ls-files', '--error-unmatch', path], { cwd, stdio: 'ignore' });
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ...paths], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false; // untracked, modified, or git unavailable: never "committed"
  }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(new URL(path, root)))
    .digest('hex');
}

/** A post-install record is valid only if it pins the exact local migration bytes. */
async function installed(recordPath, migrationPath, version) {
  let record;
  try {
    record = JSON.parse(await readFile(new URL(recordPath, root), 'utf8'));
  } catch {
    return false;
  }
  return (
    record.migrationVersion === version &&
    record.migrationSha256 === (await sha256(migrationPath)) &&
    record.remoteSuite === 'pass' &&
    Array.isArray(record.neutralizationInventory) &&
    typeof record.verifiedAt === 'string' &&
    Number.isFinite(Date.parse(record.verifiedAt))
  );
}

async function derivedState() {
  const f4 = gate.blockers.find((item) => item.id === 'F-4');
  const state = {
    f4Committed: committed(F4_ARTIFACTS),
    f4Installed: await installed(
      'releases/phase-17-7a-f4/post-install-verification.json',
      F4_MIGRATION,
      '20261002180000',
    ),
    productCheckInstalled: await installed(
      'releases/phase-17-7a-1/post-install-verification.json',
      P17_MIGRATION,
      '20261002120000',
    ),
    f4Closed: Boolean(
      f4 && CLOSED.has(f4.status) && typeof f4.decision === 'string' && f4.decision,
    ),
  };
  state.productionReady =
    state.f4Committed && state.f4Installed && state.productCheckInstalled && state.f4Closed;
  return state;
}

test('F-4 is a declared blocker of Phase 17.7a-1', async () => {
  const f4 = gate.blockers.find((item) => item.id === 'F-4');
  assert.ok(f4, 'F-4 must stay listed as a blocker');
  await access(new URL(f4.document, root));
});

test('productionReady can only be true when every real artifact proves it', async () => {
  const state = await derivedState();
  if (gate.productionReady) assert.ok(state.productionReady, JSON.stringify(state));
});

test('the gate JSON never claims more than the artifacts prove', async () => {
  const state = await derivedState();
  const f4 = gate.blockers.find((item) => item.id === 'F-4');
  if (f4.localFix?.committed === true) assert.ok(state.f4Committed, 'F-4 claimed committed');
  if (f4.localFix?.installedInProduction === true) {
    assert.ok(state.f4Installed, 'F-4 claimed installed without a matching verification record');
  }
  if (CLOSED.has(f4.status)) {
    assert.ok(state.f4Committed && state.f4Installed, 'F-4 closed before commit and installation');
  }
});

test('today: F-4 is not installed, so the phase is not production ready', async () => {
  const state = await derivedState();
  assert.equal(state.f4Installed, false);
  assert.equal(state.productionReady, false);
  assert.equal(gate.productionReady, false);
});

test('install order: F-4 before Phase 17.7a-1', () => {
  assert.match(gate.installOrder[0], /F-4/u);
  assert.match(gate.installOrder.at(-1), /17\.7a-1/u);
});

test('the product check ships disabled (migration default and gate agree)', async () => {
  const migration = await readFile(new URL(P17_MIGRATION, root), 'utf8');
  assert.match(migration, /add column product_check_enabled boolean not null default false/u);
  assert.match(migration, /F-4/u);
  assert.equal(gate.productCheckEnabledByDefault, false);
});

test('no migration, script, or function enables product checks', async () => {
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
