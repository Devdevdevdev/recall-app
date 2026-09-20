import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

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
import {
  extractPriceMetadata,
  findConfiguredModel,
  loadPhase9NebiusConfig,
} from '../nebiusRuntime.mjs';
import { calculateActualCost, enforcePaidRunGuardrails, projectPhase15Case } from './paidRun.ts';
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
const outputPath = 'benchmarks/recall-matching/phase-15/results/hybrid-guarded-v1-paid.json';
const checkpointPath =
  'benchmarks/recall-matching/phase-15/results/hybrid-guarded-v1-paid.checkpoint.json';
const nemotronResultPath = 'benchmarks/recall-matching/phase-15/results/nemotron-v1-paid.json';
await refuseExisting(outputPath);
const context = await loadPaidRunContext();
const directResult = JSON.parse(await readFile(nemotronResultPath, 'utf8'));
if (directResult.actualCostUsd === null) throw new Error('Prior Nemotron cost is unavailable.');
const reviewed = context.plan.hybrid_guarded_v1;
if (reviewed.casesRequiringInference !== 88 || reviewed.maximumRequestCount !== 176) {
  throw new Error('Reviewed guarded-hybrid request plan changed unexpectedly.');
}
const baseline = JSON.parse(
  await readFile('benchmarks/recall-matching/phase-15/results/deterministic-v1-all.json', 'utf8'),
);
const expectedEscalationIds = baseline.cases
  .filter((item) => item.predicted === 'needs_review')
  .map((item) => item.caseId)
  .sort();
if (expectedEscalationIds.length !== reviewed.casesRequiringInference) {
  throw new Error('Frozen deterministic escalation population is not the reviewed 88 cases.');
}
const config = loadPhase9NebiusConfig({ maxRetries: 0 });
if (config.modelId !== PHASE_15_MODEL_ID || config.maxRetries !== 0) {
  throw new Error('Guarded-hybrid configuration does not match the frozen policy.');
}
const client = new NebiusClient(config);
const metadataObservedAt = new Date().toISOString();
const modelResponse = await client.listModels(true);
const configuredModel = findConfiguredModel(modelResponse.body, config.modelId);
if (!configuredModel) throw new Error('The exact reviewed Nemotron model is unavailable.');
const pricing = extractPriceMetadata(configuredModel, metadataObservedAt);
if (!pricing) throw new Error('Live pricing is unavailable; refusing an unmetered paid run.');
const evaluateNemotron = createGuardedNebiusEvaluator(client, config.modelId);

const cases = [];
let requestCount = 0;
let processedEscalations = 0;
const allAttempts = [];
const runStartedAt = new Date().toISOString();
const runStart = performance.now();
for (const [index, { benchmarkCase, split }] of context.cases.entries()) {
  const source = context.sourceByFamily.get(benchmarkCase.recallFamilyId);
  if (!source) throw new Error(`Missing source for ${benchmarkCase.caseId}.`);
  const input = projectPhase15Case(benchmarkCase, source);
  const result = await evaluateHybridGuardedMatch(input, evaluateNemotron, config.modelId);
  if (result.trace.aiEscalated) processedEscalations += 1;
  requestCount += result.nemotronRequestCount + result.transportRetries;
  allAttempts.push(
    ...result.attemptHistory.map((attempt) => ({
      ...attempt,
      retries: 0,
    })),
  );
  const technicalFailure = result.structuredOutputValid === false;
  const prediction = benchmarkPrediction(benchmarkCase, split, result.evaluation, technicalFailure);
  cases.push({
    ...prediction,
    evaluation: result.evaluation,
    trace: result.trace,
    nemotronRequestCount: result.nemotronRequestCount,
    orchestrationRetries: result.orchestrationRetries,
    transportRetries: result.transportRetries,
    structuredOutputValid: result.structuredOutputValid,
    attemptHistory: result.attemptHistory,
    latencyMs: result.latencyMs,
    nemotronLatencyMs: result.nemotronLatencyMs,
    usage: result.usage,
    usageComplete: result.usageComplete,
  });
  const actualEscalationIds = cases
    .filter((item) => item.trace.aiEscalated)
    .map((item) => item.caseId);
  if (actualEscalationIds.some((caseId) => !expectedEscalationIds.includes(caseId))) {
    throw new Error('Guarded hybrid widened AI eligibility beyond the frozen population.');
  }
  const usage = sumUsage(allAttempts);
  const actualCostUsd = calculateActualCost(usage, pricing);
  enforcePaidRunGuardrails({
    requests: requestCount,
    requestCap: reviewed.maximumRequestCount,
    currentRunCostUsd: actualCostUsd,
    priorPaidCostUsd: directResult.actualCostUsd,
    combinedCostCapUsd: PAID_COMBINED_COST_CAP_USD,
  });
  if (result.trace.aiEscalated && result.structuredOutputValid === false) {
    await writeJson(checkpointPath, { stopped: true, reason: 'final_ai_technical_failure', cases });
    throw new Error(`Final guarded AI technical failure on ${benchmarkCase.caseId}; stopped.`);
  }
  const retryCount = cases.reduce((total, item) => total + item.orchestrationRetries, 0);
  if (processedEscalations >= 20 && retryCount / processedEscalations > 0.35) {
    await writeJson(checkpointPath, {
      stopped: true,
      reason: 'material_retry_rate',
      retryCount,
      processedEscalations,
      cases,
    });
    throw new Error('Guarded retry rate materially exceeded the reviewed observed plan.');
  }
  if (processedEscalations >= 10 && actualCostUsd !== null) {
    const projectedHybridCost =
      (actualCostUsd / processedEscalations) * reviewed.casesRequiringInference;
    if (projectedHybridCost + directResult.actualCostUsd > PAID_COMBINED_COST_CAP_USD) {
      await writeJson(checkpointPath, {
        stopped: true,
        reason: 'projected_combined_cost_cap',
        projectedHybridCost,
        cases,
      });
      throw new Error('Projected combined paid cost exceeds USD 1.60; stopped.');
    }
  }
  await writeJson(checkpointPath, {
    run: HYBRID_GUARDED_MATCH_METHOD,
    completedCases: cases.length,
    processedEscalations,
    requestCount,
    usage,
    actualCostUsd,
    cases,
  });
  console.log(
    `[${index + 1}/${context.cases.length}] ${benchmarkCase.caseId}: ${prediction.predicted}; ${result.trace.aiEscalated ? 'ai' : 'deterministic'}; requests=${requestCount}; cost=${actualCostUsd?.toFixed(6) ?? 'unavailable'}`,
  );
}

const actualEscalationIds = cases
  .filter((item) => item.trace.aiEscalated)
  .map((item) => item.caseId)
  .sort();
if (JSON.stringify(actualEscalationIds) !== JSON.stringify(expectedEscalationIds)) {
  throw new Error('Final guarded-hybrid AI population differs from the reviewed population.');
}
const usage = sumUsage(allAttempts);
const actualCostUsd = calculateActualCost(usage, pricing);
const predictions = cases.map(({ evaluation: _evaluation, trace: _trace, ...item }) => item);
const analysis = metricsAndStrata(predictions);
const providerFailures = allAttempts.filter((attempt) => !attempt.apiSucceeded).length;
const invalidStructuredOutput = allAttempts.filter(
  (attempt) => attempt.apiSucceeded && !attempt.structuredOutputValid,
).length;
const retryCount = cases.reduce((total, item) => total + item.orchestrationRetries, 0);
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
    requestCap: reviewed.maximumRequestCount,
    combinedCostCapUsd: PAID_COMBINED_COST_CAP_USD,
  },
  sourceGitCommit,
  orchestration: {
    deterministicResolutions: cases.length - actualEscalationIds.length,
    nemotronEscalations: actualEscalationIds.length,
    eligibleCaseIds: actualEscalationIds,
    requestCount,
    retryCount,
  },
  usage,
  usageComplete: usage.inputTokens !== null && usage.outputTokens !== null,
  pricing,
  actualCostUsd,
  technicalFailures: {
    providerFailures,
    timeouts: allAttempts.filter((attempt) => attempt.failureKind === 'timeout').length,
    invalidStructuredOutput,
    retries: retryCount,
    exhaustedRetries: cases.filter(
      (item) => item.trace.aiEscalated && item.structuredOutputValid === false,
    ).length,
    safetyVerifierRejections: cases.filter((item) => item.trace.verifierRejectionReasons.length > 0)
      .length,
    fallbacks: cases.filter((item) => item.trace.aiTechnicalFailure !== null).length,
  },
  structuredOutput: {
    successes: allAttempts.filter((attempt) => attempt.structuredOutputValid).length,
    failures: allAttempts.filter((attempt) => !attempt.structuredOutputValid).length,
    finalSuccesses: cases.filter(
      (item) => item.trace.aiEscalated && item.structuredOutputValid === true,
    ).length,
    finalFailures: cases.filter(
      (item) => item.trace.aiEscalated && item.structuredOutputValid === false,
    ).length,
  },
  latency: {
    wallClockMs: performance.now() - runStart,
    allCases: latencySummary(cases.map((item) => item.latencyMs)),
    escalatedCases: latencySummary(
      cases.filter((item) => item.trace.aiEscalated).map((item) => item.nemotronLatencyMs),
    ),
  },
  ...analysis,
  cases,
};
await writeJson(outputPath, result);
await writeJson(checkpointPath, { complete: true, outputPath, requestCount, actualCostUsd });
console.log(
  JSON.stringify({ outputPath, requestCount, usage, actualCostUsd, metrics: result.metrics }),
);
