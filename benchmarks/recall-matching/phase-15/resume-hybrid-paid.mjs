import { createHash } from 'node:crypto';
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
import {
  calculateActualCost,
  enforcePaidRunGuardrails,
  projectPhase15Case,
  validateHybridContinuationCheckpoint,
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

const protectedArtifacts = {
  'benchmarks/recall-matching/phase-15/PAID_RUN_STOP_REPORT.md':
    '7aa6b2c1a5f75578b50510d4e810a043fbdc90ae34d763fb318c4d197e128578',
  'benchmarks/recall-matching/phase-15/paid-run-stop-report.json':
    'f19300e592fd881893e4993bd93c8ae7d8a42a8233e237c7ff9e1dea1338f985',
  'benchmarks/recall-matching/phase-15/results/nemotron-v1-paid.json':
    'c4166e85c81c258ff4bc4a805914b73761cf571abeb49952dd400478360c688b',
  'benchmarks/recall-matching/phase-15/results/hybrid-guarded-v1-paid.checkpoint.json':
    '62e21fe7cef7b406fad0e151d5f62c1eab5285a8904c440f3db3429308d2bd61',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function verifyProtectedArtifacts() {
  for (const [path, expected] of Object.entries(protectedArtifacts)) {
    const actual = sha256(await readFile(path));
    if (actual !== expected) throw new Error(`Protected continuation artifact changed: ${path}.`);
  }
}

const argumentsList = process.argv.slice(2);
requirePaidApproval(argumentsList);
const outputPath =
  'benchmarks/recall-matching/phase-15/results/hybrid-guarded-v1-paid-resumed.json';
const checkpointPath =
  'benchmarks/recall-matching/phase-15/results/hybrid-guarded-v1-paid-resumed.checkpoint.json';
const originalCheckpointPath =
  'benchmarks/recall-matching/phase-15/results/hybrid-guarded-v1-paid.checkpoint.json';
const directResultPath = 'benchmarks/recall-matching/phase-15/results/nemotron-v1-paid.json';
await refuseExisting(outputPath);
await verifyProtectedArtifacts();
const context = await loadPaidRunContext();
const originalCheckpoint = JSON.parse(await readFile(originalCheckpointPath, 'utf8'));
const directResult = JSON.parse(await readFile(directResultPath, 'utf8'));
if (directResult.actualCostUsd === null) throw new Error('Prior Nemotron cost is unavailable.');
const orderedBenchmarkCases = context.cases.map((item) => item.benchmarkCase);
const continuation = validateHybridContinuationCheckpoint(
  orderedBenchmarkCases,
  originalCheckpoint,
);
const remainingEntries = context.cases.slice(continuation.completedCases.length);
if (
  remainingEntries.length !== 87 ||
  remainingEntries[0]?.benchmarkCase.caseId !== 'p15-hol-29-2'
) {
  throw new Error('Authorized continuation remaining-case boundary mismatch.');
}
const reviewed = context.plan.hybrid_guarded_v1;
if (reviewed.casesRequiringInference !== 88 || reviewed.maximumRequestCount !== 176) {
  throw new Error('Reviewed guarded-hybrid request plan changed unexpectedly.');
}
const config = loadPhase9NebiusConfig({ maxRetries: 0 });
if (config.modelId !== PHASE_15_MODEL_ID || config.maxRetries !== 0) {
  throw new Error('Continuation configuration does not match the frozen policy.');
}
const client = new NebiusClient(config);
const metadataObservedAt = new Date().toISOString();
const modelResponse = await client.listModels(true);
const configuredModel = findConfiguredModel(modelResponse.body, config.modelId);
if (!configuredModel) throw new Error('The exact reviewed Nemotron model is unavailable.');
const pricing = extractPriceMetadata(configuredModel, metadataObservedAt);
if (!pricing) throw new Error('Live pricing is unavailable; refusing an unmetered continuation.');
const evaluateNemotron = createGuardedNebiusEvaluator(client, config.modelId);

const cases = structuredClone(continuation.completedCases);
const originalCompletedIds = new Set(cases.map((item) => item.caseId));
const allAttempts = cases.flatMap((item) => item.attemptHistory ?? []);
let requestCount = cases.reduce(
  (total, item) => total + (item.nemotronRequestCount ?? 0) + (item.transportRetries ?? 0),
  0,
);
let processedEscalations = cases.filter((item) => item.trace.aiEscalated).length;
const runStartedAt = new Date().toISOString();
const runStart = performance.now();
for (const [remainingIndex, { benchmarkCase, split }] of remainingEntries.entries()) {
  if (originalCompletedIds.has(benchmarkCase.caseId)) {
    throw new Error(`Refusing to rerun completed case ${benchmarkCase.caseId}.`);
  }
  const source = context.sourceByFamily.get(benchmarkCase.recallFamilyId);
  if (!source) throw new Error(`Missing source for ${benchmarkCase.caseId}.`);
  const input = projectPhase15Case(benchmarkCase, source);
  const result = await evaluateHybridGuardedMatch(input, evaluateNemotron, config.modelId);
  if (result.trace.aiEscalated) processedEscalations += 1;
  requestCount += result.nemotronRequestCount + result.transportRetries;
  allAttempts.push(...result.attemptHistory);
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
    continuationCase: true,
  });
  const usage = sumUsage(allAttempts);
  const actualHybridCostUsd = calculateActualCost(usage, pricing);
  enforcePaidRunGuardrails({
    requests: requestCount,
    requestCap: reviewed.maximumRequestCount,
    currentRunCostUsd: actualHybridCostUsd,
    priorPaidCostUsd: directResult.actualCostUsd,
    combinedCostCapUsd: PAID_COMBINED_COST_CAP_USD,
  });
  if (result.trace.aiEscalated && result.structuredOutputValid === false) {
    if (result.trace.aiTechnicalFailure !== 'schema_violation') {
      await writeJson(checkpointPath, {
        stopped: true,
        reason: 'non_schema_final_ai_technical_failure',
        cases,
      });
      throw new Error(
        `Final non-schema AI failure on ${benchmarkCase.caseId}; continuation stopped.`,
      );
    }
    if (
      result.orchestrationRetries !== HYBRID_GUARDED_MAX_ORCHESTRATION_RETRIES ||
      result.attemptHistory.length !== 2
    ) {
      throw new Error('Schema-exhausted case did not use exactly the frozen retry policy.');
    }
  }
  if (processedEscalations >= 10 && actualHybridCostUsd !== null) {
    const projectedHybridCost =
      (actualHybridCostUsd / processedEscalations) * reviewed.casesRequiringInference;
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
    continuation: true,
    originalCheckpointSha256: protectedArtifacts[originalCheckpointPath],
    completedCases: cases.length,
    newlyProcessedCases: remainingIndex + 1,
    processedEscalations,
    requestCount,
    usage,
    actualHybridCostUsd,
    cases,
  });
  console.log(
    `[resume ${remainingIndex + 1}/${remainingEntries.length}; total ${cases.length}/200] ${benchmarkCase.caseId}: ${prediction.predicted}; ${result.trace.aiEscalated ? 'ai' : 'deterministic'}; requests=${requestCount}; hybridCost=${actualHybridCostUsd?.toFixed(6) ?? 'unavailable'}`,
  );
}

const finalIds = cases.map((item) => item.caseId);
const expectedIds = orderedBenchmarkCases.map((item) => item.caseId);
if (
  cases.length !== 200 ||
  new Set(finalIds).size !== 200 ||
  JSON.stringify(finalIds) !== JSON.stringify(expectedIds)
) {
  throw new Error('Final resumed result does not contain every case exactly once in frozen order.');
}
await verifyProtectedArtifacts();
const usage = sumUsage(allAttempts);
const actualCostUsd = calculateActualCost(usage, pricing);
const predictions = cases.map(({ evaluation: _evaluation, trace: _trace, ...item }) => item);
const analysis = metricsAndStrata(predictions);
const schemaExhaustedCases = cases
  .filter(
    (item) =>
      item.trace.aiEscalated &&
      item.structuredOutputValid === false &&
      item.trace.aiTechnicalFailure === 'schema_violation',
  )
  .map((item) => item.caseId);
const providerFailures = allAttempts.filter((attempt) => !attempt.apiSucceeded).length;
const invalidStructuredOutput = allAttempts.filter(
  (attempt) => attempt.apiSucceeded && !attempt.structuredOutputValid,
).length;
const retryCount = cases.reduce((total, item) => total + (item.orchestrationRetries ?? 0), 0);
let sourceGitCommit = null;
try {
  sourceGitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // Frozen hashes are the primary reproducibility boundary.
}
const result = {
  generatedAt: new Date().toISOString(),
  runStartedAt,
  authorization: {
    initial: 'explicit_user_approval_2026-09-20',
    continuation: 'explicit_fail_closed_continuation_approval_2026-09-20',
  },
  benchmarkVersion: 'recall_safety_benchmark_v2',
  continuation: {
    originalStopCaseId: 'p15-hol-29-1',
    originalStopCaseFinalDecision: 'needs_review',
    additionalRequestMadeForOriginalStopCase: false,
    originalCompletedCaseCount: 113,
    resumedCaseCount: 87,
    firstResumedCaseId: 'p15-hol-29-2',
    protectedArtifacts,
    schemaExhaustedCases,
    policy:
      'Schema-exhausted cases remain needs_review after the one frozen retry; no prompt, schema, matcher, verifier, or retry relaxation occurred.',
  },
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
    deterministicResolutions: cases.length - processedEscalations,
    nemotronEscalations: processedEscalations,
    requestCount,
    retryCount,
  },
  usage,
  usageComplete: usage.inputTokens !== null && usage.outputTokens !== null,
  pricing,
  actualCostUsd,
  combinedPaidCostUsd: directResult.actualCostUsd + actualCostUsd,
  technicalFailures: {
    providerFailures,
    timeouts: allAttempts.filter((attempt) => attempt.failureKind === 'timeout').length,
    invalidStructuredOutput,
    retries: retryCount,
    exhaustedRetries: schemaExhaustedCases.length,
    schemaExhaustedCases,
    safetyVerifierRejections: cases.filter((item) => item.trace.verifierRejectionReasons.length > 0)
      .length,
    fallbacks: cases.filter((item) => item.trace.aiTechnicalFailure !== null).length,
  },
  structuredOutput: {
    attemptSuccesses: allAttempts.filter((attempt) => attempt.structuredOutputValid).length,
    attemptFailures: allAttempts.filter((attempt) => !attempt.structuredOutputValid).length,
    finalSuccesses: cases.filter(
      (item) => item.trace.aiEscalated && item.structuredOutputValid === true,
    ).length,
    finalFailures: schemaExhaustedCases.length,
  },
  latency: {
    continuationWallClockMs: performance.now() - runStart,
    allCases: latencySummary(cases.map((item) => item.latencyMs)),
    escalatedCases: latencySummary(
      cases.filter((item) => item.trace.aiEscalated).map((item) => item.nemotronLatencyMs),
    ),
    attempts: latencySummary(allAttempts.map((attempt) => attempt.latencyMs)),
  },
  ...analysis,
  cases,
};
await writeJson(outputPath, result);
await writeJson(checkpointPath, {
  complete: true,
  outputPath,
  originalCheckpointSha256: protectedArtifacts[originalCheckpointPath],
  requestCount,
  actualCostUsd,
  combinedPaidCostUsd: result.combinedPaidCostUsd,
  schemaExhaustedCases,
});
await verifyProtectedArtifacts();
console.log(
  JSON.stringify({
    outputPath,
    requestCount,
    retryCount,
    schemaExhaustedCases,
    usage,
    actualCostUsd,
    combinedPaidCostUsd: result.combinedPaidCostUsd,
    metrics: result.metrics,
  }),
);
