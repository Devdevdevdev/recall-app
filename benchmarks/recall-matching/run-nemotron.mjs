import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { NebiusClient } from '../../supabase/functions/_shared/nebius/client.ts';
import { safeNebiusEndpoint } from '../../supabase/functions/_shared/nebius/config.ts';
import { evaluateDeterministicMatch } from '../../supabase/functions/_shared/matching/deterministicMatcher.ts';
import {
  evaluateNemotronMatch,
  NEMOTRON_MAX_OUTPUT_TOKENS,
  NEMOTRON_STRUCTURED_OUTPUT_METHOD,
  NEMOTRON_TEMPERATURE,
} from '../../supabase/functions/_shared/matching/nemotronMatcher.ts';
import {
  MATCH_EVALUATION_SCHEMA_VERSION,
  NEBIUS_AI_PROVIDER,
  NEMOTRON_MATCH_METHOD,
  NEMOTRON_PROMPT_VERSION,
} from '../../supabase/functions/_shared/matching/types.ts';
import { comparePredictions, simulateHybridPolicy } from './comparison.ts';
import { asBenchmarkDataset, recallForCase } from './dataset.ts';
import { calculateBenchmarkMetrics, decisionToExpected, percentile } from './metrics.ts';
import { projectBenchmarkCaseForNemotron } from './nemotronProjection.ts';
import {
  extractPriceMetadata,
  findConfiguredModel,
  loadPhase9NebiusConfig,
} from './nebiusRuntime.mjs';

const EXPECTED_DATASET_SHA256 = 'c547d61df8e9eacc1d47d46ec505e409d88cd23795abc20cbbfb4e96f67fb3f8';
const datasetUrl = new URL('./cases.v1.json', import.meta.url);
const schemaUrl = new URL('./benchmark.schema.json', import.meta.url);
const argumentsList = process.argv.slice(2);
const outputIndex = argumentsList.indexOf('--output');
const comparisonIndex = argumentsList.indexOf('--comparison-output');
const outputPath = resolve(
  outputIndex >= 0 && argumentsList[outputIndex + 1]
    ? argumentsList[outputIndex + 1]
    : 'benchmarks/recall-matching/results/nemotron-v1.json',
);
const comparisonPath = resolve(
  comparisonIndex >= 0 && argumentsList[comparisonIndex + 1]
    ? argumentsList[comparisonIndex + 1]
    : 'benchmarks/recall-matching/results/comparison.json',
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
    throw new Error(`Refusing to overwrite existing benchmark result ${path}.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error;
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

const datasetText = await readFile(datasetUrl, 'utf8');
const datasetHash = createHash('sha256').update(datasetText).digest('hex');
if (datasetHash !== EXPECTED_DATASET_SHA256) {
  throw new Error(`Frozen benchmark dataset fingerprint mismatch: ${datasetHash}.`);
}
const rawDataset = JSON.parse(datasetText);
const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
const dataset = asBenchmarkDataset(rawDataset, schema);
const config = loadPhase9NebiusConfig();
const client = new NebiusClient(config);
const generatedAt = new Date().toISOString();

let priceMetadata = null;
try {
  const models = await client.listModels(true);
  priceMetadata = extractPriceMetadata(
    findConfiguredModel(models.body, config.modelId),
    generatedAt,
  );
} catch {
  // Pricing is optional. Inference continues only because the authenticated model preflight is a
  // separate required gate; an unavailable verbose metadata response does not invent a price.
}

const deterministicPredictions = dataset.cases.map((benchmarkCase) => {
  const evaluation = evaluateDeterministicMatch(
    benchmarkCase.ownedProduct,
    recallForCase(dataset, benchmarkCase),
  );
  return {
    caseId: benchmarkCase.caseId,
    expected: benchmarkCase.expected,
    predicted: decisionToExpected(evaluation.decision),
    decision: evaluation.decision,
    reasoningSummary: evaluation.reasoningSummary,
    matchedIdentifiers: evaluation.matchedIdentifiers,
    conflictingIdentifiers: evaluation.conflictingIdentifiers,
  };
});

const cases = [];
const predictions = [];
for (const [index, benchmarkCase] of dataset.cases.entries()) {
  const input = projectBenchmarkCaseForNemotron(dataset, benchmarkCase);
  const attempt = await evaluateNemotronMatch(input, client, config.modelId);
  const prediction = {
    caseId: benchmarkCase.caseId,
    expected: benchmarkCase.expected,
    predicted: decisionToExpected(attempt.evaluation.decision),
    decision: attempt.evaluation.decision,
    reasoningSummary: attempt.evaluation.reasoningSummary,
    matchedIdentifiers: attempt.evaluation.matchedIdentifiers,
    conflictingIdentifiers: attempt.evaluation.conflictingIdentifiers,
    technicalFailure: !attempt.structuredOutputValid,
  };
  predictions.push(prediction);
  cases.push({
    caseId: benchmarkCase.caseId,
    officialRecallExternalId: benchmarkCase.officialRecallExternalId,
    expected: benchmarkCase.expected,
    predicted: prediction.predicted,
    evaluation: attempt.evaluation,
    structuredOutputValid: attempt.structuredOutputValid,
    apiSucceeded: attempt.apiSucceeded,
    failureKind: attempt.failureKind,
    retries: attempt.retries,
    latencyMs: attempt.latencyMs,
    usage: attempt.usage,
  });
  if (!argumentsList.includes('--json')) {
    console.log(
      `[${index + 1}/${dataset.cases.length}] ${benchmarkCase.caseId}: ${prediction.predicted} (${attempt.structuredOutputValid ? 'valid' : attempt.failureKind})`,
    );
  }
}

const metrics = calculateBenchmarkMetrics(predictions);
const deterministicMetrics = calculateBenchmarkMetrics(deterministicPredictions);
const comparison = comparePredictions(deterministicPredictions, predictions);
const hybrid = simulateHybridPolicy(dataset.cases, deterministicPredictions, predictions);
const usage = cases.reduce(
  (totals, item) => ({
    inputTokens: totals.inputTokens + (item.usage.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (item.usage.outputTokens ?? 0),
    totalTokens: totals.totalTokens + (item.usage.totalTokens ?? 0),
    reasoningTokens: totals.reasoningTokens + (item.usage.reasoningTokens ?? 0),
    responsesWithUsage: totals.responsesWithUsage + (item.usage.totalTokens === null ? 0 : 1),
    responsesWithReasoningUsage:
      totals.responsesWithReasoningUsage + (item.usage.reasoningTokens === null ? 0 : 1),
  }),
  {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    responsesWithUsage: 0,
    responsesWithReasoningUsage: 0,
  },
);
const reportedUsage = {
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  totalTokens: usage.totalTokens,
  reasoningTokens: usage.responsesWithReasoningUsage ? usage.reasoningTokens : null,
  responsesWithUsage: usage.responsesWithUsage,
  responsesWithReasoningUsage: usage.responsesWithReasoningUsage,
};
const latencies = cases.map((item) => item.latencyMs);
const apiFailureCount = cases.filter((item) => !item.apiSucceeded).length;
const validStructuredResponses = cases.filter((item) => item.structuredOutputValid).length;
const retryCount = cases.reduce((sum, item) => sum + item.retries, 0);
const cost =
  priceMetadata && usage.responsesWithUsage === cases.length
    ? (usage.inputTokens * priceMetadata.inputRate +
        usage.outputTokens * priceMetadata.outputRate) /
      1_000_000
    : null;
let gitCommit = null;
try {
  gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  }).trim();
} catch {
  // Git metadata is optional; dataset identity is pinned independently by SHA-256.
}

const focusCases = Object.fromEntries(
  ['10588', '10826', '10930'].map((externalId) => {
    const item = cases.find((candidate) => candidate.officialRecallExternalId === externalId);
    return [
      externalId,
      item
        ? {
            caseId: item.caseId,
            prediction: item.predicted,
            decision: item.evaluation.decision,
            structuredOutputValid: item.structuredOutputValid,
          }
        : null,
    ];
  }),
);
const falsePositives = cases
  .filter((item) => item.expected !== 'match' && item.predicted === 'match')
  .map((item) => ({
    caseId: item.caseId,
    officialRecallExternalId: item.officialRecallExternalId,
    reasoningSummary: item.evaluation.reasoningSummary,
    matchedIdentifiers: item.evaluation.matchedIdentifiers,
    conflictingIdentifiers: item.evaluation.conflictingIdentifiers,
  }));

const result = {
  generatedAt,
  dataset: {
    version: dataset.datasetVersion,
    sha256: datasetHash,
    expectedSha256: EXPECTED_DATASET_SHA256,
    frozenAuditCommit: '50203c175be76e0cfc9dfcba845ad0bd5f20c503',
    caseCount: dataset.cases.length,
  },
  matcher: {
    version: NEMOTRON_MATCH_METHOD,
    promptVersion: NEMOTRON_PROMPT_VERSION,
    schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION,
    structuredOutputMethod: NEMOTRON_STRUCTURED_OUTPUT_METHOD,
  },
  provider: {
    name: NEBIUS_AI_PROVIDER,
    modelId: config.modelId,
    endpoint: `${safeNebiusEndpoint(config)}chat/completions`,
  },
  inference: {
    temperature: NEMOTRON_TEMPERATURE,
    maxOutputTokens: NEMOTRON_MAX_OUTPUT_TOKENS,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetriesPerCase: config.maxRetries,
    stream: false,
    primaryEvaluationsPerCase: 1,
  },
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  sourceGitCommit: gitCommit,
  metrics,
  integrity: {
    attemptedCases: cases.length,
    validStructuredResponses,
    structuredOutputSuccessRate: cases.length ? validStructuredResponses / cases.length : 0,
    apiFailureCount,
    retryCount,
    technicalFailureCases: cases
      .filter((item) => !item.structuredOutputValid)
      .map((item) => ({ caseId: item.caseId, failureKind: item.failureKind })),
  },
  latency: {
    totalDurationMs: latencies.reduce((sum, value) => sum + value, 0),
    averageMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  },
  usage: reportedUsage,
  cost: {
    amount: cost,
    pricing: priceMetadata,
    note:
      cost === null
        ? 'Unavailable: no complete, clearly interpretable live pricing and usage pair was available.'
        : 'Calculated from provider-reported token usage and live Nebius per-million-token rates.',
  },
  falsePositives,
  focusCases,
  cases,
};

const comparisonResult = {
  generatedAt,
  datasetSha256: datasetHash,
  caseCount: dataset.cases.length,
  baseline: { matcherVersion: 'deterministic_v1', metrics: deterministicMetrics },
  nemotron: {
    matcherVersion: NEMOTRON_MATCH_METHOD,
    metrics,
    structuredOutputSuccessRate: result.integrity.structuredOutputSuccessRate,
    apiFailureCount,
    retryCount,
    latency: result.latency,
    usage: reportedUsage,
    cost: result.cost,
  },
  cases: comparison,
  hybridSimulation: {
    name: 'hybrid_simulation_v1',
    policy:
      'Use deterministic_v1 when it confirms or rejects; otherwise reuse the primary nemotron_v1 evaluation.',
    metrics: hybrid.metrics,
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(comparisonPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
});
await writeFile(comparisonPath, `${JSON.stringify(comparisonResult, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
});

if (argumentsList.includes('--json')) {
  console.log(
    JSON.stringify(
      { resultPath: outputPath, comparisonPath, metrics, integrity: result.integrity },
      null,
      2,
    ),
  );
} else {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  console.log(`Nemotron accuracy: ${percent(metrics.exactThreeClassAccuracy)}`);
  console.log(
    `MATCH TP/FP/FN/TN: ${metrics.match.truePositives}/${metrics.match.falsePositives}/${metrics.match.falseNegatives}/${metrics.match.trueNegatives}`,
  );
  console.log(
    `Precision/strict recall/FPR: ${metrics.match.precision === null ? 'n/a' : percent(metrics.match.precision)}/${metrics.match.strictRecall === null ? 'n/a' : percent(metrics.match.strictRecall)}/${metrics.match.falsePositiveRate === null ? 'n/a' : percent(metrics.match.falsePositiveRate)}`,
  );
  console.log(
    `Needs review: ${metrics.needsReview.predictedCount} (${percent(metrics.needsReview.rate)}); coverage: ${percent(metrics.decisionCoverage)}`,
  );
  console.log(
    `Structured output: ${validStructuredResponses}/${cases.length}; API failures: ${apiFailureCount}; retries: ${retryCount}`,
  );
  console.log(`False positives: ${falsePositives.length}`);
  console.log(`Results written to ${outputPath} and ${comparisonPath}`);
}
