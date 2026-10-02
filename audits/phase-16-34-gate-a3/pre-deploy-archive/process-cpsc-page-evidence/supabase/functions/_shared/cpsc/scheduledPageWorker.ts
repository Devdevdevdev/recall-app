import { extractCpscPageStructure } from './htmlExtractor.ts';
import { semanticCpscRevision } from './pageEvidence.ts';
import { CpscPageFetchError, fetchCpscOfficialPage } from './pageFetcher.ts';
import { buildCpscSourceCoverage } from './sourceCoverage.ts';
import type { CpscTransportSnapshot } from './pageFetcher.ts';

export const PAGE_WORKER_MAX_PAGES = 10;
export const PAGE_WORKER_MAX_MS = 20_000;
export const PAGE_WORKER_MAX_CONCURRENCY = 2;
// 10s fetch + 4s database statement + 2s parse/serialization/cleanup.
// Claim admission additionally has a 4s role-level DB timeout.
export const PAGE_WORKER_PAGE_RESERVE_MS = 16_000;
export const PAGE_WORKER_CLAIM_RESERVE_MS = 18_000;

type Database = {
  rpc: (
    name: string,
    parameters: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

type Claim = {
  claim_id: string;
  identity_id: string;
  official_recall_number: string;
  canonical_url: string;
  sole_scope_id: string | null;
};

export type PageWorkerOptions = {
  dryRun?: boolean;
  maxPages?: number;
  timeBudgetMs?: number;
};

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CPSC page worker received a malformed database result.');
  }
  return value as Record<string, unknown>;
}

async function rpc(database: Database, name: string, parameters: Record<string, unknown>) {
  const { data, error } = await database.rpc(name, parameters);
  if (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null;
    throw new PageRpcError(name, code);
  }
  return data;
}

class PageRpcError extends Error {
  readonly operation: string;
  readonly sqlState: string | null;
  constructor(operation: string, sqlState: string | null) {
    super('CPSC page database operation failed closed.');
    this.operation = operation;
    this.sqlState = sqlState;
  }
}

export function validatePageWorkerOptions(input: unknown): Required<PageWorkerOptions> {
  const value = row(input);
  if (Object.keys(value).some((key) => !['dryRun', 'maxPages', 'timeBudgetMs'].includes(key))) {
    throw new Error('Unknown page worker option.');
  }
  const dryRun = value.dryRun ?? false;
  const maxPages = value.maxPages ?? PAGE_WORKER_MAX_PAGES;
  const timeBudgetMs = value.timeBudgetMs ?? PAGE_WORKER_MAX_MS;
  if (
    typeof dryRun !== 'boolean' ||
    !Number.isInteger(maxPages) ||
    Number(maxPages) < 1 ||
    Number(maxPages) > PAGE_WORKER_MAX_PAGES ||
    !Number.isInteger(timeBudgetMs) ||
    Number(timeBudgetMs) < 1 ||
    Number(timeBudgetMs) > PAGE_WORKER_MAX_MS
  ) {
    throw new Error('Page worker options exceed their bounds.');
  }
  return { dryRun, maxPages: Number(maxPages), timeBudgetMs: Number(timeBudgetMs) };
}

function checkedClaim(value: unknown): Claim {
  const claim = row(value);
  if (
    typeof claim.claim_id !== 'string' ||
    typeof claim.identity_id !== 'string' ||
    typeof claim.official_recall_number !== 'string' ||
    typeof claim.canonical_url !== 'string' ||
    (claim.sole_scope_id !== null && typeof claim.sole_scope_id !== 'string')
  ) {
    throw new Error('CPSC page claim is malformed.');
  }
  return claim as Claim;
}

async function finish(
  database: Database,
  claim: Claim,
  outcome: string,
  details: {
    httpStatus?: number | null;
    finalUrl?: string | null;
    rawPageHash?: string | null;
    errorCode?: string;
  } = {},
) {
  await rpc(database, 'finish_cpsc_page_attempt', {
    p_claim_id: claim.claim_id,
    p_outcome: outcome,
    p_http_status: details.httpStatus ?? null,
    p_final_url: details.finalUrl ?? null,
    p_raw_page_hash: details.rawPageHash ?? null,
    p_error_code: details.errorCode?.slice(0, 80) ?? null,
  });
  return outcome;
}

function fetchOutcome(
  error: unknown,
): 'temporary_failure' | 'permanent_unsupported' | 'identity_redirect' {
  if (!(error instanceof Error)) return 'temporary_failure';
  const status = error instanceof CpscPageFetchError ? error.httpStatus : null;
  if (status === 429 || (status !== null && status >= 500)) return 'temporary_failure';
  if (/redirect|unsafe authority|exact HTTPS recall authority/iu.test(error.message)) {
    return 'identity_redirect';
  }
  if (status !== null && status >= 400) return 'permanent_unsupported';
  if (/content type|response-size|UTF-8|no response body/iu.test(error.message)) {
    return 'permanent_unsupported';
  }
  return 'temporary_failure';
}

function fetchErrorCode(error: unknown): string {
  const status = error instanceof CpscPageFetchError ? error.httpStatus : null;
  if (status === 429) return 'http_429';
  if (status !== null && status >= 500) return 'http_5xx';
  if (status !== null && status >= 400) return 'http_4xx';
  if (!(error instanceof Error)) return 'transport_failure';
  if (/timed out/iu.test(error.message)) return 'fetch_timeout';
  if (/redirect|unsafe authority|exact HTTPS recall authority/iu.test(error.message)) {
    return 'redirect_rejected';
  }
  if (/content type|response-size|UTF-8|no response body/iu.test(error.message)) {
    return 'transport_rejected';
  }
  return 'transport_failure';
}

function snapshotMetadata(snapshot: CpscTransportSnapshot) {
  return {
    canonicalUrl: snapshot.canonicalUrl,
    finalUrl: snapshot.finalUrl,
    fetchedAt: snapshot.fetchedAt,
    httpStatus: snapshot.status,
    rawPageHash: snapshot.rawPageHash,
    contentType: snapshot.contentType.slice(0, 128),
    etag: snapshot.etag?.slice(0, 256) ?? null,
    lastModified: snapshot.lastModified?.slice(0, 128) ?? null,
    redirectChain: snapshot.redirectChain,
  };
}

function databaseFailure(error: unknown, fallback: 'evidence_rejected' | 'internal_failure') {
  if (error instanceof PageRpcError && ['57014', '55P03'].includes(error.sqlState ?? '')) {
    return { outcome: 'database_timeout', errorCode: 'database_timeout' } as const;
  }
  if (error instanceof PageRpcError && error.sqlState === '42501') {
    return { outcome: 'internal_failure', errorCode: 'claim_inactive' } as const;
  }
  if (error instanceof PageRpcError && error.operation === 'commit_cpsc_page_evidence_verified') {
    return { outcome: 'evidence_rejected', errorCode: 'semantic_commit_rejected' } as const;
  }
  return { outcome: fallback, errorCode: fallback } as const;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function processCpscPageClaim(
  database: Database,
  claim: Claim,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<string> {
  let snapshot;
  try {
    snapshot = await fetchCpscOfficialPage(claim.canonical_url, fetchImpl, { timeoutMs });
  } catch (error) {
    const outcome = fetchOutcome(error);
    return finish(database, claim, outcome, {
      httpStatus: error instanceof CpscPageFetchError ? error.httpStatus : null,
      errorCode: fetchErrorCode(error),
    });
  }
  if (snapshot.finalUrl !== claim.canonical_url) {
    return finish(database, claim, 'identity_redirect', {
      httpStatus: 200,
      finalUrl: snapshot.finalUrl,
      rawPageHash: snapshot.rawPageHash,
      errorCode: 'final_url_mismatch',
    });
  }
  const metadata = snapshotMetadata(snapshot);
  try {
    await rpc(database, 'retain_cpsc_page_transport', {
      p_claim_id: claim.claim_id,
      p_snapshot: metadata,
      p_raw_page_hex: bytesToHex(snapshot.rawBytes),
    });
  } catch (error) {
    const failure = databaseFailure(error, 'internal_failure');
    return finish(database, claim, failure.outcome, {
      httpStatus: 200,
      finalUrl: snapshot.finalUrl,
      rawPageHash: snapshot.rawPageHash,
      errorCode: failure.errorCode,
    });
  }
  let page;
  let census;
  try {
    ({ page, census } = extractCpscPageStructure(snapshot.html, claim.canonical_url));
  } catch (error) {
    // A page that declares another canonical URL is an identity question, not
    // a structure failure: it must wait for a human (Phase 16.29 page hold).
    if (error instanceof Error && /canonical link contradicts/iu.test(error.message)) {
      return finish(database, claim, 'identity_redirect', {
        httpStatus: 200,
        finalUrl: snapshot.finalUrl,
        rawPageHash: snapshot.rawPageHash,
        errorCode: 'canonical_link_mismatch',
      });
    }
    return finish(database, claim, 'unresolved_structure', {
      httpStatus: 200,
      finalUrl: snapshot.finalUrl,
      rawPageHash: snapshot.rawPageHash,
      errorCode: 'extractor_rejected',
    });
  }
  if (page.recallNumber !== claim.official_recall_number) {
    return finish(database, claim, 'identity_redirect', {
      httpStatus: 200,
      finalUrl: snapshot.finalUrl,
      rawPageHash: snapshot.rawPageHash,
      errorCode: 'recall_number_mismatch',
    });
  }
  let revision;
  let coverage;
  try {
    revision = await semanticCpscRevision(page);
    coverage = await buildCpscSourceCoverage(page, census, revision);
  } catch {
    return finish(database, claim, 'unresolved_structure', {
      httpStatus: 200,
      finalUrl: snapshot.finalUrl,
      rawPageHash: snapshot.rawPageHash,
      errorCode: 'parser_rejected',
    });
  }
  const candidates = coverage.candidates.map((candidate) => ({
    proposedScopeId: claim.sole_scope_id,
    evidenceAddress: candidate.sourceAddress,
    evidenceFingerprint: candidate.sourceAddress.evidenceFingerprint,
    kind: candidate.kind,
    value: candidate.value,
    conjunctionKey: candidate.conjunctionKey,
    authoritativeExcerpt: candidate.authoritativeExcerpt,
  }));
  let result;
  try {
    result = row(
      await rpc(database, 'commit_cpsc_page_evidence_verified', {
        p_claim_id: claim.claim_id,
        p_snapshot: metadata,
        p_revision: revision,
        p_candidates: candidates,
        p_ledger: coverage.ledger,
        p_raw_page_hex: bytesToHex(snapshot.rawBytes),
      }),
    );
  } catch (error) {
    const failure = databaseFailure(error, 'internal_failure');
    return finish(database, claim, failure.outcome, {
      httpStatus: 200,
      finalUrl: snapshot.finalUrl,
      rawPageHash: snapshot.rawPageHash,
      errorCode: failure.errorCode,
    });
  }
  if (
    !['fetched_unchanged', 'fetched_changed'].includes(String(result.outcome)) ||
    row(result.coverage).coverageFingerprint !== coverage.summary.coverageFingerprint
  ) {
    throw new Error('CPSC page commit result did not match its coverage.');
  }
  return String(result.outcome);
}

/** Claims are DB-serialized. A cycle is a bounded, independent shadow stage. */
export async function runCpscPageWorker(
  database: Database,
  input: unknown,
  dependencies: { fetchImpl?: typeof fetch; now?: () => number } = {},
) {
  const options = validatePageWorkerOptions(input);
  const now = dependencies.now ?? Date.now;
  const started = now();
  if (options.dryRun) {
    return {
      dryRun: true,
      claimed: 0,
      completed: 0,
      failed: 0,
      errorCategories: [] as string[],
      outcomes: [] as string[],
      stoppedBy: 'dry_run',
    };
  }
  const outcomes: string[] = [];
  let claimed = 0;
  let exhausted = false;
  let admissionClosed = false;
  const active = new Set<Promise<void>>();
  while (!exhausted && claimed < options.maxPages && now() - started < options.timeBudgetMs) {
    while (active.size < PAGE_WORKER_MAX_CONCURRENCY && claimed < options.maxPages) {
      const remaining = options.timeBudgetMs - (now() - started);
      if (remaining < PAGE_WORKER_CLAIM_RESERVE_MS) {
        admissionClosed = true;
        break;
      }
      const claims = await rpc(database, 'claim_cpsc_page_evidence', { p_limit: 1 });
      if (!Array.isArray(claims) || claims.length > 1) {
        throw new Error('CPSC page claim response is malformed.');
      }
      if (claims.length === 0) {
        exhausted = true;
        break;
      }
      const claim = checkedClaim(claims[0]);
      claimed++;
      if (options.timeBudgetMs - (now() - started) < PAGE_WORKER_PAGE_RESERVE_MS) {
        outcomes.push(
          await finish(database, claim, 'budget_deferred', {
            errorCode: 'cycle_deadline',
          }),
        );
        break;
      }
      const task = processCpscPageClaim(
        database,
        claim,
        dependencies.fetchImpl ?? fetch,
        Math.max(1, Math.min(10_000, options.timeBudgetMs - (now() - started))),
      )
        .then((outcome) => {
          outcomes.push(outcome);
        })
        .catch(async () => {
          // Last-resort terminalization covers unexpected post-claim exceptions.
          // A fully unavailable DB may still defeat this separate statement.
          try {
            outcomes.push(
              await finish(database, claim, 'internal_failure', {
                errorCode: 'worker_exception',
              }),
            );
          } catch {
            outcomes.push('terminalization_failed');
          }
        })
        .finally(() => {
          active.delete(task);
        });
      active.add(task);
    }
    if (active.size) await Promise.race(active);
    else break;
  }
  await Promise.all(active);
  const completed = outcomes.filter(
    (outcome) => outcome === 'fetched_unchanged' || outcome === 'fetched_changed',
  ).length;
  const failed = outcomes.length - completed;
  return {
    dryRun: false,
    claimed,
    completed,
    failed,
    errorCategories: [
      ...new Set(
        outcomes.filter(
          (outcome) => outcome !== 'fetched_unchanged' && outcome !== 'fetched_changed',
        ),
      ),
    ],
    outcomes,
    stoppedBy:
      claimed >= options.maxPages
        ? 'page_limit'
        : now() - started >= options.timeBudgetMs
          ? 'time_limit'
          : admissionClosed
            ? 'admission_budget'
            : 'queue_empty',
  };
}
