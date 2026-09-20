import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const phaseDirectory = new URL('./', import.meta.url);
const hash = async (url) =>
  createHash('sha256')
    .update(await readFile(url))
    .digest('hex');
const load = async (url) => JSON.parse(await readFile(url, 'utf8'));
const splitNames = ['development', 'holdout', 'stress'];
const datasets = Object.fromEntries(
  await Promise.all(
    splitNames.map(async (split) => [
      split,
      await load(new URL(`./${split}.v2.json`, phaseDirectory)),
    ]),
  ),
);
const datasetHashes = Object.fromEntries(
  await Promise.all(
    splitNames.map(async (split) => [
      split,
      await hash(new URL(`./${split}.v2.json`, phaseDirectory)),
    ]),
  ),
);
const baseline = await load(new URL('./results/deterministic-v1-all.json', phaseDirectory));
const historicalNemotron = await load(
  new URL('./benchmarks/recall-matching/results/nemotron-v1.json', root),
);
const historicalHybrid = await load(
  new URL('./benchmarks/recall-matching/phase-9-1/results/hybrid-holdout-v1.json', root),
);
const allCaseCount = Object.values(datasets).reduce(
  (total, dataset) => total + dataset.cases.length,
  0,
);
const hybridInferenceCases = baseline.cases.filter(
  (item) => item.predicted === 'needs_review',
).length;
const directAverage = {
  inputTokens: historicalNemotron.usage.inputTokens / historicalNemotron.dataset.caseCount,
  outputTokens: historicalNemotron.usage.outputTokens / historicalNemotron.dataset.caseCount,
  costUsd: historicalNemotron.cost.amount / historicalNemotron.dataset.caseCount,
  runtimeMs: historicalNemotron.latency.totalDurationMs / historicalNemotron.dataset.caseCount,
};
const hybridObservedRequestFactor =
  historicalHybrid.orchestration.nemotronRequestCount /
  historicalHybrid.orchestration.nemotronEscalations;
const hybridExpectedRequests = Math.ceil(hybridInferenceCases * hybridObservedRequestFactor);
const hybridAveragePerRequest = {
  inputTokens:
    historicalHybrid.usage.inputTokens / historicalHybrid.orchestration.nemotronRequestCount,
  outputTokens:
    historicalHybrid.usage.outputTokens / historicalHybrid.orchestration.nemotronRequestCount,
  costUsd: historicalHybrid.cost.amount / historicalHybrid.orchestration.nemotronRequestCount,
};
const promptFiles = [
  'supabase/functions/_shared/matching/deterministicMatcher.ts',
  'supabase/functions/_shared/matching/evidence.ts',
  'supabase/functions/_shared/matching/aggregation.ts',
  'supabase/functions/_shared/matching/normalization.ts',
  'supabase/functions/_shared/matching/nemotronMatcher.ts',
  'supabase/functions/_shared/matching/nemotronPrompt.ts',
  'supabase/functions/_shared/matching/nemotronSchema.ts',
  'supabase/functions/_shared/matching/guardedNemotronMatcher.ts',
  'supabase/functions/_shared/matching/guardedNemotronPrompt.ts',
  'supabase/functions/_shared/matching/guardedNemotronSchema.ts',
  'supabase/functions/_shared/matching/hybridGuardedMatcher.ts',
  'supabase/functions/_shared/matching/types.ts',
];
const promptPolicyHashes = Object.fromEntries(
  await Promise.all(promptFiles.map(async (path) => [path, await hash(new URL(path, root))])),
);
const plan = {
  generatedAt: new Date().toISOString(),
  authorizationStatus: 'not_authorized_do_not_execute',
  provider: 'Nebius',
  modelId: 'nvidia/nemotron-3-super-120b-a12b',
  datasets: { splits: splitNames, caseCount: allCaseCount, sha256: datasetHashes },
  promptPolicyHashes,
  estimateBasis: {
    direct: 'Measured nemotron_v1 30-case run from 2026-09-14.',
    hybrid: 'Measured hybrid_guarded_v1 20-escalation/24-request run from 2026-09-14.',
    pricing: historicalNemotron.cost.pricing,
    caveat:
      'Planning estimates only; provider pricing, tokenization, retry rate, and latency can change.',
  },
  nemotron_v1: {
    casesRequiringInference: allCaseCount,
    primaryRequestCount: allCaseCount,
    expectedRequestCount: allCaseCount,
    retryCeilingPerCase: historicalNemotron.inference.maxRetriesPerCase,
    maximumRequestCount: allCaseCount * (historicalNemotron.inference.maxRetriesPerCase + 1),
    estimatedInputTokens: Math.ceil(directAverage.inputTokens * allCaseCount),
    estimatedOutputTokens: Math.ceil(directAverage.outputTokens * allCaseCount),
    estimatedTotalTokens: Math.ceil(
      (directAverage.inputTokens + directAverage.outputTokens) * allCaseCount,
    ),
    estimatedCostUsd: directAverage.costUsd * allCaseCount,
    maximumRetryCostUsd:
      directAverage.costUsd * allCaseCount * (historicalNemotron.inference.maxRetriesPerCase + 1),
    estimatedSequentialRuntimeSeconds: (directAverage.runtimeMs * allCaseCount) / 1000,
  },
  hybrid_guarded_v1: {
    casesRequiringInference: hybridInferenceCases,
    deterministicResolutions: allCaseCount - hybridInferenceCases,
    primaryRequestCount: hybridInferenceCases,
    expectedRequestCount: hybridExpectedRequests,
    expectedRequestFactor: hybridObservedRequestFactor,
    retryCeilingPerEscalation: historicalHybrid.inference.maxOrchestrationRetries,
    maximumRequestCount:
      hybridInferenceCases * (historicalHybrid.inference.maxOrchestrationRetries + 1),
    estimatedInputTokens: Math.ceil(hybridAveragePerRequest.inputTokens * hybridExpectedRequests),
    estimatedOutputTokens: Math.ceil(hybridAveragePerRequest.outputTokens * hybridExpectedRequests),
    estimatedTotalTokens: Math.ceil(
      (hybridAveragePerRequest.inputTokens + hybridAveragePerRequest.outputTokens) *
        hybridExpectedRequests,
    ),
    estimatedCostUsd: hybridAveragePerRequest.costUsd * hybridExpectedRequests,
    maximumRetryCostUsd:
      hybridAveragePerRequest.costUsd *
      hybridInferenceCases *
      (historicalHybrid.inference.maxOrchestrationRetries + 1),
    estimatedSequentialRuntimeSeconds:
      (historicalHybrid.latency.nemotronEscalatedAverageMs * hybridInferenceCases) / 1000,
  },
};
await writeFile(
  new URL('./model-run-plan.json', phaseDirectory),
  `${JSON.stringify(plan, null, 2)}\n`,
);
console.log(JSON.stringify(plan, null, 2));
