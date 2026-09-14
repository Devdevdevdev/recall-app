import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  asBenchmarkDataset,
  recallForCase,
  validateBenchmarkDataset,
} from '../benchmarks/recall-matching/dataset.ts';
import {
  calculateBenchmarkMetrics,
  decisionToExpected,
} from '../benchmarks/recall-matching/metrics.ts';
import { evaluateDeterministicMatch } from '../supabase/functions/_shared/matching/deterministicMatcher.ts';

const rawDataset = JSON.parse(
  await readFile(new URL('../benchmarks/recall-matching/cases.v1.json', import.meta.url), 'utf8'),
);
const benchmarkSchema = JSON.parse(
  await readFile(
    new URL('../benchmarks/recall-matching/benchmark.schema.json', import.meta.url),
    'utf8',
  ),
);

test('dataset v1 is valid, controlled, and balanced', () => {
  assert.deepEqual(validateBenchmarkDataset(rawDataset, benchmarkSchema), []);
  const dataset = asBenchmarkDataset(rawDataset, benchmarkSchema);
  assert.equal(dataset.cases.length, 30);
  assert.deepEqual(
    Object.fromEntries(
      ['match', 'no_match', 'needs_review'].map((label) => [
        label,
        dataset.cases.filter((benchmarkCase) => benchmarkCase.expected === label).length,
      ]),
    ),
    { match: 10, no_match: 10, needs_review: 10 },
  );
  assert.equal(
    dataset.cases.some((benchmarkCase) => benchmarkCase.labelProvenance === 'human_reviewed'),
    false,
  );
  assert.equal(JSON.stringify(dataset).includes('C0001-NB 130-LCUS'), false);

  const arizerRecall = dataset.recalls.find((recall) => recall.source.externalId === '10826');
  const arizerPositive = dataset.cases.find(
    (benchmarkCase) => benchmarkCase.caseId === 'cpsc-10826-serial-prefix-positive',
  );
  assert.ok(arizerRecall);
  assert.ok(arizerPositive);
  assert.equal(arizerPositive.ownedProduct.modelNumber, null);
  assert.equal(arizerPositive.ownedProduct.gtin, null);
  assert.ok(
    arizerRecall.rawEvidence.explicitSerialPrefixes.some((prefix) =>
      arizerPositive.ownedProduct.serialNumber.startsWith(prefix),
    ),
  );
});

test('dataset validator rejects false human-review claims and private identifiers', () => {
  const invalid = structuredClone(rawDataset);
  invalid.cases[0].labelProvenance = 'human_reviewed';
  invalid.cases[0].ownedProduct.userId = 'private-user';
  const errors = validateBenchmarkDataset(invalid, benchmarkSchema);
  assert.ok(errors.some((error) => /falsely claims human review/u.test(error)));
  assert.ok(errors.some((error) => /private-data-shaped/iu.test(error)));
});

test('committed JSON Schema rejects missing and malformed required fields', () => {
  const invalid = structuredClone(rawDataset);
  delete invalid.cases[0].ownedProduct;
  invalid.recalls[0].title = 123;
  invalid.recalls[0].recallDate = '9999-99-99';
  const errors = validateBenchmarkDataset(invalid, benchmarkSchema);
  assert.ok(errors.some((error) => /ownedProduct is required/u.test(error)));
  assert.ok(errors.some((error) => /title has the wrong JSON type/u.test(error)));
  assert.ok(errors.some((error) => /recallDate is not a valid calendar date/u.test(error)));
});

test('baseline metrics count abstentions as strict match false negatives', () => {
  const metrics = calculateBenchmarkMetrics([
    {
      caseId: 'positive-abstention',
      expected: 'match',
      predicted: 'needs_review',
      decision: 'needs_review',
      reasoningSummary: 'ambiguous',
      matchedIdentifiers: {},
      conflictingIdentifiers: {},
    },
    {
      caseId: 'negative',
      expected: 'no_match',
      predicted: 'no_match',
      decision: 'rejected',
      reasoningSummary: 'conflict',
      matchedIdentifiers: {},
      conflictingIdentifiers: {},
    },
  ]);
  assert.equal(metrics.match.truePositives, 0);
  assert.equal(metrics.match.falseNegatives, 1);
  assert.equal(metrics.match.strictRecall, 0);
  assert.equal(metrics.match.unresolvedPositiveCases, 1);
  assert.equal(metrics.decisionCoverage, 0.5);
});

test('deterministic_v1 evaluates every frozen benchmark case', () => {
  const dataset = asBenchmarkDataset(rawDataset, benchmarkSchema);
  const predictions = dataset.cases.map((benchmarkCase) => {
    const evaluation = evaluateDeterministicMatch(
      benchmarkCase.ownedProduct,
      recallForCase(dataset, benchmarkCase),
    );
    return {
      caseId: benchmarkCase.caseId,
      expected: benchmarkCase.expected,
      predicted: decisionToExpected(evaluation.decision),
      decision: evaluation.decision,
      reasoningSummary: evaluation.reasoningSummary,
      matchedIdentifiers: evaluation.matchedIdentifiers,
      conflictingIdentifiers: evaluation.conflictingIdentifiers,
    };
  });
  const metrics = calculateBenchmarkMetrics(predictions);
  assert.equal(metrics.totalCases, 30);
  assert.equal(metrics.match.falsePositives, 0);
  assert.equal(metrics.confusionMatrix.match.match, 7);
  assert.equal(metrics.confusionMatrix.match.needs_review, 3);
  assert.equal(metrics.match.unresolvedPositiveCases, 3);
  assert.equal(metrics.exactThreeClassAccuracy, 0.9);
});
