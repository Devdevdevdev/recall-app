export type AutomationTrigger = 'cron' | 'manual';

export type AutomationRunRequest = {
  trigger: AutomationTrigger;
  verificationMode: boolean;
  maxRecalls: number | null;
  maxCandidatePairs: number | null;
  maxAiEscalations: number | null;
  notificationBatchSize: number | null;
};

export type AutomationClaim =
  | { status: 'skipped_disabled' | 'already_running'; runId: string }
  | {
      status: 'claimed';
      runId: string;
      leaseToken: string;
      windowStart: string;
      windowEnd: string;
      maxRecalls: number;
      maxCandidatePairs: number;
      maxAiEscalations: number;
      notificationBatchSize: number;
      aiEnabled: boolean;
      pushEnabled: boolean;
    };

export type IngestionSummary = {
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  affectedRecallIds: readonly string[];
  sourceFailures?: number;
  successfulSources?: number;
  sources?: readonly {
    sourceKey: string;
    status: 'success' | 'failed';
    errorCode?: string;
  }[];
};

export type UnresolvedMatchingReason =
  | 'stale'
  | 'busy'
  | 'failure'
  | 'provider_failure'
  | 'limit'
  | 'not_reached'
  | 'inconsistent_summary';

export type UnresolvedMatchingRecall = {
  recallNoticeId: string;
  reason: UnresolvedMatchingReason;
};

export type MatchingSummary = {
  recallsProcessed: number;
  candidatePairs: number;
  deterministicResolved: number;
  nemotronEscalated: number;
  confirmed: number;
  rejected: number;
  needsReview: number;
  alertsCreated: number;
  failures: number;
  providerFailures: number;
  limitsReached: number;
  staleSkipped?: number;
  busySkipped?: number;
  /** Per-recall resolution from the matcher; absent from pre-16.33 matchers. */
  resolvedRecallIds?: readonly string[];
  unresolvedRecalls?: readonly UnresolvedMatchingRecall[];
};

export type PushSummary = {
  claimed: number;
  accepted: number;
  failed: number;
  invalidDevices: number;
  transientFailures: number;
};

/** Aggregate counters returned by process-owned-product-checks (Phase 17.7a-1). */
export type ProductCheckWorkerSummary = {
  claimed: number;
  completed: number;
  continued: number;
  retrying: number;
  exhausted: number;
  rearmed: number;
  staleLeases: number;
  confirmed: number;
  rejected: number;
  possibleMatches: number;
  alertsCreated: number;
  aiCalls: number;
};

/**
 * Phase 17.7a-2 product-check stage. Aggregate counters only: never a product,
 * user or recall identifier.
 *   disabled  - flag false: no worker call, no claim, no job change
 *   deferred  - enabled but the run is past its start budget; jobs stay due
 *   completed - the worker answered with a valid summary
 *   failed    - plan read, worker call or worker response failed (fail closed)
 */
export type ProductCheckStageResult = {
  status: 'disabled' | 'deferred' | 'completed' | 'failed';
  /** null when the flag itself could not be read. */
  enabled: boolean | null;
  attempted: boolean;
  maxProducts: number;
  claimed: number;
  completed: number;
  continued: number;
  rearmed: number;
  staleLeases: number;
  possibleMatches: number;
  confirmedAlerts: number;
  retrying: number;
  failed: number;
  durationMs: number;
  errorCode: string | null;
};

export type AutomationRunResult = {
  status: 'success' | 'partial_success' | 'failed' | 'skipped_disabled' | 'skipped_already_running';
  runId: string;
  window: { start: string; end: string } | null;
  ingestion: IngestionSummary | null;
  matching: MatchingSummary | null;
  push: PushSummary | null;
  /** null when the run was not claimed or no product-check stage is wired. */
  productCheck: ProductCheckStageResult | null;
  errorStep: 'ingestion' | 'matching' | 'product_check' | 'push' | 'persistence' | null;
  errorCode: string | null;
};

export type AutomationStore = {
  claimRun(input: AutomationRunRequest): Promise<AutomationClaim>;
  recordIngestion(input: {
    runId: string;
    leaseToken: string;
    summary: IngestionSummary;
  }): Promise<void>;
  listPendingRecalls(input: {
    runId: string;
    leaseToken: string;
    limit: number;
  }): Promise<readonly string[]>;
  recordMatching(input: {
    runId: string;
    leaseToken: string;
    resolvedRecallIds: readonly string[];
    unresolvedRecalls: readonly UnresolvedMatchingRecall[];
    summary: MatchingSummary;
  }): Promise<void>;
  completeRun(input: {
    runId: string;
    leaseToken: string;
    status: 'success' | 'partial_success' | 'failed';
    push: PushSummary | null;
    errorStep: string | null;
    errorCode: string | null;
  }): Promise<void>;
};

export type AutomationDependencies = {
  store: AutomationStore;
  ingest(input: {
    startDate: string;
    endDate: string;
    maxRecords: number;
  }): Promise<IngestionSummary>;
  match(input: {
    recallNoticeIds: readonly string[];
    maxRecalls: number;
    maxCandidatePairs: number;
    maxAiEscalations: number;
  }): Promise<MatchingSummary>;
  push(input: { batchSize: number }): Promise<PushSummary>;
  pushDeliveryGateEnabled: boolean;
  /**
   * Phase 17.7a-2. Absent: no stage at all (pre-17.7a-2 behaviour). Present: the
   * flag is read under the run lease and the worker is called only when it is true.
   */
  productCheck?: {
    readPlan(input: { runId: string; leaseToken: string }): Promise<{ enabled: boolean }>;
    runWorker(input: { maxProducts: number }): Promise<ProductCheckWorkerSummary>;
  };
  now?: () => number;
};
