import type {
  AutomationDependencies,
  AutomationRunRequest,
  AutomationRunResult,
  MatchingSummary,
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
  return summary.failures > 0 || summary.providerFailures > 0 || summary.limitsReached > 0;
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

  try {
    ingestion = await dependencies.ingest({
      startDate: claim.windowStart,
      endDate: claim.windowEnd,
      maxRecords: claim.maxRecalls,
    });
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
      const complete = !incompleteMatching(matching);
      await dependencies.store.recordMatching({
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        recallNoticeIds: pendingRecallIds,
        complete,
        summary: matching,
      });
      if (!complete) {
        await dependencies.store.completeRun({
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          status: 'partial_success',
          push: null,
          errorStep: 'matching',
          errorCode: matching.providerFailures > 0 ? 'provider_failure' : 'matching_incomplete',
        });
        return {
          ...base,
          status: 'partial_success',
          ingestion,
          matching,
          push: null,
          errorStep: 'matching',
          errorCode: matching.providerFailures > 0 ? 'provider_failure' : 'matching_incomplete',
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
