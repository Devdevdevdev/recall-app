import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { NebiusClient } from '../../../supabase/functions/_shared/nebius/client.ts';
import { safeNebiusEndpoint } from '../../../supabase/functions/_shared/nebius/config.ts';
import {
  evaluateNemotronMatch,
  NEMOTRON_MAX_OUTPUT_TOKENS,
  NEMOTRON_STRUCTURED_OUTPUT_METHOD,
  NEMOTRON_TEMPERATURE,
} from '../../../supabase/functions/_shared/matching/nemotronMatcher.ts';
import {
  MATCH_EVALUATION_SCHEMA_VERSION,
  NEMOTRON_MATCH_METHOD,
  NEMOTRON_PROMPT_VERSION,
} from '../../../supabase/functions/_shared/matching/types.ts';
import {
  extractPriceMetadata,
  findConfiguredModel,
  loadPhase9NebiusConfig,
} from '../nebiusRuntime.mjs';
import {
  calculateActualCost,
  enforcePaidRunGuardrails,
  projectPhase15Case,
  summarizeTechnicalFailures,
} from './paidRun.ts';
import {
  benchmarkPrediction,
  latencySummary,
  loadPaidRunContext,
  metricsAndStrata,
  PAID_COMBINED_COST_CAP_USD,
  PHASE_15_MODEL_ID,
  refuseExisting,
  requirePaidApproval,
  sumUsage,
  writeJson,
} from './paidRuntime.mjs';

const argumentsList = process.argv.slice(2);
requirePaidApproval(argumentsList);
const outputPath = 'benchmarks/recall-matching/phase-15/results/nemotron-v1-paid.json';
const checkpointPath =
  'benchmarks/recall-matching/phase-15/results/nemotron-v1-paid.checkpoint.json';
await refuseExisting(outputPath);
const context = await loadPaidRunContext();
const reviewed = context.plan.nemotron_v1;
if (reviewed.casesRequiringInference !== 200 || reviewed.maximumRequestCount !== 600) {
  throw new Error('Reviewed Nemotron request plan changed unexpectedly.');
}
const config = loadPhase9NebiusConfig();
if (config.modelId !== PHASE_15_MODEL_ID || config.maxRetries !== reviewed.retryCeilingPerCase) {
  throw new Error('Nemotron configuration does not match the reviewed model/retry plan.');
}
const client = new NebiusClient(config);
const metadataObservedAt = new Date().toISOString();
const modelResponse = await client.listModels(true);
const configuredModel = findConfiguredModel(modelResponse.body, config.modelId);
if (!configuredModel) throw new Error('The exact reviewed Nemotron model is unavailable.');
const pricing = extractPriceMetadata(configuredModel, metadataObservedAt);
if (!pricing) throw new Error('Live pricing is unavailable; refusing an unmetered paid run.');

const cases = [];
const attempts = [];
let requestCount = 0;
let invalidStructuredOutput = 0;
const runStartedAt = new Date().toISOString();
const runStart = performance.now();
for (const [index, { benchmarkCase, split }] of context.cases.entries()) {
  const source = context.sourceByFamily.get(benchmarkCase.recallFamilyId);
  if (!source) throw new Error(`Missing source for ${benchmarkCase.caseId}.`);
  const input = projectPhase15Case(benchmarkCase, source);
  const attempt = await evaluateNemotronMatch(input, client, config.modelId);
  const requestsForCase = 1 + attempt.retries;
  requestCount += requestsForCase;
  const technicalFailure = !attempt.structuredOutputValid;
  if (technicalFailure) invalidStructuredOutput += 1;
  attempts.push({
    apiSucceeded: attempt.apiSucceeded,
    structuredOutputValid: attempt.structuredOutputValid,
    failureKind: attempt.failureKind,
    retries: attempt.retries,
    latencyMs: attempt.latencyMs,
    usage: attempt.usage,
  });
  const prediction = benchmarkPrediction(
    benchmarkCase,
    split,
    attempt.evaluation,
    technicalFailure,
  );
  cases.push({
    ...prediction,
    evaluation: attempt.evaluation,
    apiSucceeded: attempt.apiSucceeded,
    structuredOutputValid: attempt.structuredOutputValid,
    failureKind: attempt.failureKind,
    transportRetries: attempt.retries,
    requestCount: requestsForCase,
    latencyMs: attempt.latencyMs,
    usage: attempt.usage,
  });
  const usage = sumUsage(attempts);
  const actualCostUsd = calculateActualCost(usage, pricing);
  enforcePaidRunGuardrails({
    requests: requestCount,
    requestCap: reviewed.maximumRequestCount,
    currentRunCostUsd: actualCostUsd,
    priorPaidCostUsd: 0,
    combinedCostCapUsd: PAID_COMBINED_COST_CAP_USD,
  });
  if (!attempt.apiSucceeded) {
    await writeJson(checkpointPath, { stopped: true, reason: 'final_provider_failure', cases });
    throw new Error(`Final provider failure on ${benchmarkCase.caseId}; stopped safely.`);
  }
  if (invalidStructuredOutput >= 3) {
    await writeJson(checkpointPath, { stopped: true, reason: 'material_schema_failures', cases });
    throw new Error('Three final structured-output failures observed; stopped safely.');
  }
  if (cases.length >= 10 && actualCostUsd !== null) {
    const projectedDirectCost = (actualCostUsd / cases.length) * context.cases.length;
    const projectedCombinedCost =
      projectedDirectCost + context.plan.hybrid_guarded_v1.estimatedCostUsd;
    if (projectedCombinedCost > PAID_COMBINED_COST_CAP_USD) {
      await writeJson(checkpointPath, {
        stopped: true,
        reason: 'projected_combined_cost_cap',
        projectedCombinedCost,
        cases,
      });
      throw new Error(
        `Projected combined paid cost USD ${projectedCombinedCost.toFixed(6)} exceeds cap.`,
      );
    }
  }
  await writeJson(checkpointPath, {
    run: NEMOTRON_MATCH_METHOD,
    completedCases: cases.length,
    requestCount,
    usage,
    actualCostUsd,
    cases,
  });
  console.log(
    `[${index + 1}/${context.cases.length}] ${benchmarkCase.caseId}: ${prediction.predicted}; requests=${requestCount}; cost=${actualCostUsd?.toFixed(6) ?? 'unavailable'}`,
  );
}

const usage = sumUsage(attempts);
const actualCostUsd = calculateActualCost(usage, pricing);
const predictions = cases.map(({ evaluation: _evaluation, ...item }) => item);
const analysis = metricsAndStrata(predictions);
let sourceGitCommit = null;
try {
  sourceGitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // Frozen hashes are the primary reproducibility boundary.
}
const result = {
  generatedAt: new Date().toISOString(),
  runStartedAt,
  authorization: 'explicit_user_approval_2026-09-20',
  benchmarkVersion: 'recall_safety_benchmark_v2',
  frozenArtifacts: {
    datasets: context.datasetHashes,
    schema:
      context.manifest.phase15Artifacts[
        'benchmarks/recall-matching/phase-15/benchmark.schema.json'
      ],
    policy: context.manifest.phase15Artifacts['benchmarks/recall-matching/phase-15/policy.v1.json'],
    promptPolicyArtifacts: context.manifest.promptPolicyArtifacts,
  },
  matcher: {
    version: NEMOTRON_MATCH_METHOD,
    promptVersion: NEMOTRON_PROMPT_VERSION,
    schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION,
    structuredOutputMethod: NEMOTRON_STRUCTURED_OUTPUT_METHOD,
  },
  provider: {
    name: 'nebius',
    modelId: config.modelId,
    endpoint: `${safeNebiusEndpoint(config)}chat/completions`,
  },
  inference: {
    temperature: NEMOTRON_TEMPERATURE,
    maxOutputTokens: NEMOTRON_MAX_OUTPUT_TOKENS,
    requestTimeoutMs: config.requestTimeoutMs,
    maxTransportRetriesPerCase: config.maxRetries,
    requestCap: reviewed.maximumRequestCount,
    combinedCostCapUsd: PAID_COMBINED_COST_CAP_USD,
  },
  sourceGitCommit,
  requestCount,
  usage,
  usageComplete: usage.inputTokens !== null && usage.outputTokens !== null,
  pricing,
  actualCostUsd,
  technicalFailures: summarizeTechnicalFailures(attempts),
  structuredOutput: {
    successes: attempts.filter((attempt) => attempt.structuredOutputValid).length,
    failures: attempts.filter((attempt) => !attempt.structuredOutputValid).length,
    successRate:
      attempts.filter((attempt) => attempt.structuredOutputValid).length / attempts.length,
  },
  latency: {
    wallClockMs: performance.now() - runStart,
    ...latencySummary(attempts.map((attempt) => attempt.latencyMs)),
  },
  ...analysis,
  cases,
};
await writeJson(outputPath, result);
await writeJson(checkpointPath, { complete: true, outputPath, requestCount, actualCostUsd });
console.log(
  JSON.stringify({ outputPath, requestCount, usage, actualCostUsd, metrics: result.metrics }),
);
