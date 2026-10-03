import type {
  IngestionSummary,
  MatchingSummary,
  ProductCheckWorkerSummary,
  PushSummary,
  UnresolvedMatchingRecall,
} from '../_shared/automation/index.ts';

const responseLimitBytes = 1024 * 1024;
const requestTimeoutMs = 150_000;
// Phase 17.7a-2: the worker bounds each product to 20 s and the automation asks for
// at most 3 products, so a slower answer is abandoned; the claimed jobs keep their
// 120 s lease and are reclaimed afterwards.
export const PRODUCT_CHECK_TIMEOUT_MS = 75_000;

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UNRESOLVED_REASONS = new Set([
  'stale',
  'busy',
  'failure',
  'provider_failure',
  'limit',
  'not_reached',
]);

function optionalCount(value: unknown): number | undefined {
  return value === undefined ? undefined : count(value);
}

function optionalRecallIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const ids = strings(value);
  if (ids.some((id) => !UUID.test(id))) throw new ChildFunctionError('invalid_child_response');
  return ids;
}

function optionalUnresolved(value: unknown): readonly UnresolvedMatchingRecall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ChildFunctionError('invalid_child_response');
  return value.map((item) => {
    const row = record(item);
    if (
      typeof row.recallNoticeId !== 'string' ||
      !UUID.test(row.recallNoticeId) ||
      typeof row.reason !== 'string' ||
      !UNRESOLVED_REASONS.has(row.reason)
    ) {
      throw new ChildFunctionError('invalid_child_response');
    }
    return {
      recallNoticeId: row.recallNoticeId,
      reason: row.reason as UnresolvedMatchingRecall['reason'],
    };
  });
}

function sourceResults(value: unknown): IngestionSummary['sources'] {
  if (!Array.isArray(value)) throw new ChildFunctionError('invalid_child_response');
  return value.map((item) => {
    const row = record(item);
    const sourceKey = row.sourceKey;
    const status = row.status;
    if (
      typeof sourceKey !== 'string' ||
      (status !== 'success' && status !== 'failed') ||
      (row.errorCode !== undefined && typeof row.errorCode !== 'string')
    ) {
      throw new ChildFunctionError('invalid_child_response');
    }
    return {
      sourceKey,
      status,
      ...(typeof row.errorCode === 'string' ? { errorCode: row.errorCode } : {}),
    };
  });
}

const PRODUCT_CHECK_FIELDS = [
  'claimed',
  'completed',
  'continued',
  'retrying',
  'exhausted',
  'rearmed',
  'staleLeases',
  'confirmed',
  'rejected',
  'possibleMatches',
  'alertsCreated',
  'aiCalls',
] as const;

// Exactly the worker's aggregate counters, internally consistent, and no AI call.
// Anything else is refused rather than partially trusted.
function productCheckSummary(
  response: Record<string, unknown>,
  maxProducts: number,
): ProductCheckWorkerSummary {
  const keys = Object.keys(response).sort();
  const expected = [...PRODUCT_CHECK_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ChildFunctionError('invalid_child_response');
  }
  const summary = Object.fromEntries(
    PRODUCT_CHECK_FIELDS.map((field) => [field, count(response[field])]),
  ) as ProductCheckWorkerSummary;
  const outcomes =
    summary.completed +
    summary.continued +
    summary.retrying +
    summary.exhausted +
    summary.rearmed +
    summary.staleLeases;
  if (
    summary.aiCalls !== 0 ||
    summary.claimed > maxProducts ||
    outcomes !== summary.claimed ||
    summary.alertsCreated > summary.confirmed
  ) {
    throw new ChildFunctionError('invalid_child_response');
  }
  return summary;
}

async function invoke(
  url: string,
  headerName: string,
  secret: string,
  body: Record<string, unknown>,
  timeoutMs = requestTimeoutMs,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
    private readonly productCheckTimeoutMs = PRODUCT_CHECK_TIMEOUT_MS,
  ) {}

  async ingest(input: {
    startDate: string;
    endDate: string;
    maxRecords: number;
  }): Promise<IngestionSummary> {
    const response = await invoke(
      `${this.functionsRoot}/ingest-recall-sources`,
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
      sourceFailures: count(response.sourceFailures),
      successfulSources: count(response.successfulSources),
      sources: sourceResults(response.sources),
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
      staleSkipped: optionalCount(response.staleSkipped),
      busySkipped: optionalCount(response.busySkipped),
      resolvedRecallIds: optionalRecallIds(response.resolvedRecallIds),
      unresolvedRecalls: optionalUnresolved(response.unresolvedRecalls),
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

  // Phase 17.7a-2: same server-held matching key the automation already sends to
  // process-recall-matches; no new secret and never the automation caller key.
  async checkProducts(input: { maxProducts: number }): Promise<ProductCheckWorkerSummary> {
    const response = await invoke(
      `${this.functionsRoot}/process-owned-product-checks`,
      'x-recall-matching-key',
      this.secrets.matching,
      { maxProducts: input.maxProducts },
      this.productCheckTimeoutMs,
    );
    return productCheckSummary(response, input.maxProducts);
  }
}
