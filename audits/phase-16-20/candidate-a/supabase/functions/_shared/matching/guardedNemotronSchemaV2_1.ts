import type { MatchDecision } from './types.ts';
import { PRODUCT_ATTRIBUTE_KEYS, type RecallCriterionOperator } from './typesV2.ts';
import type {
  GuardedAiDecisionV2_1,
  GuardedEvidenceClaimV2_1,
  OwnedEvidenceReferenceV2_1,
} from './typesV2_1.ts';

const decisions = new Set<MatchDecision>(['confirmed', 'rejected', 'needs_review']);
const relations = new Set<RecallCriterionOperator>([
  'equals',
  'one_of',
  'prefix',
  'range',
  'date_range',
]);
const baseFields = new Set(['gtin', 'modelNumber', 'serialNumber', 'lotNumber']);
const attributeKeys = new Set<string>(PRODUCT_ATTRIBUTE_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function boundedString(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function validateEvidenceReference(value: unknown): OwnedEvidenceReferenceV2_1 | null {
  if (!isRecord(value) || typeof value.source !== 'string') return null;
  if (value.source === 'base') {
    if (!exactKeys(value, ['source', 'field']) || !baseFields.has(value.field as string)) {
      return null;
    }
    return value as OwnedEvidenceReferenceV2_1;
  }
  if (value.source === 'attribute') {
    if (!exactKeys(value, ['source', 'key']) || !attributeKeys.has(value.key as string)) {
      return null;
    }
    return value as OwnedEvidenceReferenceV2_1;
  }
  return null;
}

function validateClaim(value: unknown): GuardedEvidenceClaimV2_1 | null {
  if (!isRecord(value)) return null;
  if (
    !exactKeys(value, [
      'scopeIndex',
      'associationId',
      'criterionId',
      'ownedEvidence',
      'relation',
    ]) ||
    !Number.isSafeInteger(value.scopeIndex) ||
    (value.scopeIndex as number) < 0 ||
    !boundedString(value.associationId) ||
    !boundedString(value.criterionId) ||
    !relations.has(value.relation as RecallCriterionOperator)
  ) {
    return null;
  }
  const ownedEvidence = validateEvidenceReference(value.ownedEvidence);
  if (!ownedEvidence) return null;
  return {
    scopeIndex: value.scopeIndex as number,
    associationId: value.associationId,
    criterionId: value.criterionId,
    ownedEvidence,
    relation: value.relation as RecallCriterionOperator,
  };
}

export function validateGuardedAiDecisionV2_1(value: unknown): GuardedAiDecisionV2_1 | null {
  if (!isRecord(value)) return null;
  if (
    !exactKeys(value, ['decision', 'scopeIndex', 'associationId', 'claims', 'reasoningSummary']) ||
    !decisions.has(value.decision as MatchDecision) ||
    !Number.isSafeInteger(value.scopeIndex) ||
    (value.scopeIndex as number) < 0 ||
    !boundedString(value.associationId) ||
    !Array.isArray(value.claims) ||
    value.claims.length > 64 ||
    (value.reasoningSummary !== undefined &&
      (typeof value.reasoningSummary !== 'string' || value.reasoningSummary.length > 1_000))
  ) {
    return null;
  }
  const claims = value.claims.map(validateClaim);
  if (claims.some((claim) => claim === null)) return null;
  return {
    decision: value.decision as MatchDecision,
    scopeIndex: value.scopeIndex as number,
    associationId: value.associationId,
    claims: claims as GuardedEvidenceClaimV2_1[],
    ...(typeof value.reasoningSummary === 'string'
      ? { reasoningSummary: value.reasoningSummary }
      : {}),
  };
}
