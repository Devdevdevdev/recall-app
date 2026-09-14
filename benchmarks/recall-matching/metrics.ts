import type {
  IdentifierEvidence,
  MatchDecision,
} from '../../supabase/functions/_shared/matching/types.ts';
import type { BenchmarkExpected } from './dataset.ts';

export type BenchmarkPrediction = {
  caseId: string;
  expected: BenchmarkExpected;
  predicted: BenchmarkExpected;
  decision: MatchDecision;
  reasoningSummary: string;
  matchedIdentifiers: IdentifierEvidence;
  conflictingIdentifiers: IdentifierEvidence;
  technicalFailure?: boolean;
};

export type ConfusionMatrix = Record<BenchmarkExpected, Record<BenchmarkExpected, number>>;

export type BenchmarkMetrics = {
  totalCases: number;
  exactThreeClassAccuracy: number;
  match: {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    precision: number | null;
    strictRecall: number | null;
    falsePositiveRate: number | null;
    unresolvedPositiveCases: number;
  };
  needsReview: {
    predictedCount: number;
    rate: number;
  };
  decisionCoverage: number;
  confusionMatrix: ConfusionMatrix;
};

const labels: readonly BenchmarkExpected[] = ['match', 'no_match', 'needs_review'];

export function decisionToExpected(decision: MatchDecision): BenchmarkExpected {
  if (decision === 'confirmed') {
    return 'match';
  }
  if (decision === 'rejected') {
    return 'no_match';
  }
  return 'needs_review';
}

export function calculateBenchmarkMetrics(
  predictions: readonly BenchmarkPrediction[],
): BenchmarkMetrics {
  const confusionMatrix = Object.fromEntries(
    labels.map((expected) => [
      expected,
      Object.fromEntries(labels.map((predicted) => [predicted, 0])) as Record<
        BenchmarkExpected,
        number
      >,
    ]),
  ) as ConfusionMatrix;

  for (const prediction of predictions) {
    confusionMatrix[prediction.expected][prediction.predicted] += 1;
  }

  const totalCases = predictions.length;
  const truePositives = confusionMatrix.match.match;
  const falsePositives = predictions.filter(
    (prediction) => prediction.expected !== 'match' && prediction.predicted === 'match',
  ).length;
  const falseNegatives = predictions.filter(
    (prediction) => prediction.expected === 'match' && prediction.predicted !== 'match',
  ).length;
  const trueNegatives = predictions.filter(
    (prediction) => prediction.expected !== 'match' && prediction.predicted !== 'match',
  ).length;
  const expectedMatches = predictions.filter(
    (prediction) => prediction.expected === 'match',
  ).length;
  const predictedMatches = truePositives + falsePositives;
  const predictedNeedsReview = predictions.filter(
    (prediction) => prediction.predicted === 'needs_review',
  ).length;
  const exact = predictions.filter(
    (prediction) => !prediction.technicalFailure && prediction.expected === prediction.predicted,
  ).length;
  const decided = predictions.filter(
    (prediction) => prediction.predicted !== 'needs_review',
  ).length;

  return {
    totalCases,
    exactThreeClassAccuracy: totalCases ? exact / totalCases : 0,
    match: {
      truePositives,
      falsePositives,
      falseNegatives,
      trueNegatives,
      precision: predictedMatches ? truePositives / predictedMatches : null,
      strictRecall: expectedMatches ? truePositives / expectedMatches : null,
      falsePositiveRate:
        falsePositives + trueNegatives ? falsePositives / (falsePositives + trueNegatives) : null,
      unresolvedPositiveCases: predictions.filter(
        (prediction) => prediction.expected === 'match' && prediction.predicted === 'needs_review',
      ).length,
    },
    needsReview: {
      predictedCount: predictedNeedsReview,
      rate: totalCases ? predictedNeedsReview / totalCases : 0,
    },
    decisionCoverage: totalCases ? decided / totalCases : 0,
    confusionMatrix,
  };
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? 0;
}
