import { evaluateDeterministicMatchV2 } from './deterministicMatcherV2.ts';
import type {
  GuardedAiDecisionV2,
  OfficialRecallEvidenceV2,
  OwnedProductEvidenceV2,
} from './typesV2.ts';

export function verifyNemotronConfirmationV2(input: {
  ownedProduct: OwnedProductEvidenceV2;
  officialRecall: OfficialRecallEvidenceV2;
  aiDecision: GuardedAiDecisionV2;
}): { accepted: boolean; rejectionReasons: readonly string[] } {
  const local = evaluateDeterministicMatchV2(input.ownedProduct, input.officialRecall);
  const requiredIds = new Set(
    input.officialRecall.scopes.flatMap(
      (scope) =>
        scope.criteria?.criteria.filter((item) => item.required).map((item) => item.id) ?? [],
    ),
  );
  const claimedIds = new Set(input.aiDecision.claimedCriterionIds);
  const missingClaims = [...requiredIds].filter((id) => !claimedIds.has(id));
  const rejectionReasons: string[] = [];
  if (input.aiDecision.decision !== 'confirmed') rejectionReasons.push('AI did not confirm.');
  if (local.decision !== 'confirmed') {
    rejectionReasons.push('Mandatory structured criteria are not all locally verified.');
  }
  if (missingClaims.length) {
    rejectionReasons.push(`AI omitted mandatory criterion claims: ${missingClaims.join(', ')}.`);
  }
  return { accepted: rejectionReasons.length === 0, rejectionReasons };
}
