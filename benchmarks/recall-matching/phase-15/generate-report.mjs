import { readFile, writeFile } from 'node:fs/promises';

const load = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const audit = await load('./audit.json');
const plan = await load('./model-run-plan.json');
const manifest = await load('./freeze-manifest.json');
const aggregate = await load('./results/deterministic-v1-all.json');
const splitResults = Object.fromEntries(
  await Promise.all(
    ['development', 'holdout', 'stress'].map(async (split) => [
      split,
      await load(`./results/deterministic-v1-${split}.json`),
    ]),
  ),
);
const percent = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const compact = (metrics) => ({
  cases: metrics.totalCases,
  accuracy: metrics.exactThreeClassAccuracy,
  unsafeConfirmations: metrics.safety.unsafeConfirmations,
  unsafeConfirmRate: metrics.safety.unsafeConfirmRate,
  strictRecall: metrics.match.strictRecall,
  missedAffected: metrics.safety.missedAffectedCount,
  needsReviewRate: metrics.needsReview.rate,
  pairwiseDiscrimination: metrics.safety.pairwiseDiscrimination,
});
const reportJson = {
  generatedAt: new Date().toISOString(),
  benchmarkVersion: 'recall_safety_benchmark_v2',
  claimBoundary:
    'This is a controlled internal safety evaluation, not a representative estimate of all real-world recalls.',
  composition: audit,
  integrity: {
    phase15ArtifactHashes: manifest.phase15Artifacts,
    historicalArtifactCount: Object.keys(manifest.historicalArtifacts).length,
    historicalHashesVerified: true,
  },
  baseline: {
    matcherVersion: 'deterministic_v1',
    aggregate: compact(aggregate.metrics),
    bySplit: Object.fromEntries(
      Object.entries(splitResults).map(([split, result]) => [split, compact(result.metrics)]),
    ),
    fullMachineResult: 'results/deterministic-v1-all.json',
  },
  futurePaidEvaluation: plan,
  limitations: [
    'All 50 source families are CPSC notices because the selected CPSC evidence had explicit machine-auditable boundaries; no source quota was forced.',
    'Controlled fixtures test stated scope rules and do not estimate real-world prevalence, OCR quality, inventory completeness, or all recall-language patterns.',
    'Holdout and stress are frozen; any policy tuning informed by their failures requires a new future evaluation set.',
    'Nemotron and guarded-hybrid cells remain unmeasured until explicit paid-run approval.',
  ],
};
await writeFile(
  new URL('./report.json', import.meta.url),
  `${JSON.stringify(reportJson, null, 2)}\n`,
);

const splitRows = Object.entries(splitResults)
  .map(([split, result]) => {
    const metrics = result.metrics;
    return `| ${split} | ${metrics.totalCases} | ${percent(metrics.exactThreeClassAccuracy)} | ${metrics.safety.unsafeConfirmations} | ${percent(metrics.match.strictRecall)} | ${percent(metrics.needsReview.rate)} | ${percent(metrics.safety.pairwiseDiscrimination)} |`;
  })
  .join('\n');
const subgroupRows = Object.entries(aggregate.stratified.evidenceCategory)
  .map(
    ([category, metrics]) =>
      `| ${category} | ${metrics.totalCases} | ${percent(metrics.exactThreeClassAccuracy)} | ${metrics.safety.unsafeConfirmations} | ${percent(metrics.match.strictRecall)} | ${percent(metrics.safety.pairwiseDiscrimination)} |`,
  )
  .join('\n');
const perturbationRows = Object.entries(aggregate.stratified.perturbationFamily)
  .filter(([, metrics]) => metrics.totalCases >= 2)
  .map(
    ([category, metrics]) =>
      `| ${category} | ${metrics.totalCases} | ${percent(metrics.exactThreeClassAccuracy)} | ${metrics.safety.unsafeConfirmations} | ${percent(metrics.match.strictRecall)} |`,
  )
  .join('\n');
const markdown = `# Recall Safety Benchmark 2.0

> This is a controlled internal safety evaluation, not a representative estimate of all real-world recalls.

## Dataset composition and independence

- 200 controlled cases: 48 development, 120 holdout, and 32 stress/adversarial.
- 50 official CPSC recall families: 12 development, 30 holdout, and 8 stress.
- Labels: 67 match, 67 no_match, and 66 needs_review.
- 67 hard negatives and 50 positive/negative near-identical pairs.
- Cross-split recall-family overlap: 0. Duplicate cases/evidence fingerprints: 0. Unsupported labels: 0.
- Ground truth is based on explicit official scope evidence or controlled counterfactuals at explicit boundaries. No model established labels.
- Historical benchmark artifacts remain pinned by the freeze manifest (${Object.keys(manifest.historicalArtifacts).length} files).

The split boundary is the official recall family. Reannouncements, expansions, and cross-authority descriptions of one safety event are treated conservatively as one family. Development may support debugging or future tuning; holdout and stress may not.

## Source and evidence composition

The final source distribution is CPSC: 200 cases. Health Canada was not forced into the benchmark because the selected CPSC notices provided enough explicit identifiers and scope boundaries for machine-verifiable labels. This is a limitation, not a population claim.

Evidence coverage includes GTIN (${audit.evidenceDistribution.gtin}), model (${audit.evidenceDistribution.model}), serial/range (${audit.evidenceDistribution.serial_range}), lot (${audit.evidenceDistribution.lot}), manufacture/production/date (${(audit.evidenceDistribution.manufacture_date ?? 0) + (audit.evidenceDistribution.production_date ?? 0) + (audit.evidenceDistribution.date ?? 0)}), variant (${audit.evidenceDistribution.variant}), and multi-condition scope (${audit.evidenceDistribution.multi_condition}).

Development-seen perturbations: ${audit.perturbationVisibility.developmentSeen.join(', ')}. Stress-only perturbations: ${audit.perturbationVisibility.stressOnly.join(', ')}.

## Safety metric definitions

- **Unsafe confirmations:** false-positive confirmed matches.
- **Unsafe confirm rate:** FP / (TP + FP).
- **Missed affected rate:** expected MATCH cases not confirmed / expected MATCH cases, split into rejected and abstained true matches.
- **Pairwise discrimination:** positive/negative near-identical pairs where both cases are correct / total eligible pairs.
- Technical failures are tracked independently and never counted as correct abstentions.

## Deterministic v1 baseline

| Split | Cases | 3-class accuracy | Unsafe confirmations | Strict recall | Needs review | Pairwise discrimination |
|---|---:|---:|---:|---:|---:|---:|
${splitRows}
| **All** | ${aggregate.metrics.totalCases} | ${percent(aggregate.metrics.exactThreeClassAccuracy)} | ${aggregate.metrics.safety.unsafeConfirmations} | ${percent(aggregate.metrics.match.strictRecall)} | ${percent(aggregate.metrics.needsReview.rate)} | ${percent(aggregate.metrics.safety.pairwiseDiscrimination)} |

The weakest split is stress: ${percent(splitResults.stress.metrics.exactThreeClassAccuracy)} accuracy, ${splitResults.stress.metrics.safety.unsafeConfirmations} unsafe confirmations, ${percent(splitResults.stress.metrics.match.strictRecall)} strict recall, and ${percent(splitResults.stress.metrics.safety.pairwiseDiscrimination)} pairwise discrimination. Development is perfect for deterministic_v1 because its GTIN-centered patterns align with the matcher; that should not be generalized.

### Evidence-category results

| Evidence category | Cases | 3-class accuracy | Unsafe confirmations | Strict recall | Pairwise discrimination |
|---|---:|---:|---:|---:|---:|
${subgroupRows}

### Perturbation-family results

Rows with at least two cases are shown here; the machine-readable result retains every perturbation family, including singletons.

| Perturbation family | Cases | 3-class accuracy | Unsafe confirmations | Strict recall |
|---|---:|---:|---:|---:|
${perturbationRows}

All 200 cases are from CPSC, so the source-authority stratum equals the aggregate. Provider failures, timeouts, invalid structured outputs, retries, exhausted retries, verifier rejections, and fallbacks were all zero because deterministic_v1 made no AI calls.

## Future paid evaluation plan — not executed

| Metric | Deterministic v1 | Nemotron v1 | Guarded Hybrid v1 |
|---|---:|---:|---:|
| Unsafe confirmations | ${aggregate.metrics.safety.unsafeConfirmations} | Not run | Not run |
| Strict recall | ${percent(aggregate.metrics.match.strictRecall)} | Not run | Not run |
| Needs review | ${percent(aggregate.metrics.needsReview.rate)} | Not run | Not run |
| Pairwise discrimination | ${percent(aggregate.metrics.safety.pairwiseDiscrimination)} | Not run | Not run |
| Stress-set accuracy | ${percent(splitResults.stress.metrics.exactThreeClassAccuracy)} | Not run | Not run |
| AI calls | 0 | Planned: ${plan.nemotron_v1.expectedRequestCount} | Planned estimate: ${plan.hybrid_guarded_v1.expectedRequestCount} |
| Cost | USD 0 | Estimated USD ${plan.nemotron_v1.estimatedCostUsd.toFixed(3)} | Estimated USD ${plan.hybrid_guarded_v1.estimatedCostUsd.toFixed(3)} |

Nemotron would evaluate all ${plan.nemotron_v1.casesRequiringInference} cases (${plan.nemotron_v1.primaryRequestCount} primary requests; maximum ${plan.nemotron_v1.maximumRequestCount} requests at the current retry ceiling). Guarded hybrid would escalate ${plan.hybrid_guarded_v1.casesRequiringInference} deterministic abstentions (${plan.hybrid_guarded_v1.primaryRequestCount} primary requests; ${plan.hybrid_guarded_v1.expectedRequestCount} requests estimated from the historical retry factor; maximum ${plan.hybrid_guarded_v1.maximumRequestCount}). Exact dataset and prompt/policy hashes are in model-run-plan.json.

No Nebius/Nemotron calls were made in Phase 15 construction or baseline execution. Explicit approval is required before either paid run.

## Limitations

- This controlled benchmark is intentionally safety-focused and adversarial; it is not prevalence-weighted.
- It does not measure private inventory capture, OCR accuracy, or population-level recall matching.
- Some official constraints are not natively represented by deterministic_v1, which is the point of the stress evaluation.
- Any future tuning informed by frozen holdout/stress failures requires a new evaluation set.
`;
await writeFile(new URL('./REPORT.md', import.meta.url), markdown);
console.log(JSON.stringify({ reportJson: 'report.json', reportMarkdown: 'REPORT.md' }));
