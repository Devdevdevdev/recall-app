import type {
  AutomationDependencies,
  AutomationRunRequest,
  AutomationRunResult,
  IngestionSummary,
  MatchingSummary,
  ProductCheckStageResult,
  PushSummary,
  UnresolvedMatchingReason,
  UnresolvedMatchingRecall,
} from './types.ts';

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'unexpected_failure';
}

function incompleteMatching(summary: MatchingSummary): boolean {
  return (
    summary.failures > 0 ||
    summary.providerFailures > 0 ||
    summary.limitsReached > 0 ||
    (summary.staleSkipped ?? 0) > 0 ||
    (summary.busySkipped ?? 0) > 0
  );
}

// Partitions the requested recalls. Only a recall the matcher reports as
// resolved leaves the pending set; anything unaccounted for stays pending.
// Without per-recall data (a pre-16.33 matcher) any incompleteness keeps the
// whole batch pending, as Phase 12 did, but now including stale and busy pairs.
function partitionMatching(
  requested: readonly string[],
  summary: MatchingSummary,
): { resolved: string[]; unresolved: UnresolvedMatchingRecall[] } {
  const incomplete = incompleteMatching(summary);
  if (!summary.resolvedRecallIds || !summary.unresolvedRecalls) {
    const reason: UnresolvedMatchingReason =
      summary.providerFailures > 0
        ? 'provider_failure'
        : summary.failures > 0
          ? 'failure'
          : summary.limitsReached > 0
            ? 'limit'
            : (summary.staleSkipped ?? 0) > 0
              ? 'stale'
              : 'busy';
    return incomplete
      ? {
          resolved: [],
          unresolved: requested.map((recallNoticeId) => ({ recallNoticeId, reason })),
        }
      : { resolved: [...requested], unresolved: [] };
  }
  const reported = new Map(summary.unresolvedRecalls.map((item) => [item.recallNoticeId, item]));
  const resolvedSet = new Set(summary.resolvedRecallIds);
  const resolved: string[] = [];
  const unresolved: UnresolvedMatchingRecall[] = [];
  for (const recallNoticeId of requested) {
    const item = reported.get(recallNoticeId);
    if (item) unresolved.push({ recallNoticeId, reason: item.reason });
    else if (resolvedSet.has(recallNoticeId)) resolved.push(recallNoticeId);
    else unresolved.push({ recallNoticeId, reason: 'inconsistent_summary' });
  }
  // Counters that report unfinished work while every recall claims to be
  // resolved are contradictory; fail closed.
  if (incomplete && unresolved.length === 0) {
    return {
      resolved: [],
      unresolved: requested.map((recallNoticeId) => ({
        recallNoticeId,
        reason: 'inconsistent_summary' as const,
      })),
    };
  }
  return { resolved, unresolved };
}

function matchingErrorCode(
  summary: MatchingSummary,
  unresolved: readonly UnresolvedMatchingRecall[],
): string {
  if (summary.providerFailures > 0) return 'provider_failure';
  if (unresolved.every((item) => item.reason === 'stale' || item.reason === 'busy')) {
    return 'matching_retry_pending';
  }
  return 'matching_incomplete';
}

/**
 * Phase 17.7a-2 budget. The stage is a durable catch-up net behind the app's
 * immediate check, so it stays small: at most this many products per run
 * (each bounded to 20 s by the worker), and it is not started once the run has
 * already used this much time. Deferred jobs simply stay due.
 */
export const PRODUCT_CHECK_MAX_PRODUCTS_PER_RUN = 3;
export const PRODUCT_CHECK_LATEST_START_MS = 60_000;

async function runProductCheckStage(
  stage: NonNullable<AutomationDependencies['productCheck']>,
  lease: { runId: string; leaseToken: string },
  startedAt: number,
  now: () => number,
): Promise<ProductCheckStageResult> {
  const began = now();
  const maxProducts = PRODUCT_CHECK_MAX_PRODUCTS_PER_RUN;
  const done = (patch: Partial<ProductCheckStageResult>): ProductCheckStageResult => ({
    status: 'disabled',
    enabled: false,
    attempted: false,
    maxProducts,
    claimed: 0,
    completed: 0,
    continued: 0,
    rearmed: 0,
    staleLeases: 0,
    possibleMatches: 0,
    confirmedAlerts: 0,
    retrying: 0,
    failed: 0,
    errorCode: null,
    ...patch,
    durationMs: Math.max(0, now() - began),
  });

  let enabled: boolean;
  try {
    const plan = await stage.readPlan(lease);
    if (typeof plan?.enabled !== 'boolean') throw new Error('invalid plan');
    enabled = plan.enabled;
  } catch {
    // The flag is unknown: fail closed, never call the worker.
    return done({ status: 'failed', enabled: null, errorCode: 'product_check_plan_unavailable' });
  }
  if (!enabled) return done({ status: 'disabled', enabled: false });
  if (began - startedAt > PRODUCT_CHECK_LATEST_START_MS) {
    return done({ status: 'deferred', enabled: true });
  }

  try {
    const summary = await stage.runWorker({ maxProducts });
    if (summary.aiCalls !== 0 || summary.claimed > maxProducts) {
      return done({
        status: 'failed',
        enabled: true,
        attempted: true,
        errorCode: 'invalid_child_response',
      });
    }
    return done({
      status: 'completed',
      enabled: true,
      attempted: true,
      claimed: summary.claimed,
      completed: summary.completed,
      continued: summary.continued,
      rearmed: summary.rearmed,
      staleLeases: summary.staleLeases,
      possibleMatches: summary.possibleMatches,
      confirmedAlerts: summary.alertsCreated,
      retrying: summary.retrying,
      failed: summary.exhausted,
    });
  } catch (error) {
    // Claimed jobs keep their lease and are reclaimed after it expires: nothing is lost.
    return done({ status: 'failed', enabled: true, attempted: true, errorCode: errorCode(error) });
  }
}

type FinalStatus = 'success' | 'partial_success' | 'failed';

export async function runRecallAutomation(
  request: AutomationRunRequest,
  dependencies: AutomationDependencies,
): Promise<AutomationRunResult> {
  const now = dependencies.now ?? (() => Date.now());
  const startedAt = now();
  const claim = await dependencies.store.claimRun(request);
  if (claim.status !== 'claimed') {
    return {
      status: claim.status === 'already_running' ? 'skipped_already_running' : claim.status,
      runId: claim.runId,
      window: null,
      ingestion: null,
      matching: null,
      push: null,
      productCheck: null,
      errorStep: null,
      errorCode: null,
    };
  }

  const base = {
    runId: claim.runId,
    window: { start: claim.windowStart, end: claim.windowEnd },
  };
  let ingestion: IngestionSummary | null = null;
  let matching: MatchingSummary | null = null;
  let push: PushSummary | null = null;
  let ingestionStep: 'ingestion' | 'persistence' = 'ingestion';
  let hasSourceFailure = false;
  let productCheck: ProductCheckStageResult | null = null;
  let productCheckRan = false;

  // Phase 17.7a-2: the product-check stage runs once, after ingestion and matching
  // and before notifications, whatever their outcome: it only reads recalls that
  // are already stored. Its failure never changes an earlier error and never fails
  // the run; at worst it turns an otherwise successful run into partial_success.
  const productCheckStage = async () => {
    if (productCheckRan) return;
    productCheckRan = true;
    if (dependencies.productCheck) {
      productCheck = await runProductCheckStage(
        dependencies.productCheck,
        { runId: claim.runId, leaseToken: claim.leaseToken },
        startedAt,
        now,
      );
    }
  };

  const finish = async (
    finalStatus: FinalStatus,
    finalErrorStep: AutomationRunResult['errorStep'],
    finalErrorCode: string | null,
  ): Promise<AutomationRunResult> => {
    await productCheckStage();
    let status = finalStatus;
    let errorStep = finalErrorStep;
    let code = finalErrorCode;
    if (status === 'success' && productCheck?.status === 'failed') {
      status = 'partial_success';
      errorStep = 'product_check';
      code = productCheck.errorCode;
    }
    await dependencies.store.completeRun({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      status,
      push,
      errorStep,
      errorCode: code,
    });
    return {
      ...base,
      status,
      ingestion,
      matching,
      push,
      productCheck,
      errorStep,
      errorCode: code,
    };
  };

  try {
    ingestion = await dependencies.ingest({
      startDate: claim.windowStart,
      endDate: claim.windowEnd,
      maxRecords: claim.maxRecalls,
    });
    hasSourceFailure = (ingestion.sourceFailures ?? 0) > 0;
    if (
      ingestion.rejected > 0 ||
      ingestion.fetched !== ingestion.inserted + ingestion.updated + ingestion.unchanged ||
      ingestion.affectedRecallIds.length !== ingestion.inserted + ingestion.updated
    ) {
      const invalidIngestion = new Error('Authoritative ingestion was incomplete.') as Error & {
        code: string;
      };
      invalidIngestion.code = 'ingestion_incomplete';
      throw invalidIngestion;
    }

    ingestionStep = 'persistence';
    await dependencies.store.recordIngestion({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      summary: ingestion,
    });
  } catch (error) {
    return finish('failed', ingestionStep, errorCode(error));
  }

  let pendingRecallIds: readonly string[];
  try {
    pendingRecallIds = await dependencies.store.listPendingRecalls({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      limit: claim.maxRecalls,
    });
  } catch (error) {
    return finish('partial_success', 'persistence', errorCode(error));
  }

  if (pendingRecallIds.length) {
    try {
      matching = await dependencies.match({
        recallNoticeIds: pendingRecallIds,
        maxRecalls: Math.min(claim.maxRecalls, pendingRecallIds.length),
        maxCandidatePairs: claim.maxCandidatePairs,
        maxAiEscalations: claim.aiEnabled ? claim.maxAiEscalations : 0,
      });
      const { resolved, unresolved } = partitionMatching(pendingRecallIds, matching);
      await dependencies.store.recordMatching({
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        resolvedRecallIds: resolved,
        unresolvedRecalls: unresolved,
        summary: matching,
      });
      if (unresolved.length > 0) {
        return finish('partial_success', 'matching', matchingErrorCode(matching, unresolved));
      }
    } catch (error) {
      return finish('partial_success', 'matching', errorCode(error));
    }
  }

  if (hasSourceFailure) {
    return finish('partial_success', 'ingestion', 'source_partial_failure');
  }

  await productCheckStage();

  if (claim.pushEnabled && dependencies.pushDeliveryGateEnabled) {
    try {
      push = await dependencies.push({ batchSize: claim.notificationBatchSize });
    } catch (error) {
      return finish('partial_success', 'push', errorCode(error));
    }
  }

  return finish('success', null, null);
}
