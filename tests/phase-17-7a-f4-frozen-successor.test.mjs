// Phase 17.7a F-4: the frozen Phase 16 product-safety suite stays byte-identical and
// is superseded (not rewritten) by an active Phase 17 successor.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { activeSuites, SUPERSEDED, verifySuperseded } from '../scripts/run-local-pgtap.mjs';

const root = new URL('../', import.meta.url);
const FROZEN = 'supabase/tests/phase-16-product-safety-evidence.sql';
const HISTORICAL_SHA = '800ce8cd9c93a17b32c91b988625ff2d159b3b72662a756f11afc79fb30376ab';

test('the frozen Phase 16 artifact keeps its historical bytes and manifest entry', async () => {
  const sha = createHash('sha256')
    .update(await readFile(new URL(FROZEN, root)))
    .digest('hex');
  assert.equal(sha, HISTORICAL_SHA);
  const manifest = JSON.parse(
    await readFile(
      new URL('benchmarks/recall-matching/phase-16/freeze-manifest.json', root),
      'utf8',
    ),
  );
  assert.equal(
    manifest.implementationArtifacts?.[FROZEN] ??
      manifest.reviewArtifacts?.[FROZEN] ??
      manifest.benchmarkArtifacts?.[FROZEN],
    HISTORICAL_SHA,
  );
  await verifySuperseded();
});

test('the active pgTAP run skips only the superseded artifact and runs its successor', async () => {
  const suites = await activeSuites();
  assert.deepEqual(Object.keys(SUPERSEDED), [FROZEN]);
  assert.ok(!suites.includes(FROZEN));
  assert.ok(suites.includes('supabase/tests/phase-17-7a-f4-product-safety-evidence.sql'));
  assert.ok(suites.includes('supabase/tests/remote/phase-16-production-compatibility.sql'));
  assert.ok(suites.length >= 25);
});

test('the successor keeps the Phase 16 assertions and adds the F-4 contract', async () => {
  const frozen = await readFile(new URL(FROZEN, root), 'utf8');
  const successor = await readFile(
    new URL('supabase/tests/phase-17-7a-f4-product-safety-evidence.sql', root),
    'utf8',
  );
  const descriptions = (text) => [...text.matchAll(/\n  '([^'\n]+)'\n\);/gu)].map((m) => m[1]);
  for (const description of descriptions(frozen)) {
    assert.ok(successor.includes(`'${description}'`), description);
  }
  assert.match(successor, /the owner role has no exemption/u);
  assert.match(successor, /F-4 withholds the historical v1 confirmation/u);
  assert.doesNotMatch(
    successor,
    /create or replace function private\.automatic_alert_eligibility/u,
  );
});
