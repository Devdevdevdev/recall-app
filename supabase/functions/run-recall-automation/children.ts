import type {
  IngestionSummary,
  MatchingSummary,
  PushSummary,
} from '../_shared/automation/index.ts';

const responseLimitBytes = 1024 * 1024;
const requestTimeoutMs = 150_000;

export class ChildFunctionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ChildFunctionError';
  }
}

type ChildSecrets = {
  ingestion: string;
  matching: string;
  push: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChildFunctionError('invalid_child_response');
  }
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new ChildFunctionError('invalid_child_response');
  }
  return Number(value);
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ChildFunctionError('invalid_child_response');
  }
  return value as string[];
}

async function invoke(
  url: string,
  headerName: string,
  secret: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [headerName]: secret },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > responseLimitBytes) {
      throw new ChildFunctionError('child_response_too_large');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > responseLimitBytes) {
      throw new ChildFunctionError('child_response_too_large');
    }
    if (!response.ok) throw new ChildFunctionError(`child_http_${response.status}`);
    return record(JSON.parse(new TextDecoder().decode(buffer)));
  } catch (error) {
    if (error instanceof ChildFunctionError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ChildFunctionError('child_timeout');
    }
    throw new ChildFunctionError('child_unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

export class RecallAutomationChildren {
  constructor(
    private readonly functionsRoot: string,
    private readonly secrets: ChildSecrets,
  ) {}

  async ingest(input: {
    startDate: string;
    endDate: string;
    maxRecords: number;
  }): Promise<IngestionSummary> {
    const response = await invoke(
      `${this.functionsRoot}/ingest-cpsc-recalls`,
      'x-recall-ingestion-key',
      this.secrets.ingestion,
      {
        startDate: input.startDate,
        endDate: input.endDate,
        dryRun: false,
        maxRecords: input.maxRecords,
      },
    );
    const stats = record(response.stats);
    return {
      fetched: count(stats.fetched),
      inserted: count(stats.inserted),
      updated: count(stats.updated),
      unchanged: count(stats.unchanged),
      rejected: count(stats.rejected),
      affectedRecallIds: strings(response.affectedRecallIds),
    };
  }

  async match(input: {
    recallNoticeIds: readonly string[];
    maxRecalls: number;
    maxCandidatePairs: number;
    maxAiEscalations: number;
  }): Promise<MatchingSummary> {
    const response = await invoke(
      `${this.functionsRoot}/process-recall-matches`,
      'x-recall-matching-key',
      this.secrets.matching,
      {
        recallNoticeIds: input.recallNoticeIds,
        maxRecalls: input.maxRecalls,
        maxCandidatePairs: input.maxCandidatePairs,
        maxNebiusCalls: input.maxAiEscalations,
        deliverPush: false,
      },
    );
    return {
      recallsProcessed: count(response.recallsProcessed),
      candidatePairs: count(response.candidatePairs),
      deterministicResolved: count(response.deterministicResolved),
      nemotronEscalated: count(response.nemotronEscalated),
      confirmed: count(response.confirmed),
      rejected: count(response.rejected),
      needsReview: count(response.needsReview),
      alertsCreated: count(response.alertsCreated),
      failures: count(response.failures),
      providerFailures: count(response.providerFailures),
      limitsReached: count(response.limitsReached),
    };
  }

  async push(input: { batchSize: number }): Promise<PushSummary> {
    const response = await invoke(
      `${this.functionsRoot}/send-recall-notifications`,
      'x-recall-push-delivery-key',
      this.secrets.push,
      { alertIds: null, batchSize: input.batchSize, checkReceipts: true },
    );
    return {
      claimed: count(response.claimed),
      accepted: count(response.accepted),
      failed: count(response.failed),
      invalidDevices: count(response.invalidDevices),
      transientFailures: count(response.transientFailures),
    };
  }
}
