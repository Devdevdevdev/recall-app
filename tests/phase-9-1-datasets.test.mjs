import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { projectBenchmarkCaseForNemotron } from '../benchmarks/recall-matching/nemotronProjection.ts';
import {
  DIAGNOSTIC_V1_DATASET_SHA256,
  validatePhase91Dataset,
} from '../benchmarks/recall-matching/phase-9-1/dataset.ts';
import { verifyPhase91Freeze } from '../benchmarks/recall-matching/phase-9-1/freezeGuard.mjs';

const load = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
const schema = await load('benchmarks/recall-matching/benchmark.schema.json');
const historical = await load('benchmarks/recall-matching/cases.v1.json');
const development = await load('benchmarks/recall-matching/phase-9-1/development.v1.json');
const holdout = await load('benchmarks/recall-matching/phase-9-1/holdout.v1.json');
const deterministicHoldout = await load(
  'benchmarks/recall-matching/phase-9-1/results/deterministic-holdout-v1.json',
);
const hybridHoldout = await load(
  'benchmarks/recall-matching/phase-9-1/results/hybrid-holdout-v1.json',
);

function sourceIds(dataset) {
  return new Set(dataset.recalls.map((recall) => recall.source.externalId));
}

function intersection(left, right) {
  return [...left].filter((value) => right.has(value));
}

test('development and holdout datasets are balanced, public, and source-disjoint', () => {
  const historicalIds = sourceIds(historical);
  const developmentIds = sourceIds(development);
  const holdoutIds = sourceIds(holdout);
  assert.deepEqual(intersection(historicalIds, developmentIds), []);
  assert.deepEqual(intersection(historicalIds, holdoutIds), []);
  assert.deepEqual(intersection(developmentIds, holdoutIds), []);
  assert.equal(development.cases.length, 24);
  assert.equal(development.recalls.length, 8);
  assert.equal(holdout.cases.length, 36);
  assert.equal(holdout.recalls.length, 12);
  for (const dataset of [development, holdout]) {
    for (const expected of ['match', 'no_match', 'needs_review']) {
      assert.equal(
        dataset.cases.filter((benchmarkCase) => benchmarkCase.expected === expected).length,
        dataset === development ? 8 : 12,
      );
    }
    for (const recall of dataset.recalls) {
      assert.equal(recall.source.authority, 'CPSC');
      assert.match(recall.source.officialUrl, /^https:\/\/www\.cpsc\.gov\/Recalls\//u);
    }
  }
});

test('development and holdout label-quality validators pass independently', () => {
  assert.deepEqual(
    validatePhase91Dataset(development, schema, {
      name: 'development',
      expectedCaseCount: 24,
      expectedPerClass: 8,
      forbiddenRecallIds: sourceIds(historical),
    }),
    [],
  );
  assert.deepEqual(
    validatePhase91Dataset(holdout, schema, {
      name: 'holdout',
      expectedCaseCount: 36,
      expectedPerClass: 12,
      forbiddenRecallIds: new Set([...sourceIds(historical), ...sourceIds(development)]),
    }),
    [],
  );
});

test('freeze manifest pins holdout, policy, development, and historical artifacts', async () => {
  const manifest = await verifyPhase91Freeze();
  assert.equal(
    manifest.holdout.sha256,
    '3dd19b7075cc7f865816f7217984d1e98f6fd83e1aea2cba6ebbc4554502e608',
  );
  assert.equal(
    manifest.historicalArtifacts['benchmarks/recall-matching/cases.v1.json'],
    DIAGNOSTIC_V1_DATASET_SHA256,
  );
  assert.equal(Object.keys(manifest.frozenPolicyFiles).length, 8);
});

test('every holdout model projection excludes labels and benchmark metadata', () => {
  for (const benchmarkCase of holdout.cases) {
    const serialized = JSON.stringify(projectBenchmarkCaseForNemotron(holdout, benchmarkCase));
    for (const forbiddenValue of [
      benchmarkCase.caseId,
      benchmarkCase.reason,
      benchmarkCase.notes,
    ]) {
      assert.equal(serialized.includes(forbiddenValue), false);
    }
  }
});

test('deterministic holdout result is tied to the frozen dataset and predicts 20 escalations', () => {
  assert.equal(
    deterministicHoldout.dataset.sha256,
    '3dd19b7075cc7f865816f7217984d1e98f6fd83e1aea2cba6ebbc4554502e608',
  );
  assert.equal(deterministicHoldout.metrics.totalCases, 36);
  assert.equal(deterministicHoldout.metrics.match.falsePositives, 0);
  assert.equal(deterministicHoldout.orchestration.deterministicResolutions, 16);
  assert.equal(36 - deterministicHoldout.orchestration.deterministicResolutions, 20);
});

test('committed hybrid result respects the authorized run and safety bounds', () => {
  assert.equal(hybridHoldout.dataset.sha256, deterministicHoldout.dataset.sha256);
  assert.equal(hybridHoldout.provider.modelId, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(hybridHoldout.matcher.version, 'hybrid_guarded_v1');
  assert.equal(hybridHoldout.orchestration.deterministicResolutions, 16);
  assert.equal(hybridHoldout.orchestration.nemotronEscalations, 20);
  assert.equal(hybridHoldout.orchestration.nemotronRequestCount, 24);
  assert.ok(hybridHoldout.orchestration.nemotronRequestCount <= 40);
  assert.equal(hybridHoldout.orchestration.retryCount, 4);
  assert.equal(hybridHoldout.integrity.finalValidStructuredResponses, 20);
  assert.equal(hybridHoldout.integrity.providerFailureAttempts, 0);
  assert.equal(hybridHoldout.metrics.match.falsePositives, 0);
  assert.equal(hybridHoldout.metrics.match.unresolvedPositiveCases, 0);
  assert.equal(hybridHoldout.usage.complete, true);
  assert.equal(hybridHoldout.usage.totalTokens, 82_229);
  assert.ok(hybridHoldout.cost.amount < 0.09);

  const retriedCases = hybridHoldout.cases.filter(
    (benchmarkCase) => benchmarkCase.orchestrationRetries > 0,
  );
  assert.equal(retriedCases.length, 4);
  for (const benchmarkCase of retriedCases) {
    assert.equal(benchmarkCase.orchestrationRetries, 1);
    assert.equal(benchmarkCase.attemptHistory.length, 2);
    assert.equal(benchmarkCase.attemptHistory[0].failureKind, 'schema_violation');
    assert.equal(benchmarkCase.attemptHistory[1].structuredOutputValid, true);
  }
});

test('the original diagnostic dataset content hash remains immutable', async () => {
  const bytes = await readFile(
    new URL('../benchmarks/recall-matching/cases.v1.json', import.meta.url),
  );
  assert.equal(createHash('sha256').update(bytes).digest('hex'), DIAGNOSTIC_V1_DATASET_SHA256);
});
