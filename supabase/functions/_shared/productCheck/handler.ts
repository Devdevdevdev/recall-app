import {
  runOwnedProductCheck,
  type ProductCheckClaim,
  type ProductCheckCursor,
  type ProductCheckPairStore,
  type ProductCheckResult,
  type ProductCheckRetryReason,
} from './orchestrator.ts';

export type MonitoringState =
  | 'pending_check'
  | 'checking'
  | 'monitored_no_known_recall'
  | 'possible_match_needs_verification'
  | 'recall_detected'
  | 'check_failed_retrying'
  | 'check_failed';

export type MonitoringSnapshot = {
  state: MonitoringState;
  checkedAt: string | null;
  possibleMatches: number;
  confirmedAlerts: number;
  retrying: boolean;
};

export type UserClaimResult =
  | { status: 'not_found' }
  | {
      status: 'disabled' | 'complete' | 'busy' | 'not_due' | 'rate_limited';
      snapshot: MonitoringSnapshot;
    }
  | { status: 'claimed'; claim: ProductCheckClaim; snapshot: MonitoringSnapshot };

export type CompletionInput = {
  ownedProductId: string;
  leaseToken: string;
  matchingRevision: number;
  outcome: 'complete' | 'continue' | 'retry';
  error: ProductCheckRetryReason | null;
  cursor: ProductCheckCursor | null;
  path: 'user' | 'worker';
};

export type CompletionResult = {
  status:
    'completed' | 'continued' | 'retrying' | 'exhausted' | 'rearmed' | 'stale_lease' | 'missing';
  snapshot: MonitoringSnapshot | null;
};

export type ProductCheckJobStore = {
  claimForUser(input: { ownedProductId: string; userId: string }): Promise<UserClaimResult>;
  claimDue(limit: number): Promise<readonly ProductCheckClaim[]>;
  complete(input: CompletionInput): Promise<CompletionResult>;
};

export type ProductCheckStores = { jobs: ProductCheckJobStore; pairs: ProductCheckPairStore };

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u;
export const USER_CHECK_TIME_BUDGET_MS = 15_000;
export const WORKER_PRODUCT_TIME_BUDGET_MS = 20_000;
export const MAX_WORKER_PRODUCTS = 25;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Exactly `{ "ownedProductId": "<uuid>" }`. No user id, list, or bound can be supplied. */
export function parseCheckOwnedProductRequest(value: unknown): { ownedProductId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object.');
  }
  const keys = Object.keys(value);
  const id = (value as Record<string, unknown>).ownedProductId;
  if (
    keys.length !== 1 ||
    keys[0] !== 'ownedProductId' ||
    typeof id !== 'string' ||
    !UUID.test(id)
  ) {
    throw new Error('Request body must contain exactly one ownedProductId UUID.');
  }
  return { ownedProductId: id.toLowerCase() };
}

export function parseWorkerRequest(value: unknown): { maxProducts: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object.');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'maxProducts')) {
    throw new Error('Unknown request field.');
  }
  const maxProducts = input.maxProducts ?? 5;
  if (
    !Number.isInteger(maxProducts) ||
    Number(maxProducts) < 1 ||
    Number(maxProducts) > MAX_WORKER_PRODUCTS
  ) {
    throw new Error(`maxProducts must be an integer between 1 and ${MAX_WORKER_PRODUCTS}.`);
  }
  return { maxProducts: Number(maxProducts) };
}

export function bearerToken(request: Request): string | null {
  return BEARER.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
}

function responseBody(snapshot: MonitoringSnapshot | null) {
  return {
    state: snapshot?.state ?? 'pending_check',
    checkedAt: snapshot?.checkedAt ?? null,
    possibleMatches: snapshot?.possibleMatches ?? 0,
    confirmedAlerts: snapshot?.confirmedAlerts ?? 0,
    retrying: snapshot?.retrying ?? false,
  };
}

async function runAndComplete(
  claim: ProductCheckClaim,
  stores: ProductCheckStores,
  path: 'user' | 'worker',
  deadline: number,
): Promise<{ result: ProductCheckResult | null; completion: CompletionResult }> {
  let result: ProductCheckResult | null = null;
  try {
    result = await runOwnedProductCheck(claim, stores.pairs, { deadline });
  } catch {
    result = null;
  }
  const outcome = result?.outcome ?? 'retry';
  const completion = await stores.jobs.complete({
    ownedProductId: claim.ownedProductId,
    leaseToken: claim.leaseToken,
    matchingRevision: claim.matchingRevision,
    outcome,
    error: result === null ? 'failure' : result.outcome === 'retry' ? result.error : null,
    cursor: result?.outcome === 'continue' ? result.cursor : null,
    path,
  });
  return { result, completion };
}

export type UserHandlerDependencies = {
  /** Verifies the bearer token with the auth server; returns the user id or null. */
  authenticate(token: string): Promise<string | null>;
  createStores(): ProductCheckStores;
  now?: () => number;
};

/** User path: one owned product, verified JWT, bounded immediate work, no AI. */
export function createCheckOwnedProductHandler(deps: UserHandlerDependencies) {
  const now = deps.now ?? (() => Date.now());
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
    const token = bearerToken(request);
    if (!token) return json(401, { error: 'Unauthorized.' });
    let userId: string | null;
    try {
      userId = await deps.authenticate(token);
    } catch {
      userId = null;
    }
    if (!userId) return json(401, { error: 'Unauthorized.' });

    let ownedProductId: string;
    try {
      ownedProductId = parseCheckOwnedProductRequest(await request.json()).ownedProductId;
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
    }

    let stores: ProductCheckStores;
    let claimed: UserClaimResult;
    try {
      stores = deps.createStores();
      claimed = await stores.jobs.claimForUser({ ownedProductId, userId });
    } catch {
      return json(503, { error: 'Product check is temporarily unavailable.' });
    }
    if (claimed.status === 'not_found') return json(404, { error: 'Product not found.' });
    if (claimed.status === 'rate_limited') return json(429, responseBody(claimed.snapshot));
    if (claimed.status !== 'claimed') return json(200, responseBody(claimed.snapshot));

    try {
      const { completion } = await runAndComplete(
        claimed.claim,
        stores,
        'user',
        now() + USER_CHECK_TIME_BUDGET_MS,
      );
      return json(200, responseBody(completion.snapshot ?? claimed.snapshot));
    } catch {
      // The product stays saved; the job lease expires and the check is retried.
      return json(200, { ...responseBody(claimed.snapshot), retrying: true });
    }
  };
}

export type WorkerHandlerDependencies = {
  authorized(request: Request): boolean;
  createStores(): ProductCheckStores;
  now?: () => number;
};

/** Admin worker (local only in 17.7a-1): bounded batch of due jobs, aggregate counters. */
export function createProductCheckWorkerHandler(deps: WorkerHandlerDependencies) {
  const now = deps.now ?? (() => Date.now());
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
    if (!deps.authorized(request)) return json(401, { error: 'Unauthorized.' });
    let maxProducts: number;
    try {
      maxProducts = parseWorkerRequest(await request.json()).maxProducts;
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
    }
    const summary = {
      claimed: 0,
      completed: 0,
      continued: 0,
      retrying: 0,
      exhausted: 0,
      rearmed: 0,
      staleLeases: 0,
      confirmed: 0,
      rejected: 0,
      possibleMatches: 0,
      alertsCreated: 0,
      aiCalls: 0,
    };
    try {
      const stores = deps.createStores();
      const claims = await stores.jobs.claimDue(maxProducts);
      for (const claim of claims) {
        summary.claimed += 1;
        const { result, completion } = await runAndComplete(
          claim,
          stores,
          'worker',
          now() + WORKER_PRODUCT_TIME_BUDGET_MS,
        );
        if (completion.status === 'completed') summary.completed += 1;
        else if (completion.status === 'continued') summary.continued += 1;
        else if (completion.status === 'retrying') summary.retrying += 1;
        else if (completion.status === 'exhausted') summary.exhausted += 1;
        else if (completion.status === 'rearmed') summary.rearmed += 1;
        else summary.staleLeases += 1;
        summary.confirmed += result?.counters.confirmed ?? 0;
        summary.rejected += result?.counters.rejected ?? 0;
        summary.possibleMatches += result?.counters.possibleMatches ?? 0;
        summary.alertsCreated += result?.counters.alertsCreated ?? 0;
      }
      return json(200, summary);
    } catch {
      return json(500, { error: 'Product check worker failed closed.' });
    }
  };
}
