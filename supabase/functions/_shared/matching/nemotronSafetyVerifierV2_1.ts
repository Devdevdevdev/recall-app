import { evaluateCriterionV2 } from './criterionEvaluatorV2.ts';
import type { OwnedProductEvidenceV2, RecallCriterion } from './typesV2.ts';
import type {
  GuardedAiDecisionV2_1,
  GuardedEvidenceClaimV2_1,
  OfficialRecallEvidenceV2_1,
  VerifierResultV2_1,
} from './typesV2_1.ts';

const expectedBaseField = {
  gtin: 'gtin',
  model_number: 'modelNumber',
  serial_number: 'serialNumber',
  lot_number: 'lotNumber',
} as const;

function evidenceReferenceMatches(
  criterion: RecallCriterion,
  claim: GuardedEvidenceClaimV2_1,
): boolean {
  const baseField = expectedBaseField[criterion.kind as keyof typeof expectedBaseField];
  if (baseField) {
    return claim.ownedEvidence.source === 'base' && claim.ownedEvidence.field === baseField;
  }
  const attributeKey = criterion.kind === 'date_code_prefix' ? 'date_code' : criterion.kind;
  return claim.ownedEvidence.source === 'attribute' && claim.ownedEvidence.key === attributeKey;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  );
}

export function verifyNemotronConfirmationV2_1(input: {
  ownedProduct: OwnedProductEvidenceV2;
  officialRecall: OfficialRecallEvidenceV2_1;
  aiDecision: GuardedAiDecisionV2_1;
}): VerifierResultV2_1 {
  const reasons: string[] = [];
  const { aiDecision } = input;
  if (aiDecision.decision !== 'confirmed') {
    return { accepted: false, rejectionReasons: ['AI did not propose a confirmation.'] };
  }

  const scope = input.officialRecall.scopes[aiDecision.scopeIndex];
  if (!scope) {
    return { accepted: false, rejectionReasons: ['AI referenced a nonexistent recall scope.'] };
  }
  if (scope.criteria?.semantics !== 'ambiguous') {
    reasons.push('AI confirmation is limited to explicitly ambiguous structured scopes.');
  }
  const association = scope.associations?.find((item) => item.id === aiDecision.associationId);
  if (!association) {
    return {
      accepted: false,
      rejectionReasons: [...reasons, 'AI referenced a nonexistent authoritative association.'],
    };
  }
  if (
    association.provenance.officialUrl !== input.officialRecall.source.officialUrl ||
    association.provenance.authority !== input.officialRecall.source.authority
  ) {
    reasons.push('Association provenance does not address the supplied authoritative recall.');
  }

  const criteria = scope.criteria?.criteria ?? [];
  const criterionById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const requiredIds = criteria
    .filter((criterion) => criterion.required)
    .map((criterion) => criterion.id);
  if (requiredIds.length === 0) {
    reasons.push('Association has no mandatory criterion to verify.');
  }
  if (!sameMembers(association.criterionIds, requiredIds)) {
    reasons.push('Association does not cover every mandatory criterion in its scope exactly once.');
  }

  const claimIds = aiDecision.claims.map((claim) => claim.criterionId);
  if (!sameMembers(claimIds, association.criterionIds)) {
    reasons.push('AI claims do not exactly cover the selected authoritative association.');
  }
  for (const claim of aiDecision.claims) {
    if (
      claim.scopeIndex !== aiDecision.scopeIndex ||
      claim.associationId !== aiDecision.associationId
    ) {
      reasons.push(`Claim ${claim.criterionId} does not address the selected scope/association.`);
      continue;
    }
    const criterion = criterionById.get(claim.criterionId);
    if (!criterion || !association.criterionIds.includes(claim.criterionId)) {
      reasons.push(
        `Claim ${claim.criterionId} references no criterion in the selected association.`,
      );
      continue;
    }
    if (claim.relation !== criterion.operator) {
      reasons.push(`Claim ${claim.criterionId} changes the authoritative comparison operator.`);
      continue;
    }
    if (!evidenceReferenceMatches(criterion, claim)) {
      reasons.push(`Claim ${claim.criterionId} references an incompatible owned-evidence field.`);
      continue;
    }
    const evaluation = evaluateCriterionV2(input.ownedProduct, criterion);
    if (evaluation.outcome !== 'matched') {
      reasons.push(`Claim ${claim.criterionId} is not locally verified (${evaluation.outcome}).`);
    }
  }
  return { accepted: reasons.length === 0, rejectionReasons: reasons };
}
