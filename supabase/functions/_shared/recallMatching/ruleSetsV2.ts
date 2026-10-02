import {
  DETERMINISTIC_RULE_SETS_ADAPTER_V2,
  evaluateExpandedRuleSetsV2,
  type DeterministicRuleSetsEvaluationV2,
  type RuleSetUnitV2,
} from '../matching/deterministicRuleSetsV2.ts';
import type { JsonObject, JsonValue } from '../matching/types.ts';
import type {
  OfficialRecallEvidenceV2,
  OwnedProductEvidenceV2,
  RecallCriterionSet,
} from '../matching/typesV2.ts';
import { productionFingerprintV2, projectRecallForProductionV2 } from './productionPolicyV2.ts';
import {
  validateLiveReviewedCriteriaV2,
  type LiveReviewedCriterionSetV2,
} from './reviewedCriteriaV2.ts';
import type { AuthoritativeRecallRow, RecallScopeRow } from './types.ts';

export const RULE_SET_ENVELOPE_SCHEMA_V1 = 'recall_rule_sets_v1';
export const RULE_SET_SCHEMA_V1 = 'recall_rule_set_v1';

/** One human-reviewed conjunction, built by the database from the review ledger. */
export type LiveRuleSetV2 = LiveReviewedCriterionSetV2 & {
  review: LiveReviewedCriterionSetV2['review'] & {
    schema: typeof RULE_SET_SCHEMA_V1;
    ruleSetFingerprint: string;
    identityFingerprint: string;
    scopeSemanticFingerprint: string;
    sourceAddressHashes: readonly string[];
  };
};

/** Phase 16.13: the revision's latest source-coverage ledger, or `missing`. */
export type SourceCoverageStateV2 = {
  state: 'recorded' | 'missing';
  coverageStatus: 'complete' | 'partial' | 'unresolved';
  positiveStatus: 'independent' | 'blocked' | 'unknown';
  negativeEvidenceEligible: boolean;
  coverageFingerprint?: string;
};

export type RuleSetCoverageV2 = {
  currentRevisionId: string | null;
  proposedRuleSets: number;
  unattributedRuleSets: number;
  servedRuleSets: number;
  complete: boolean;
  sourceCoverage?: SourceCoverageStateV2;
};

/** Served by get_recall_v2_scopes: OR across rule sets, AND inside each. */
export type LiveRuleSetEnvelopeV2 = {
  semantics: 'any_of';
  schema: typeof RULE_SET_ENVELOPE_SCHEMA_V1;
  scopeId: string;
  ruleSets: readonly LiveRuleSetV2[];
  coverage: RuleSetCoverageV2;
};

export type ValidatedScopeRuleSetsV2 = {
  ruleSets: readonly LiveRuleSetV2[];
  coverageComplete: boolean;
  droppedRuleSets: number;
};

export type RuleSetProjectionV2 = {
  official: OfficialRecallEvidenceV2;
  units: readonly RuleSetUnitV2[];
  coverageComplete: boolean;
};

const HEX64 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

/** Byte-wise UTF-8 order, identical to PostgreSQL `collate "C"`. */
function utf8Compare(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
    .join(',')}}`;
}

/**
 * Recomputes the semantic rule-set identity exactly as the database builder
 * (private.cpsc_reviewed_rule_set) does. Row UUIDs, timestamps, and reviewer
 * identity are not inputs.
 */
export async function computeRuleSetFingerprintV2(set: LiveRuleSetV2): Promise<string> {
  const { review } = set;
  const addressByCandidate = new Map(
    review.candidateIds.map((id, index) => [id, review.sourceAddressHashes[index]]),
  );
  const lines = set.criteria.map((criterion) => {
    const candidateId = criterion.id.replace(/^cpsc-ledger-/u, '');
    const address = addressByCandidate.get(candidateId);
    if (!address) throw new Error('Rule set member has no source address hash.');
    const value =
      criterion.operator === 'equals'
        ? criterion.value
        : [...(criterion.values ?? [])].sort(utf8Compare).join('\u001e');
    return [
      criterion.kind,
      criterion.operator,
      value,
      criterion.provenance.sourceField,
      address,
    ].join('\u001f');
  });
  lines.sort(utf8Compare);
  return sha256(
    [
      'recall-rule-set/v1',
      review.identityFingerprint,
      review.scopeSemanticFingerprint,
      review.sourceRevisionHash,
      'all_of',
      ...lines,
    ].join('\n'),
  );
}

function isCoverage(value: unknown): value is RuleSetCoverageV2 {
  const coverage = value as Partial<RuleSetCoverageV2> | null;
  return (
    !!coverage &&
    typeof coverage === 'object' &&
    Number.isInteger(coverage.proposedRuleSets) &&
    Number.isInteger(coverage.unattributedRuleSets) &&
    Number.isInteger(coverage.servedRuleSets) &&
    typeof coverage.complete === 'boolean'
  );
}

/**
 * Validates the served envelope. Each rule set passes the Phase 16.11 ledger
 * validator on its own and must reproduce its semantic fingerprint. An invalid
 * rule set is dropped individually (it never invalidates an independent complete
 * one), and any drop makes coverage incomplete so no false rejection follows.
 */
export async function validateLiveRuleSetEnvelopeV2(
  recall: AuthoritativeRecallRow,
  scope: RecallScopeRow,
  envelope: unknown,
): Promise<ValidatedScopeRuleSetsV2 | null> {
  if (envelope === null || envelope === undefined) return null;
  const candidate = envelope as Partial<LiveRuleSetEnvelopeV2>;
  if (
    typeof envelope !== 'object' ||
    candidate.semantics !== 'any_of' ||
    candidate.schema !== RULE_SET_ENVELOPE_SCHEMA_V1 ||
    !scope.scope_id ||
    candidate.scopeId !== scope.scope_id ||
    !Array.isArray(candidate.ruleSets) ||
    !candidate.ruleSets.length ||
    !isCoverage(candidate.coverage)
  ) {
    throw new Error('Reviewed v2 scope does not carry a recall_rule_sets_v1 envelope.');
  }
  const accepted: LiveRuleSetV2[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of candidate.ruleSets) {
    try {
      const set = raw as LiveRuleSetV2;
      await validateLiveReviewedCriteriaV2(recall, scope, set as RecallCriterionSet);
      const review = set.review;
      if (
        review.schema !== RULE_SET_SCHEMA_V1 ||
        !HEX64.test(review.ruleSetFingerprint ?? '') ||
        !HEX64.test(review.identityFingerprint ?? '') ||
        !HEX64.test(review.scopeSemanticFingerprint ?? '') ||
        !Array.isArray(review.sourceAddressHashes) ||
        review.sourceAddressHashes.length !== review.candidateIds.length ||
        !review.sourceAddressHashes.every((hash) => HEX64.test(hash)) ||
        seen.has(review.ruleSetFingerprint) ||
        (await computeRuleSetFingerprintV2(set)) !== review.ruleSetFingerprint
      ) {
        throw new Error('Rule set identity does not match its semantic content.');
      }
      seen.add(review.ruleSetFingerprint);
      accepted.push(set);
    } catch {
      dropped += 1;
    }
  }
  const coverage = candidate.coverage;
  // Negative evidence needs the database's own proof that the rule universe is
  // complete (Phase 16.13 ledger); its absence is never read as completeness.
  const source = coverage.sourceCoverage;
  const coverageComplete =
    coverage.complete === true &&
    source?.state === 'recorded' &&
    source.coverageStatus === 'complete' &&
    source.positiveStatus === 'independent' &&
    source.negativeEvidenceEligible === true &&
    dropped === 0 &&
    coverage.unattributedRuleSets === 0 &&
    coverage.servedRuleSets === candidate.ruleSets.length &&
    coverage.proposedRuleSets === accepted.length;
  return { ruleSets: accepted, coverageComplete, droppedRuleSets: dropped };
}

/**
 * Expands every validated rule set into its own all_of unit and reuses the
 * Phase 16 provenance checks. Scopes without rule sets stay criterion-less.
 */
export function projectRecallRuleSetsForProductionV2(
  row: AuthoritativeRecallRow,
  perScope: readonly (ValidatedScopeRuleSetsV2 | null)[],
): RuleSetProjectionV2 {
  if (perScope.length !== row.scopes.length) {
    throw new Error('Validated rule sets must match the canonical scope count.');
  }
  const scopes: RecallScopeRow[] = [];
  const criteria: (RecallCriterionSet | null)[] = [];
  const units: RuleSetUnitV2[] = [];
  row.scopes.forEach((scope, scopeIndex) => {
    const validated = perScope[scopeIndex];
    if (!validated?.ruleSets.length) {
      scopes.push(scope);
      criteria.push(null);
      units.push({ scopeIndex, ruleSetId: null });
      return;
    }
    for (const set of validated.ruleSets) {
      scopes.push(scope);
      criteria.push(set);
      units.push({ scopeIndex, ruleSetId: set.review.ruleSetFingerprint });
    }
  });
  const official = projectRecallForProductionV2({ ...row, scopes }, criteria);
  const coverageComplete =
    perScope.length > 0 && perScope.every((item) => item?.coverageComplete === true);
  return { official, units, coverageComplete };
}

export function evaluateRuleSetsPairV2(
  ownedProduct: OwnedProductEvidenceV2,
  projection: RuleSetProjectionV2,
): DeterministicRuleSetsEvaluationV2 {
  return evaluateExpandedRuleSetsV2(
    ownedProduct,
    projection.official,
    projection.units,
    projection.coverageComplete,
  );
}

/** Scope order and rule-set order do not change the fingerprint; coverage does. */
export async function ruleSetsFingerprintV2(input: {
  ownedProduct: OwnedProductEvidenceV2;
  projection: RuleSetProjectionV2;
  productRevision?: string;
  recallRevision?: string;
}): Promise<string> {
  const base = await productionFingerprintV2({
    ownedProduct: input.ownedProduct,
    officialRecall: input.projection.official,
    productRevision: input.productRevision,
    recallRevision: input.recallRevision,
  });
  const document = {
    adapter: DETERMINISTIC_RULE_SETS_ADAPTER_V2,
    coverageComplete: input.projection.coverageComplete,
    ruleSetIds: input.projection.units
      .map((unit) => unit.ruleSetId ?? '')
      .filter(Boolean)
      .sort(utf8Compare),
    base,
  } as unknown as JsonObject;
  return sha256(canonical(document));
}
