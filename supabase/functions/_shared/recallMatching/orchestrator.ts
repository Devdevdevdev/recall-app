import type { GuardedNemotronAttempt } from '../matching/guardedNemotronMatcher.ts';
import { evaluateHybridGuardedMatch } from '../matching/hybridGuardedMatcher.ts';
import { evaluateDeterministicMatch } from '../matching/deterministicMatcher.ts';
import { retrieveRecallCandidates } from '../matching/candidateRetrieval.ts';
import {
  MATCH_EVALUATION_SCHEMA_VERSION,
  NEBIUS_AI_PROVIDER,
  type JsonObject,
  type MatchEvaluationCore,
} from '../matching/types.ts';
import { buildEvidenceFingerprint } from './fingerprint.ts';
import { projectAuthoritativeRecall, projectOwnedProduct } from './projection.ts';
import type {
  GuardedEvaluator,
  MatchingRunOptions,
  OperationalLogger,
  RecallMatchingStore,
} from './types.ts';

const RECALL_PAGE_SIZE = 25;
const CANDIDATE_PAGE_SIZE = 50;
const PAIR_LEASE_SECONDS = 300;

type NullableUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type RecallMatchingSummary = {
  recallsProcessed: number;
  candidatePairs: number;
  deterministicResolved: number;
  nemotronEscalated: number;
  confirmed: number;
  rejected: number;
  needsReview: number;
  alertsCreated: number;
  alertsExisting: number;
  failures: number;
  retries: number;
  duration: number;
  unchangedSkipped: number;
  busySkipped: number;
  staleSkipped: number;
  providerFailures: number;
  limitsReached: number;
  usage: NullableUsage;
};

export type RecallMatchingDependencies = {
  store: RecallMatchingStore;
  modelId: string;
  createNemotronEvaluator: () => GuardedEvaluator;
  logger?: OperationalLogger;
  now?: () => number;
};

function emptySummary(): RecallMatchingSummary {
  return {
    recallsProcessed: 0,
    candidatePairs: 0,
    deterministicResolved: 0,
    nemotronEscalated: 0,
    confirmed: 0,
    rejected: 0,
    needsReview: 0,
    alertsCreated: 0,
    alertsExisting: 0,
    failures: 0,
    retries: 0,
    duration: 0,
    unchangedSkipped: 0,
    busySkipped: 0,
    staleSkipped: 0,
    providerFailures: 0,
    limitsReached: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return left + right;
}

function revision(value: string | null | undefined, kind: string): string {
  if (!value) throw new Error(`${kind} revision is unavailable.`);
  return value;
}

function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

function noRetryAfterBudget(
  evaluate: GuardedEvaluator,
  canCall: () => boolean,
  recordCall: () => void,
): GuardedEvaluator {
  return async (input) => {
    if (!canCall()) {
      return {
        output: null,
        structuredOutputValid: false,
        apiSucceeded: false,
        failureKind: 'invalid_request',
        retryEligible: false,
        transportRetries: 0,
        latencyMs: 0,
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          reasoningTokens: null,
        },
      };
    }
    recordCall();
    const attempt: GuardedNemotronAttempt = await evaluate(input);
    return canCall() ? attempt : { ...attempt, retryEligible: false };
  };
}

export function safeMatchingSummary(summary: RecallMatchingSummary): Record<string, number> {
  return {
    recallsProcessed: summary.recallsProcessed,
    candidatePairs: summary.candidatePairs,
    deterministicResolved: summary.deterministicResolved,
    nemotronEscalated: summary.nemotronEscalated,
    confirmed: summary.confirmed,
    rejected: summary.rejected,
    needsReview: summary.needsReview,
    alertsCreated: summary.alertsCreated,
    alertsExisting: summary.alertsExisting,
    failures: summary.failures,
    retries: summary.retries,
    duration: summary.duration,
  };
}

export async function processRecallMatches(
  limits: MatchingRunOptions,
  dependencies: RecallMatchingDependencies,
): Promise<RecallMatchingSummary> {
  const now = dependencies.now ?? (() => performance.now());
  const startedAt = now();
  const summary = emptySummary();
  let afterRecallId: string | null = limits.afterRecallId ?? null;
  let evaluator: GuardedEvaluator | null = null;
  let providerUnavailable = false;
  let nebiusCalls = 0;

  recallLoop: while (
    summary.recallsProcessed < limits.maxRecalls &&
    summary.candidatePairs < limits.maxCandidatePairs
  ) {
    const recallLimit = Math.min(RECALL_PAGE_SIZE, limits.maxRecalls - summary.recallsProcessed);
    const recallRows = await dependencies.store.listAuthoritativeRecalls({
      afterRecallId,
      limit: recallLimit,
      recallNoticeIds: limits.recallNoticeIds ?? null,
    });
    if (!recallRows.length) break;

    for (const recallRow of recallRows.slice(0, recallLimit)) {
      summary.recallsProcessed += 1;
      afterRecallId = recallRow.recall_notice_id;
      let afterProductId: string | null = null;
      let afterExactRank: number | null = null;
      const officialRecall = projectAuthoritativeRecall(recallRow);
      const recallRevision = revision(
        recallRow.recall_notice_updated_at ?? recallRow.retrieved_at,
        'Recall',
      );

      while (summary.candidatePairs < limits.maxCandidatePairs) {
        const productLimit = Math.min(
          CANDIDATE_PAGE_SIZE,
          limits.maxCandidatePairs - summary.candidatePairs,
        );
        const productRows = await dependencies.store.listRecallCandidateProducts({
          recallNoticeId: recallRow.recall_notice_id,
          afterExactRank,
          afterProductId,
          limit: productLimit,
        });
        if (!productRows.length) break;

        for (const productRow of productRows.slice(0, productLimit)) {
          afterProductId = productRow.owned_product_id;
          afterExactRank = productRow.exact_rank ?? 1;
          const ownedProduct = projectOwnedProduct(productRow);
          if (
            retrieveRecallCandidates(ownedProduct, [officialRecall], { maxCandidates: 1 })
              .length === 0
          ) {
            continue;
          }
          summary.candidatePairs += 1;
          const fingerprint = await buildEvidenceFingerprint({
            ownedProduct,
            officialRecall,
            rawPayload: recallRow.raw_payload,
            modelId: dependencies.modelId,
          });
          const productRevision = revision(
            productRow.owned_product_updated_at ?? productRow.updated_at,
            'Product',
          );

          try {
            const claim = await dependencies.store.claimPair({
              ownedProductId: productRow.owned_product_id,
              recallNoticeId: recallRow.recall_notice_id,
              expectedProductUpdatedAt: productRevision,
              expectedRecallUpdatedAt: recallRevision,
              evidenceFingerprint: fingerprint,
              leaseSeconds: PAIR_LEASE_SECONDS,
            });
            if (claim.status !== 'claimed') {
              if (claim.status === 'unchanged') summary.unchangedSkipped += 1;
              else if (claim.status === 'busy') summary.busySkipped += 1;
              else summary.staleSkipped += 1;
              continue;
            }

            const matchingInput = { ownedProduct, officialRecall };
            const deterministic = evaluateDeterministicMatch(ownedProduct, officialRecall);
            let evaluation: MatchEvaluationCore & {
              matchMethod: 'deterministic_v1' | 'hybrid_guarded_v1';
              schemaVersion: string;
            } = deterministic;
            let aiProvider: 'nebius' | null = null;
            let aiModel: string | null = null;

            if (deterministic.decision !== 'needs_review') {
              summary.deterministicResolved += 1;
            } else if (nebiusCalls >= limits.maxNebiusCalls) {
              summary.limitsReached += 1;
            } else if (providerUnavailable) {
              summary.failures += 1;
            } else {
              try {
                evaluator ??= dependencies.createNemotronEvaluator();
                const callsBefore = nebiusCalls;
                const result = await evaluateHybridGuardedMatch(
                  matchingInput,
                  noRetryAfterBudget(
                    evaluator,
                    () => nebiusCalls < limits.maxNebiusCalls,
                    () => {
                      nebiusCalls += 1;
                    },
                  ),
                  dependencies.modelId,
                );
                if (nebiusCalls > callsBefore) summary.nemotronEscalated += 1;
                evaluation = result.evaluation;
                aiProvider = result.trace.aiEscalated ? NEBIUS_AI_PROVIDER : null;
                aiModel = result.trace.aiEscalated ? dependencies.modelId : null;
                summary.retries += result.orchestrationRetries + result.transportRetries;
                summary.usage.inputTokens = addNullable(
                  summary.usage.inputTokens,
                  result.usage.inputTokens,
                );
                summary.usage.outputTokens = addNullable(
                  summary.usage.outputTokens,
                  result.usage.outputTokens,
                );
                summary.usage.totalTokens = addNullable(
                  summary.usage.totalTokens,
                  result.usage.totalTokens,
                );
                if (result.trace.aiTechnicalFailure) {
                  summary.failures += 1;
                  summary.providerFailures += 1;
                  if (
                    ['authentication', 'authorization', 'invalid_request'].includes(
                      result.trace.aiTechnicalFailure,
                    )
                  ) {
                    providerUnavailable = true;
                  }
                }
              } catch {
                providerUnavailable = true;
                summary.failures += 1;
                summary.providerFailures += 1;
              }
            }

            const finalization = await dependencies.store.finalizePair({
              ownedProductId: productRow.owned_product_id,
              recallNoticeId: recallRow.recall_notice_id,
              expectedProductUpdatedAt: productRevision,
              expectedRecallUpdatedAt: recallRevision,
              leaseToken: claim.leaseToken,
              evidenceFingerprint: fingerprint,
              status: evaluation.decision,
              confidence: evaluation.confidence,
              matchMethod: evaluation.matchMethod,
              matchedIdentifiers: asJsonObject(evaluation.matchedIdentifiers),
              reasoningSummary: evaluation.reasoningSummary,
              aiProvider,
              aiModel,
              schemaVersion: evaluation.schemaVersion ?? MATCH_EVALUATION_SCHEMA_VERSION,
            });
            if (finalization.status === 'stale' || finalization.status === 'missing') {
              summary.staleSkipped += 1;
              continue;
            }
            if (evaluation.decision === 'confirmed') summary.confirmed += 1;
            else if (evaluation.decision === 'rejected') summary.rejected += 1;
            else summary.needsReview += 1;
            if (finalization.alertOutcome === 'created') summary.alertsCreated += 1;
            else if (finalization.alertOutcome === 'existing') summary.alertsExisting += 1;
          } catch {
            summary.failures += 1;
            dependencies.logger?.error('recall_matching_pair_failed', {
              failures: summary.failures,
            });
          }

          if (summary.candidatePairs >= limits.maxCandidatePairs) {
            summary.limitsReached += 1;
            break recallLoop;
          }
        }

        if (productRows.length < productLimit) break;
      }

      if (summary.recallsProcessed >= limits.maxRecalls) break recallLoop;
    }
    if (recallRows.length < recallLimit) break;
  }

  summary.duration = Math.max(0, now() - startedAt);
  dependencies.logger?.info('recall_matching_run_complete', safeMatchingSummary(summary));
  return summary;
}
