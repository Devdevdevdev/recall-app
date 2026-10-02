import type { RecallCriterionSet } from '../matching/typesV2.ts';
import type { AuthoritativeRecallRow, RecallScopeRow } from './types.ts';

/** The only live shape: built by the database from the human review ledger. */
export type LiveReviewedCriterionSetV2 = RecallCriterionSet & {
  review: {
    origin: 'human_review_ledger';
    revisionId: string;
    sourceRevisionHash: string;
    conjunctionGroup: string;
    scopeId: string;
    scopeFingerprint: string;
    candidateIds: readonly string[];
    reviewEventIds: readonly string[];
    reviewerIds: readonly string[];
    reviewedAt: string;
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

function uuidList(value: unknown, length: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => typeof item === 'string' && UUID.test(item))
  );
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

export async function sourcePayloadSha256(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(payload)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Live allowlist. deterministic_v2 consumes only a conjunction that the database
 * built from current human review-ledger decisions (and re-verified when serving
 * it). The retired Phase 16.4 free-text approval shape is rejected here too.
 * Every criterion is required; the set must be anchored by a product model.
 */
export async function validateLiveReviewedCriteriaV2(
  recall: AuthoritativeRecallRow,
  scope: RecallScopeRow,
  set: RecallCriterionSet | null,
): Promise<RecallCriterionSet | null> {
  if (!set) return null;
  const review = (set as Partial<LiveReviewedCriterionSetV2>).review;
  const count = set.criteria?.length ?? 0;
  if (
    review?.origin !== 'human_review_ledger' ||
    !UUID.test(review.revisionId ?? '') ||
    !HEX64.test(review.sourceRevisionHash ?? '') ||
    !HEX64.test(review.scopeFingerprint ?? '') ||
    !review.conjunctionGroup ||
    review.scopeId !== scope.scope_id ||
    !uuidList(review.candidateIds, count) ||
    !uuidList(review.reviewEventIds, count) ||
    !uuidList(review.reviewerIds, count) ||
    !Number.isFinite(Date.parse(review.reviewedAt ?? ''))
  ) {
    throw new Error('Reviewed v2 criterion does not originate from the human review ledger.');
  }
  if (set.semantics !== 'all_of') throw new Error('Unknown v2 criterion semantics.');
  if (!count) throw new Error('Empty reviewed v2 criterion set.');
  if (!recall.source_authority.includes('CPSC')) {
    throw new Error('No live structured Health Canada criterion class is approved.');
  }
  const expectedIds = new Set(review.candidateIds.map((id) => `cpsc-ledger-${id}`));
  let models = 0;
  for (const criterion of set.criteria) {
    const exact =
      criterion.operator === 'equals' &&
      typeof criterion.value === 'string' &&
      criterion.value.trim() !== '' &&
      criterion.values === undefined;
    const listed =
      criterion.operator === 'one_of' &&
      criterion.value === undefined &&
      Array.isArray(criterion.values) &&
      criterion.values.length > 0 &&
      criterion.values.every((value) => typeof value === 'string' && value.trim() !== '') &&
      new Set(criterion.values).size === criterion.values.length;
    if (
      (criterion.kind !== 'model_number' && criterion.kind !== 'date_code') ||
      !(exact || listed) ||
      criterion.required !== true ||
      !expectedIds.delete(criterion.id) ||
      criterion.provenance?.authority !== 'CPSC' ||
      criterion.provenance.officialUrl !== recall.source_official_url ||
      !criterion.provenance.sourceField?.startsWith('cpsc-page:') ||
      criterion.provenance.normalizationRule !== 'identifier_v2'
    ) {
      throw new Error('Reviewed v2 criterion lacks ledger-bound structured evidence.');
    }
    if (criterion.kind === 'model_number') models += 1;
  }
  if (!models) throw new Error('Reviewed v2 criterion set has no product-model anchor.');
  return set;
}
