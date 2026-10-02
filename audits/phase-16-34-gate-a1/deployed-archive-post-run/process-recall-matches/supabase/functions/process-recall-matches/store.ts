import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import type {
  AuthoritativeRecallRow,
  FinalizePairInput,
  FinalizePairResult,
  OwnedProductRow,
  PairClaim,
  RecallMatchingStore,
} from '../_shared/recallMatching/types.ts';

function firstRow(value: unknown): Record<string, unknown> | null {
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item === 'object' && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${context} returned invalid data.`);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class SupabaseRecallMatchingStore implements RecallMatchingStore {
  constructor(private readonly database: SupabaseClient) {}

  async listAuthoritativeRecalls(input: {
    afterRecallId: string | null;
    limit: number;
    recallNoticeIds: readonly string[] | null;
  }): Promise<readonly AuthoritativeRecallRow[]> {
    const { data, error } = await this.database.rpc('get_recall_matching_batch', {
      p_after_recall_id: input.afterRecallId,
      p_limit: input.limit,
      p_recall_notice_ids: input.recallNoticeIds,
    });
    if (error || !Array.isArray(data)) throw new Error('Authoritative recall retrieval failed.');

    return data.map((value) => {
      const row = firstRow(value);
      if (!row) throw new Error('Authoritative recall retrieval returned invalid data.');
      const scopes = Array.isArray(row.scopes) ? row.scopes : [];
      return {
        recall_notice_id: requiredString(row.recall_notice_id, 'Recall batch'),
        recall_notice_updated_at: requiredString(row.recall_notice_updated_at, 'Recall batch'),
        source_authority: requiredString(row.authority, 'Recall batch'),
        source_external_id: requiredString(row.external_id, 'Recall batch'),
        source_official_url: requiredString(row.official_url, 'Recall batch'),
        source_is_authoritative: true,
        title: requiredString(row.title, 'Recall batch'),
        description: nullableString(row.description),
        hazard: nullableString(row.hazard),
        remedy: nullableString(row.remedy),
        recall_date: requiredString(row.recall_date, 'Recall batch'),
        raw_payload: row.raw_payload as AuthoritativeRecallRow['raw_payload'],
        scopes: scopes as AuthoritativeRecallRow['scopes'],
      };
    });
  }

  async listRecallCandidateProducts(input: {
    recallNoticeId: string;
    afterExactRank: number | null;
    afterProductId: string | null;
    limit: number;
  }): Promise<readonly OwnedProductRow[]> {
    const { data, error } = await this.database.rpc('get_recall_candidates', {
      p_recall_notice_id: input.recallNoticeId,
      p_after_exact_rank: input.afterExactRank,
      p_after_product_id: input.afterProductId,
      p_limit: input.limit,
    });
    if (error || !Array.isArray(data)) throw new Error('Recall candidate retrieval failed.');
    return data as OwnedProductRow[];
  }

  async claimPair(input: {
    ownedProductId: string;
    recallNoticeId: string;
    expectedProductUpdatedAt: string;
    expectedRecallUpdatedAt: string;
    evidenceFingerprint: string;
    leaseSeconds: number;
  }): Promise<PairClaim> {
    const { data, error } = await this.database.rpc('claim_recall_match_evaluation', {
      p_owned_product_id: input.ownedProductId,
      p_recall_notice_id: input.recallNoticeId,
      p_evidence_fingerprint: input.evidenceFingerprint,
      p_expected_product_updated_at: input.expectedProductUpdatedAt,
      p_expected_recall_updated_at: input.expectedRecallUpdatedAt,
      p_lease_seconds: input.leaseSeconds,
    });
    if (error) throw new Error('Recall match claim failed.');
    const row = firstRow(data);
    const status = row?.status;
    if (status === 'claimed') {
      return {
        status,
        leaseToken: requiredString(row?.lease_token, 'Recall match claim'),
        leaseExpiresAt: nullableString(row?.lease_expires_at),
      };
    }
    if (status === 'unchanged' || status === 'busy' || status === 'stale' || status === 'missing') {
      return { status };
    }
    throw new Error('Recall match claim returned invalid data.');
  }

  async finalizePair(input: FinalizePairInput): Promise<FinalizePairResult> {
    const { data, error } = await this.database.rpc('finalize_recall_match_evaluation', {
      p_owned_product_id: input.ownedProductId,
      p_recall_notice_id: input.recallNoticeId,
      p_evidence_fingerprint: input.evidenceFingerprint,
      p_expected_product_updated_at: input.expectedProductUpdatedAt,
      p_expected_recall_updated_at: input.expectedRecallUpdatedAt,
      p_lease_token: input.leaseToken,
      p_status: input.status,
      p_confidence: input.confidence,
      p_match_method: input.matchMethod,
      p_matched_identifiers: input.matchedIdentifiers,
      p_reasoning_summary: input.reasoningSummary,
      p_ai_provider: input.aiProvider,
      p_ai_model: input.aiModel,
      p_schema_version: input.schemaVersion,
    });
    if (error) throw new Error('Recall match finalization failed.');
    const row = firstRow(data);
    if (!row || !['finalized', 'stale', 'missing'].includes(String(row.status))) {
      throw new Error('Recall match finalization returned invalid data.');
    }
    const alertOutcome = String(row.alert_outcome);
    if (!['created', 'existing', 'none'].includes(alertOutcome)) {
      throw new Error('Recall match finalization returned an invalid alert outcome.');
    }
    return {
      status: row.status as FinalizePairResult['status'],
      recallMatchId: nullableString(row.recall_match_id),
      alertId: nullableString(row.alert_id),
      alertOutcome: alertOutcome as FinalizePairResult['alertOutcome'],
      confirmationReversed: row.confirmation_reversed === true,
    };
  }
}
