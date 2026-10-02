import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { evaluateDeterministicMatchV2 } from '../../../supabase/functions/_shared/matching/deterministicMatcherV2.ts';
import { evaluateDeterministicMatch } from '../../../supabase/functions/_shared/matching/deterministicMatcher.ts';
import {
  DETERMINISTIC_MATCH_METHOD_V2,
  MATCH_EVALUATION_SCHEMA_VERSION_V2,
} from '../../../supabase/functions/_shared/matching/typesV2.ts';
import { decisionToExpected } from '../metrics.ts';
import { calculatePhase15Metrics, validatePhase15Split } from '../phase-15/dataset.ts';
import {
  projectPhase15OwnedProductV2,
  projectPhase15RecallV1,
  projectPhase15RecallV2,
} from './projection.ts';

const loadText = (url) => readFile(url, 'utf8');
const load = async (url) => JSON.parse(await loadText(url));
const phase15 = new URL('../phase-15/', import.meta.url);
const schema = await load(new URL('benchmark.schema.json', phase15));
const sources = await load(new URL('sources.normalized.json', phase15));
const sourceByFamily = new Map(sources.sources.map((source) => [source.recallFamilyId, source]));
const splitNames = ['development', 'holdout', 'stress'];
const datasets = Object.fromEntries(
  await Promise.all(
    splitNames.map(async (name) => [name, await load(new URL(`${name}.v2.json`, phase15))]),
  ),
);
const frozenV1 = await load(new URL('results/deterministic-v1-all.json', phase15));
const frozenV1ByCase = new Map(frozenV1.cases.map((item) => [item.caseId, item]));

function stratify(predictions, predicate) {
  return calculatePhase15Metrics(predictions.filter(predicate));
}

const predictions = [];
const v1ReplayMismatches = [];
for (const split of splitNames) {
  const dataset = datasets[split];
  const errors = validatePhase15Split(dataset, schema, sources, split);
  if (errors.length) throw new Error(errors.join('\n'));
  for (const benchmarkCase of dataset.cases) {
    const source = sourceByFamily.get(benchmarkCase.recallFamilyId);
    const replayedV1 = decisionToExpected(
      evaluateDeterministicMatch(benchmarkCase.ownedProduct, projectPhase15RecallV1(source))
        .decision,
    );
    const frozenPrediction = frozenV1ByCase.get(benchmarkCase.caseId)?.predicted;
    if (replayedV1 !== frozenPrediction) {
      v1ReplayMismatches.push({
        caseId: benchmarkCase.caseId,
        frozen: frozenPrediction,
        replayed: replayedV1,
      });
    }
    const evaluation = evaluateDeterministicMatchV2(
      projectPhase15OwnedProductV2(benchmarkCase),
      projectPhase15RecallV2(source),
    );
    predictions.push({
      caseId: benchmarkCase.caseId,
      recallFamilyId: benchmarkCase.recallFamilyId,
      pairGroupId: benchmarkCase.pairGroupId,
      authority: benchmarkCase.authority,
      split,
      evidenceDimensions: benchmarkCase.evidenceDimensions,
      perturbationType: benchmarkCase.perturbationType,
      hardNegative: benchmarkCase.hardNegative,
      expected: benchmarkCase.expected,
      predicted: decisionToExpected(evaluation.decision),
      technicalFailure: false,
      evaluation,
    });
  }
}

const missingV1 = predictions.filter((item) => !frozenV1ByCase.has(item.caseId));
if (missingV1.length || frozenV1ByCase.size !== predictions.length) {
  throw new Error('Frozen deterministic_v1 result corpus does not match the Phase 15 datasets.');
}
if (v1ReplayMismatches.length) {
  throw new Error(`deterministic_v1 replay drifted on ${v1ReplayMismatches.length} case(s).`);
}

const subgroupPredicates = {
  gtin: (item) => item.evidenceDimensions.includes('gtin'),
  model: (item) =>
    item.evidenceDimensions.some((value) => ['model', 'model_family'].includes(value)),
  'serial/range': (item) => item.evidenceDimensions.includes('serial_range'),
  lot: (item) => item.evidenceDimensions.includes('lot'),
  'manufacture/production/date': (item) =>
    item.evidenceDimensions.some((value) =>
      ['manufacture_date', 'production_date', 'date'].includes(value),
    ),
  variant: (item) => item.evidenceDimensions.includes('variant'),
  size: (item) => item.evidenceDimensions.includes('size'),
  capacity: (item) => item.evidenceDimensions.includes('capacity'),
  batch: (item) => item.evidenceDimensions.includes('batch'),
  'multi-condition': (item) => item.evidenceDimensions.includes('multi_condition'),
  'hard negatives': (item) => item.hardNegative === true,
  'near-identical pairs': (item) => Boolean(item.pairGroupId),
};

const delta = predictions.flatMap((item) => {
  const previous = frozenV1ByCase.get(item.caseId);
  if (previous.predicted === item.predicted) return [];
  const changedCriteria = item.evaluation.criterionEvaluations.filter(
    (criterion) => criterion.required && criterion.outcome !== 'matched',
  );
  const outcome =
    item.predicted === item.expected && previous.predicted !== item.expected
      ? 'improved'
      : item.predicted !== item.expected && previous.predicted === item.expected
        ? 'worsened'
        : 'neutral';
  return [
    {
      caseId: item.caseId,
      expected: item.expected,
      v1Decision: previous.predicted,
      v2Decision: item.predicted,
      recallFamily: item.recallFamilyId,
      safetyRule: changedCriteria.length
        ? 'explicit_all_of_required_criterion_gate'
        : 'all_mandatory_criteria_satisfied',
      evidence: changedCriteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        kind: criterion.kind,
        outcome: criterion.outcome,
        ownedValue: criterion.ownedValue,
        officialValue: criterion.officialValue,
        provenance: criterion.provenance,
      })),
      outcome,
    },
  ];
});

const result = {
  generatedAt: new Date().toISOString(),
  benchmarkVersion: 'recall_safety_benchmark_v2',
  matcher: {
    version: DETERMINISTIC_MATCH_METHOD_V2,
    schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION_V2,
  },
  inputHashes: Object.fromEntries(
    await Promise.all(
      splitNames.map(async (name) => {
        const text = await loadText(new URL(`${name}.v2.json`, phase15));
        return [name, createHash('sha256').update(text).digest('hex')];
      }),
    ),
  ),
  v1Replay: {
    sourceArtifact: 'phase-15/results/deterministic-v1-all.json',
    caseCount: frozenV1ByCase.size,
    mismatchCount: v1ReplayMismatches.length,
    reproduced: v1ReplayMismatches.length === 0,
  },
  ai: { calls: 0, retries: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  metrics: calculatePhase15Metrics(predictions),
  splitMetrics: Object.fromEntries(
    splitNames.map((split) => [split, stratify(predictions, (item) => item.split === split)]),
  ),
  subgroupMetrics: Object.fromEntries(
    Object.entries(subgroupPredicates).map(([name, predicate]) => [
      name,
      stratify(predictions, predicate),
    ]),
  ),
  knownUnsafeCases: predictions
    .filter((item) => ['p15-str-45-2', 'p15-str-45-3', 'p15-str-46-3'].includes(item.caseId))
    .map((item) => ({ caseId: item.caseId, expected: item.expected, predicted: item.predicted })),
  deltaCount: delta.length,
  cases: predictions,
};

const resultDirectory = new URL('./results/', import.meta.url);
await mkdir(resultDirectory, { recursive: true });
await writeFile(
  new URL('deterministic-v2-all.json', resultDirectory),
  `${JSON.stringify(result, null, 2)}\n`,
);
await writeFile(
  new URL('decision-delta-v1-to-v2.json', resultDirectory),
  `${JSON.stringify(delta, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      metrics: result.metrics,
      splitMetrics: result.splitMetrics,
      knownUnsafeCases: result.knownUnsafeCases,
      deltaCount: delta.length,
    },
    null,
    2,
  ),
);
