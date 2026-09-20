import { readFile, writeFile } from 'node:fs/promises';

import { calculateActualCost } from './paidRun.ts';
import { latencySummary, metricsAndStrata, sumUsage } from './paidRuntime.mjs';

const load = async (path) => JSON.parse(await readFile(path, 'utf8'));
const deterministic = await load(
  'benchmarks/recall-matching/phase-15/results/deterministic-v1-all.json',
);
const nemotron = await load('benchmarks/recall-matching/phase-15/results/nemotron-v1-paid.json');
const hybridCheckpoint = await load(
  'benchmarks/recall-matching/phase-15/results/hybrid-guarded-v1-paid.checkpoint.json',
);
const manifest = await load('benchmarks/recall-matching/phase-15/freeze-manifest.json');
const hybridCases = hybridCheckpoint.cases;
const hybridPredictions = hybridCases.map(
  ({ evaluation: _evaluation, trace: _trace, ...item }) => item,
);
const hybridAnalysis = metricsAndStrata(hybridPredictions);
const hybridAttempts = hybridCases.flatMap((item) => item.attemptHistory ?? []);
const hybridUsage = sumUsage(hybridAttempts);
const hybridPartialCostUsd = calculateActualCost(hybridUsage, nemotron.pricing);
const hybridRequestCount = hybridCases.reduce(
  (total, item) => total + (item.nemotronRequestCount ?? 0) + (item.transportRetries ?? 0),
  0,
);
const hybridRetryCount = hybridCases.reduce(
  (total, item) => total + (item.orchestrationRetries ?? 0),
  0,
);

function evidenceSummary(item) {
  return (item.evaluation?.evidenceUsed ?? []).map((entry) => ({
    kind: entry.kind,
    outcome: entry.outcome,
    strength: entry.strength,
    ownedValue: entry.ownedValue ?? null,
    officialValue: entry.officialValue ?? null,
    detail: entry.detail,
  }));
}

function failureReason(item) {
  if (item.expected === 'no_match' && item.predicted === 'match')
    return 'The unchanged production-shaped projection omitted the Phase 15 extended attribute carrying the contradiction; the model confirmed from the visible identifier alone.';
  if (item.expected === 'needs_review' && item.predicted === 'match')
    return 'The unchanged production-shaped projection omitted the required Phase 15 extended attribute state; the model confirmed from the visible identifier instead of abstaining.';
  if (item.expected === 'match' && item.predicted === 'no_match')
    return 'Rejected a controlled product that satisfies every authoritative scope condition.';
  return 'The unchanged production-shaped projection omitted the Phase 15 extended attribute that satisfied the scope; the model therefore abstained on an otherwise affected product.';
}

function safetyCases(cases) {
  const detail = (item) => ({
    caseId: item.caseId,
    recallFamily: item.recallFamilyId,
    split: item.split,
    expected: item.expected,
    producedDecision: item.decision,
    predicted: item.predicted,
    evidenceUsed: evidenceSummary(item),
    modelReasoning: item.reasoningSummary,
    exactFailureReason: failureReason(item),
  });
  return {
    unsafeConfirmations: cases
      .filter((item) => item.expected !== 'match' && item.predicted === 'match')
      .map(detail),
    missedAffected: cases
      .filter((item) => item.expected === 'match' && item.predicted !== 'match')
      .map((item) => ({
        ...detail(item),
        disposition: item.predicted === 'no_match' ? 'rejected' : 'abstained_needs_review',
      })),
  };
}

function splitOperational(cases, pricing, requestField) {
  return Object.fromEntries(
    ['development', 'holdout', 'stress'].map((split) => {
      const selected = cases.filter((item) => item.split === split);
      const usage = selected.length
        ? sumUsage(selected.map((item) => ({ usage: item.usage })))
        : { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 };
      const aiSelected = selected.filter((item) => item.structuredOutputValid !== null);
      return [
        split,
        {
          processedCases: selected.length,
          requestCount: selected.reduce((total, item) => total + (item[requestField] ?? 0), 0),
          structuredOutputSuccesses: aiSelected.filter(
            (item) => item.structuredOutputValid === true,
          ).length,
          structuredOutputFailures: aiSelected.filter(
            (item) => item.structuredOutputValid === false,
          ).length,
          retryCount: selected.reduce(
            (total, item) =>
              total + (item.transportRetries ?? 0) + (item.orchestrationRetries ?? 0),
            0,
          ),
          providerFailures: selected.filter(
            (item) =>
              item.trace?.aiTechnicalFailure &&
              item.trace.aiTechnicalFailure !== 'schema_violation',
          ).length,
          latency: latencySummary(selected.map((item) => item.latencyMs)),
          usage,
          actualCostUsd: calculateActualCost(usage, pricing),
        },
      ];
    }),
  );
}

const lastHybridCase = hybridCases.at(-1);
const report = {
  generatedAt: new Date().toISOString(),
  reviewGate: 'phase_15_paid_run_stopped_on_guarded_schema_failure',
  devpostClaimStatus: 'blocked_do_not_publish_phase_15_comparison',
  frozenIntegrity: {
    phase15Artifacts: manifest.phase15Artifacts,
    promptPolicyArtifacts: manifest.promptPolicyArtifacts,
    historicalArtifactCount: Object.keys(manifest.historicalArtifacts).length,
  },
  cost: {
    nemotronActualUsd: nemotron.actualCostUsd,
    hybridPartialActualUsd: hybridPartialCostUsd,
    combinedObservedUsd: nemotron.actualCostUsd + hybridPartialCostUsd,
    absoluteCapUsd: 1.6,
  },
  deterministic_v1: {
    status: 'complete_200_of_200',
    metrics: deterministic.metrics,
    bySplit: deterministic.stratified.split,
    stratified: deterministic.stratified,
    ai: deterministic.ai,
    technicalFailures: deterministic.technicalFailures,
  },
  nemotron_v1: {
    status: 'complete_200_of_200',
    metrics: nemotron.metrics,
    bySplit: nemotron.bySplit,
    stratified: nemotron.stratified,
    requestCount: nemotron.requestCount,
    structuredOutput: nemotron.structuredOutput,
    technicalFailures: nemotron.technicalFailures,
    latency: nemotron.latency,
    usage: nemotron.usage,
    actualCostUsd: nemotron.actualCostUsd,
    bySplitOperational: splitOperational(nemotron.cases, nemotron.pricing, 'requestCount'),
    safetyCases: safetyCases(nemotron.cases),
  },
  hybrid_guarded_v1: {
    status: 'stopped_partial_113_of_200',
    comparability: 'Partial results are not comparable to the two complete 200-case systems.',
    stop: {
      caseId: lastHybridCase.caseId,
      recallFamily: lastHybridCase.recallFamilyId,
      split: lastHybridCase.split,
      failureKind: lastHybridCase.trace.aiTechnicalFailure,
      attempts: lastHybridCase.attemptHistory,
      reason:
        'Both allowed guarded attempts returned schema-invalid structured output. Validation was not relaxed and the run stopped.',
    },
    processedCases: hybridCases.length,
    deterministicResolutionsProcessed: hybridCases.filter((item) => !item.trace.aiEscalated).length,
    escalationsProcessed: hybridCases.filter((item) => item.trace.aiEscalated).length,
    requestCount: hybridRequestCount,
    retryCount: hybridRetryCount,
    usage: hybridUsage,
    actualCostUsd: hybridPartialCostUsd,
    metricsOnProcessedPrefixOnly: hybridAnalysis.metrics,
    bySplitOnProcessedPrefixOnly: hybridAnalysis.bySplit,
    stratifiedOnProcessedPrefixOnly: hybridAnalysis.stratified,
    bySplitOperational: splitOperational(hybridCases, nemotron.pricing, 'nemotronRequestCount'),
    safetyCasesOnProcessedPrefixOnly: safetyCases(hybridCases),
  },
};
await writeFile(
  'benchmarks/recall-matching/phase-15/paid-run-stop-report.json',
  `${JSON.stringify(report, null, 2)}\n`,
);

const percent = (value) =>
  value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const row = (name, system) =>
  `| ${name} | ${system.metrics.totalCases} | ${percent(system.metrics.exactThreeClassAccuracy)} | ${system.metrics.safety.unsafeConfirmations} | ${percent(system.metrics.match.precision)} | ${percent(system.metrics.match.strictRecall)} | ${percent(system.metrics.needsReview.rate)} | ${percent(system.metrics.decisionCoverage)} | ${percent(system.metrics.safety.pairwiseDiscrimination)} |`;
const unsafeMarkdown = report.nemotron_v1.safetyCases.unsafeConfirmations
  .map(
    (item) =>
      `- **${item.caseId}** (${item.recallFamily}, expected ${item.expected}, produced ${item.producedDecision}): ${item.exactFailureReason} Model reasoning: ${item.modelReasoning}`,
  )
  .join('\n');
const missedMarkdown = report.nemotron_v1.safetyCases.missedAffected
  .map(
    (item) =>
      `- **${item.caseId}** (${item.recallFamily}, ${item.disposition}): ${item.exactFailureReason} Model reasoning: ${item.modelReasoning}`,
  )
  .join('\n');
const markdown = `# Phase 15 paid-run stop report

> **STOPPED AT THE RESULTS REVIEW GATE. Do not publish a three-system Phase 15 comparison.** Nemotron v1 completed, but guarded hybrid stopped safely after both permitted attempts for one case failed the strict schema.

## Run status

- deterministic_v1: complete, 200/200 cases.
- nemotron_v1: complete, 200/200 cases; 200 requests; zero retries, provider failures, or structured-output failures.
- hybrid_guarded_v1: **partial, 113/200 cases**; 40 escalations; 41 requests; one allowed retry; stopped on two consecutive schema violations for \`p15-hol-29-1\`.
- Cost: Nemotron USD ${nemotron.actualCostUsd.toFixed(6)} + partial hybrid USD ${hybridPartialCostUsd.toFixed(6)} = USD ${(nemotron.actualCostUsd + hybridPartialCostUsd).toFixed(6)}, below the USD 1.60 cap.

## Complete-system measurements

| System | Cases | Accuracy | Unsafe confirmations | Precision | Strict recall | Needs review | Coverage | Pairwise discrimination |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${row('deterministic_v1', report.deterministic_v1)}
${row('nemotron_v1', report.nemotron_v1)}

No full guarded-hybrid row is shown because its run did not complete. Its prefix metrics in the JSON artifact are diagnostic only and not comparable.

## Nemotron safety failures

### Unsafe confirmations (${report.nemotron_v1.safetyCases.unsafeConfirmations.length})

${unsafeMarkdown}

### Missed affected cases (${report.nemotron_v1.safetyCases.missedAffected.length})

All were abstentions; none were rejected.

${missedMarkdown}

## Guarded-hybrid stop

Case \`p15-hol-29-1\` expected MATCH. deterministic_v1 abstained and correctly escalated. Both allowed Nemotron attempts reached the provider but returned schema-invalid output. Each attempt used 2,140 input and 1,242 output tokens and took about 22.8 seconds. The second failure exhausted the one orchestration retry. Validation, eligibility, and retry limits were not relaxed.

The partial prefix contains ${report.hybrid_guarded_v1.safetyCasesOnProcessedPrefixOnly.unsafeConfirmations.length} unsafe confirmations and ${report.hybrid_guarded_v1.safetyCasesOnProcessedPrefixOnly.missedAffected.length} missed affected cases, but these figures must not be compared with complete 200-case results.

## Interpretation boundary

The completed measurements show trade-offs between deterministic_v1 and standalone nemotron_v1. They do not establish a completed Phase 15 result for hybrid_guarded_v1, do not support a subjective winner, and must not be converted into Devpost claims. A future continuation would require explicit authorization and a defined policy for resuming after the recorded technical failure; no such continuation occurred here.
`;
await writeFile('benchmarks/recall-matching/phase-15/PAID_RUN_STOP_REPORT.md', markdown);
console.log(
  JSON.stringify({ json: 'paid-run-stop-report.json', markdown: 'PAID_RUN_STOP_REPORT.md' }),
);
