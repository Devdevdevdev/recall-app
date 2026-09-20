import { readFile, writeFile } from 'node:fs/promises';

import { calculatePhase15Metrics } from './dataset.ts';
import { calculateActualCost } from './paidRun.ts';
import { latencySummary, metricsAndStrata, sumUsage } from './paidRuntime.mjs';

const load = async (path) => JSON.parse(await readFile(path, 'utf8'));
const deterministic = await load(
  'benchmarks/recall-matching/phase-15/results/deterministic-v1-all.json',
);
const nemotron = await load('benchmarks/recall-matching/phase-15/results/nemotron-v1-paid.json');
const hybrid = await load(
  'benchmarks/recall-matching/phase-15/results/hybrid-guarded-v1-paid-resumed.json',
);
const manifest = await load('benchmarks/recall-matching/phase-15/freeze-manifest.json');
const deterministicSplitResults = Object.fromEntries(
  await Promise.all(
    ['development', 'holdout', 'stress'].map(async (split) => [
      split,
      await load(`benchmarks/recall-matching/phase-15/results/deterministic-v1-${split}.json`),
    ]),
  ),
);
const datasets = await Promise.all(
  ['development', 'holdout', 'stress'].map((split) =>
    load(`benchmarks/recall-matching/phase-15/${split}.v2.json`),
  ),
);
const benchmarkCaseById = new Map(
  datasets.flatMap((dataset) => dataset.cases).map((item) => [item.caseId, item]),
);
const deterministicPredictions = deterministic.cases.map((item) => ({
  ...item,
  hardNegative: benchmarkCaseById.get(item.caseId)?.hardNegative ?? false,
}));
const deterministicAnalysis = metricsAndStrata(deterministicPredictions);

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

function hybridFailureMechanism(item) {
  if (!item.trace.aiEscalated) return 'deterministic_confirmation_bypassed_ai_guard';
  if (item.structuredOutputValid === false) return 'schema_exhausted_fail_closed';
  if (item.trace.verifierRejectionReasons.length)
    return 'ai_confirmation_rejected_by_local_verifier';
  return 'ai_remained_unresolved';
}

function hybridSafetyCases(cases) {
  const describe = (item) => ({
    caseId: item.caseId,
    recallFamily: item.recallFamilyId,
    split: item.split,
    expected: item.expected,
    producedDecision: item.decision,
    deterministicDecision: item.trace.deterministicDecision,
    aiInvoked: item.trace.aiEscalated,
    evidence: evidenceSummary(item),
    aiDecision: item.trace.aiDecision,
    verifier: {
      confirmedEvidence: item.trace.verifierConfirmedEvidence,
      rejectionReasons: item.trace.verifierRejectionReasons,
    },
    technicalFailure: item.trace.aiTechnicalFailure,
    failureMechanism: hybridFailureMechanism(item),
  });
  return {
    unsafeConfirmations: cases
      .filter((item) => item.expected !== 'match' && item.predicted === 'match')
      .map(describe),
    missedAffected: cases
      .filter((item) => item.expected === 'match' && item.predicted !== 'match')
      .map((item) => ({
        ...describe(item),
        disposition: item.predicted === 'no_match' ? 'rejected' : 'needs_review_abstained',
      })),
  };
}

function operationalBySplit(cases, pricing, requestField) {
  return Object.fromEntries(
    ['development', 'holdout', 'stress'].map((split) => {
      const selected = cases.filter((item) => item.split === split);
      const attempts = selected.flatMap(
        (item) =>
          item.attemptHistory ??
          (item.usage
            ? [
                {
                  usage: item.usage,
                  latencyMs: item.latencyMs,
                  structuredOutputValid: item.structuredOutputValid,
                  apiSucceeded: item.apiSucceeded,
                  failureKind: item.failureKind,
                },
              ]
            : []),
      );
      const usage = attempts.length
        ? sumUsage(attempts)
        : { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 };
      return [
        split,
        {
          cases: selected.length,
          requests: selected.reduce(
            (total, item) =>
              total +
              (item[requestField] ?? 0) +
              (requestField === 'nemotronRequestCount' ? (item.transportRetries ?? 0) : 0),
            0,
          ),
          attemptStructuredSuccesses: attempts.filter((item) => item.structuredOutputValid).length,
          attemptStructuredFailures: attempts.filter((item) => item.structuredOutputValid === false)
            .length,
          retries: selected.reduce(
            (total, item) => total + (item.orchestrationRetries ?? item.transportRetries ?? 0),
            0,
          ),
          providerFailures: attempts.filter((item) => item.apiSucceeded === false).length,
          latency: latencySummary(selected.map((item) => item.latencyMs)),
          usage,
          actualCostUsd: calculateActualCost(usage, pricing),
        },
      ];
    }),
  );
}

const hybridSafety = hybridSafetyCases(hybrid.cases);
const deterministicOperationalBySplit = Object.fromEntries(
  Object.entries(deterministicSplitResults).map(([split, result]) => [
    split,
    {
      cases: result.dataset.caseCount,
      requests: 0,
      retries: 0,
      latency: result.latency,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 },
      actualCostUsd: 0,
    },
  ]),
);
const finalReport = {
  generatedAt: new Date().toISOString(),
  reviewGate: 'completed_phase_15_results_review',
  claimBoundary:
    'Controlled internal CPSC-backed safety evaluation; not representative of all real-world recalls.',
  continuationHistory: hybrid.continuation,
  integrity: {
    phase15Artifacts: manifest.phase15Artifacts,
    promptPolicyArtifacts: manifest.promptPolicyArtifacts,
    historicalArtifactCount: Object.keys(manifest.historicalArtifacts).length,
  },
  systems: {
    deterministic_v1: {
      metrics: deterministic.metrics,
      bySplit: deterministicAnalysis.bySplit,
      stratified: deterministicAnalysis.stratified,
      ai: deterministic.ai,
      technicalFailures: deterministic.technicalFailures,
      operationalBySplit: deterministicOperationalBySplit,
    },
    nemotron_v1: {
      metrics: nemotron.metrics,
      bySplit: nemotron.bySplit,
      stratified: nemotron.stratified,
      requests: nemotron.requestCount,
      structuredOutput: nemotron.structuredOutput,
      technicalFailures: nemotron.technicalFailures,
      latency: nemotron.latency,
      usage: nemotron.usage,
      actualCostUsd: nemotron.actualCostUsd,
      operationalBySplit: operationalBySplit(nemotron.cases, nemotron.pricing, 'requestCount'),
    },
    hybrid_guarded_v1: {
      metrics: hybrid.metrics,
      bySplit: hybrid.bySplit,
      stratified: hybrid.stratified,
      orchestration: hybrid.orchestration,
      structuredOutput: hybrid.structuredOutput,
      technicalFailures: hybrid.technicalFailures,
      latency: hybrid.latency,
      usage: hybrid.usage,
      actualCostUsd: hybrid.actualCostUsd,
      combinedPaidCostUsd: hybrid.combinedPaidCostUsd,
      operationalBySplit: operationalBySplit(hybrid.cases, hybrid.pricing, 'nemotronRequestCount'),
      safetyCases: hybridSafety,
    },
  },
  architectureFinding: {
    summary:
      'Several Benchmark 2.0 evidence dimensions are not representable in the current production-shaped OwnedProductEvidence projection.',
    affectedDimensions: [
      'size',
      'color',
      'charging-port type',
      'screw state',
      'battery model',
      'date-code prefix',
      'manufacture date',
      'production date',
    ],
    consequence:
      'The frozen systems often saw a matching model but not the extended attribute that proved inclusion, exclusion, or ambiguity. The production contract was intentionally not changed mid-evaluation.',
  },
};
await writeFile(
  'benchmarks/recall-matching/phase-15/final-report.json',
  `${JSON.stringify(finalReport, null, 2)}\n`,
);
await writeFile(
  'benchmarks/recall-matching/phase-15/report.json',
  `${JSON.stringify(finalReport, null, 2)}\n`,
);

const percent = (value) =>
  value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const systemRow = (name, system, cost) =>
  `| ${name} | ${percent(system.metrics.exactThreeClassAccuracy)} | ${system.metrics.match.truePositives}/${system.metrics.match.falsePositives}/${system.metrics.match.falseNegatives}/${system.metrics.match.trueNegatives} | ${system.metrics.safety.unsafeConfirmations} | ${percent(system.metrics.match.precision)} | ${percent(system.metrics.match.strictRecall)} | ${percent(system.metrics.needsReview.rate)} | ${percent(system.metrics.decisionCoverage)} | ${percent(system.metrics.safety.pairwiseDiscrimination)} | ${cost} |`;
const splitRows = ['development', 'holdout', 'stress']
  .flatMap((split) =>
    [
      ['deterministic_v1', finalReport.systems.deterministic_v1],
      ['nemotron_v1', finalReport.systems.nemotron_v1],
      ['hybrid_guarded_v1', finalReport.systems.hybrid_guarded_v1],
    ].map(([name, system]) => {
      const metrics = system.bySplit[split];
      return `| ${split} | ${name} | ${percent(metrics.exactThreeClassAccuracy)} | ${metrics.match.truePositives}/${metrics.match.falsePositives}/${metrics.match.falseNegatives}/${metrics.match.trueNegatives} | ${metrics.safety.unsafeConfirmations} | ${percent(metrics.match.precision)} | ${percent(metrics.match.strictRecall)} | ${percent(metrics.needsReview.rate)} | ${percent(metrics.decisionCoverage)} | ${percent(metrics.safety.pairwiseDiscrimination)} |`;
    }),
  )
  .join('\n');
const operationalRows = ['development', 'holdout', 'stress']
  .flatMap((split) =>
    [
      ['deterministic_v1', finalReport.systems.deterministic_v1],
      ['nemotron_v1', finalReport.systems.nemotron_v1],
      ['hybrid_guarded_v1', finalReport.systems.hybrid_guarded_v1],
    ].map(([name, system]) => {
      const operation = system.operationalBySplit[split];
      const averageMs = operation.latency.averageMs ?? operation.latency.averageEvaluationMs ?? 0;
      return `| ${split} | ${name} | ${operation.requests} | ${operation.retries} | ${operation.usage.totalTokens} | ${averageMs.toFixed(3)} | USD ${operation.actualCostUsd.toFixed(6)} |`;
    }),
  )
  .join('\n');
const subgroupNames = [
  'gtin',
  'model',
  'serial_range',
  'lot',
  'manufacture_date',
  'production_date',
  'date',
  'variant',
  'size',
  'capacity',
  'batch',
  'multi_condition',
];
const subgroupRows = subgroupNames
  .map((name) => {
    const d = finalReport.systems.deterministic_v1.stratified.evidenceCategory[name];
    const n = finalReport.systems.nemotron_v1.stratified.evidenceCategory[name];
    const h = finalReport.systems.hybrid_guarded_v1.stratified.evidenceCategory[name];
    return `| ${name} | ${percent(d?.exactThreeClassAccuracy)} / ${d?.safety.unsafeConfirmations ?? 0} | ${percent(n?.exactThreeClassAccuracy)} / ${n?.safety.unsafeConfirmations ?? 0} | ${percent(h?.exactThreeClassAccuracy)} / ${h?.safety.unsafeConfirmations ?? 0} |`;
  })
  .join('\n');
const perturbations = [
  'boundary_date',
  'conflicting_identifiers',
  'lot_near_miss',
  'purchase_date_as_manufacture_date',
  'serial_just_outside_range',
  'single_character_model_mutation',
  'transposed_digits',
  'variant_mismatch',
];
const perturbationRows = perturbations
  .map((name) => {
    const d = finalReport.systems.deterministic_v1.stratified.perturbationFamily[name];
    const n = finalReport.systems.nemotron_v1.stratified.perturbationFamily[name];
    const h = finalReport.systems.hybrid_guarded_v1.stratified.perturbationFamily[name];
    return `| ${name} | ${percent(d?.exactThreeClassAccuracy)} / ${d?.safety.unsafeConfirmations ?? 0} | ${percent(n?.exactThreeClassAccuracy)} / ${n?.safety.unsafeConfirmations ?? 0} | ${percent(h?.exactThreeClassAccuracy)} / ${h?.safety.unsafeConfirmations ?? 0} |`;
  })
  .join('\n');
const unsafeRows = hybridSafety.unsafeConfirmations
  .map(
    (item) =>
      `- **${item.caseId}** (${item.recallFamily}, expected ${item.expected}, produced ${item.producedDecision}): deterministic=${item.deterministicDecision}; AI invoked=${item.aiInvoked}; verifier evidence=${item.verifier.confirmedEvidence.length}; failure=${item.failureMechanism}.`,
  )
  .join('\n');
const missedRows = hybridSafety.missedAffected
  .map(
    (item) =>
      `- **${item.caseId}** (${item.recallFamily}, ${item.disposition}): deterministic=${item.deterministicDecision}; AI invoked=${item.aiInvoked}; AI decision=${item.aiDecision ?? 'none'}; technical=${item.technicalFailure ?? 'none'}; verifier rejections=${item.verifier.rejectionReasons.length}; mechanism=${item.failureMechanism}.`,
  )
  .join('\n');
const markdown = `# Recall Safety Benchmark 2.0 — final results

> This is a controlled internal CPSC-backed safety evaluation, not a representative estimate of all real-world recalls.

## Continuation integrity

The guarded run originally stopped at \`p15-hol-29-1\` after two provider-success/schema-invalid attempts. A separate fail-closed continuation was authorized. That case remained \`needs_review\`; no additional request was made for it. The remaining 87 cases were processed exactly once. Eleven total cases exhausted the one frozen retry and remained \`needs_review\`. No prompt, schema, matcher, verifier, eligibility, or retry policy was relaxed. The original checkpoint and stop reports remain unchanged.

## Three-system measurements

| System | Accuracy | TP/FP/FN/TN | Unsafe confirmations | Precision | Strict recall | Needs review | Coverage | Pairwise | AI cost |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
${systemRow('deterministic_v1', finalReport.systems.deterministic_v1, 'USD 0')}
${systemRow('nemotron_v1', finalReport.systems.nemotron_v1, `USD ${nemotron.actualCostUsd.toFixed(6)}`)}
${systemRow('hybrid_guarded_v1', finalReport.systems.hybrid_guarded_v1, `USD ${hybrid.actualCostUsd.toFixed(6)}`)}

Combined paid cost was USD ${hybrid.combinedPaidCostUsd.toFixed(6)}. Nemotron used ${nemotron.requestCount} requests and ${nemotron.usage.totalTokens.toLocaleString('en-US')} tokens. Guarded hybrid escalated ${hybrid.orchestration.nemotronEscalations} cases, used ${hybrid.orchestration.requestCount} requests including ${hybrid.orchestration.retryCount} retries, and consumed ${hybrid.usage.totalTokens.toLocaleString('en-US')} tokens. It recorded ${hybrid.technicalFailures.invalidStructuredOutput} schema-invalid attempts, ${hybrid.technicalFailures.exhaustedRetries} exhausted cases, zero provider failures, and zero timeouts.

## Results by split

| Split | System | Accuracy | TP/FP/FN/TN | Unsafe | Precision | Strict recall | Needs review | Coverage | Pairwise |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
${splitRows}

## Operational measurements by split

| Split | System | Requests | Retries | Tokens | Average latency ms | Cost |
|---|---|---:|---:|---:|---:|---:|
${operationalRows}

## Evidence subgroups — accuracy / unsafe confirmations

| Evidence | Deterministic | Nemotron | Guarded hybrid |
|---|---:|---:|---:|
${subgroupRows}

Hard-negative accuracy was ${percent(finalReport.systems.deterministic_v1.stratified.hardNegative.true.exactThreeClassAccuracy)} deterministic, ${percent(finalReport.systems.nemotron_v1.stratified.hardNegative.true.exactThreeClassAccuracy)} Nemotron, and ${percent(finalReport.systems.hybrid_guarded_v1.stratified.hardNegative.true.exactThreeClassAccuracy)} guarded hybrid. Pairwise discrimination was ${percent(deterministic.metrics.safety.pairwiseDiscrimination)}, ${percent(nemotron.metrics.safety.pairwiseDiscrimination)}, and ${percent(hybrid.metrics.safety.pairwiseDiscrimination)}, respectively.

## Stress-only perturbations — accuracy / unsafe confirmations

| Perturbation | Deterministic | Nemotron | Guarded hybrid |
|---|---:|---:|---:|
${perturbationRows}

## Guarded-hybrid unsafe confirmations (${hybridSafety.unsafeConfirmations.length})

${unsafeRows}

All three bypassed AI because deterministic_v1 confirmed first. The guard therefore could not intervene.

## Guarded-hybrid missed affected cases (${hybridSafety.missedAffected.length})

All were \`needs_review\` abstentions; none were rejected.

${missedRows}

## Architecture finding

Several Benchmark 2.0 dimensions—size, color, charging-port type, screw state, battery model, date-code prefix, and manufacture/production dates—are not representable in the current production-shaped \`OwnedProductEvidence\` projection. The frozen systems often saw a matching model but not the extended attribute proving inclusion, exclusion, or ambiguity. This contract was intentionally not changed during Phase 15; it is future-phase work.

## Measured trade-offs

- Standalone Nemotron increased aggregate accuracy, recall, coverage, and pairwise discrimination versus deterministic_v1, but increased unsafe confirmations and reduced precision.
- Guarded hybrid prevented AI-originated unsafe confirmations in this benchmark, but retained unsafe deterministic confirmations because deterministic confirmed decisions bypass AI.
- Guarded hybrid's exact accuracy is reduced by schema-exhausted technical failures, which are not counted as correct abstentions even when the final safe decision is \`needs_review\`.
- Guarded hybrid used fewer requests and lower cost than standalone Nemotron, with more abstention and lower coverage.

No subjective winner is declared.
`;
await writeFile('benchmarks/recall-matching/phase-15/FINAL_REPORT.md', markdown);
await writeFile('benchmarks/recall-matching/phase-15/REPORT.md', markdown);
console.log(JSON.stringify({ json: 'final-report.json', markdown: 'FINAL_REPORT.md' }));
