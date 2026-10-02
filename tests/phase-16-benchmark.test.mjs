import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`../benchmarks/recall-matching/phase-16/results/${name}`, import.meta.url),
      'utf8',
    ),
  );

const result = await load('deterministic-v2-all.json');
const delta = await load('decision-delta-v1-to-v2.json');

test('Phase 16 replays all 200 frozen cases without AI and reproduces the v1 corpus boundary', () => {
  assert.equal(result.metrics.totalCases, 200);
  assert.equal(result.v1Replay.reproduced, true);
  assert.equal(result.v1Replay.caseCount, 200);
  assert.equal(result.v1Replay.mismatchCount, 0);
  assert.equal(result.ai.calls, 0);
});

test('the three known deterministic unsafe confirmations no longer confirm', () => {
  assert.deepEqual(result.knownUnsafeCases, [
    { caseId: 'p15-str-45-2', expected: 'no_match', predicted: 'no_match' },
    { caseId: 'p15-str-45-3', expected: 'needs_review', predicted: 'needs_review' },
    { caseId: 'p15-str-46-3', expected: 'needs_review', predicted: 'needs_review' },
  ]);
});

test('v2 introduces no unsafe confirmations or unjustified affected-case rejections', () => {
  assert.equal(result.metrics.safety.unsafeConfirmations, 0);
  assert.equal(result.metrics.safety.rejectedTrueMatches, 0);
});

test('every decision change is machine-readable, source-traceable, and non-worsening', () => {
  assert.equal(delta.length, result.deltaCount);
  assert.ok(delta.length > 0);
  assert.ok(delta.every((item) => item.outcome === 'improved'));
  assert.ok(
    delta.every(
      (item) =>
        item.safetyRule === 'all_mandatory_criteria_satisfied' ||
        item.evidence.every((criterion) => criterion.provenance.officialUrl.startsWith('https://')),
    ),
  );
});

test('requested safety subgroups are reported', () => {
  assert.deepEqual(Object.keys(result.subgroupMetrics).sort(), [
    'batch',
    'capacity',
    'gtin',
    'hard negatives',
    'lot',
    'manufacture/production/date',
    'model',
    'multi-condition',
    'near-identical pairs',
    'serial/range',
    'size',
    'variant',
  ]);
});
