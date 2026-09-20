import { validateBenchmarkJsonSchema } from '../dataset.ts';
import type { BenchmarkExpected } from '../dataset.ts';
import { calculateBenchmarkMetrics } from '../metrics.ts';

export const PHASE_15_BENCHMARK_VERSION = 'recall_safety_benchmark_v2';
export const PHASE_15_DATASET_VERSION = '2.0.0';
export const PHASE_15_POLICY_VERSION = 'phase_15_safety_policy_v1';

type JsonRecord = Record<string, unknown>;
type Criterion = {
  field: string;
  operator:
    | 'equals'
    | 'one_of'
    | 'prefix_one_of'
    | 'numeric_range'
    | 'fixed_width_range'
    | 'date_range'
    | 'before_date';
  value?: string;
  values?: string[];
  from?: string;
  to?: string;
};

type Phase15Source = {
  recallFamilyId: string;
  authority: string;
  externalRecallId: string;
  scopeRules: Array<{ criteria: Criterion[] }>;
};

type Phase15Case = {
  caseId: string;
  recallFamilyId: string;
  expected: BenchmarkExpected;
  pairGroupId: string | null;
  ownedProduct: JsonRecord;
  attributes: JsonRecord;
  [key: string]: unknown;
};

type PredictionLike = {
  caseId: string;
  pairGroupId?: string | null;
  expected: BenchmarkExpected;
  predicted: BenchmarkExpected;
  technicalFailure?: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalize(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.normalize('NFKC').trim().toLocaleUpperCase('en-US')
    : null;
}

function fieldValue(benchmarkCase: Phase15Case, field: string): string | null {
  const [container, key] = field.split('.');
  if (!key) return null;
  const target = container === 'attributes' ? benchmarkCase.attributes : benchmarkCase.ownedProduct;
  return normalize(target?.[key]);
}

function evaluateCriterion(benchmarkCase: Phase15Case, criterion: Criterion): boolean | null {
  const actual = fieldValue(benchmarkCase, criterion.field);
  if (!actual) return null;
  if (criterion.operator === 'equals') return actual === normalize(criterion.value);
  if (criterion.operator === 'one_of') {
    return (criterion.values ?? []).map(normalize).includes(actual);
  }
  if (criterion.operator === 'prefix_one_of') {
    return (criterion.values ?? [])
      .map(normalize)
      .some((prefix) => prefix && actual.startsWith(prefix));
  }
  if (criterion.operator === 'numeric_range') {
    const from = normalize(criterion.from);
    const to = normalize(criterion.to);
    if (!from || !to || !/^\d+$/u.test(actual) || !/^\d+$/u.test(from) || !/^\d+$/u.test(to)) {
      return null;
    }
    const valueNumber = BigInt(actual);
    return valueNumber >= BigInt(from) && valueNumber <= BigInt(to);
  }
  if (criterion.operator === 'fixed_width_range') {
    const from = normalize(criterion.from);
    const to = normalize(criterion.to);
    if (!from || !to || actual.length !== from.length || from.length !== to.length) return null;
    return actual >= from && actual <= to;
  }
  if (criterion.operator === 'date_range') {
    const from = normalize(criterion.from);
    const to = normalize(criterion.to);
    return from && to ? actual >= from && actual <= to : null;
  }
  const boundary = normalize(criterion.to);
  return boundary ? actual < boundary : null;
}

export function evaluateControlledLabel(
  source: Phase15Source,
  benchmarkCase: Phase15Case,
): BenchmarkExpected {
  const ruleOutcomes = source.scopeRules.map((rule) =>
    rule.criteria.map((criterion) => evaluateCriterion(benchmarkCase, criterion)),
  );
  if (ruleOutcomes.some((outcomes) => outcomes.every((outcome) => outcome === true))) {
    return 'match';
  }
  if (ruleOutcomes.every((outcomes) => outcomes.some((outcome) => outcome === false))) {
    return 'no_match';
  }
  return 'needs_review';
}

export function validatePhase15Split(
  value: unknown,
  schema: unknown,
  sourceSnapshot: unknown,
  expectedSplit: string,
): string[] {
  const errors = validateBenchmarkJsonSchema(value, schema);
  if (!isRecord(value) || !Array.isArray(value.cases))
    return [...errors, 'Dataset must contain cases.'];
  if (value.benchmarkVersion !== PHASE_15_BENCHMARK_VERSION) errors.push('Wrong benchmarkVersion.');
  if (value.datasetVersion !== PHASE_15_DATASET_VERSION) errors.push('Wrong datasetVersion.');
  if (value.split !== expectedSplit) errors.push(`Expected split ${expectedSplit}.`);
  if (!isRecord(sourceSnapshot) || !Array.isArray(sourceSnapshot.sources)) {
    return [...errors, 'Source snapshot must contain sources.'];
  }
  const sources = new Map<string, Phase15Source>();
  for (const source of sourceSnapshot.sources) {
    if (!isRecord(source) || typeof source.recallFamilyId !== 'string') continue;
    sources.set(source.recallFamilyId, source as unknown as Phase15Source);
  }
  const ids = new Set<string>();
  for (const [index, item] of value.cases.entries()) {
    if (!isRecord(item)) {
      errors.push(`cases[${index}] must be an object.`);
      continue;
    }
    const benchmarkCase = item as Phase15Case;
    if (ids.has(benchmarkCase.caseId)) errors.push(`Duplicate caseId ${benchmarkCase.caseId}.`);
    ids.add(benchmarkCase.caseId);
    const source = sources.get(benchmarkCase.recallFamilyId);
    if (!source) {
      errors.push(`${benchmarkCase.caseId} references an unknown recall family.`);
      continue;
    }
    if (source.authority !== item.authority)
      errors.push(`${benchmarkCase.caseId} authority drift.`);
    if (source.externalRecallId !== item.externalRecallId) {
      errors.push(`${benchmarkCase.caseId} external recall ID drift.`);
    }
    const derived = evaluateControlledLabel(source, benchmarkCase);
    if (derived !== benchmarkCase.expected) {
      errors.push(
        `${benchmarkCase.caseId} expected ${benchmarkCase.expected} but oracle derives ${derived}.`,
      );
    }
    if (benchmarkCase.expected === 'no_match' && item.hardNegative !== true) {
      errors.push(`${benchmarkCase.caseId} no_match must be an intentional hard negative.`);
    }
  }
  return errors;
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

export function auditPhase15Benchmark(
  splits: Record<string, { cases: Phase15Case[] }>,
  sourceSnapshot: { sources: Phase15Source[] },
) {
  const allCases = Object.values(splits).flatMap((dataset) => dataset.cases);
  const familySets = Object.fromEntries(
    Object.entries(splits).map(([name, dataset]) => [
      name,
      new Set(dataset.cases.map((benchmarkCase) => benchmarkCase.recallFamilyId)),
    ]),
  ) as Record<string, Set<string>>;
  const overlaps: Array<{ left: string; right: string; recallFamilyId: string }> = [];
  const names = Object.keys(familySets);
  for (let leftIndex = 0; leftIndex < names.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < names.length; rightIndex += 1) {
      const left = names[leftIndex];
      const right = names[rightIndex];
      if (!left || !right) continue;
      const leftFamilies = familySets[left];
      const rightFamilies = familySets[right];
      if (!leftFamilies || !rightFamilies) continue;
      for (const familyId of leftFamilies) {
        if (rightFamilies.has(familyId)) overlaps.push({ left, right, recallFamilyId: familyId });
      }
    }
  }
  const duplicateValues = (values: string[]) =>
    [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
  const sourceByFamily = new Map(
    sourceSnapshot.sources.map((source) => [source.recallFamilyId, source]),
  );
  const unsupported = allCases.filter((benchmarkCase) => {
    const source = sourceByFamily.get(benchmarkCase.recallFamilyId);
    return !source || evaluateControlledLabel(source, benchmarkCase) !== benchmarkCase.expected;
  });
  const evidenceFingerprints = allCases.map((benchmarkCase) =>
    stableFingerprint({
      recallFamilyId: benchmarkCase.recallFamilyId,
      ownedProduct: benchmarkCase.ownedProduct,
      attributes: benchmarkCase.attributes,
    }),
  );
  const pairGroups = new Set(
    allCases.map((benchmarkCase) => benchmarkCase.pairGroupId).filter(Boolean),
  );
  const developmentPerturbations = new Set(
    (splits.development?.cases ?? [])
      .map((item) => item.perturbationType as string)
      .filter(Boolean),
  );
  const stressPerturbations = new Set(
    (splits.stress?.cases ?? []).map((item) => item.perturbationType as string).filter(Boolean),
  );
  return {
    generatedAt: new Date().toISOString(),
    totalCaseCount: allCases.length,
    caseCountBySplit: Object.fromEntries(
      Object.entries(splits).map(([name, dataset]) => [name, dataset.cases.length]),
    ),
    uniqueRecallFamilyCount: new Set(allCases.map((item) => item.recallFamilyId)).size,
    uniqueRecallFamiliesBySplit: Object.fromEntries(
      Object.entries(familySets).map(([name, families]) => [name, families.size]),
    ),
    crossSplitRecallFamilyOverlap: overlaps,
    labelDistribution: Object.fromEntries(
      ['match', 'no_match', 'needs_review'].map((label) => [
        label,
        allCases.filter((item) => item.expected === label).length,
      ]),
    ),
    evidenceDistribution: Object.fromEntries(
      [...new Set(allCases.flatMap((item) => (item.evidenceDimensions as string[]) ?? []))]
        .sort()
        .map((dimension) => [
          dimension,
          allCases.filter((item) =>
            ((item.evidenceDimensions as string[]) ?? []).includes(dimension),
          ).length,
        ]),
    ),
    sourceDistribution: Object.fromEntries(
      [...new Set(allCases.map((item) => item.authority as string))].map((authority) => [
        authority,
        allCases.filter((item) => item.authority === authority).length,
      ]),
    ),
    perturbationDistribution: Object.fromEntries(
      [...new Set(allCases.map((item) => item.perturbationType as string).filter(Boolean))]
        .sort()
        .map((kind) => [kind, allCases.filter((item) => item.perturbationType === kind).length]),
    ),
    perturbationVisibility: {
      developmentSeen: [...developmentPerturbations].sort(),
      stressOnly: [...stressPerturbations]
        .filter((kind) => !developmentPerturbations.has(kind))
        .sort(),
    },
    provenanceDistribution: Object.fromEntries(
      [...new Set(allCases.map((item) => item.labelProvenance as string))]
        .sort()
        .map((kind) => [kind, allCases.filter((item) => item.labelProvenance === kind).length]),
    ),
    hardNegativeCount: allCases.filter((item) => item.hardNegative === true).length,
    pairCount: pairGroups.size,
    missingProvenanceCount: allCases.filter((item) => !item.labelProvenance).length,
    duplicateCaseIds: duplicateValues(allCases.map((item) => item.caseId)),
    duplicateEvidenceFingerprints: duplicateValues(evidenceFingerprints),
    duplicateCaseCount: duplicateValues(allCases.map((item) => item.caseId)).length,
    duplicateEvidenceFingerprintCount: duplicateValues(evidenceFingerprints).length,
    unsupportedLabelCount: unsupported.length,
    unsupportedCaseIds: unsupported.map((item) => item.caseId),
    nearDuplicateLeakageAnalysis: {
      method: 'Exact recall-family isolation plus normalized controlled-evidence fingerprinting.',
      crossSplitFamilyOverlapCount: overlaps.length,
      duplicateEvidenceFingerprintCount: duplicateValues(evidenceFingerprints).length,
    },
  };
}

export function calculatePhase15Metrics(predictions: readonly PredictionLike[]) {
  const core = calculateBenchmarkMetrics(
    predictions.map((prediction) => ({
      ...prediction,
      decision:
        prediction.predicted === 'match'
          ? 'confirmed'
          : prediction.predicted === 'no_match'
            ? 'rejected'
            : 'needs_review',
      reasoningSummary: '',
      matchedIdentifiers: {},
      conflictingIdentifiers: {},
    })),
  );
  const trueMatches = predictions.filter((item) => item.expected === 'match');
  const unsafeConfirmations = predictions.filter(
    (item) => item.expected !== 'match' && item.predicted === 'match',
  ).length;
  const predictedMatches = predictions.filter((item) => item.predicted === 'match').length;
  const pairs = new Map<string, PredictionLike[]>();
  for (const prediction of predictions) {
    if (!prediction.pairGroupId) continue;
    pairs.set(prediction.pairGroupId, [...(pairs.get(prediction.pairGroupId) ?? []), prediction]);
  }
  const completePairs = [...pairs.values()].filter(
    (items) =>
      items.some((item) => item.expected === 'match') &&
      items.some((item) => item.expected === 'no_match'),
  );
  const correctPairs = completePairs.filter((items) =>
    items.every((item) => !item.technicalFailure && item.expected === item.predicted),
  ).length;
  return {
    ...core,
    safety: {
      unsafeConfirmations,
      unsafeConfirmRate: predictedMatches ? unsafeConfirmations / predictedMatches : null,
      missedAffectedCount: trueMatches.filter((item) => item.predicted !== 'match').length,
      missedAffectedRate: trueMatches.length
        ? trueMatches.filter((item) => item.predicted !== 'match').length / trueMatches.length
        : null,
      rejectedTrueMatches: trueMatches.filter((item) => item.predicted === 'no_match').length,
      abstainedTrueMatches: trueMatches.filter((item) => item.predicted === 'needs_review').length,
      pairwiseDiscrimination: completePairs.length ? correctPairs / completePairs.length : null,
      correctPairs,
      totalPairs: completePairs.length,
    },
  };
}
