import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';

import { evaluateDeterministicMatchV2 } from '../../../supabase/functions/_shared/matching/deterministicMatcherV2.ts';
import { deterministicAssociationSelectorV2_1Probe } from './deterministicAssociationSelectorV2_1Probe.ts';

const load = async (relative) =>
  JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
const proposed = await load('./ai-value-holdout.proposed.json');
const candidates = await load('./association-probe-candidates.json');

function runCase(caseId, ownedProduct, officialRecall, expected = null) {
  const deterministic = evaluateDeterministicMatchV2(ownedProduct, officialRecall);
  const probe = deterministicAssociationSelectorV2_1Probe({ ownedProduct, officialRecall });
  return {
    caseId,
    expected,
    deterministicV2: deterministic.decision,
    probeDecision: probe.decision,
    safeAssociationCount: probe.safeAssociationCount,
    selectedAssociation: probe.selectedAssociation,
    associationEvaluations: probe.associationEvaluations,
  };
}

const proposedFamilyById = new Map(
  proposed.families.map((family) => [family.recallFamilyId, family]),
);
const proposedCases = proposed.cases.map((benchmarkCase) => {
  const family = proposedFamilyById.get(benchmarkCase.recallFamilyId);
  if (!family) throw new Error(`Missing proposed family ${benchmarkCase.recallFamilyId}.`);
  return runCase(
    benchmarkCase.caseId,
    benchmarkCase.ownedEvidence,
    family.recall,
    benchmarkCase.expectedDecision,
  );
});

const candidateFamilyById = new Map(candidates.families.map((family) => [family.familyId, family]));
const candidateCases = candidates.cases.map((benchmarkCase) => {
  const family = candidateFamilyById.get(benchmarkCase.familyId);
  if (!family) throw new Error(`Missing candidate family ${benchmarkCase.familyId}.`);
  return runCase(
    benchmarkCase.caseId,
    benchmarkCase.ownedEvidence,
    family.recall,
    benchmarkCase.expectedProbeDecision,
  );
});

const result = {
  generatedAt: '2026-09-23T00:00:00.000Z',
  mode: 'offline_no_ai',
  productionImpact: 'none',
  proposedDatasetStatus: proposed.status,
  proposedLabelWarning:
    'The rejected proposed dataset is measured as stored. The two Seeday labels are not repaired or treated as valid ground truth.',
  proposedCases,
  candidateDatasetStatus: candidates.status,
  candidateCases,
  summary: {
    proposedCaseCount: proposedCases.length,
    proposedDeterministicV2NeedsReview: proposedCases.filter(
      (item) => item.deterministicV2 === 'needs_review',
    ).length,
    proposedProbeConfirmed: proposedCases.filter((item) => item.probeDecision === 'confirmed')
      .length,
    proposedProbeNeedsReview: proposedCases.filter((item) => item.probeDecision === 'needs_review')
      .length,
    candidateCaseCount: candidateCases.length,
    candidateExpectedDecisionsMatched: candidateCases.filter(
      (item) => item.probeDecision === item.expected,
    ).length,
  },
};

await writeFile(
  new URL('./results/deterministic-association-selector-v2-1-probe.json', import.meta.url),
  await format(JSON.stringify(result), { parser: 'json', printWidth: 100 }),
);
console.log(JSON.stringify(result.summary, null, 2));
