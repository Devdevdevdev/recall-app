import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';

import { evaluateDeterministicMatchV2 } from '../../../supabase/functions/_shared/matching/deterministicMatcherV2.ts';

const load = async (url) => JSON.parse(await readFile(url, 'utf8'));
const datasetUrl = new URL('./ai-value-holdout.proposed.json', import.meta.url);
const dataset = await load(datasetUrl);
const root = new URL('../../../', import.meta.url);
const historicalUrls = [
  'benchmarks/recall-matching/cases.v1.json',
  'benchmarks/recall-matching/phase-9-1/development.v1.json',
  'benchmarks/recall-matching/phase-9-1/holdout.v1.json',
  'benchmarks/recall-matching/phase-15/sources.normalized.json',
];

function collectOfficialUrls(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectOfficialUrls(item, result);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'officialUrl' && typeof item === 'string') result.add(item);
      collectOfficialUrls(item, result);
    }
  }
  return result;
}

const historicalOfficialUrls = new Set();
for (const path of historicalUrls) {
  collectOfficialUrls(await load(new URL(path, root)), historicalOfficialUrls);
}

const errors = [];
const missingProvenance = [];
const familyById = new Map(dataset.families.map((family) => [family.recallFamilyId, family]));
if (familyById.size !== dataset.families.length) errors.push('Recall family IDs must be unique.');
if (new Set(dataset.cases.map((item) => item.caseId)).size !== dataset.cases.length) {
  errors.push('Case IDs must be unique.');
}

const classDistribution = { match: 0, no_match: 0, needs_review: 0 };
const caseChecks = [];
for (const benchmarkCase of dataset.cases) {
  const family = familyById.get(benchmarkCase.recallFamilyId);
  if (!family) {
    errors.push(`${benchmarkCase.caseId}: missing recall family.`);
    continue;
  }
  if (!(benchmarkCase.expectedDecision in classDistribution)) {
    errors.push(`${benchmarkCase.caseId}: unsupported expected decision.`);
    continue;
  }
  classDistribution[benchmarkCase.expectedDecision] += 1;
  if (
    !benchmarkCase.officialSource ||
    !benchmarkCase.officialUrl ||
    !benchmarkCase.labelRationale ||
    !benchmarkCase.constructionType ||
    !benchmarkCase.provenance?.authority ||
    !benchmarkCase.provenance?.control
  ) {
    missingProvenance.push(benchmarkCase.caseId);
  }
  if (benchmarkCase.officialUrl !== family.officialUrl) {
    errors.push(`${benchmarkCase.caseId}: case and family official URLs differ.`);
  }
  const criteria = family.recall.scopes.flatMap((scope) => scope.criteria?.criteria ?? []);
  const requiredIds = criteria
    .filter((criterion) => criterion.required)
    .map((criterion) => criterion.id);
  if (
    benchmarkCase.authoritativeCriteria.length !== requiredIds.length ||
    !requiredIds.every((id) => benchmarkCase.authoritativeCriteria.includes(id))
  ) {
    errors.push(`${benchmarkCase.caseId}: authoritative criterion references are incomplete.`);
  }
  for (const criterion of criteria) {
    if (
      !criterion.provenance?.authority ||
      !criterion.provenance?.officialUrl ||
      !criterion.provenance?.sourceField ||
      !criterion.provenance?.normalizationRule
    ) {
      missingProvenance.push(`${benchmarkCase.recallFamilyId}:${criterion.id}`);
    }
  }
  const evaluation = evaluateDeterministicMatchV2(benchmarkCase.ownedEvidence, family.recall);
  if (evaluation.decision !== 'needs_review') {
    errors.push(`${benchmarkCase.caseId}: deterministic_v2 did not abstain.`);
  }
  const requiredOutcomes = evaluation.criterionEvaluations
    .filter((criterion) => criterion.required)
    .map((criterion) => criterion.outcome);
  if (
    benchmarkCase.expectedDecision === 'match' &&
    !requiredOutcomes.every((outcome) => outcome === 'matched')
  ) {
    errors.push(`${benchmarkCase.caseId}: controlled positive is not locally recomputable.`);
  }
  if (
    benchmarkCase.expectedDecision === 'no_match' &&
    (!requiredOutcomes.includes('conflicting') ||
      requiredOutcomes.some((outcome) => outcome === 'missing' || outcome === 'unresolved'))
  ) {
    errors.push(`${benchmarkCase.caseId}: hard negative lacks a supplied conflicting criterion.`);
  }
  if (
    benchmarkCase.expectedDecision === 'needs_review' &&
    !requiredOutcomes.some((outcome) => outcome === 'missing' || outcome === 'unresolved')
  ) {
    errors.push(`${benchmarkCase.caseId}: review label lacks genuinely insufficient evidence.`);
  }
  caseChecks.push({
    caseId: benchmarkCase.caseId,
    expectedDecision: benchmarkCase.expectedDecision,
    deterministicV2Decision: evaluation.decision,
    requiredOutcomes,
  });
}

if (JSON.stringify(classDistribution) !== JSON.stringify(dataset.classDistribution)) {
  errors.push('Declared class distribution does not match cases.');
}
const overlaps = dataset.families
  .filter((family) => historicalOfficialUrls.has(family.officialUrl))
  .map((family) => family.recallFamilyId);
if (overlaps.length) errors.push(`Historical family overlap: ${overlaps.join(', ')}.`);
if (missingProvenance.length) {
  errors.push(`Missing provenance: ${[...new Set(missingProvenance)].join(', ')}.`);
}
if (errors.length) throw new Error(errors.join('\n'));

const audit = {
  generatedAt: '2026-09-23T00:00:00.000Z',
  datasetVersion: dataset.version,
  status: dataset.status,
  labelSource: dataset.labelSource,
  caseCount: dataset.cases.length,
  recallFamilyCount: dataset.families.length,
  classDistribution,
  familyOverlapCount: overlaps.length,
  familyOverlaps: overlaps,
  historicalCorporaChecked: historicalUrls,
  missingProvenanceCount: new Set(missingProvenance).size,
  allDeterministicV2NeedsReview: caseChecks.every(
    (item) => item.deterministicV2Decision === 'needs_review',
  ),
  futureAiEligibleCount: caseChecks.length,
  estimatedPaidRun: {
    basis: 'Phase 15 average: 76 requests, 245451 tokens, $0.1201 for 66 eligible cases',
    requests: 14,
    tokens: 44627,
    costUsd: 0.0218,
  },
  caseChecks,
};
await writeFile(
  new URL('./ai-value-holdout-audit.json', import.meta.url),
  await format(JSON.stringify(audit), { parser: 'json' }),
);
console.log(JSON.stringify(audit, null, 2));
