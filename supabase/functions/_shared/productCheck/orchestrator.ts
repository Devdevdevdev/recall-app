import { retrieveRecallCandidates } from '../matching/candidateRetrieval.ts';
import { normalizeGtin, normalizeIdentifier } from '../matching/normalization.ts';
import type { CandidateSignal, JsonObject, JsonValue, MatchDecision } from '../matching/types.ts';
import type { OwnedProductEvidenceV2 } from '../matching/typesV2.ts';
import type { ReviewedScopeRowV2 } from '../recallMatching/orchestratorV2.ts';
import { projectOwnedProductForProductionV2 } from '../recallMatching/productionPolicyV2.ts';
import {
  evaluateRuleSetsPairV2,
  projectRecallRuleSetsForProductionV2,
  ruleSetsFingerprintV2,
  validateLiveRuleSetEnvelopeV2,
  type RuleSetProjectionV2,
} from '../recallMatching/ruleSetsV2.ts';
import type {
  AuthoritativeRecallRow,
  OwnedProductRow,
  PairClaim,
} from '../recallMatching/types.ts';
import {
  assessAutomaticConfirmationEligibility,
  PRODUCT_CHECK_GATE_VERSION,
  type AutomaticConfirmationEligibility,
  type NoticeJurisdiction,
  type ScopeRuleSetState,
} from './gate.ts';

export const PRODUCT_CHECK_ADAPTER = 'product_check_v2_targeted_v1';
const PAGE_SIZE = 25;
const PAIR_LEASE_SECONDS = 60;

export type CandidateRecallRow = AuthoritativeRecallRow & {
  jurisdictions: readonly NoticeJurisdiction[];
  exact_rank: number;
};

export type ProductCheckCursor = { rank: number; recallId: string };

/** A claimed job, as returned by the claim RPCs. */
export type ProductCheckClaim = {
  ownedProductId: string;
  leaseToken: string;
  matchingRevision: number;
  productUpdatedAt: string;
  purchaseCountryCode: string | null;
  cursor: ProductCheckCursor | null;
  maxCandidates: number;
};

/** Every method maps to an existing RPC except listCandidateRecalls (Phase 17.7a-1). */
export type ProductCheckPairStore = {
  getProductEvidence(productId: string): Promise<OwnedProductRow | null>;
  listCandidateRecalls(input: {
    productId: string;
    after: ProductCheckCursor | null;
    limit: number;
  }): Promise<readonly CandidateRecallRow[]>;
  getReviewedScopes(recallNoticeId: string): Promise<readonly ReviewedScopeRowV2[]>;
  claimPair(input: {
    ownedProductId: string;
    recallNoticeId: string;
    expectedProductUpdatedAt: string;
    expectedRecallUpdatedAt: string;
    evidenceFingerprint: string;
    leaseSeconds: number;
  }): Promise<PairClaim>;
  finalizeV2(input: {
    ownedProductId: string;
    recallNoticeId: string;
    expectedProductUpdatedAt: string;
    expectedRecallUpdatedAt: string;
    leaseToken: string;
    evidenceFingerprint: string;
    status: MatchDecision;
    confidence: number;
    matchedIdentifiers: JsonObject;
    reasoningSummary: string;
  }): Promise<{
    status: 'finalized' | 'unchanged' | 'stale' | 'missing';
    alertEligibility: 'created' | 'revoked' | 'none';
  }>;
  createAlert(
    ownedProductId: string,
    recallNoticeId: string,
  ): Promise<'created' | 'existing' | 'ineligible'>;
};

export type ProductCheckRetryReason = 'busy' | 'stale' | 'failure' | 'timeout' | 'product_changed';

export type ProductCheckOutcome =
  | { outcome: 'complete' }
  | { outcome: 'continue'; cursor: ProductCheckCursor }
  | { outcome: 'retry'; error: ProductCheckRetryReason };

export type ProductCheckCounters = {
  candidates: number;
  evaluated: number;
  confirmed: number;
  rejected: number;
  possibleMatches: number;
  ignored: number;
  alertsCreated: number;
  gate: Partial<Record<AutomaticConfirmationEligibility, number>>;
};

export type ProductCheckResult = ProductCheckOutcome & { counters: ProductCheckCounters };

type PairResult =
  | { kind: 'confirmed' | 'rejected' | 'possible' | 'ignored' | 'not_candidate' }
  | { kind: 'unresolved'; error: ProductCheckRetryReason };

const STRONG_SIGNALS = new Set<CandidateSignal['kind']>([
  'exact_gtin',
  'exact_model',
  'exact_serial',
  'exact_lot',
]);

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
    .join(',')}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The unchanged v2 rule-set fingerprint (which already binds product and notice
 * revisions) plus the gate inputs, so a jurisdiction change is never served from a
 * stale result.
 */
export async function productCheckFingerprint(input: {
  ownedProduct: OwnedProductEvidenceV2;
  projection: RuleSetProjectionV2;
  productRevision: string;
  recallRevision: string;
  purchaseCountryCode: string | null;
  jurisdictions: readonly NoticeJurisdiction[];
}): Promise<string> {
  const v2 = await ruleSetsFingerprintV2(input);
  const jurisdictions = input.jurisdictions.map((item) => `${item.type}:${item.code}`).sort();
  return sha256(
    canonical({
      adapter: PRODUCT_CHECK_ADAPTER,
      gate: {
        version: PRODUCT_CHECK_GATE_VERSION,
        purchaseCountryCode: input.purchaseCountryCode,
        jurisdictions,
      },
      v2,
    }),
  );
}

/** Owned identifiers behind strong retrieval signals; display context only, never a decision. */
function signalIdentifiers(owned: OwnedProductEvidenceV2, signals: readonly CandidateSignal[]) {
  const result: Record<string, string[]> = {};
  const add = (kind: string, value: string | null) => {
    if (value) result[kind] = [value];
  };
  for (const signal of signals) {
    if (signal.kind === 'exact_gtin') add('gtin', normalizeGtin(owned.gtin));
    if (signal.kind === 'exact_model') add('modelNumber', normalizeIdentifier(owned.modelNumber));
    if (signal.kind === 'exact_serial')
      add('serialNumber', normalizeIdentifier(owned.serialNumber));
    if (signal.kind === 'exact_lot') add('lotNumber', normalizeIdentifier(owned.lotNumber));
  }
  return result;
}

async function scopeStates(
  recall: AuthoritativeRecallRow,
  scopes: readonly ReviewedScopeRowV2[],
): Promise<ScopeRuleSetState[]> {
  return Promise.all(
    scopes.map(async (scope): Promise<ScopeRuleSetState> => {
      try {
        const value = await validateLiveRuleSetEnvelopeV2(recall, scope, scope.reviewed_criteria);
        return value ? { kind: 'validated', value } : { kind: 'absent' };
      } catch {
        return { kind: 'invalid' };
      }
    }),
  );
}

export type AutomaticAlertClassification =
  AutomaticConfirmationEligibility | 'criteria_not_satisfied';

export type RecallAssessment =
  | {
      states: ScopeRuleSetState[];
      projection: RuleSetProjectionV2;
      gate: AutomaticConfirmationEligibility;
      evaluation: ReturnType<typeof evaluateRuleSetsPairV2>;
      /** Same vocabulary as private.automatic_alert_classification (parity tested). */
      classification: AutomaticAlertClassification;
    }
  | {
      /** A non-authoritative source is never projected or evaluated (fail closed). */
      states: [];
      projection: null;
      gate: 'unsupported_scope';
      evaluation: null;
      classification: 'unsupported_scope';
    };

/**
 * Pure assessment of one notice for one product: live envelope validation, the safe
 * gate, and the unchanged deterministic_v2 rule-set evaluation. No I/O, no AI.
 */
export async function assessRecallForProduct(
  owned: OwnedProductEvidenceV2,
  recall: AuthoritativeRecallRow & { jurisdictions: readonly NoticeJurisdiction[] },
  scopes: readonly ReviewedScopeRowV2[],
  purchaseCountryCode: string | null,
): Promise<RecallAssessment> {
  if (recall.source_is_authoritative !== true) {
    return {
      states: [],
      projection: null,
      gate: 'unsupported_scope',
      evaluation: null,
      classification: 'unsupported_scope',
    };
  }
  const recallRow = { ...recall, scopes };
  let states = await scopeStates(recall, scopes);
  let projection: RuleSetProjectionV2;
  try {
    projection = projectRecallRuleSetsForProductionV2(
      recallRow,
      states.map((state) => (state.kind === 'validated' ? state.value : null)),
    );
  } catch {
    // Provenance that cannot be projected is never eligible; evaluate without rule sets.
    states = states.map(() => ({ kind: 'invalid' }));
    projection = projectRecallRuleSetsForProductionV2(
      recallRow,
      scopes.map(() => null),
    );
  }
  const gate = assessAutomaticConfirmationEligibility({
    sourceIsAuthoritative: recall.source_is_authoritative === true,
    purchaseCountryCode,
    noticeJurisdictions: recall.jurisdictions,
    scopes: states,
  });
  const evaluation = evaluateRuleSetsPairV2(owned, projection);
  const classification: AutomaticAlertClassification =
    gate !== 'eligible'
      ? gate
      : evaluation.decision === 'confirmed'
        ? 'eligible'
        : 'criteria_not_satisfied';
  return { states, projection, gate, evaluation, classification };
}

async function evaluatePair(
  claim: ProductCheckClaim,
  product: OwnedProductRow,
  owned: OwnedProductEvidenceV2,
  recall: CandidateRecallRow,
  store: ProductCheckPairStore,
  counters: ProductCheckCounters,
): Promise<PairResult> {
  const scopes = await store.getReviewedScopes(recall.recall_notice_id);
  if (!scopes.length) return { kind: 'not_candidate' };
  const assessment = await assessRecallForProduct(owned, recall, scopes, claim.purchaseCountryCode);
  if (assessment.projection === null) return { kind: 'not_candidate' };
  const { projection, gate, evaluation: v2 } = assessment;

  // Same in-memory retrieval guard as the existing orchestrators.
  const signals =
    retrieveRecallCandidates(owned, [projection.official], { maxCandidates: 1 })[0]?.signals ?? [];
  if (!signals.length) return { kind: 'not_candidate' };

  counters.gate[gate] = (counters.gate[gate] ?? 0) + 1;
  const strong = signals.some((signal) => STRONG_SIGNALS.has(signal.kind));
  // A weak, ineligible candidate (name/brand overlap only) is not worth a verification prompt.
  if (gate !== 'eligible' && !strong) return { kind: 'ignored' };

  const productRevision = product.owned_product_updated_at as string;
  const recallRevision = recall.recall_notice_updated_at;
  if (!recallRevision) return { kind: 'unresolved', error: 'failure' };
  const evidenceFingerprint = await productCheckFingerprint({
    ownedProduct: owned,
    projection,
    productRevision,
    recallRevision,
    purchaseCountryCode: claim.purchaseCountryCode,
    jurisdictions: recall.jurisdictions,
  });
  const pair = await store.claimPair({
    ownedProductId: claim.ownedProductId,
    recallNoticeId: recall.recall_notice_id,
    expectedProductUpdatedAt: productRevision,
    expectedRecallUpdatedAt: recallRevision,
    evidenceFingerprint,
    leaseSeconds: PAIR_LEASE_SECONDS,
  });
  if (pair.status === 'busy' || pair.status === 'stale') {
    return { kind: 'unresolved', error: pair.status };
  }
  if (pair.status !== 'claimed') return { kind: 'ignored' };

  const eligible = gate === 'eligible';
  const decision: MatchDecision = eligible ? v2.decision : 'needs_review';
  const missingRequired = v2.criterionEvaluations.some(
    (item) => item.required && item.outcome === 'missing',
  );
  const reason = !eligible
    ? gate
    : decision === 'needs_review'
      ? missingRequired
        ? 'incomplete_evidence'
        : 'human_review_required'
      : null;
  const reasoningSummary = reason
    ? `Automatic confirmation withheld (${reason}); verify the official recall conditions.`
    : v2.reasoningSummary;
  const matchedIdentifiers = (
    eligible && decision !== 'needs_review'
      ? v2.matchedIdentifiers
      : { ...signalIdentifiers(owned, signals), ...v2.matchedIdentifiers }
  ) as JsonObject;

  const finalized = await store.finalizeV2({
    ownedProductId: claim.ownedProductId,
    recallNoticeId: recall.recall_notice_id,
    expectedProductUpdatedAt: productRevision,
    expectedRecallUpdatedAt: recallRevision,
    leaseToken: pair.leaseToken,
    evidenceFingerprint,
    status: decision,
    confidence: eligible ? v2.confidence : 0,
    matchedIdentifiers,
    reasoningSummary,
  });
  if (finalized.status === 'stale') return { kind: 'unresolved', error: 'stale' };
  if (finalized.status === 'missing') return { kind: 'ignored' };
  counters.evaluated += 1;

  if (decision === 'confirmed') {
    if (finalized.status === 'unchanged' || finalized.alertEligibility === 'created') {
      const alert = await store.createAlert(claim.ownedProductId, recall.recall_notice_id);
      if (alert === 'created') counters.alertsCreated += 1;
    }
    return { kind: 'confirmed' };
  }
  return { kind: decision === 'rejected' ? 'rejected' : 'possible' };
}

/**
 * Checks ONE claimed product against the official recalls already known. No AI, no v1
 * matcher, no fallback: an unresolved pair stops the run before the cursor passes it, so
 * the next attempt resumes exactly there.
 */
export async function runOwnedProductCheck(
  claim: ProductCheckClaim,
  store: ProductCheckPairStore,
  options: { deadline: number; now?: () => number },
): Promise<ProductCheckResult> {
  const now = options.now ?? (() => Date.now());
  const counters: ProductCheckCounters = {
    candidates: 0,
    evaluated: 0,
    confirmed: 0,
    rejected: 0,
    possibleMatches: 0,
    ignored: 0,
    alertsCreated: 0,
    gate: {},
  };
  const result = (outcome: ProductCheckOutcome): ProductCheckResult => ({ ...outcome, counters });

  const product = await store.getProductEvidence(claim.ownedProductId);
  if (!product) return result({ outcome: 'complete' });
  if (product.owned_product_updated_at !== claim.productUpdatedAt) {
    return result({ outcome: 'retry', error: 'product_changed' });
  }
  const owned = projectOwnedProductForProductionV2(product);

  let cursor = claim.cursor;
  const budget = Math.max(1, Math.min(claim.maxCandidates, 100));
  while (true) {
    if (counters.candidates >= budget || now() >= options.deadline) {
      return cursor
        ? result({ outcome: 'continue', cursor })
        : result({ outcome: 'retry', error: 'timeout' });
    }
    const limit = Math.min(PAGE_SIZE, budget - counters.candidates);
    const rows = await store.listCandidateRecalls({
      productId: claim.ownedProductId,
      after: cursor,
      limit,
    });
    for (const recall of rows) {
      if (now() >= options.deadline) {
        return cursor
          ? result({ outcome: 'continue', cursor })
          : result({ outcome: 'retry', error: 'timeout' });
      }
      counters.candidates += 1;
      let pair: PairResult;
      try {
        pair = await evaluatePair(claim, product, owned, recall, store, counters);
      } catch {
        pair = { kind: 'unresolved', error: 'failure' };
      }
      if (pair.kind === 'unresolved') return result({ outcome: 'retry', error: pair.error });
      if (pair.kind === 'confirmed') counters.confirmed += 1;
      else if (pair.kind === 'rejected') counters.rejected += 1;
      else if (pair.kind === 'possible') counters.possibleMatches += 1;
      else counters.ignored += 1;
      cursor = { rank: recall.exact_rank, recallId: recall.recall_notice_id };
    }
    if (rows.length < limit) return result({ outcome: 'complete' });
  }
}
