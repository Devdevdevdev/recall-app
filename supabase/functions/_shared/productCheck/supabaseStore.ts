import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import type { ReviewedScopeRowV2 } from '../recallMatching/orchestratorV2.ts';
import type { OwnedProductRow, PairClaim } from '../recallMatching/types.ts';
import type {
  CompletionInput,
  CompletionResult,
  MonitoringSnapshot,
  ProductCheckJobStore,
  UserClaimResult,
} from './handler.ts';
import type {
  CandidateRecallRow,
  ProductCheckClaim,
  ProductCheckPairStore,
} from './orchestrator.ts';

const STATES = new Set([
  'pending_check',
  'checking',
  'monitored_no_known_recall',
  'possible_match_needs_verification',
  'recall_detected',
  'check_failed_retrying',
  'check_failed',
]);

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('RPC returned invalid data.');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('RPC returned invalid data.');
    }
    return item as Record<string, unknown>;
  });
}

function first(value: unknown): Record<string, unknown> {
  const row = rows(value)[0];
  if (!row) throw new Error('RPC returned no row.');
  return row;
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${context} is invalid.`);
  return value;
}

function count(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error('Count is invalid.');
  return Number(value);
}

function snapshot(row: Record<string, unknown>): MonitoringSnapshot {
  const state = text(row.state, 'Monitoring state');
  if (!STATES.has(state)) throw new Error('Monitoring state is invalid.');
  return {
    state: state as MonitoringSnapshot['state'],
    checkedAt: typeof row.checked_at === 'string' ? row.checked_at : null,
    possibleMatches: count(row.possible_matches),
    confirmedAlerts: count(row.confirmed_alerts),
    retrying: row.retrying === true,
  };
}

function claimFrom(row: Record<string, unknown>, productId: string): ProductCheckClaim {
  const rank = row.cursor_rank;
  const recallId = row.cursor_recall_id;
  return {
    ownedProductId: productId,
    leaseToken: text(row.lease_token, 'Lease token'),
    matchingRevision: count(row.matching_revision),
    productUpdatedAt: text(row.product_updated_at, 'Product revision'),
    purchaseCountryCode:
      typeof row.purchase_country_code === 'string' ? row.purchase_country_code : null,
    cursor:
      Number.isInteger(rank) && typeof recallId === 'string'
        ? { rank: Number(rank), recallId }
        : null,
    maxCandidates: count(row.max_candidates),
  };
}

/** Job RPCs added by Phase 17.7a-1. Every call runs with server credentials. */
export class SupabaseProductCheckJobStore implements ProductCheckJobStore {
  constructor(private readonly database: SupabaseClient) {}

  async claimForUser(input: { ownedProductId: string; userId: string }): Promise<UserClaimResult> {
    const { data, error } = await this.database.rpc('claim_owned_product_recall_check', {
      p_owned_product_id: input.ownedProductId,
      p_user_id: input.userId,
      p_lease_seconds: 120,
    });
    if (error) throw new Error('Product check claim failed.');
    const row = first(data);
    const status = row.status;
    if (status === 'not_found') return { status };
    if (status === 'claimed') {
      return { status, claim: claimFrom(row, input.ownedProductId), snapshot: snapshot(row) };
    }
    if (
      status === 'disabled' ||
      status === 'complete' ||
      status === 'busy' ||
      status === 'not_due' ||
      status === 'rate_limited'
    ) {
      return { status, snapshot: snapshot(row) };
    }
    throw new Error('Product check claim returned an invalid status.');
  }

  async claimDue(limit: number): Promise<readonly ProductCheckClaim[]> {
    const { data, error } = await this.database.rpc('claim_due_owned_product_recall_checks', {
      p_limit: limit,
      p_lease_seconds: 120,
    });
    if (error) throw new Error('Due product check claim failed.');
    return rows(data).map((row) => claimFrom(row, text(row.owned_product_id, 'Product')));
  }

  async complete(input: CompletionInput): Promise<CompletionResult> {
    const { data, error } = await this.database.rpc('complete_owned_product_recall_check', {
      p_owned_product_id: input.ownedProductId,
      p_lease_token: input.leaseToken,
      p_matching_revision: input.matchingRevision,
      p_outcome: input.outcome,
      p_error: input.error,
      p_cursor_rank: input.cursor?.rank ?? null,
      p_cursor_recall_id: input.cursor?.recallId ?? null,
      p_path: input.path,
    });
    if (error) throw new Error('Product check completion failed.');
    const row = first(data);
    const status = text(row.status, 'Completion status') as CompletionResult['status'];
    if (
      ![
        'completed',
        'continued',
        'retrying',
        'exhausted',
        'rearmed',
        'stale_lease',
        'missing',
      ].includes(status)
    ) {
      throw new Error('Product check completion returned an invalid status.');
    }
    return { status, snapshot: status === 'missing' ? null : snapshot(row) };
  }
}

/**
 * Pair-level RPCs. Everything except candidate retrieval is the existing, installed
 * Phase 10 / Phase 16 v2 surface; nothing here writes the v1 match or alert tables.
 */
export class SupabaseProductCheckPairStore implements ProductCheckPairStore {
  constructor(private readonly database: SupabaseClient) {}

  async getProductEvidence(productId: string): Promise<OwnedProductRow | null> {
    const { data, error } = await this.database.rpc('get_owned_product_evidence_v2', {
      p_owned_product_id: productId,
    });
    if (error) throw new Error('Owned product evidence retrieval failed.');
    const row = rows(data)[0];
    if (!row) return null;
    if (row.owned_product_id !== productId || typeof row.owned_product_updated_at !== 'string') {
      throw new Error('Owned product evidence is invalid.');
    }
    return row as unknown as OwnedProductRow;
  }

  async listCandidateRecalls(input: {
    productId: string;
    after: { rank: number; recallId: string } | null;
    limit: number;
  }): Promise<readonly CandidateRecallRow[]> {
    const { data, error } = await this.database.rpc('get_owned_product_recall_candidates', {
      p_owned_product_id: input.productId,
      p_after_rank: input.after?.rank ?? null,
      p_after_recall_id: input.after?.recallId ?? null,
      p_limit: input.limit,
    });
    if (error) throw new Error('Candidate recall retrieval failed.');
    return rows(data).map((row) => ({
      recall_notice_id: text(row.recall_notice_id, 'Recall'),
      recall_notice_updated_at: text(row.recall_notice_updated_at, 'Recall revision'),
      source_authority: text(row.authority, 'Authority'),
      source_external_id: text(row.external_id, 'External id'),
      source_official_url: text(row.official_url, 'Official URL'),
      // The RPC returns authoritative sources only.
      source_is_authoritative: true,
      title: text(row.title, 'Title'),
      description: typeof row.description === 'string' ? row.description : null,
      hazard: typeof row.hazard === 'string' ? row.hazard : null,
      remedy: typeof row.remedy === 'string' ? row.remedy : null,
      recall_date: text(row.recall_date, 'Recall date'),
      raw_payload: row.raw_payload as CandidateRecallRow['raw_payload'],
      scopes: (Array.isArray(row.scopes) ? row.scopes : []) as CandidateRecallRow['scopes'],
      jurisdictions: (Array.isArray(row.jurisdictions)
        ? row.jurisdictions
        : []) as CandidateRecallRow['jurisdictions'],
      exact_rank: count(row.exact_rank),
    }));
  }

  async getReviewedScopes(recallNoticeId: string): Promise<readonly ReviewedScopeRowV2[]> {
    const { data, error } = await this.database.rpc('get_recall_v2_scopes', {
      p_recall_notice_id: recallNoticeId,
    });
    if (error) throw new Error('Reviewed v2 scope retrieval failed.');
    const scopes = rows(data);
    if (scopes.some((scope) => typeof scope.scope_id !== 'string')) {
      throw new Error('Reviewed v2 scope retrieval returned invalid data.');
    }
    return scopes as unknown as ReviewedScopeRowV2[];
  }

  async claimPair(input: Parameters<ProductCheckPairStore['claimPair']>[0]): Promise<PairClaim> {
    const { data, error } = await this.database.rpc('claim_recall_match_evaluation', {
      p_owned_product_id: input.ownedProductId,
      p_recall_notice_id: input.recallNoticeId,
      p_evidence_fingerprint: input.evidenceFingerprint,
      p_expected_product_updated_at: input.expectedProductUpdatedAt,
      p_expected_recall_updated_at: input.expectedRecallUpdatedAt,
      p_lease_seconds: input.leaseSeconds,
    });
    if (error) throw new Error('Pair claim failed.');
    const row = first(data);
    if (row.status === 'claimed') {
      return { status: 'claimed', leaseToken: text(row.lease_token, 'Pair lease') };
    }
    if (['unchanged', 'busy', 'stale', 'missing'].includes(String(row.status))) {
      return { status: row.status as 'unchanged' | 'busy' | 'stale' | 'missing' };
    }
    throw new Error('Pair claim returned an invalid status.');
  }

  async finalizeV2(
    input: Parameters<ProductCheckPairStore['finalizeV2']>[0],
  ): ReturnType<ProductCheckPairStore['finalizeV2']> {
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
    if (error) throw new Error('V2 finalization failed.');
    const row = first(data);
    if (
      !['finalized', 'unchanged', 'stale', 'missing'].includes(String(row.status)) ||
      !['created', 'revoked', 'none'].includes(String(row.alert_eligibility))
    ) {
      throw new Error('V2 finalization returned invalid data.');
    }
    return {
      status: row.status as 'finalized' | 'unchanged' | 'stale' | 'missing',
      alertEligibility: row.alert_eligibility as 'created' | 'revoked' | 'none',
    };
  }

  async createAlert(
    ownedProductId: string,
    recallNoticeId: string,
  ): Promise<'created' | 'existing' | 'ineligible'> {
    const { data, error } = await this.database.rpc('create_recall_v2_alert', {
      p_owned_product_id: ownedProductId,
      p_recall_notice_id: recallNoticeId,
    });
    const status = error ? null : first(data).status;
    if (status !== 'created' && status !== 'existing' && status !== 'ineligible') {
      throw new Error('V2 alert creation failed.');
    }
    return status;
  }
}
