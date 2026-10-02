import type { RecallCriterionSet } from '../matching/typesV2.ts';
import type { AuthoritativeRecallRow, RecallScopeRow } from './types.ts';

export type LiveReviewedCriterionSetV2 = RecallCriterionSet & {
  review: {
    reviewerId: string;
    reviewedAt: string;
    sourcePayloadSha256: string;
    eligibilityStatement: string;
  };
};

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
 * Live allowlist. A human review must attest that the structured CPSC product model is
 * an eligibility requirement. A recall-level UPC or descriptive product text cannot
 * acquire that meaning through this layer. Unsupported evidence remains unresolved.
 */
export async function validateLiveReviewedCriteriaV2(
  recall: AuthoritativeRecallRow,
  scope: RecallScopeRow,
  set: RecallCriterionSet | null,
): Promise<RecallCriterionSet | null> {
  if (!set) return null;
  const review = (set as LiveReviewedCriterionSetV2).review;
  if (
    !review?.reviewerId ||
    !review.eligibilityStatement?.trim() ||
    !Number.isFinite(Date.parse(review.reviewedAt)) ||
    review.sourcePayloadSha256 !== (await sourcePayloadSha256(recall.raw_payload))
  ) {
    throw new Error('Reviewed v2 criterion is not bound to the current source revision.');
  }
  if (set.semantics !== 'all_of' && set.semantics !== 'ambiguous') {
    throw new Error('Unknown v2 criterion semantics.');
  }
  if (!set.criteria.length) throw new Error('Empty reviewed v2 criterion set.');
  if (!recall.source_authority.includes('CPSC')) {
    throw new Error('No live structured Health Canada criterion class is approved.');
  }
  const products = recall.raw_payload.Products;
  if (!Array.isArray(products)) throw new Error('CPSC source products are unavailable.');
  for (const criterion of set.criteria) {
    const match = /^Products\[(\d+)\]\.Model$/u.exec(criterion.provenance.sourceField);
    const product = match ? products[Number(match[1])] : null;
    const sourceModel =
      product && typeof product === 'object' && !Array.isArray(product)
        ? (product as Record<string, unknown>).Model
        : null;
    if (
      criterion.kind !== 'model_number' ||
      criterion.operator !== 'equals' ||
      criterion.required !== true ||
      !match ||
      typeof sourceModel !== 'string' ||
      !sourceModel.trim() ||
      sourceModel.trim() !== criterion.value ||
      scope.model_number !== criterion.value ||
      criterion.provenance.officialUrl !== recall.source_official_url ||
      !criterion.provenance.authority.includes('CPSC')
    ) {
      throw new Error('Reviewed v2 criterion lacks product-specific structured evidence.');
    }
  }
  return set;
}
