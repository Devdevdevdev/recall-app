import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { comparePredictions } from '../comparison.ts';
import { recallForCase } from '../dataset.ts';
import { calculateBenchmarkMetrics, decisionToExpected, percentile } from '../metrics.ts';
import { projectBenchmarkCaseForNemotron } from '../nemotronProjection.ts';
import {
  extractPriceMetadata,
  findConfiguredModel,
  loadPhase9NebiusConfig,
} from '../nebiusRuntime.mjs';
import { NebiusClient } from '../../../supabase/functions/_shared/nebius/client.ts';
import { safeNebiusEndpoint } from '../../../supabase/functions/_shared/nebius/config.ts';
import {
  createGuardedNebiusEvaluator,
  evaluateHybridGuardedMatch,
  HYBRID_GUARDED_MAX_ORCHESTRATION_RETRIES,
} from '../../../supabase/functions/_shared/matching/hybridGuardedMatcher.ts';
import {
  GUARDED_NEMOTRON_MAX_OUTPUT_TOKENS,
  GUARDED_NEMOTRON_RESULT_TOOL_NAME,
} from '../../../supabase/functions/_shared/matching/guardedNemotronMatcher.ts';
import {
  GUARDED_NEMOTRON_PROMPT_VERSION,
  HYBRID_GUARDED_MATCH_METHOD,
  MATCH_EVALUATION_SCHEMA_VERSION,
} from '../../../supabase/functions/_shared/matching/types.ts';
import { asPhase91Dataset } from './dataset.ts';
import { verifyPhase91Freeze } from './freezeGuard.mjs';

const argumentsList = process.argv.slice(2);
const outputIndex = argumentsList.indexOf('--output');
const comparisonIndex = argumentsList.indexOf('--comparison-output');
const outputPath = resolve(
  outputIndex >= 0 && argumentsList[outputIndex + 1]
    ? argumentsList[outputIndex + 1]
    : 'benchmarks/recall-matching/phase-9-1/results/hybrid-holdout-v1.json',
);
const comparisonPath = resolve(
  comparisonIndex >= 0 && argumentsList[comparisonIndex + 1]
    ? argumentsList[comparisonIndex + 1]
    : 'benchmarks/recall-matching/phase-9-1/results/holdout-comparison.json',
);
if (
  (outputIndex >= 0 && !argumentsList[outputIndex + 1]) ||
  (comparisonIndex >= 0 && !argumentsList[comparisonIndex + 1])
) {
  throw new Error('Output options require a path.');
}
for (const path of [outputPath, comparisonPath]) {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing independent holdout result ${path}.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error;
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

const manifest = await verifyPhase91Freeze();
const schema = JSON.parse(
  await readFile(new URL('../benchmark.schema.json', import.meta.url), 'utf8'),
);
const holdout = JSON.parse(await readFile(new URL('./holdout.v1.json', import.meta.url), 'utf8'));
const historical = JSON.parse(await readFile(new URL('../cases.v1.json', import.meta.url), 'utf8'));
const development = JSON.parse(
  await readFile(new URL('./development.v1.json', import.meta.url), 'utf8'),
);
const dataset = asPhase91Dataset(holdout, schema, {
  name: 'holdout',
  expectedCaseCount: 36,
  expectedPerClass: 12,
  forbiddenRecallIds: new Set(
    [...historical.recalls, ...development.recalls].map((recall) => recall.source.externalId),
  ),
});
const baseline = JSON.parse(
  await readFile(new URL('./results/deterministic-holdout-v1.json', import.meta.url), 'utf8'),
);
if (baseline.dataset.sha256 !== manifest.holdout.sha256) {
  throw new Error('Deterministic comparison result does not use the frozen holdout.');
}

const expectedEscalations = baseline.cases.filter(
  (item) => item.predicted === 'needs_review',
).length;
if (argumentsList.includes('--plan')) {
  const historicalNemotron = JSON.parse(
    await readFile(new URL('../results/nemotron-v1.json', import.meta.url), 'utf8'),
  );
  const historicalRequestCount = historicalNemotron.dataset.caseCount;
  const estimatedInputTokens =
    (historicalNemotron.usage.inputTokens / historicalRequestCount) * expectedEscalations;
  const estimatedOutputTokens =
    (historicalNemotron.usage.outputTokens / historicalRequestCount) * expectedEscalations;
  const estimatedCost =
    historicalNemotron.cost.amount * (expectedEscalations / historicalRequestCount);
  console.log(
    JSON.stringify({
      holdoutCases: dataset.cases.length,
      deterministicResolutions: dataset.cases.length - expectedEscalations,
      expectedPrimaryNebiusCalls: expectedEscalations,
      maximumAttemptsIfEveryEscalationUsesItsOneRetry: expectedEscalations * 2,
      estimateBasis: 'Phase 9 observed per-request usage and pricing from 2026-09-14',
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedPrimaryCostUsd: estimatedCost,
      estimatedAllRetryUpperCostUsd: estimatedCost * 2,
    }),
  );
  process.exit(0);
}

// Disable client-level retries so the orchestration policy is the single retry authority.
const config = loadPhase9NebiusConfig({ maxRetries: 0 });
const client = new NebiusClient(config);
const metadataObservedAt = new Date().toISOString();
const modelResponse = await client.listModels(true);
const configuredModel = findConfiguredModel(modelResponse.body, config.modelId);
if (!configuredModel) throw new Error('The exact configured Nemotron model is unavailable.');
const pricing = extractPriceMetadata(configuredModel, metadataObservedAt);
const evaluateNemotron = createGuardedNebiusEvaluator(client, config.modelId);

const cases = [];
for (const [index, benchmarkCase] of dataset.cases.entries()) {
  const input = projectBenchmarkCaseForNemotron(dataset, benchmarkCase);
  const result = await evaluateHybridGuardedMatch(input, evaluateNemotron, config.modelId);
  cases.push({
    caseId: benchmarkCase.caseId,
    officialRecallExternalId: benchmarkCase.officialRecallExternalId,
    expected: benchmarkCase.expected,
    predicted: decisionToExpected(result.evaluation.decision),
    ...result,
  });
  if (!argumentsList.includes('--json')) {
    console.log(
      `[${index + 1}/${dataset.cases.length}] ${benchmarkCase.caseId}: ${decisionToExpected(result.evaluation.decision)} (${result.trace.aiEscalated ? 'escalated' : 'deterministic'})`,
    );
  }
}

const predictions = cases.map((item) => ({
  caseId: item.caseId,
  expected: item.expected,
  predicted: item.predicted,
  decision: item.evaluation.decision,
  reasoningSummary: item.evaluation.reasoningSummary,
  matchedIdentifiers: item.evaluation.matchedIdentifiers,
  conflictingIdentifiers: item.evaluation.conflictingIdentifiers,
  technicalFailure: item.structuredOutputValid === false,
}));
const metrics = calculateBenchmarkMetrics(predictions);
const escalatedCases = cases.filter((item) => item.trace.aiEscalated);
const allAttempts = escalatedCases.flatMap((item) => item.attemptHistory);
const usageComplete = escalatedCases.every((item) => item.usageComplete);
const usage = usageComplete
  ? escalatedCases.reduce(
      (total, item) => ({
        inputTokens: total.inputTokens + item.usage.inputTokens,
        outputTokens: total.outputTokens + item.usage.outputTokens,
        totalTokens: total.totalTokens + item.usage.totalTokens,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    )
  : { inputTokens: null, outputTokens: null, totalTokens: null };
const reasoningTokensAvailable = allAttempts.every(
  (attempt) => attempt.usage.reasoningTokens !== null,
);
const reasoningTokens = reasoningTokensAvailable
  ? allAttempts.reduce((total, attempt) => total + attempt.usage.reasoningTokens, 0)
  : null;
const cost =
  pricing && usage.inputTokens !== null && usage.outputTokens !== null
    ? (usage.inputTokens * pricing.inputRate + usage.outputTokens * pricing.outputRate) / 1_000_000
    : null;
const latencies = cases.map((item) => item.latencyMs);
const nemotronLatencies = escalatedCases.map((item) => item.nemotronLatencyMs);
const finalStructuredSuccesses = escalatedCases.filter(
  (item) => item.structuredOutputValid === true,
).length;
const providerFailureAttempts = allAttempts.filter((attempt) => !attempt.apiSucceeded).length;
const structuredFailureAttempts = allAttempts.filter(
  (attempt) => attempt.apiSucceeded && !attempt.structuredOutputValid,
).length;
const retryCount = cases.reduce(
  (total, item) => total + item.orchestrationRetries + item.transportRetries,
  0,
);
let sourceGitCommit = null;
try {
  sourceGitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('../../../', import.meta.url),
    encoding: 'utf8',
  }).trim();
} catch {
  // Frozen dataset and policy hashes remain the primary reproducibility boundary.
}

const result = {
  generatedAt: new Date().toISOString(),
  dataset: {
    name: 'phase_9_1_independent_holdout_v1',
    sha256: manifest.holdout.sha256,
    caseCount: dataset.cases.length,
    sourceCount: dataset.recalls.length,
  },
  matcher: {
    version: HYBRID_GUARDED_MATCH_METHOD,
    promptVersion: GUARDED_NEMOTRON_PROMPT_VERSION,
    schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION,
    outputMethod: `strict_function_tool:${GUARDED_NEMOTRON_RESULT_TOOL_NAME}`,
  },
  provider: {
    name: 'nebius',
    modelId: config.modelId,
    endpoint: `${safeNebiusEndpoint(config)}chat/completions`,
  },
  inference: {
    temperature: 0,
    maxOutputTokens: GUARDED_NEMOTRON_MAX_OUTPUT_TOKENS,
    transportRetries: 0,
    maxOrchestrationRetries: HYBRID_GUARDED_MAX_ORCHESTRATION_RETRIES,
  },
  sourceGitCommit,
  metrics,
  orchestration: {
    deterministicResolutions: cases.length - escalatedCases.length,
    nemotronEscalations: escalatedCases.length,
    escalationRate: escalatedCases.length / cases.length,
    nemotronRequestCount: allAttempts.length,
    retryCount,
  },
  integrity: {
    finalValidStructuredResponses: finalStructuredSuccesses,
    finalStructuredOutputSuccessRate: escalatedCases.length
      ? finalStructuredSuccesses / escalatedCases.length
      : null,
    providerFailureAttempts,
    structuredFailureAttempts,
    technicalFailureCases: escalatedCases
      .filter((item) => item.structuredOutputValid === false)
      .map((item) => ({ caseId: item.caseId, failureKind: item.trace.aiTechnicalFailure })),
  },
  latency: {
    overallTotalMs: latencies.reduce((sum, value) => sum + value, 0),
    overallAverageMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    overallP50Ms: percentile(latencies, 0.5),
    overallP95Ms: percentile(latencies, 0.95),
    nemotronEscalatedTotalMs: nemotronLatencies.reduce((sum, value) => sum + value, 0),
    nemotronEscalatedAverageMs:
      nemotronLatencies.reduce((sum, value) => sum + value, 0) / nemotronLatencies.length,
    nemotronEscalatedP50Ms: percentile(nemotronLatencies, 0.5),
    nemotronEscalatedP95Ms: percentile(nemotronLatencies, 0.95),
  },
  usage: { ...usage, reasoningTokens, complete: usageComplete },
  cost: {
    amount: cost,
    pricing,
    note:
      cost === null
        ? 'Unavailable: complete provider usage and clearly interpretable live pricing were not both available.'
        : 'Calculated from every primary and retry request made for the guarded holdout run.',
  },
  cases,
};

const baselinePredictions = baseline.cases.map((item) => ({
  caseId: item.caseId,
  expected: item.expected,
  predicted: item.predicted,
  decision: item.evaluation.decision,
  reasoningSummary: item.evaluation.reasoningSummary,
  matchedIdentifiers: item.evaluation.matchedIdentifiers,
  conflictingIdentifiers: item.evaluation.conflictingIdentifiers,
}));
const comparison = {
  generatedAt: result.generatedAt,
  datasetSha256: manifest.holdout.sha256,
  baseline: { matcherVersion: 'deterministic_v1', metrics: baseline.metrics },
  guardedHybrid: {
    matcherVersion: HYBRID_GUARDED_MATCH_METHOD,
    metrics,
    orchestration: result.orchestration,
    integrity: result.integrity,
    latency: result.latency,
    usage: result.usage,
    cost: result.cost,
  },
  cases: comparePredictions(baselinePredictions, predictions),
};

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(comparisonPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
await writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, { flag: 'wx' });
console.log(
  JSON.stringify({ outputPath, comparisonPath, metrics, orchestration: result.orchestration }),
);
