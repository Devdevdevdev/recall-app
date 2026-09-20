import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  auditPhase15Benchmark,
  calculatePhase15Metrics,
  validatePhase15Split,
} from '../benchmarks/recall-matching/phase-15/dataset.ts';
import { verifyPhase15Freeze } from '../benchmarks/recall-matching/phase-15/freezeGuard.mjs';
import {
  calculateActualCost,
  enforcePaidRunGuardrails,
  projectPhase15Case,
  summarizeTechnicalFailures,
  validateHybridContinuationCheckpoint,
} from '../benchmarks/recall-matching/phase-15/paidRun.ts';

const load = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));

const schema = await load('benchmarks/recall-matching/phase-15/benchmark.schema.json');
const sources = await load('benchmarks/recall-matching/phase-15/sources.normalized.json');
const development = await load('benchmarks/recall-matching/phase-15/development.v2.json');
const holdout = await load('benchmarks/recall-matching/phase-15/holdout.v2.json');
const stress = await load('benchmarks/recall-matching/phase-15/stress.v2.json');
const auditArtifact = await load('benchmarks/recall-matching/phase-15/audit.json');
const hybridStoppedCheckpoint = await load(
  'benchmarks/recall-matching/phase-15/results/hybrid-guarded-v1-paid.checkpoint.json',
);

test('phase 15 has 200 independently split controlled cases', () => {
  assert.equal(development.cases.length, 48);
  assert.equal(holdout.cases.length, 120);
  assert.equal(stress.cases.length, 32);

  const allCases = [...development.cases, ...holdout.cases, ...stress.cases];
  assert.equal(allCases.length, 200);
  assert.deepEqual(
    Object.fromEntries(
      ['match', 'no_match', 'needs_review'].map((label) => [
        label,
        allCases.filter((benchmarkCase) => benchmarkCase.expected === label).length,
      ]),
    ),
    { match: 67, no_match: 67, needs_review: 66 },
  );
});

test('every split validates against the v2 schema and controlled-scope oracle', () => {
  for (const [name, dataset] of [
    ['development', development],
    ['holdout', holdout],
    ['stress', stress],
  ]) {
    assert.deepEqual(validatePhase15Split(dataset, schema, sources, name), []);
  }
});

test('the audit proves source-family independence and label support', () => {
  const audit = auditPhase15Benchmark({ development, holdout, stress }, sources);
  assert.equal(audit.totalCaseCount, 200);
  assert.deepEqual(audit.caseCountBySplit, { development: 48, holdout: 120, stress: 32 });
  assert.equal(audit.uniqueRecallFamilyCount, 50);
  assert.equal(audit.crossSplitRecallFamilyOverlap.length, 0);
  assert.equal(audit.duplicateCaseIds.length, 0);
  assert.equal(audit.duplicateEvidenceFingerprints.length, 0);
  assert.equal(audit.unsupportedLabelCount, 0);
  assert.ok(audit.hardNegativeCount >= 50);
  assert.ok(audit.pairCount >= 50);
  assert.deepEqual(audit.sourceDistribution, { CPSC: 200 });
  assert.deepEqual(auditArtifact.historicalRecallOverlap, []);
  assert.ok(auditArtifact.perturbationVisibility.stressOnly.includes('variant_mismatch'));
});

test('stress includes perturbations absent from development', () => {
  const developmentTypes = new Set(
    development.cases.map((benchmarkCase) => benchmarkCase.perturbationType).filter(Boolean),
  );
  const requiredStressOnly = [
    'single_character_model_mutation',
    'transposed_digits',
    'serial_just_outside_range',
    'lot_near_miss',
    'purchase_date_as_manufacture_date',
    'variant_mismatch',
    'conflicting_identifiers',
  ];
  for (const perturbation of requiredStressOnly) {
    assert.equal(developmentTypes.has(perturbation), false);
    assert.ok(
      stress.cases.some((benchmarkCase) => benchmarkCase.perturbationType === perturbation),
    );
  }
});

test('primary safety metrics separate unsafe confirmations and missed affected outcomes', () => {
  const metrics = calculatePhase15Metrics(
    [
      ['match', 'match'],
      ['match', 'no_match'],
      ['match', 'needs_review'],
      ['no_match', 'match'],
      ['needs_review', 'match'],
      ['no_match', 'no_match'],
    ].map(([expected, predicted], index) => ({
      caseId: `metric-${index}`,
      pairGroupId: index < 2 ? 'pair-1' : null,
      expected,
      predicted,
      technicalFailure: false,
    })),
  );

  assert.equal(metrics.safety.unsafeConfirmations, 2);
  assert.equal(metrics.safety.unsafeConfirmRate, 2 / 3);
  assert.equal(metrics.safety.missedAffectedCount, 2);
  assert.equal(metrics.safety.missedAffectedRate, 2 / 3);
  assert.equal(metrics.safety.rejectedTrueMatches, 1);
  assert.equal(metrics.safety.abstainedTrueMatches, 1);
});

test('freeze manifest pins phase 15 and all historical artifacts', async () => {
  const manifest = await verifyPhase15Freeze();
  assert.equal(manifest.benchmarkVersion, 'recall_safety_benchmark_v2');
  assert.equal(
    manifest.historicalArtifacts['benchmarks/recall-matching/cases.v1.json'],
    'c547d61df8e9eacc1d47d46ec505e409d88cd23795abc20cbbfb4e96f67fb3f8',
  );
  assert.equal(
    manifest.historicalArtifacts['benchmarks/recall-matching/phase-9-1/development.v1.json'],
    '1887da996161611c1d48d3fa75fea281d29f49d27befcb52ce818b0728bd81b1',
  );
  assert.equal(
    manifest.historicalArtifacts['benchmarks/recall-matching/phase-9-1/holdout.v1.json'],
    '3dd19b7075cc7f865816f7217984d1e98f6fd83e1aea2cba6ebbc4554502e608',
  );
});

test('paid-run projection contains production evidence but no labels or benchmark metadata', () => {
  const benchmarkCase = stress.cases[0];
  const source = sources.sources.find(
    (candidate) => candidate.recallFamilyId === benchmarkCase.recallFamilyId,
  );
  const projected = projectPhase15Case(benchmarkCase, source);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes(benchmarkCase.caseId), false);
  assert.equal(serialized.includes(benchmarkCase.expected), false);
  assert.equal(serialized.includes(benchmarkCase.reason), false);
  assert.equal(serialized.includes('pairGroupId'), false);
  assert.deepEqual(projected.ownedProduct, benchmarkCase.ownedProduct);
  assert.equal(projected.officialRecall.source.externalId, source.externalRecallId);
});

test('paid-run guardrails enforce reviewed request and combined-cost caps', () => {
  const pricing = { inputRate: 0.3, outputRate: 0.9 };
  assert.equal(calculateActualCost({ inputTokens: 1000, outputTokens: 2000 }, pricing), 0.0021);
  assert.doesNotThrow(() =>
    enforcePaidRunGuardrails({
      requests: 200,
      requestCap: 600,
      currentRunCostUsd: 0.5,
      priorPaidCostUsd: 0.6,
      combinedCostCapUsd: 1.6,
    }),
  );
  assert.throws(
    () =>
      enforcePaidRunGuardrails({
        requests: 601,
        requestCap: 600,
        currentRunCostUsd: 0.5,
        priorPaidCostUsd: 0,
        combinedCostCapUsd: 1.6,
      }),
    /request cap/u,
  );
  assert.throws(
    () =>
      enforcePaidRunGuardrails({
        requests: 200,
        requestCap: 600,
        currentRunCostUsd: 1.01,
        priorPaidCostUsd: 0.6,
        combinedCostCapUsd: 1.6,
      }),
    /cost cap/u,
  );
});

test('technical failures remain separate from correct abstentions', () => {
  assert.deepEqual(
    summarizeTechnicalFailures([
      { apiSucceeded: false, structuredOutputValid: false, failureKind: 'timeout', retries: 2 },
      {
        apiSucceeded: true,
        structuredOutputValid: false,
        failureKind: 'schema_violation',
        retries: 0,
      },
      { apiSucceeded: true, structuredOutputValid: true, failureKind: null, retries: 1 },
    ]),
    {
      providerFailures: 1,
      timeouts: 1,
      invalidStructuredOutput: 1,
      retries: 3,
      exhaustedRetries: 1,
    },
  );
});

test('hybrid continuation resumes exactly after the exhausted fail-closed case', () => {
  const orderedCases = [...development.cases, ...holdout.cases, ...stress.cases];
  const continuation = validateHybridContinuationCheckpoint(orderedCases, hybridStoppedCheckpoint);
  assert.equal(continuation.completedCases.length, 113);
  assert.equal(continuation.remainingCases.length, 87);
  assert.equal(continuation.exhaustedCase.caseId, 'p15-hol-29-1');
  assert.equal(continuation.exhaustedCase.predicted, 'needs_review');
  assert.equal(continuation.remainingCases[0].caseId, 'p15-hol-29-2');
  assert.equal(
    new Set(continuation.completedCases.map((item) => item.caseId)).size,
    continuation.completedCases.length,
  );
});

test('hybrid continuation rejects duplicate or reordered completed cases', () => {
  const orderedCases = [...development.cases, ...holdout.cases, ...stress.cases];
  const corrupted = structuredClone(hybridStoppedCheckpoint);
  corrupted.cases[1] = structuredClone(corrupted.cases[0]);
  assert.throws(
    () => validateHybridContinuationCheckpoint(orderedCases, corrupted),
    /completed case IDs/u,
  );
});
