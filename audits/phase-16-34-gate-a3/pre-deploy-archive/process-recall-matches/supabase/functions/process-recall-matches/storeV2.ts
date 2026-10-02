import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { OwnedProductRow } from '../_shared/recallMatching/types.ts';
import type { ReviewedScopeRowV2, V2Store } from '../_shared/recallMatching/orchestratorV2.ts';
import { SupabaseRecallMatchingStore } from './store.ts';

function one(value: unknown): Record<string, unknown> | null {
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item === 'object' && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : null;
}

export class SupabaseRecallMatchingStoreV2 implements V2Store {
  private readonly base: SupabaseRecallMatchingStore;
  constructor(private readonly database: SupabaseClient) {
    this.base = new SupabaseRecallMatchingStore(database);
  }
  listAuthoritativeRecalls: V2Store['listAuthoritativeRecalls'] = (input) =>
    this.base.listAuthoritativeRecalls(input);
  listRecallCandidateProducts: V2Store['listRecallCandidateProducts'] = (input) =>
    this.base.listRecallCandidateProducts(input);
  claimPair: V2Store['claimPair'] = (input) => this.base.claimPair(input);

  async getReviewedScopes(recallNoticeId: string): Promise<readonly ReviewedScopeRowV2[]> {
    const { data, error } = await this.database.rpc('get_recall_v2_scopes', {
      p_recall_notice_id: recallNoticeId,
    });
    if (
      error ||
      !Array.isArray(data) ||
      data.some((row) => !row || typeof row.scope_id !== 'string')
    ) {
      throw new Error('Reviewed v2 scope retrieval failed.');
    }
    return data as ReviewedScopeRowV2[];
  }

  async getOwnedSafetyEvidence(productId: string): Promise<OwnedProductRow> {
    const { data, error } = await this.database.rpc('get_owned_product_evidence_v2', {
      p_owned_product_id: productId,
    });
    const row = one(data);
    if (
      error ||
      !row ||
      row.owned_product_id !== productId ||
      typeof row.owned_product_updated_at !== 'string' ||
      typeof row.user_id !== 'string'
    ) {
      throw new Error('Owned safety evidence retrieval failed.');
    }
    return row as unknown as OwnedProductRow;
  }

  async finalizeV2(input: Parameters<V2Store['finalizeV2']>[0]): ReturnType<V2Store['finalizeV2']> {
    const { data, error } = await this.database.rpc('finalize_recall_match_evaluation_v2', {
      p_owned_product_id: input.ownedProductId,
      p_recall_notice_id: input.recallNoticeId,
      p_evidence_fingerprint: input.evidenceFingerprint,
      p_expected_product_updated_at: input.expectedProductUpdatedAt,
      p_expected_recall_updated_at: input.expectedRecallUpdatedAt,
      p_lease_token: input.leaseToken,
      p_status: input.status,
      p_confidence: input.confidence,
      p_matched_identifiers: input.matchedIdentifiers,
      p_reasoning_summary: input.reasoningSummary,
    });
    const row = one(data);
    if (
      error ||
      !row ||
      !['finalized', 'unchanged', 'stale', 'missing'].includes(String(row.status)) ||
      !['created', 'revoked', 'none'].includes(String(row.alert_eligibility))
    ) {
      throw new Error('V2 finalization failed.');
    }
    return {
      status: row.status as Awaited<ReturnType<V2Store['finalizeV2']>>['status'],
      alertEligibility: row.alert_eligibility as Awaited<
        ReturnType<V2Store['finalizeV2']>
      >['alertEligibility'],
    };
  }

  async createAlert(
    ownedProductId: string,
    recallNoticeId: string,
  ): ReturnType<V2Store['createAlert']> {
    const { data, error } = await this.database.rpc('create_recall_v2_alert', {
      p_owned_product_id: ownedProductId,
      p_recall_notice_id: recallNoticeId,
    });
    const status = one(data)?.status;
    if (error || !['created', 'existing', 'ineligible'].includes(String(status))) {
      throw new Error('V2 alert snapshot creation failed.');
    }
    return status as Awaited<ReturnType<V2Store['createAlert']>>;
  }
}
