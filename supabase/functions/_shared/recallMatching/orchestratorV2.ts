import { retrieveRecallCandidates } from '../matching/candidateRetrieval.ts';
import type { JsonObject, MatchDecision } from '../matching/types.ts';
import { projectOwnedProductForProductionV2 } from './productionPolicyV2.ts';
import {
  evaluateRuleSetsPairV2,
  projectRecallRuleSetsForProductionV2,
  ruleSetsFingerprintV2,
  validateLiveRuleSetEnvelopeV2,
} from './ruleSetsV2.ts';
import type {
  AuthoritativeRecallRow,
  MatchingRunOptions,
  OwnedProductRow,
  PairClaim,
  RecallScopeRow,
} from './types.ts';

export type ReviewedScopeRowV2 = RecallScopeRow & {
  scope_id: string;
  /** A recall_rule_sets_v1 envelope (OR of reviewed all_of rule sets), or null. */
  reviewed_criteria: unknown;
};

export type V2Store = {
  listAuthoritativeRecalls(input: {
    afterRecallId: string | null;
    limit: number;
    recallNoticeIds: readonly string[] | null;
  }): Promise<readonly AuthoritativeRecallRow[]>;
  listRecallCandidateProducts(input: {
    recallNoticeId: string;
    afterExactRank: number | null;
    afterProductId: string | null;
    limit: number;
  }): Promise<readonly OwnedProductRow[]>;
  getReviewedScopes(recallNoticeId: string): Promise<readonly ReviewedScopeRowV2[]>;
  getOwnedSafetyEvidence(productId: string): Promise<OwnedProductRow>;
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

export type V2Summary = {
  recallsProcessed: number;
  candidatePairs: number;
  confirmed: number;
  rejected: number;
  needsReview: number;
  duplicateAttempts: number;
  eligibilityCreated: number;
  eligibilityRevoked: number;
  alertsCreated: number;
  errors: number;
  stale: number;
  processingLatencyMs: number;
  pairLatencyP50Ms: number;
  pairLatencyP95Ms: number;
  aiCalls: 0;
  aiCostUsd: 0;
};

/** Inactive deterministic-only worker. It has no provider imports or push path. */
export async function processRecallMatchesV2(
  limits: MatchingRunOptions,
  store: V2Store,
  now = () => performance.now(),
  createAlerts = true,
): Promise<V2Summary> {
  const started = now();
  const pairLatencies: number[] = [];
  const summary: V2Summary = {
    recallsProcessed: 0,
    candidatePairs: 0,
    confirmed: 0,
    rejected: 0,
    needsReview: 0,
    duplicateAttempts: 0,
    eligibilityCreated: 0,
    eligibilityRevoked: 0,
    alertsCreated: 0,
    errors: 0,
    stale: 0,
    processingLatencyMs: 0,
    pairLatencyP50Ms: 0,
    pairLatencyP95Ms: 0,
    aiCalls: 0,
    aiCostUsd: 0,
  };
  let afterRecallId = limits.afterRecallId ?? null;
  recallLoop: while (
    summary.recallsProcessed < limits.maxRecalls &&
    summary.candidatePairs < limits.maxCandidatePairs
  ) {
    const recallRows = await store.listAuthoritativeRecalls({
      afterRecallId,
      limit: Math.min(25, limits.maxRecalls - summary.recallsProcessed),
      recallNoticeIds: limits.recallNoticeIds ?? null,
    });
    if (!recallRows.length) break;
    for (const recall of recallRows) {
      summary.recallsProcessed += 1;
      afterRecallId = recall.recall_notice_id;
      const scopes = await store.getReviewedScopes(recall.recall_notice_id);
      if (!scopes.length) throw new Error('Authoritative v2 scope rows are unavailable.');
      const ruleSets = await Promise.all(
        scopes.map(async (scope) => {
          try {
            return await validateLiveRuleSetEnvelopeV2(recall, scope, scope.reviewed_criteria);
          } catch {
            // A stale or unsupported source binding is unresolved, never eligibility.
            return null;
          }
        }),
      );
      const projection = projectRecallRuleSetsForProductionV2({ ...recall, scopes }, ruleSets);
      const official = projection.official;
      const recallRevision = recall.recall_notice_updated_at;
      if (!recallRevision) throw new Error('Recall revision is unavailable.');
      let afterProductId: string | null = null;
      let afterExactRank: number | null = null;
      while (summary.candidatePairs < limits.maxCandidatePairs) {
        const pageSize = Math.min(50, limits.maxCandidatePairs - summary.candidatePairs);
        const candidates = await store.listRecallCandidateProducts({
          recallNoticeId: recall.recall_notice_id,
          afterExactRank,
          afterProductId,
          limit: pageSize,
        });
        if (!candidates.length) break;
        for (const candidate of candidates) {
          afterProductId = candidate.owned_product_id;
          afterExactRank = candidate.exact_rank ?? 1;
          const pairStarted = now();
          try {
            const product = await store.getOwnedSafetyEvidence(candidate.owned_product_id);
            const productRevision = product.owned_product_updated_at;
            if (
              !productRevision ||
              productRevision !== candidate.owned_product_updated_at ||
              !product.user_id
            ) {
              summary.stale += 1;
              continue;
            }
            const owned = projectOwnedProductForProductionV2(product);
            if (!retrieveRecallCandidates(owned, [official], { maxCandidates: 1 }).length) continue;
            summary.candidatePairs += 1;
            const fingerprint = await ruleSetsFingerprintV2({
              ownedProduct: owned,
              projection,
              productRevision,
              recallRevision,
            });
            const claim = await store.claimPair({
              ownedProductId: candidate.owned_product_id,
              recallNoticeId: recall.recall_notice_id,
              expectedProductUpdatedAt: productRevision,
              expectedRecallUpdatedAt: recallRevision,
              evidenceFingerprint: fingerprint,
              leaseSeconds: 300,
            });
            if (claim.status !== 'claimed') {
              if (claim.status === 'unchanged' || claim.status === 'busy')
                summary.duplicateAttempts += 1;
              else summary.stale += 1;
              continue;
            }
            const evaluation = evaluateRuleSetsPairV2(owned, projection);
            const finalized = await store.finalizeV2({
              ownedProductId: candidate.owned_product_id,
              recallNoticeId: recall.recall_notice_id,
              expectedProductUpdatedAt: productRevision,
              expectedRecallUpdatedAt: recallRevision,
              leaseToken: claim.leaseToken,
              evidenceFingerprint: fingerprint,
              status: evaluation.decision,
              confidence: evaluation.confidence,
              matchedIdentifiers: evaluation.matchedIdentifiers as JsonObject,
              reasoningSummary: evaluation.reasoningSummary,
            });
            if (finalized.status === 'stale' || finalized.status === 'missing') {
              summary.stale += 1;
              continue;
            }
            if (finalized.status === 'unchanged') {
              summary.duplicateAttempts += 1;
              if (createAlerts && evaluation.decision === 'confirmed') {
                const recovered = await store.createAlert(
                  candidate.owned_product_id,
                  recall.recall_notice_id,
                );
                if (recovered === 'created') summary.alertsCreated += 1;
              }
              continue;
            }
            if (evaluation.decision === 'confirmed') summary.confirmed += 1;
            else if (evaluation.decision === 'rejected') summary.rejected += 1;
            else summary.needsReview += 1;
            if (finalized.alertEligibility === 'created') summary.eligibilityCreated += 1;
            if (finalized.alertEligibility === 'revoked') summary.eligibilityRevoked += 1;
            if (
              createAlerts &&
              evaluation.decision === 'confirmed' &&
              finalized.alertEligibility === 'created'
            ) {
              const alert = await store.createAlert(
                candidate.owned_product_id,
                recall.recall_notice_id,
              );
              if (alert === 'created') summary.alertsCreated += 1;
            }
          } catch {
            summary.errors += 1;
          } finally {
            pairLatencies.push(Math.max(0, now() - pairStarted));
          }
          if (summary.candidatePairs >= limits.maxCandidatePairs) break recallLoop;
        }
        if (candidates.length < pageSize) break;
      }
      if (summary.recallsProcessed >= limits.maxRecalls) break recallLoop;
    }
    if (recallRows.length < 25) break;
  }
  summary.processingLatencyMs = Math.max(0, now() - started);
  pairLatencies.sort((a, b) => a - b);
  if (pairLatencies.length) {
    summary.pairLatencyP50Ms = pairLatencies[Math.ceil(pairLatencies.length * 0.5) - 1] ?? 0;
    summary.pairLatencyP95Ms = pairLatencies[Math.ceil(pairLatencies.length * 0.95) - 1] ?? 0;
  }
  return summary;
}
