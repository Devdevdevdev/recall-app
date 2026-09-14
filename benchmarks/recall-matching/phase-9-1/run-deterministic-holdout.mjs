import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { evaluateDeterministicMatch } from '../../../supabase/functions/_shared/matching/deterministicMatcher.ts';
import { calculateBenchmarkMetrics, decisionToExpected, percentile } from '../metrics.ts';
import { recallForCase } from '../dataset.ts';
import { asPhase91Dataset } from './dataset.ts';
import { verifyPhase91Freeze } from './freezeGuard.mjs';

const manifest = await verifyPhase91Freeze();
const outputPath = resolve(
  process.argv[2] ?? 'benchmarks/recall-matching/phase-9-1/results/deterministic-holdout-v1.json',
);
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

const startedAt = performance.now();
const cases = dataset.cases.map((benchmarkCase) => {
  const caseStartedAt = performance.now();
  const evaluation = evaluateDeterministicMatch(
    benchmarkCase.ownedProduct,
    recallForCase(dataset, benchmarkCase),
  );
  return {
    caseId: benchmarkCase.caseId,
    officialRecallExternalId: benchmarkCase.officialRecallExternalId,
    expected: benchmarkCase.expected,
    predicted: decisionToExpected(evaluation.decision),
    evaluation,
    latencyMs: performance.now() - caseStartedAt,
  };
});
const predictions = cases.map((item) => ({
  caseId: item.caseId,
  expected: item.expected,
  predicted: item.predicted,
  decision: item.evaluation.decision,
  reasoningSummary: item.evaluation.reasoningSummary,
  matchedIdentifiers: item.evaluation.matchedIdentifiers,
  conflictingIdentifiers: item.evaluation.conflictingIdentifiers,
}));
const latencies = cases.map((item) => item.latencyMs);
let sourceGitCommit = null;
try {
  sourceGitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('../../../', import.meta.url),
    encoding: 'utf8',
  }).trim();
} catch {
  // The frozen manifest is the primary reproducibility boundary.
}
const result = {
  generatedAt: new Date().toISOString(),
  dataset: {
    name: 'phase_9_1_independent_holdout_v1',
    sha256: manifest.holdout.sha256,
    caseCount: dataset.cases.length,
    sourceCount: dataset.recalls.length,
  },
  matcher: { version: 'deterministic_v1', schemaVersion: '1.0.0' },
  sourceGitCommit,
  metrics: calculateBenchmarkMetrics(predictions),
  orchestration: {
    deterministicResolutions: cases.filter((item) => item.predicted !== 'needs_review').length,
    nemotronEscalations: 0,
  },
  latency: {
    totalMs: performance.now() - startedAt,
    averageMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  },
  cases,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(
  JSON.stringify({
    outputPath,
    metrics: result.metrics,
    deterministicResolutions: result.orchestration.deterministicResolutions,
    expectedHybridEscalations: cases.length - result.orchestration.deterministicResolutions,
  }),
);
