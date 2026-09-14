import type { BenchmarkCase } from './dataset.ts';
import {
  calculateBenchmarkMetrics,
  type BenchmarkMetrics,
  type BenchmarkPrediction,
} from './metrics.ts';

export type CaseComparison = {
  caseId: string;
  deterministic: BenchmarkPrediction['predicted'];
  nemotron: BenchmarkPrediction['predicted'];
};

export type BenchmarkComparison = {
  improved: CaseComparison[];
  worsened: CaseComparison[];
  unchanged: CaseComparison[];
};

export function comparePredictions(
  deterministic: readonly BenchmarkPrediction[],
  nemotron: readonly BenchmarkPrediction[],
): BenchmarkComparison {
  const deterministicById = new Map(
    deterministic.map((prediction) => [prediction.caseId, prediction]),
  );
  const comparison: BenchmarkComparison = { improved: [], worsened: [], unchanged: [] };
  for (const modelPrediction of nemotron) {
    const baseline = deterministicById.get(modelPrediction.caseId);
    if (!baseline)
      throw new Error(`Missing deterministic prediction for ${modelPrediction.caseId}.`);
    const item = {
      caseId: modelPrediction.caseId,
      deterministic: baseline.predicted,
      nemotron: modelPrediction.predicted,
    };
    const baselineCorrect = baseline.expected === baseline.predicted;
    const modelCorrect =
      !modelPrediction.technicalFailure && modelPrediction.expected === modelPrediction.predicted;
    if (!baselineCorrect && modelCorrect) comparison.improved.push(item);
    else if (baselineCorrect && !modelCorrect) comparison.worsened.push(item);
    else comparison.unchanged.push(item);
  }
  return comparison;
}

export function simulateHybridPolicy(
  cases: readonly BenchmarkCase[],
  deterministic: readonly BenchmarkPrediction[],
  nemotron: readonly BenchmarkPrediction[],
): { predictions: BenchmarkPrediction[]; metrics: BenchmarkMetrics } {
  const baselineById = new Map(deterministic.map((prediction) => [prediction.caseId, prediction]));
  const modelById = new Map(nemotron.map((prediction) => [prediction.caseId, prediction]));
  const predictions = cases.map((benchmarkCase) => {
    const baseline = baselineById.get(benchmarkCase.caseId);
    const model = modelById.get(benchmarkCase.caseId);
    if (!baseline || !model) throw new Error(`Missing hybrid input for ${benchmarkCase.caseId}.`);
    return baseline.predicted === 'needs_review' ? model : baseline;
  });
  return { predictions, metrics: calculateBenchmarkMetrics(predictions) };
}
