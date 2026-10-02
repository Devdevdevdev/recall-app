import { readFile, writeFile } from 'node:fs/promises';

import { evaluateHybridGuardedMatchV2_1 } from '../../../supabase/functions/_shared/matching/hybridGuardedMatcherV2_1.ts';
import { decisionToExpected } from '../metrics.ts';
import { projectPhase15OwnedProductV2, projectPhase15RecallV2 } from './projection.ts';

const load = async (url) => JSON.parse(await readFile(url, 'utf8'));
const phase15 = new URL('../phase-15/', import.meta.url);
const sources = await load(new URL('sources.normalized.json', phase15));
const sourceByFamily = new Map(sources.sources.map((source) => [source.recallFamilyId, source]));
const splitNames = ['development', 'holdout', 'stress'];
const datasets = Object.fromEntries(
  await Promise.all(
    splitNames.map(async (split) => [split, await load(new URL(`${split}.v2.json`, phase15))]),
  ),
);
const frozen = await load(new URL('./results/deterministic-v2-all.json', import.meta.url));
const frozenByCase = new Map(frozen.cases.map((item) => [item.caseId, item]));
const changes = [];
const cases = [];
let aiEligibleCount = 0;
let needsReviewPreserved = 0;

for (const split of splitNames) {
  for (const benchmarkCase of datasets[split].cases) {
    const source = sourceByFamily.get(benchmarkCase.recallFamilyId);
    if (!source) throw new Error(`${benchmarkCase.caseId}: missing Phase 15 source.`);
    const result = await evaluateHybridGuardedMatchV2_1(
      {
        ownedProduct: projectPhase15OwnedProductV2(benchmarkCase),
        officialRecall: projectPhase15RecallV2(source),
      },
      async () => {
        aiEligibleCount += 1;
        return {
          decision: 'needs_review',
          scopeIndex: 0,
          associationId: 'no-v2-1-association-in-frozen-phase-15',
          claims: [],
          reasoningSummary: 'Safety replay preserves the frozen Phase 15 review label.',
        };
      },
    );
    const predicted = decisionToExpected(result.evaluation.decision);
    const frozenCase = frozenByCase.get(benchmarkCase.caseId);
    if (!frozenCase) throw new Error(`${benchmarkCase.caseId}: missing frozen v2 result.`);
    if (predicted !== frozenCase.predicted) {
      changes.push({
        caseId: benchmarkCase.caseId,
        expected: benchmarkCase.expected,
        frozenV2: frozenCase.predicted,
        v2_1: predicted,
      });
    }
    if (frozenCase.predicted === 'needs_review' && predicted === 'needs_review') {
      needsReviewPreserved += 1;
    }
    cases.push({
      caseId: benchmarkCase.caseId,
      split,
      expected: benchmarkCase.expected,
      frozenV2: frozenCase.predicted,
      v2_1: predicted,
      aiEscalated: result.trace.aiEscalated,
      verifierAccepted: result.trace.verifierAccepted,
    });
  }
}

const unsafeConfirmations = cases.filter(
  (item) => item.v2_1 === 'match' && item.expected !== 'match',
).length;
const output = {
  generatedAt: '2026-09-23T00:00:00.000Z',
  corpus: 'phase_15_frozen_200_case_safety_regression',
  mode: 'offline_advisory_no_provider_calls',
  totalCases: cases.length,
  aiEligibleCount,
  changedDecisionCount: changes.length,
  changedDecisions: changes,
  unsafeConfirmations,
  needsReviewPreserved,
  expectedNeedsReviewCount: 66,
  providerCalls: 0,
  cases,
};
if (
  output.totalCases !== 200 ||
  output.aiEligibleCount !== 66 ||
  output.changedDecisionCount !== 0 ||
  output.unsafeConfirmations !== 0 ||
  output.needsReviewPreserved !== 66
) {
  throw new Error('Phase 15 v2.1 safety replay did not preserve the frozen result.');
}
await writeFile(
  new URL('./results/hybrid-guarded-v2-1-phase15-safety.json', import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      totalCases: output.totalCases,
      aiEligibleCount: output.aiEligibleCount,
      changedDecisionCount: output.changedDecisionCount,
      unsafeConfirmations: output.unsafeConfirmations,
      needsReviewPreserved: output.needsReviewPreserved,
      providerCalls: output.providerCalls,
    },
    null,
    2,
  ),
);
