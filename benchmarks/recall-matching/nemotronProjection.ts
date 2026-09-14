import type { NemotronMatchingInput } from '../../supabase/functions/_shared/matching/nemotronPrompt.ts';
import type { BenchmarkCase, BenchmarkDataset } from './dataset.ts';
import { recallForCase } from './dataset.ts';

/**
 * The only benchmark-to-model boundary. Evaluation labels and case metadata are deliberately not
 * present in the returned production-shaped input.
 */
export function projectBenchmarkCaseForNemotron(
  dataset: BenchmarkDataset,
  benchmarkCase: BenchmarkCase,
): NemotronMatchingInput {
  return {
    ownedProduct: structuredClone(benchmarkCase.ownedProduct),
    officialRecall: structuredClone(recallForCase(dataset, benchmarkCase)),
  };
}
