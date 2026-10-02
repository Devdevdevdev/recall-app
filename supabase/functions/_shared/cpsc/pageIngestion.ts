import { extractCpscPageStructure } from './htmlExtractor.ts';
import { CPSC_PAGE_PARSER_VERSION, semanticCpscRevision } from './pageEvidence.ts';
import { CpscPageFetchError, fetchCpscOfficialPage } from './pageFetcher.ts';
import { buildCpscSourceCoverage, type CpscCoverageSummary } from './sourceCoverage.ts';

type WorkerDatabase = {
  rpc: (
    name: string,
    parameters: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type CpscPageTarget = {
  identityId: string;
  officialRecallNumber: string;
  canonicalUrl: string;
  soleScopeId: string | null;
};

export type CpscPageIngestionResult =
  | {
      status: 'recorded';
      revisionId: string;
      revisionStatus: 'created' | 'unchanged' | 'reverted';
      fetchId: string;
      proposalsCreated: number;
      proposalsUnchanged: number;
      unresolved: string[];
      coverage: Pick<
        CpscCoverageSummary,
        | 'coverageStatus'
        | 'structuralStatus'
        | 'criterionStatus'
        | 'positiveStatus'
        | 'negativeEvidenceEligible'
        | 'coverageFingerprint'
      >;
    }
  | { status: 'fetch_failed' | 'extraction_failed'; reason: string };

async function call(database: WorkerDatabase, name: string, parameters: Record<string, unknown>) {
  const { data, error } = await database.rpc(name, parameters);
  if (error) throw new Error(`CPSC worker RPC ${name} failed closed.`);
  return data;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CPSC worker RPC returned an invalid result.');
  }
  return value as Record<string, unknown>;
}

/** Fetch targets are authority-derived identity rows, never caller input. */
export async function listCpscPageTargets(
  database: WorkerDatabase,
  limit: number,
): Promise<CpscPageTarget[]> {
  const rows = await call(database, 'get_cpsc_page_fetch_targets', { p_limit: limit });
  if (!Array.isArray(rows)) throw new Error('CPSC page targets are unavailable.');
  return rows.map((raw) => {
    const row = record(raw);
    if (
      typeof row.identity_id !== 'string' ||
      typeof row.official_recall_number !== 'string' ||
      typeof row.canonical_url !== 'string' ||
      (row.sole_scope_id !== null && typeof row.sole_scope_id !== 'string')
    ) {
      throw new Error('CPSC page target is malformed.');
    }
    return {
      identityId: row.identity_id,
      officialRecallNumber: row.official_recall_number,
      canonicalUrl: row.canonical_url,
      soleScopeId: row.sole_scope_id as string | null,
    };
  });
}

/**
 * Inactive worker path: persists page evidence and UNREVIEWED proposals only.
 * It has no route to the review ledger or to matcher criteria.
 */
export async function ingestCpscOfficialPage(
  database: WorkerDatabase,
  target: CpscPageTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<CpscPageIngestionResult> {
  let snapshot;
  try {
    snapshot = await fetchCpscOfficialPage(target.canonicalUrl, fetchImpl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'CPSC page fetch failed.';
    const status = error instanceof CpscPageFetchError ? error.httpStatus : null;
    if (status !== null && status !== 200) {
      await call(database, 'record_cpsc_page_fetch', {
        p_identity_id: target.identityId,
        p_revision_id: null,
        p_fetched_at: new Date().toISOString(),
        p_http_status: status,
        p_raw_page_hash: null,
        p_final_url: target.canonicalUrl,
        p_content_type: null,
        p_etag: null,
        p_last_modified: null,
        p_redirect_chain: [],
        p_fetch_error: reason.slice(0, 500),
      });
    }
    return { status: 'fetch_failed', reason };
  }

  let page;
  let census;
  try {
    ({ page, census } = extractCpscPageStructure(snapshot.html, target.canonicalUrl));
    if (page.recallNumber !== target.officialRecallNumber) {
      throw new Error('CPSC page recall number contradicts its identity.');
    }
  } catch (error) {
    return {
      status: 'extraction_failed',
      reason: error instanceof Error ? error.message : 'CPSC page extraction failed.',
    };
  }

  const revision = await semanticCpscRevision(page);
  const recorded = record(
    await call(database, 'record_cpsc_page_revision', {
      p_identity_id: target.identityId,
      p_evidence_hash: revision.semanticHash,
      p_normalized_evidence: revision.normalized,
      p_section_hashes: revision.sections,
      p_table_identities: revision.tableIdentities,
      p_parser_version: revision.parserVersion,
    }),
  );
  if (
    typeof recorded.revisionId !== 'string' ||
    !['created', 'unchanged', 'reverted'].includes(String(recorded.status))
  ) {
    throw new Error('CPSC page revision result is malformed.');
  }
  const fetchId = await call(database, 'record_cpsc_page_fetch', {
    p_identity_id: target.identityId,
    p_revision_id: recorded.revisionId,
    p_fetched_at: snapshot.fetchedAt,
    p_http_status: 200,
    p_raw_page_hash: snapshot.rawPageHash,
    p_final_url: snapshot.finalUrl,
    p_content_type: snapshot.contentType.slice(0, 128),
    p_etag: snapshot.etag?.slice(0, 256) ?? null,
    p_last_modified: snapshot.lastModified?.slice(0, 128) ?? null,
    p_redirect_chain: snapshot.redirectChain,
    p_fetch_error: null,
  });
  if (typeof fetchId !== 'string') throw new Error('CPSC page fetch result is malformed.');

  // Candidates survive only when the census shows nothing unresolved could restrict them.
  const { candidates, unresolved, ledger, summary } = await buildCpscSourceCoverage(
    page,
    census,
    revision,
  );
  let proposalsCreated = 0;
  let proposalsUnchanged = 0;
  for (const candidate of candidates) {
    const result = record(
      await call(database, 'propose_cpsc_candidate_criterion', {
        p_revision_id: recorded.revisionId,
        p_proposed_scope_id: target.soleScopeId,
        p_evidence_address: candidate.sourceAddress,
        p_evidence_fingerprint: candidate.sourceAddress.evidenceFingerprint,
        p_criterion_kind: candidate.kind,
        p_criterion_value: candidate.value,
        p_conjunction_key: candidate.conjunctionKey,
        p_authoritative_excerpt: candidate.authoritativeExcerpt,
        p_parser_version: CPSC_PAGE_PARSER_VERSION,
      }),
    );
    if (result.status === 'created') proposalsCreated += 1;
    else if (result.status === 'unchanged') proposalsUnchanged += 1;
    else throw new Error('CPSC proposal result is malformed.');
  }
  // The database recomputes every status and fingerprint from the ledger itself.
  const coverage = record(
    await call(database, 'record_cpsc_page_coverage', {
      p_revision_id: recorded.revisionId,
      p_ledger: ledger,
    }),
  );
  if (
    coverage.coverageFingerprint !== summary.coverageFingerprint ||
    coverage.coverageStatus !== summary.coverageStatus ||
    coverage.positiveStatus !== summary.positiveStatus
  ) {
    throw new Error('CPSC coverage ledger was not accepted as computed.');
  }
  return {
    status: 'recorded',
    revisionId: recorded.revisionId,
    revisionStatus: recorded.status as 'created' | 'unchanged' | 'reverted',
    fetchId,
    proposalsCreated,
    proposalsUnchanged,
    unresolved,
    coverage: {
      coverageStatus: summary.coverageStatus,
      structuralStatus: summary.structuralStatus,
      criterionStatus: summary.criterionStatus,
      positiveStatus: summary.positiveStatus,
      negativeEvidenceEligible: summary.negativeEvidenceEligible,
      coverageFingerprint: summary.coverageFingerprint,
    },
  };
}
