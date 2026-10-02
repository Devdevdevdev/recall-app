import { evaluateCriterionV2 } from '../../../supabase/functions/_shared/matching/criterionEvaluatorV2.ts';
import type { OwnedProductEvidenceV2 } from '../../../supabase/functions/_shared/matching/typesV2.ts';
import type {
  OfficialRecallEvidenceV2_1,
  OfficialRecallScopeEvidenceV2_1,
  RecallAssociationV2_1,
} from '../../../supabase/functions/_shared/matching/typesV2_1.ts';

export const DETERMINISTIC_ASSOCIATION_SELECTOR_V2_1_PROBE =
  'deterministic_association_selector_v2_1_probe';

export type AssociationProbeEvaluation = {
  scopeIndex: number;
  associationId: string;
  structurallyValid: boolean;
  fullySatisfied: boolean;
  criterionOutcomes: ReadonlyArray<{
    criterionId: string;
    outcome: 'matched' | 'conflicting' | 'missing' | 'unresolved';
  }>;
  rejectionReasons: readonly string[];
};

export type AssociationProbeResult = {
  decision: 'confirmed' | 'needs_review';
  selectedAssociation: { scopeIndex: number; associationId: string } | null;
  safeAssociationCount: number;
  associationEvaluations: readonly AssociationProbeEvaluation[];
  method: typeof DETERMINISTIC_ASSOCIATION_SELECTOR_V2_1_PROBE;
  reasoningSummary: string;
};

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    unique(left) &&
    unique(right) &&
    left.every((value) => right.includes(value))
  );
}

function evaluateAssociation(
  ownedProduct: OwnedProductEvidenceV2,
  officialRecall: OfficialRecallEvidenceV2_1,
  scope: OfficialRecallScopeEvidenceV2_1,
  scopeIndex: number,
  association: RecallAssociationV2_1,
): AssociationProbeEvaluation {
  const reasons: string[] = [];
  if (!scope.criteria) reasons.push('Scope has no structured criteria.');
  if (
    association.provenance.authority !== officialRecall.source.authority ||
    association.provenance.officialUrl !== officialRecall.source.officialUrl
  ) {
    reasons.push('Association provenance does not address the supplied authoritative recall.');
  }
  if (
    !association.provenance.sourceField?.trim() ||
    !association.provenance.normalizationRule?.trim()
  ) {
    reasons.push('Association provenance lacks a source address or normalization rule.');
  }

  const criteria = scope.criteria?.criteria ?? [];
  if (!unique(criteria.map((criterion) => criterion.id))) {
    reasons.push('Scope criterion IDs are not unique.');
  }
  if (
    criteria.some(
      (criterion) =>
        criterion.provenance.authority !== officialRecall.source.authority ||
        criterion.provenance.officialUrl !== officialRecall.source.officialUrl ||
        !criterion.provenance.sourceField?.trim() ||
        !criterion.provenance.normalizationRule?.trim(),
    )
  ) {
    reasons.push('Criterion provenance does not fully address the supplied authoritative recall.');
  }
  const criterionById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const requiredIds = criteria
    .filter((criterion) => criterion.required)
    .map((criterion) => criterion.id);
  if (requiredIds.length === 0) reasons.push('Association has no mandatory criterion.');
  if (!sameMembers(association.criterionIds, requiredIds)) {
    reasons.push(
      'Association does not cover every mandatory scope criterion exactly once, as v2.1 requires.',
    );
  }

  const criterionOutcomes = association.criterionIds.map((criterionId) => {
    const criterion = criterionById.get(criterionId);
    if (!criterion) {
      reasons.push(`Association references nonexistent criterion ${criterionId}.`);
      return { criterionId, outcome: 'unresolved' as const };
    }
    const evaluation = evaluateCriterionV2(ownedProduct, criterion);
    return { criterionId, outcome: evaluation.outcome };
  });
  const structurallyValid = reasons.length === 0;
  return {
    scopeIndex,
    associationId: association.id,
    structurallyValid,
    fullySatisfied:
      structurallyValid &&
      criterionOutcomes.length > 0 &&
      criterionOutcomes.every((criterion) => criterion.outcome === 'matched'),
    criterionOutcomes,
    rejectionReasons: reasons,
  };
}

/**
 * Offline-only proof probe. It performs no inference, I/O, persistence, alerting, or production
 * matching. It reuses v2.1's mandatory comparisons, adds provenance and uniqueness guards, and
 * enumerates clear all-of scopes so real source rows do not have to be mislabeled ambiguous.
 */
export function deterministicAssociationSelectorV2_1Probe(input: {
  ownedProduct: OwnedProductEvidenceV2;
  officialRecall: OfficialRecallEvidenceV2_1;
}): AssociationProbeResult {
  const associationEvaluations = input.officialRecall.scopes.flatMap((scope, scopeIndex) =>
    (scope.associations ?? []).map((association) =>
      evaluateAssociation(input.ownedProduct, input.officialRecall, scope, scopeIndex, association),
    ),
  );
  const safe = associationEvaluations.filter((association) => association.fullySatisfied);
  const onlySafe = safe.length === 1 ? safe[0] : undefined;
  const selectedAssociation = onlySafe
    ? { scopeIndex: onlySafe.scopeIndex, associationId: onlySafe.associationId }
    : null;
  return {
    decision: selectedAssociation ? 'confirmed' : 'needs_review',
    selectedAssociation,
    safeAssociationCount: safe.length,
    associationEvaluations,
    method: DETERMINISTIC_ASSOCIATION_SELECTOR_V2_1_PROBE,
    reasoningSummary: selectedAssociation
      ? 'Exactly one supplied authoritative association is structurally valid and fully satisfied.'
      : safe.length === 0
        ? 'No supplied authoritative association is both structurally valid and fully satisfied.'
        : 'Multiple supplied authoritative associations are fully satisfied; review remains required.',
  };
}
