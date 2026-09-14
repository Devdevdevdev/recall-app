import type { GuardedNemotronAttempt } from '../matching/guardedNemotronMatcher.ts';
import type { JsonObject, MatchDecision, OfficialRecallScopeEvidence } from '../matching/types.ts';

export type RecallScopeRow = {
  scope_id?: string | null;
  created_at?: string | null;
  brand?: string | null;
  product_name?: string | null;
  gtin?: string | null;
  model_number?: string | null;
  serial_number?: string | null;
  lot_number?: string | null;
  serial_from?: string | null;
  serial_to?: string | null;
  lot_from?: string | null;
  lot_to?: string | null;
  manufactured_from?: string | null;
  manufactured_to?: string | null;
  additional_criteria?: JsonObject | null;
};

export type AuthoritativeRecallRow = {
  recall_notice_id: string;
  recall_notice_updated_at?: string;
  source_authority: string;
  source_external_id: string;
  source_official_url: string;
  source_is_authoritative: boolean;
  retrieved_at?: string | null;
  title: string;
  description: string | null;
  hazard: string | null;
  remedy: string | null;
  recall_date: string;
  raw_payload: JsonObject;
  scopes: readonly RecallScopeRow[];
};

export type OwnedProductRow = {
  owned_product_id: string;
  owned_product_updated_at?: string;
  user_id?: string;
  updated_at?: string;
  product_name: string | null;
  brand: string | null;
  category: string | null;
  gtin: string | null;
  model_number: string | null;
  serial_number: string | null;
  lot_number: string | null;
  purchase_date: string | null;
  identification_method: string | null;
  exact_rank?: number;
};

export type MatchingLimits = {
  maxRecalls: number;
  maxCandidatePairs: number;
  maxNebiusCalls: number;
};

export type MatchingRunOptions = MatchingLimits & {
  afterRecallId?: string | null;
  recallNoticeIds?: readonly string[] | null;
};

export type PairClaim =
  | { status: 'claimed'; leaseToken: string; leaseExpiresAt?: string | null }
  | { status: 'unchanged' | 'busy' | 'stale' | 'missing' };

export type FinalizePairInput = {
  ownedProductId: string;
  recallNoticeId: string;
  expectedProductUpdatedAt: string;
  expectedRecallUpdatedAt: string;
  leaseToken: string;
  evidenceFingerprint: string;
  status: MatchDecision;
  confidence: number;
  matchMethod: 'deterministic_v1' | 'hybrid_guarded_v1';
  matchedIdentifiers: JsonObject;
  reasoningSummary: string;
  aiProvider: 'nebius' | null;
  aiModel: string | null;
  schemaVersion: string;
};

export type FinalizePairResult = {
  status?: 'finalized' | 'stale' | 'missing';
  recallMatchId?: string | null;
  alertId?: string | null;
  alertOutcome: 'created' | 'existing' | 'none';
  confirmationReversed?: boolean;
};

export type RecallMatchingStore = {
  listAuthoritativeRecalls(input: {
    afterRecallId: string | null;
    limit: number;
    recallNoticeIds: readonly string[] | null;
  }): Promise<readonly AuthoritativeRecallRow[]>;
  listRecallCandidateProducts(input: {
    recallNoticeId: string;
    afterExactRank: number | null;
    afterProductId: string | null;
    limit: number;
  }): Promise<readonly OwnedProductRow[]>;
  claimPair(input: {
    ownedProductId: string;
    recallNoticeId: string;
    expectedProductUpdatedAt: string;
    expectedRecallUpdatedAt: string;
    evidenceFingerprint: string;
    leaseSeconds: number;
  }): Promise<PairClaim>;
  finalizePair(input: FinalizePairInput): Promise<FinalizePairResult>;
};

export type GuardedEvaluator = (
  input: import('../matching/nemotronPrompt.ts').NemotronMatchingInput,
) => Promise<GuardedNemotronAttempt>;

export type OperationalLogger = {
  info(event: string, summary: Record<string, number>): void;
  error(event: string, summary: Record<string, number>): void;
};

export type ProductionScopeEvidence = Omit<OfficialRecallScopeEvidence, 'scopeId'>;
