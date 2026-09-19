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
};

export type PushSummary = {
  claimed: number;
  accepted: number;
  failed: number;
  invalidDevices: number;
  transientFailures: number;
};

export type AutomationRunResult = {
  status: 'success' | 'partial_success' | 'failed' | 'skipped_disabled' | 'skipped_already_running';
  runId: string;
  window: { start: string; end: string } | null;
  ingestion: IngestionSummary | null;
  matching: MatchingSummary | null;
  push: PushSummary | null;
  errorStep: 'ingestion' | 'matching' | 'push' | 'persistence' | null;
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
    recallNoticeIds: readonly string[];
    complete: boolean;
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
};
