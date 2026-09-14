import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { evaluateDeterministicMatch } from '../../supabase/functions/_shared/matching/deterministicMatcher.ts';
import {
  DETERMINISTIC_MATCH_METHOD,
  MATCH_EVALUATION_SCHEMA_VERSION,
} from '../../supabase/functions/_shared/matching/types.ts';
import { asBenchmarkDataset, recallForCase } from './dataset.ts';
import { calculateBenchmarkMetrics, decisionToExpected, percentile } from './metrics.ts';

const datasetUrl = new URL('./cases.v1.json', import.meta.url);
const schemaUrl = new URL('./benchmark.schema.json', import.meta.url);
const rawDataset = JSON.parse(await readFile(datasetUrl, 'utf8'));
const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
const dataset = asBenchmarkDataset(rawDataset, schema);
const startedAt = performance.now();
const predictions = dataset.cases.map((benchmarkCase) => {
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
const totalDurationMs = performance.now() - startedAt;

const latencySamplesMs = [];
const latencyIterations = 200;
for (let iteration = 0; iteration < latencyIterations; iteration += 1) {
  for (const benchmarkCase of dataset.cases) {
    const start = performance.now();
    evaluateDeterministicMatch(benchmarkCase.ownedProduct, recallForCase(dataset, benchmarkCase));
    latencySamplesMs.push(performance.now() - start);
  }
}

const metrics = calculateBenchmarkMetrics(predictions);
const failures = predictions.filter((prediction) => prediction.expected !== prediction.predicted);
const abstentions = predictions.filter((prediction) => prediction.predicted === 'needs_review');
let gitCommit = null;
try {
  gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  }).trim();
} catch {
  // Git metadata is optional in machine-readable output.
}

const result = {
  generatedAt: new Date().toISOString(),
  datasetVersion: dataset.datasetVersion,
  sourceRetrievalDate: dataset.sourceRetrievalDate,
  matcherVersion: DETERMINISTIC_MATCH_METHOD,
  schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION,
  gitCommit,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  ai: { calls: 0, cost: 0, currency: 'USD' },
  metrics,
  latency: {
    totalBenchmarkDurationMs: totalDurationMs,
    averageEvaluationMs:
      latencySamplesMs.reduce((sum, value) => sum + value, 0) / latencySamplesMs.length,
    p50EvaluationMs: percentile(latencySamplesMs, 0.5),
    p95EvaluationMs: percentile(latencySamplesMs, 0.95),
    sampleCount: latencySamplesMs.length,
    timer: 'performance.now; sub-millisecond values are environment-dependent',
  },
  failures,
  abstentions,
};

const argumentsList = process.argv.slice(2);
const outputIndex = argumentsList.indexOf('--output');
const outputPath = outputIndex >= 0 ? argumentsList[outputIndex + 1] : null;
if (outputIndex >= 0 && !outputPath) {
  throw new Error('--output requires a path.');
}
if (outputPath) {
  const absolutePath = resolve(outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

if (argumentsList.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  console.log(`Recall matching baseline: ${DETERMINISTIC_MATCH_METHOD}`);
  console.log(`Dataset v${dataset.datasetVersion}: ${metrics.totalCases} cases`);
  console.log(`3-class accuracy: ${percent(metrics.exactThreeClassAccuracy)}`);
  console.log(
    `MATCH TP/FP/FN/TN: ${metrics.match.truePositives}/${metrics.match.falsePositives}/${metrics.match.falseNegatives}/${metrics.match.trueNegatives}`,
  );
  console.log(
    `MATCH precision: ${metrics.match.precision === null ? 'n/a' : percent(metrics.match.precision)} | strict recall: ${metrics.match.strictRecall === null ? 'n/a' : percent(metrics.match.strictRecall)} | false-positive rate: ${metrics.match.falsePositiveRate === null ? 'n/a' : percent(metrics.match.falsePositiveRate)}`,
  );
  console.log(
    `Needs review: ${metrics.needsReview.predictedCount} (${percent(metrics.needsReview.rate)}) | decision coverage: ${percent(metrics.decisionCoverage)}`,
  );
  console.log('Confusion matrix rows=expected, columns=predicted [match, no_match, needs_review]');
  for (const label of ['match', 'no_match', 'needs_review']) {
    const row = metrics.confusionMatrix[label];
    console.log(`${label}: [${row.match}, ${row.no_match}, ${row.needs_review}]`);
  }
  console.log(
    `Latency ms avg/p50/p95: ${result.latency.averageEvaluationMs.toFixed(4)}/${result.latency.p50EvaluationMs.toFixed(4)}/${result.latency.p95EvaluationMs.toFixed(4)} (${result.latency.sampleCount} samples)`,
  );
  console.log(`AI calls/cost: 0 / USD 0`);
  console.log(`Failures: ${failures.length}`);
  for (const failure of failures) {
    console.log(
      `- ${failure.caseId}: expected=${failure.expected} predicted=${failure.predicted}; ${failure.reasoningSummary}`,
    );
    console.log(`  matched=${JSON.stringify(failure.matchedIdentifiers)}`);
    console.log(`  conflicting=${JSON.stringify(failure.conflictingIdentifiers)}`);
  }
  console.log(`Abstentions: ${abstentions.length}`);
  for (const abstention of abstentions) {
    console.log(
      `- ${abstention.caseId}: expected=${abstention.expected}; ${abstention.reasoningSummary}`,
    );
    console.log(`  matched=${JSON.stringify(abstention.matchedIdentifiers)}`);
    console.log(`  conflicting=${JSON.stringify(abstention.conflictingIdentifiers)}`);
  }
  if (outputPath) {
    console.log(`Machine-readable result written to ${resolve(outputPath)}`);
  }
}
