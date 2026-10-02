import type { MatchDecision } from './types.ts';
import type {
  DeterministicMatchEvaluationV2,
  OfficialRecallEvidenceV2,
  OfficialRecallScopeEvidenceV2,
  ProductAttributeKey,
  RecallCriterionOperator,
} from './typesV2.ts';

export const HYBRID_GUARDED_MATCH_METHOD_V2_1 = 'hybrid_guarded_v2_1';
export const VERIFIER_VERSION_V2_1 = '2.1.0';
export const MATCH_FINGERPRINT_VERSION_V2_1 = '2.1.0';
export const MATCH_FINGERPRINT_POLICY_V2_1 = 'phase_16_guarded_v2_1_offline';

export type RecallAssociationV2_1 = {
  id: string;
  criterionIds: readonly string[];
  provenance: {
    authority: string;
    officialUrl: string;
    sourceField: string;
    normalizationRule: string;
  };
};

export type OfficialRecallScopeEvidenceV2_1 = OfficialRecallScopeEvidenceV2 & {
  associations?: readonly RecallAssociationV2_1[];
};

export type OfficialRecallEvidenceV2_1 = Omit<OfficialRecallEvidenceV2, 'scopes'> & {
  scopes: readonly OfficialRecallScopeEvidenceV2_1[];
};

export type OwnedEvidenceReferenceV2_1 =
  | {
      source: 'base';
      field: 'gtin' | 'modelNumber' | 'serialNumber' | 'lotNumber';
    }
  | { source: 'attribute'; key: ProductAttributeKey };

export type GuardedEvidenceClaimV2_1 = {
  scopeIndex: number;
  associationId: string;
  criterionId: string;
  ownedEvidence: OwnedEvidenceReferenceV2_1;
  relation: RecallCriterionOperator;
};

export type GuardedAiDecisionV2_1 = {
  decision: MatchDecision;
  scopeIndex: number;
  associationId: string;
  claims: readonly GuardedEvidenceClaimV2_1[];
  reasoningSummary?: string;
};

export type VerifierResultV2_1 = {
  accepted: boolean;
  rejectionReasons: readonly string[];
};

export type HybridGuardedEvaluationV2_1 = Omit<DeterministicMatchEvaluationV2, 'matchMethod'> & {
  matchMethod: typeof HYBRID_GUARDED_MATCH_METHOD_V2_1;
};

export type HybridGuardedResultV2_1 = {
  evaluation: HybridGuardedEvaluationV2_1;
  trace: {
    deterministicDecision: MatchDecision;
    aiEscalated: boolean;
    aiDecision: MatchDecision | null;
    aiTechnicalFailure: 'provider_error' | 'schema_violation' | null;
    verifierVersion: typeof VERIFIER_VERSION_V2_1;
    verifierAccepted: boolean;
    verifierRejectionReasons: readonly string[];
  };
};
