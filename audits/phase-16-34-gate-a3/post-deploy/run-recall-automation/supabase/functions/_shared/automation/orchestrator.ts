import type {
  AutomationDependencies,
  AutomationRunRequest,
  AutomationRunResult,
  MatchingSummary,
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

export async function runRecallAutomation(
  request: AutomationRunRequest,
  dependencies: AutomationDependencies,
): Promise<AutomationRunResult> {
  const claim = await dependencies.store.claimRun(request);
  if (claim.status !== 'claimed') {
    return {
      status: claim.status === 'already_running' ? 'skipped_already_running' : claim.status,
      runId: claim.runId,
      window: null,
      ingestion: null,
      matching: null,
      push: null,
      errorStep: null,
      errorCode: null,
    };
  }

  const base = {
    runId: claim.runId,
    window: { start: claim.windowStart, end: claim.windowEnd },
  };
  let ingestion = null;
  let matching = null;
  let push = null;
  let ingestionStep: 'ingestion' | 'persistence' = 'ingestion';
  let hasSourceFailure = false;

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
    const code = errorCode(error);
    await dependencies.store.completeRun({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      status: 'failed',
      push: null,
      errorStep: ingestionStep,
      errorCode: code,
    });
    return {
      ...base,
      status: 'failed',
      ingestion,
      matching: null,
      push: null,
      errorStep: ingestionStep,
      errorCode: code,
    };
  }

  let pendingRecallIds: readonly string[];
  try {
    pendingRecallIds = await dependencies.store.listPendingRecalls({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      limit: claim.maxRecalls,
    });
  } catch (error) {
    const code = errorCode(error);
    await dependencies.store.completeRun({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      status: 'partial_success',
      push: null,
      errorStep: 'persistence',
      errorCode: code,
    });
    return {
      ...base,
      status: 'partial_success',
      ingestion,
      matching: null,
      push: null,
      errorStep: 'persistence',
      errorCode: code,
    };
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
        const code = matchingErrorCode(matching, unresolved);
        await dependencies.store.completeRun({
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          status: 'partial_success',
          push: null,
          errorStep: 'matching',
          errorCode: code,
        });
        return {
          ...base,
          status: 'partial_success',
          ingestion,
          matching,
          push: null,
          errorStep: 'matching',
          errorCode: code,
        };
      }
    } catch (error) {
      const code = errorCode(error);
      await dependencies.store.completeRun({
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        status: 'partial_success',
        push: null,
        errorStep: 'matching',
        errorCode: code,
      });
      return {
        ...base,
        status: 'partial_success',
        ingestion,
        matching,
        push: null,
        errorStep: 'matching',
        errorCode: code,
      };
    }
  }

  if (hasSourceFailure) {
    await dependencies.store.completeRun({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      status: 'partial_success',
      push: null,
      errorStep: 'ingestion',
      errorCode: 'source_partial_failure',
    });
    return {
      ...base,
      status: 'partial_success',
      ingestion,
      matching,
      push: null,
      errorStep: 'ingestion',
      errorCode: 'source_partial_failure',
    };
  }

  if (claim.pushEnabled && dependencies.pushDeliveryGateEnabled) {
    try {
      push = await dependencies.push({ batchSize: claim.notificationBatchSize });
    } catch (error) {
      const code = errorCode(error);
      await dependencies.store.completeRun({
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        status: 'partial_success',
        push: null,
        errorStep: 'push',
        errorCode: code,
      });
      return {
        ...base,
        status: 'partial_success',
        ingestion,
        matching,
        push: null,
        errorStep: 'push',
        errorCode: code,
      };
    }
  }

  await dependencies.store.completeRun({
    runId: claim.runId,
    leaseToken: claim.leaseToken,
    status: 'success',
    push,
    errorStep: null,
    errorCode: null,
  });
  return {
    ...base,
    status: 'success',
    ingestion,
    matching,
    push,
    errorStep: null,
    errorCode: null,
  };
}
