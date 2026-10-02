import type {
  IdentifierEvidence,
  JsonObject,
  MatchDecision,
  MatchEvidence,
  OfficialRecallEvidence,
  OfficialRecallScopeEvidence,
  OwnedProductEvidence,
} from './types.ts';

export const DETERMINISTIC_MATCH_METHOD_V2 = 'deterministic_v2';
export const HYBRID_GUARDED_MATCH_METHOD_V2 = 'hybrid_guarded_v2';
export const MATCH_EVALUATION_SCHEMA_VERSION_V2 = '2.0.0';
export const GUARDED_NEMOTRON_PROMPT_VERSION_V2 = '2.0.0';

export const PRODUCT_ATTRIBUTE_KEYS = [
  'variant',
  'color',
  'size',
  'capacity',
  'battery_model',
  'charging_port_type',
  'screw_state',
  'date_code',
  'manufacture_date',
  'production_date',
] as const;

export type ProductAttributeKey = (typeof PRODUCT_ATTRIBUTE_KEYS)[number];
export type ProductAttributeValueType = 'text' | 'date';
export type ProductAttributeCaptureSource = 'manual' | 'ocr_assisted';

export type OwnedProductAttribute = {
  key: ProductAttributeKey;
  value: string;
  valueType: ProductAttributeValueType;
  captureSource: ProductAttributeCaptureSource;
};

export type OwnedProductEvidenceV2 = OwnedProductEvidence & {
  attributes: readonly OwnedProductAttribute[];
};

export type RecallCriterionKind =
  | 'gtin'
  | 'model_number'
  | 'serial_number'
  | 'lot_number'
  | ProductAttributeKey
  | 'date_code_prefix';

export type RecallCriterionOperator = 'equals' | 'one_of' | 'prefix' | 'range' | 'date_range';

export type RecallCriterionProvenance = {
  authority: string;
  officialUrl: string;
  sourceField: string;
  normalizationRule: string;
};

export type RecallCriterion = {
  id: string;
  kind: RecallCriterionKind;
  operator: RecallCriterionOperator;
  required: boolean;
  value?: string;
  values?: readonly string[];
  range?: { from: string; to: string };
  provenance: RecallCriterionProvenance;
};

export type RecallCriterionSet = {
  /** `all_of` is explicit conjunction. `ambiguous` deliberately blocks confirmation/rejection. */
  semantics: 'all_of' | 'ambiguous';
  criteria: readonly RecallCriterion[];
};

export type OfficialRecallScopeEvidenceV2 = OfficialRecallScopeEvidence & {
  criteria?: RecallCriterionSet;
};

export type OfficialRecallEvidenceV2 = Omit<OfficialRecallEvidence, 'scopes'> & {
  scopes: readonly OfficialRecallScopeEvidenceV2[];
};

export type CriterionOutcome = 'matched' | 'conflicting' | 'missing' | 'unresolved';

export type CriterionEvaluation = {
  criterionId: string;
  kind: RecallCriterionKind;
  required: boolean;
  outcome: CriterionOutcome;
  ownedValue: string | null;
  officialValue: string;
  detail: string;
  provenance: RecallCriterionProvenance;
};

export type ScopeEvaluationV2 = {
  scopeIndex: number;
  relevant: boolean;
  decision: MatchDecision;
  confidence: number;
  matchedIdentifiers: IdentifierEvidence;
  conflictingIdentifiers: IdentifierEvidence;
  evidenceUsed: readonly MatchEvidence[];
  criterionEvaluations: readonly CriterionEvaluation[];
  reasoningSummary: string;
};

export type DeterministicMatchEvaluationV2 = {
  decision: MatchDecision;
  confidence: number;
  matchedIdentifiers: IdentifierEvidence;
  conflictingIdentifiers: IdentifierEvidence;
  evidenceUsed: readonly MatchEvidence[];
  criterionEvaluations: readonly CriterionEvaluation[];
  reasoningSummary: string;
  matchMethod: typeof DETERMINISTIC_MATCH_METHOD_V2;
  schemaVersion: typeof MATCH_EVALUATION_SCHEMA_VERSION_V2;
};

export type GuardedAiDecisionV2 = {
  decision: MatchDecision;
  claimedCriterionIds: readonly string[];
  reasoningSummary?: string;
};

export type HybridGuardedEvaluationV2 = Omit<DeterministicMatchEvaluationV2, 'matchMethod'> & {
  matchMethod: typeof HYBRID_GUARDED_MATCH_METHOD_V2;
};

export type HybridGuardedResultV2 = {
  evaluation: HybridGuardedEvaluationV2;
  trace: {
    deterministicDecision: MatchDecision;
    aiEscalated: boolean;
    aiDecision: MatchDecision | null;
    aiTechnicalFailure: 'provider_error' | 'schema_violation' | null;
    verifierAccepted: boolean;
    verifierRejectionReasons: readonly string[];
  };
};

export type FingerprintJson = JsonObject;
