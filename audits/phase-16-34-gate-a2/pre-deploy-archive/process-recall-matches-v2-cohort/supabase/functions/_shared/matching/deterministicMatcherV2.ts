import { mergeIdentifierEvidence } from './evidence.ts';
import { evaluateCriterionSetV2 } from './criterionEvaluatorV2.ts';
import type { IdentifierEvidence, IdentifierKind } from './types.ts';
import {
  DETERMINISTIC_MATCH_METHOD_V2,
  MATCH_EVALUATION_SCHEMA_VERSION_V2,
  type DeterministicMatchEvaluationV2,
  type OfficialRecallEvidenceV2,
  type OwnedProductEvidenceV2,
  type ScopeEvaluationV2,
} from './typesV2.ts';

const identifierKind = {
  gtin: 'gtin',
  model_number: 'modelNumber',
  serial_number: 'serialNumber',
  lot_number: 'lotNumber',
} as const;

function identifiers(
  evaluations: ScopeEvaluationV2['criterionEvaluations'],
  outcome: 'matched' | 'conflicting',
): IdentifierEvidence {
  const result: Partial<Record<IdentifierKind, string[]>> = {};
  for (const evaluation of evaluations) {
    const kind = identifierKind[evaluation.kind as keyof typeof identifierKind];
    if (!kind || evaluation.outcome !== outcome || !evaluation.ownedValue) continue;
    result[kind] = [...(result[kind] ?? []), evaluation.ownedValue];
  }
  return result;
}

function evaluateScope(
  owned: OwnedProductEvidenceV2,
  scope: OfficialRecallEvidenceV2['scopes'][number],
  scopeIndex: number,
): ScopeEvaluationV2 {
  const criterionEvaluations = evaluateCriterionSetV2(owned, scope);
  if (!scope.criteria || !criterionEvaluations.length) {
    return {
      scopeIndex,
      relevant: false,
      decision: 'needs_review',
      confidence: 0,
      matchedIdentifiers: {},
      conflictingIdentifiers: {},
      evidenceUsed: [],
      criterionEvaluations,
      reasoningSummary: 'No explicit v2 criterion semantics are available for this scope.',
    };
  }

  const matchedIdentifiers = identifiers(criterionEvaluations, 'matched');
  const conflictingIdentifiers = identifiers(criterionEvaluations, 'conflicting');
  const hasMatched = criterionEvaluations.some((item) => item.outcome === 'matched');
  const required = criterionEvaluations.filter((item) => item.required);
  if (scope.criteria.semantics === 'ambiguous') {
    return {
      scopeIndex,
      relevant: hasMatched,
      decision: 'needs_review',
      confidence: hasMatched ? 0.5 : 0,
      matchedIdentifiers,
      conflictingIdentifiers,
      evidenceUsed: [],
      criterionEvaluations,
      reasoningSummary: 'Criterion relationships are ambiguous, so v2 cannot confirm or reject.',
    };
  }

  const requiredConflict = required.some((item) => item.outcome === 'conflicting');
  const requiredIncomplete = required.some(
    (item) => item.outcome === 'missing' || item.outcome === 'unresolved',
  );
  const allRequiredMatched =
    required.length > 0 && required.every((item) => item.outcome === 'matched');
  const decision = requiredConflict
    ? 'rejected'
    : requiredIncomplete
      ? 'needs_review'
      : allRequiredMatched
        ? 'confirmed'
        : 'needs_review';
  return {
    scopeIndex,
    relevant: hasMatched || requiredConflict || requiredIncomplete,
    decision,
    confidence:
      decision === 'confirmed' ? 1 : decision === 'rejected' ? 0.98 : hasMatched ? 0.65 : 0,
    matchedIdentifiers,
    conflictingIdentifiers,
    evidenceUsed: [],
    criterionEvaluations,
    reasoningSummary:
      decision === 'confirmed'
        ? 'Every mandatory criterion in the explicit all-of scope is satisfied.'
        : decision === 'rejected'
          ? 'A mandatory criterion in the explicit all-of scope is safely contradicted.'
          : 'At least one mandatory criterion is missing or unresolved.',
  };
}

/** Pure deterministic_v2 evaluation. It performs no I/O, persistence, alerting, or inference. */
export function evaluateDeterministicMatchV2(
  ownedProduct: OwnedProductEvidenceV2,
  officialRecall: OfficialRecallEvidenceV2,
): DeterministicMatchEvaluationV2 {
  const scopes = officialRecall.scopes.map((scope, index) =>
    evaluateScope(ownedProduct, scope, index),
  );
  const relevant = scopes.filter((scope) => scope.relevant);
  const confirmed = relevant.filter((scope) => scope.decision === 'confirmed');
  const unresolved = relevant.filter((scope) => scope.decision === 'needs_review');
  const selected = confirmed.length ? confirmed : relevant;
  const decision = confirmed.length
    ? 'confirmed'
    : unresolved.length
      ? 'needs_review'
      : relevant.length && relevant.every((scope) => scope.decision === 'rejected')
        ? 'rejected'
        : 'needs_review';

  return {
    decision,
    confidence:
      decision === 'confirmed'
        ? Math.max(...confirmed.map((scope) => scope.confidence))
        : relevant.length
          ? Math.min(...relevant.map((scope) => scope.confidence))
          : 0,
    matchedIdentifiers: mergeIdentifierEvidence(selected, 'matchedIdentifiers'),
    conflictingIdentifiers: mergeIdentifierEvidence(selected, 'conflictingIdentifiers'),
    evidenceUsed: scopes.flatMap((scope) => scope.evidenceUsed),
    criterionEvaluations: scopes.flatMap((scope) => scope.criterionEvaluations),
    reasoningSummary:
      decision === 'confirmed'
        ? `${confirmed.length} explicit all-of scope(s) satisfied every mandatory criterion.`
        : decision === 'rejected'
          ? 'Every relevant explicit scope has a safely contradictory mandatory criterion.'
          : 'No explicit scope can be safely confirmed or rejected with the available evidence.',
    matchMethod: DETERMINISTIC_MATCH_METHOD_V2,
    schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION_V2,
  };
}
