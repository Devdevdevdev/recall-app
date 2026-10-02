import type { ValidatedScopeRuleSetsV2 } from '../recallMatching/ruleSetsV2.ts';

/**
 * Phase 17.7a safe confirmation gate. It never decides a match and never compares a
 * criterion value: it only decides whether a deterministic_v2 `confirmed` may become an
 * automatic confirmation. Anything it cannot prove keeps the pair out of alerting.
 */
export type AutomaticConfirmationEligibility =
  | 'eligible'
  | 'incomplete_evidence'
  | 'unsupported_scope'
  | 'jurisdiction_mismatch'
  | 'human_review_required';

export const PRODUCT_CHECK_GATE_VERSION = 'product_check_gate_v1';

/**
 * Mirrors the live reviewed-criterion allowlist (validateLiveReviewedCriteriaV2). It is
 * a second, independent fence and must never be wider than that allowlist; extending it
 * is a separate reviewed decision.
 */
export const SUPPORTED_CRITERION_KINDS: ReadonlySet<string> = new Set([
  'model_number',
  'date_code',
]);

export type NoticeJurisdiction = { type: string; code: string };

/** Per canonical scope: no envelope served, an envelope that failed validation, or a validated one. */
export type ScopeRuleSetState =
  { kind: 'absent' } | { kind: 'invalid' } | { kind: 'validated'; value: ValidatedScopeRuleSetsV2 };

export type EligibilityInput = {
  sourceIsAuthoritative: boolean;
  purchaseCountryCode: string | null;
  noticeJurisdictions: readonly NoticeJurisdiction[];
  scopes: readonly ScopeRuleSetState[];
};

const COUNTRY = /^[A-Z]{2}$/u;
const REGION = /^[A-Z][A-Z0-9]{1,7}$/u;

type JurisdictionResult = 'compatible' | Exclude<AutomaticConfirmationEligibility, 'eligible'>;

/**
 * Notice jurisdictions come only from structured rows (public.recall_notice_jurisdictions);
 * prose such as "also sold in Canada" never widens them.
 */
export function assessJurisdiction(
  purchaseCountryCode: string | null,
  jurisdictions: readonly NoticeJurisdiction[],
): JurisdictionResult {
  if (!jurisdictions.length) return 'unsupported_scope';
  for (const item of jurisdictions) {
    const wellFormed =
      (item.type === 'country' && COUNTRY.test(item.code)) ||
      (item.type === 'region' && REGION.test(item.code)) ||
      (item.type === 'global' && item.code === 'GLOBAL');
    if (!wellFormed) return 'human_review_required';
  }
  if (jurisdictions.some((item) => item.type === 'global')) return 'compatible';
  if (purchaseCountryCode === null) return 'incomplete_evidence';
  if (!COUNTRY.test(purchaseCountryCode)) return 'human_review_required';
  if (jurisdictions.some((item) => item.type === 'country' && item.code === purchaseCountryCode)) {
    return 'compatible';
  }
  // No official region membership table exists, so a region can neither include nor exclude.
  if (jurisdictions.some((item) => item.type === 'region')) return 'human_review_required';
  return 'jurisdiction_mismatch';
}

export function assessAutomaticConfirmationEligibility(
  input: EligibilityInput,
): AutomaticConfirmationEligibility {
  if (!input.sourceIsAuthoritative) return 'unsupported_scope';

  const jurisdiction = assessJurisdiction(input.purchaseCountryCode, input.noticeJurisdictions);
  if (jurisdiction !== 'compatible') return jurisdiction;

  // Completeness must be proven positively for every canonical scope. A missing
  // structured criterion is never read as the absence of a restriction.
  if (!input.scopes.length) return 'unsupported_scope';
  if (input.scopes.some((scope) => scope.kind === 'invalid')) return 'human_review_required';
  for (const scope of input.scopes) {
    if (scope.kind !== 'validated' || !scope.value.ruleSets.length) return 'unsupported_scope';
  }
  const validated = input.scopes.map(
    (scope) => (scope as Extract<ScopeRuleSetState, { kind: 'validated' }>).value,
  );
  if (validated.some((scope) => scope.droppedRuleSets > 0)) return 'human_review_required';
  if (validated.some((scope) => scope.coverageComplete !== true)) return 'unsupported_scope';

  for (const ruleSet of validated.flatMap((scope) => scope.ruleSets)) {
    if (ruleSet.semantics !== 'all_of') return 'human_review_required';
    for (const criterion of ruleSet.criteria) {
      if (!SUPPORTED_CRITERION_KINDS.has(criterion.kind) || criterion.required !== true) {
        return 'unsupported_scope';
      }
    }
  }
  return 'eligible';
}
