import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deterministicAssociationSelectorV2_1Probe } from '../benchmarks/recall-matching/phase-16/deterministicAssociationSelectorV2_1Probe.ts';
import { evaluateDeterministicMatchV2 } from '../supabase/functions/_shared/matching/deterministicMatcherV2.ts';

const load = async (relative) =>
  JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
const proposed = await load(
  '../benchmarks/recall-matching/phase-16/ai-value-holdout.proposed.json',
);
const candidates = await load(
  '../benchmarks/recall-matching/phase-16/association-probe-candidates.json',
);

test('offline selector reproduces every locally verifiable proposed confirmation without AI', () => {
  const familyById = new Map(proposed.families.map((family) => [family.recallFamilyId, family]));
  const results = proposed.cases.map((benchmarkCase) => {
    const family = familyById.get(benchmarkCase.recallFamilyId);
    assert.ok(family);
    const deterministic = evaluateDeterministicMatchV2(benchmarkCase.ownedEvidence, family.recall);
    const probe = deterministicAssociationSelectorV2_1Probe({
      ownedProduct: benchmarkCase.ownedEvidence,
      officialRecall: family.recall,
    });
    return { caseId: benchmarkCase.caseId, deterministic: deterministic.decision, probe };
  });

  assert.equal(results.length, 12);
  assert.ok(results.every((result) => result.deterministic === 'needs_review'));
  assert.deepEqual(
    results
      .filter((result) => result.probe.decision === 'confirmed')
      .map((result) => result.caseId),
    ['p16-ai-thermos-match', 'p16-ai-orb-match', 'p16-ai-dresser-match', 'p16-ai-fire-truck-match'],
  );
});

test('genuine official multi-association structures are resolved by deterministic enumeration', () => {
  const familyById = new Map(candidates.families.map((family) => [family.familyId, family]));
  for (const benchmarkCase of candidates.cases) {
    const family = familyById.get(benchmarkCase.familyId);
    assert.ok(family);
    const probe = deterministicAssociationSelectorV2_1Probe({
      ownedProduct: benchmarkCase.ownedEvidence,
      officialRecall: family.recall,
    });
    assert.equal(probe.decision, benchmarkCase.expectedProbeDecision, benchmarkCase.caseId);
  }
});
