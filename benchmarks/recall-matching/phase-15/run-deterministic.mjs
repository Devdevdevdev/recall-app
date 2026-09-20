import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { evaluateDeterministicMatch } from '../../../supabase/functions/_shared/matching/deterministicMatcher.ts';
import {
  DETERMINISTIC_MATCH_METHOD,
  MATCH_EVALUATION_SCHEMA_VERSION,
} from '../../../supabase/functions/_shared/matching/types.ts';
import { decisionToExpected, percentile } from '../metrics.ts';
import { calculatePhase15Metrics, validatePhase15Split } from './dataset.ts';

const loadText = (name) => readFile(new URL(name, import.meta.url), 'utf8');
const load = async (name) => JSON.parse(await loadText(name));
const schema = await load('./benchmark.schema.json');
const sources = await load('./sources.normalized.json');
const sourceByFamily = new Map(sources.sources.map((source) => [source.recallFamilyId, source]));
const splitNames = ['development', 'holdout', 'stress'];
const datasets = Object.fromEntries(
  await Promise.all(splitNames.map(async (name) => [name, await load(`./${name}.v2.json`)])),
);

function officialRecall(source) {
  return {
    recallNoticeId: source.sourceKey,
    source: {
      authority: source.authority,
      externalId: source.externalRecallId,
      officialUrl: source.officialUrl,
      retrievedAt: source.referenceDate,
    },
    title: source.title,
    description: source.productName,
    hazard: null,
    remedy: null,
    recallDate: source.recallDate,
    scopes: source.matcherScopes,
    rawEvidence: {
      controlledScopeRules: source.scopeRules,
      evidenceSummary: source.scopeEvidence.summary,
    },
  };
}

function stratify(predictions, field) {
  const keys = new Set(
    predictions.flatMap((item) => {
      const value = item[field];
      return Array.isArray(value) ? value : value ? [value] : [];
    }),
  );
  return Object.fromEntries(
    [...keys]
      .sort()
      .map((key) => [
        key,
        calculatePhase15Metrics(
          predictions.filter((item) =>
            Array.isArray(item[field]) ? item[field].includes(key) : item[field] === key,
          ),
        ),
      ]),
  );
}

const allPredictions = [];
const resultDirectory = new URL('./results/', import.meta.url);
await mkdir(resultDirectory, { recursive: true });
let gitCommit = null;
try {
  gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('../../../', import.meta.url),
    encoding: 'utf8',
  }).trim();
} catch {
  // The frozen artifact hashes remain the reproducibility boundary.
}

for (const split of splitNames) {
  const dataset = datasets[split];
  const errors = validatePhase15Split(dataset, schema, sources, split);
  if (errors.length) throw new Error(errors.join('\n'));
  const datasetText = await loadText(`./${split}.v2.json`);
  const startedAt = performance.now();
  const predictions = dataset.cases.map((benchmarkCase) => {
    const source = sourceByFamily.get(benchmarkCase.recallFamilyId);
    const evaluation = evaluateDeterministicMatch(
      benchmarkCase.ownedProduct,
      officialRecall(source),
    );
    return {
      caseId: benchmarkCase.caseId,
      recallFamilyId: benchmarkCase.recallFamilyId,
      pairGroupId: benchmarkCase.pairGroupId,
      authority: benchmarkCase.authority,
      split,
      evidenceDimensions: benchmarkCase.evidenceDimensions,
      perturbationType: benchmarkCase.perturbationType,
      expected: benchmarkCase.expected,
      predicted: decisionToExpected(evaluation.decision),
      technicalFailure: false,
      evaluation,
    };
  });
  const totalDurationMs = performance.now() - startedAt;
  const latencySamplesMs = [];
  for (let iteration = 0; iteration < 30; iteration += 1) {
    for (const benchmarkCase of dataset.cases) {
      const source = sourceByFamily.get(benchmarkCase.recallFamilyId);
      const start = performance.now();
      evaluateDeterministicMatch(benchmarkCase.ownedProduct, officialRecall(source));
      latencySamplesMs.push(performance.now() - start);
    }
  }
  const result = {
    generatedAt: new Date().toISOString(),
    benchmarkVersion: dataset.benchmarkVersion,
    dataset: {
      split,
      sha256: createHash('sha256').update(datasetText).digest('hex'),
      caseCount: dataset.cases.length,
      recallFamilyCount: new Set(dataset.cases.map((item) => item.recallFamilyId)).size,
    },
    matcher: {
      version: DETERMINISTIC_MATCH_METHOD,
      schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION,
    },
    sourceGitCommit: gitCommit,
    ai: { calls: 0, retries: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    technicalFailures: {
      providerFailures: 0,
      timeouts: 0,
      invalidStructuredOutput: 0,
      retries: 0,
      exhaustedRetries: 0,
      safetyVerifierRejections: 0,
      fallbacks: 0,
    },
    metrics: calculatePhase15Metrics(predictions),
    stratified: {
      evidenceCategory: stratify(predictions, 'evidenceDimensions'),
      sourceAuthority: stratify(predictions, 'authority'),
      split: stratify(predictions, 'split'),
      perturbationFamily: stratify(predictions, 'perturbationType'),
    },
    latency: {
      totalBenchmarkDurationMs: totalDurationMs,
      averageEvaluationMs:
        latencySamplesMs.reduce((sum, value) => sum + value, 0) / latencySamplesMs.length,
      p50EvaluationMs: percentile(latencySamplesMs, 0.5),
      p95EvaluationMs: percentile(latencySamplesMs, 0.95),
      sampleCount: latencySamplesMs.length,
    },
    cases: predictions,
  };
  allPredictions.push(...predictions);
  await writeFile(
    new URL(`./results/deterministic-v1-${split}.json`, import.meta.url),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

const aggregate = {
  generatedAt: new Date().toISOString(),
  benchmarkVersion: 'recall_safety_benchmark_v2',
  matcher: { version: DETERMINISTIC_MATCH_METHOD, schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION },
  sourceGitCommit: gitCommit,
  ai: { calls: 0, retries: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  technicalFailures: {
    providerFailures: 0,
    timeouts: 0,
    invalidStructuredOutput: 0,
    retries: 0,
    exhaustedRetries: 0,
    safetyVerifierRejections: 0,
    fallbacks: 0,
  },
  metrics: calculatePhase15Metrics(allPredictions),
  stratified: {
    evidenceCategory: stratify(allPredictions, 'evidenceDimensions'),
    sourceAuthority: stratify(allPredictions, 'authority'),
    split: stratify(allPredictions, 'split'),
    perturbationFamily: stratify(allPredictions, 'perturbationType'),
  },
  cases: allPredictions,
};
await writeFile(
  new URL('./results/deterministic-v1-all.json', import.meta.url),
  `${JSON.stringify(aggregate, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      matcher: DETERMINISTIC_MATCH_METHOD,
      metrics: aggregate.metrics,
      splitMetrics: Object.fromEntries(
        splitNames.map((split) => [
          split,
          calculatePhase15Metrics(allPredictions.filter((item) => item.split === split)),
        ]),
      ),
    },
    null,
    2,
  ),
);
