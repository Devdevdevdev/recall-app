// Phase 17.7a-1 release guard. "Production ready" is DERIVED from real artifacts,
// never taken from the JSON alone:
//   - the F-4 fix is committed (git: tracked and identical to HEAD);
//   - a post-install verification record exists for F-4 and for 17.7a-1, and the
//     migration SHA-256 it records equals the migration file in this repository;
//   - the 17.7a-1 record also pins the 17.7a-2 migration and the deployed Edge trees,
//     and proves the worker path (T2) and the immediate user path (T3);
//   - the F-4 blocker is closed by a recorded decision ("resolved" also requires an
//     empty neutralization inventory in the F-4 record).
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
const F4_MIGRATION = 'supabase/migrations/20261002110000_phase_17_7a_f4_automatic_alert_safety.sql';
const P17_2_MIGRATION =
  'supabase/migrations/20261003090000_phase_17_7a_2_automation_product_check_plan.sql';
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
async function readRecord(recordPath, migrationPath, version) {
  let record;
  try {
    record = JSON.parse(await readFile(new URL(recordPath, root), 'utf8'));
  } catch {
    return null;
  }
  const valid =
    record.migration === migrationPath.split('/').at(-1) &&
    record.migrationVersion === version &&
    record.migrationContentSha256 === (await sha256(migrationPath)) &&
    record.remoteSuite === 'pass' &&
    Number.isInteger(record.remoteSuitePlan) &&
    record.remoteSuitePlan > 0 &&
    record.remoteSuiteOk === record.remoteSuitePlan &&
    record.remoteSuiteNotOk === 0 &&
    record.remoteSuiteRolledBack === true &&
    Number.isInteger(record.neutralizationInventory) &&
    record.neutralizationInventory >= 0 &&
    typeof record.verifiedAt === 'string' &&
    Number.isFinite(Date.parse(record.verifiedAt));
  return valid ? record : null;
}

const SHA256 = /^[0-9a-f]{64}$/u;

/** F-4 is verified when its record also proves the deployed Edge and a clean natural run. */
function f4Verified(record) {
  const run = record?.naturalRun;
  return Boolean(
    record &&
    Number.isInteger(record.processRecallMatchesVersion) &&
    SHA256.test(record.processRecallMatchesEzbr ?? '') &&
    SHA256.test(record.expectedRuntimeTreeSha256 ?? '') &&
    record.pgtapInstalledAfter === 0 &&
    record.idleInTransactionAfter === 0 &&
    typeof record.firstRealCandidateInvocationObserved === 'boolean' &&
    Number.isFinite(Date.parse(record.naturalRunVerifiedAt)) &&
    run?.cron === 'succeeded' &&
    run.automationHttpStatus === 200 &&
    run.f4Related401 === 0 &&
    run.f4Related500 === 0 &&
    run.unsafeAlerts === 0 &&
    run.unsafePush === 0 &&
    run.unsafeEligibility === 0,
  );
}

/**
 * 17.7a-1 is verified when its record also pins the 17.7a-2 migration bytes, the three
 * deployed Edge trees, and proves the worker path (T2) and the immediate user path (T3)
 * without AI, alerts or unsafe confirmations.
 */
async function productCheckVerified(record) {
  if (!record) return false;
  const plan = record.automationPlanMigration;
  const edge = record.edgeFunctions ?? {};
  const t2 = record.t2WorkerPath;
  const t3 = record.t3ImmediatePath;
  const safety = record.safety;
  return Boolean(
    plan?.migration === P17_2_MIGRATION.split('/').at(-1) &&
    plan.migrationContentSha256 === (await sha256(P17_2_MIGRATION)) &&
    ['check-owned-product', 'process-owned-product-checks', 'run-recall-automation'].every(
      (name) => SHA256.test(edge[name]?.runtimeTreeSha256 ?? '') && edge[name]?.verifyJwt === false,
    ) &&
    record.pgtapInstalledAfter === 0 &&
    record.idleInTransactionAfter === 0 &&
    t2?.passed === true &&
    t2.aiCalls === 0 &&
    t2.workerHttpStatus === 200 &&
    t2.completedRevision === 1 &&
    t3?.passed === true &&
    t3.aiCalls === 0 &&
    t3.claimSource === 'user' &&
    t3.completedRevision === 1 &&
    safety?.alerts === 0 &&
    safety.unsafeConfirmations === 0 &&
    typeof record.firstRealCandidateInvocationObserved === 'boolean',
  );
}

async function derivedState() {
  const f4 = gate.blockers.find((item) => item.id === 'F-4');
  const f4Record = await readRecord(
    'releases/phase-17-7a-f4/post-install-verification.json',
    F4_MIGRATION,
    '20261002110000',
  );
  const productCheckRecord = await readRecord(
    'releases/phase-17-7a-1/post-install-verification.json',
    P17_MIGRATION,
    '20261002120000',
  );
  const state = {
    f4Committed: committed(F4_ARTIFACTS),
    f4Installed: f4Record !== null,
    f4Verified: f4Verified(f4Record),
    productCheckInstalled: productCheckRecord !== null,
    productCheckVerified: await productCheckVerified(productCheckRecord),
    f4Closed: Boolean(
      f4 &&
      CLOSED.has(f4.status) &&
      typeof f4.decision === 'string' &&
      f4.decision &&
      (f4.status !== 'resolved' || f4Record?.neutralizationInventory === 0),
    ),
  };
  state.productionReady =
    state.f4Committed &&
    state.f4Installed &&
    state.f4Verified &&
    state.productCheckInstalled &&
    state.productCheckVerified &&
    state.f4Closed;
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
    assert.ok(
      state.f4Committed && state.f4Installed && state.f4Verified,
      'F-4 closed before commit, installation and verification',
    );
  }
  if (gate.productCheck?.installedInProduction === true) {
    assert.ok(
      state.productCheckInstalled,
      '17.7a-1 claimed installed without a verification record',
    );
  }
});

test('current state: F-4 resolved; 17.7a-1 + 17.7a-2 installed and verified (T2, T3)', async () => {
  const state = await derivedState();
  const f4 = gate.blockers.find((item) => item.id === 'F-4');
  assert.equal(state.f4Committed, true, 'F-4 artifacts must be committed');
  assert.equal(state.f4Installed, true, 'F-4 post-install record missing or not matching');
  assert.equal(state.f4Verified, true, 'F-4 post-install record does not prove verification');
  assert.equal(f4.status, 'resolved');
  assert.equal(state.f4Closed, true);
  assert.equal(f4.localFix.installedInProduction, true);
  assert.equal(state.productCheckInstalled, true, '17.7a-1 post-install record missing');
  assert.equal(state.productCheckVerified, true, '17.7a-1 record does not prove T2 and T3');
  assert.equal(gate.productCheck.installedInProduction, true);
  assert.equal(state.productionReady, true);
  assert.equal(gate.productionReady, true);
});

test('activation is recorded as an operational GO, never as a migration default', async () => {
  const record = JSON.parse(
    await readFile(new URL('releases/phase-17-7a-1/post-install-verification.json', root), 'utf8'),
  );
  assert.equal(gate.productCheckEnabledByDefault, false);
  assert.equal(record.activation.productCheckEnabled, true);
  assert.equal(record.activation.rowsAffected, 1);
  assert.ok(Number.isFinite(Date.parse(record.activation.activatedAt)));
  assert.equal(gate.productCheck.activation.activatedAt, record.activation.activatedAt);
  assert.equal(record.activation.maxProductCheckCandidates, 25);
  if (record.firstRealCandidateInvocationObserved === true) {
    assert.ok(Number.isFinite(Date.parse(record.firstRealCandidateInvocationObservedAt)));
  }
});

test('F-5 is tracked as a non-blocking finding with a document', async () => {
  const f5 = gate.tracked.find((item) => item.id === 'F-5');
  assert.ok(f5, 'F-5 must be tracked');
  assert.equal(f5.blocksThisPhase, false);
  await access(new URL(f5.document, root));
});

test('the F-4 record never claims a real candidate invocation without a timestamp', async () => {
  const record = JSON.parse(
    await readFile(new URL('releases/phase-17-7a-f4/post-install-verification.json', root), 'utf8'),
  );
  if (record.firstRealCandidateInvocationObserved === true) {
    assert.ok(Number.isFinite(Date.parse(record.firstRealCandidateInvocationObservedAt)));
  }
  assert.equal(record.phase17_7a1InstalledInProduction, false);
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
