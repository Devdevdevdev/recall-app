export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

export const DETERMINISTIC_MATCH_METHOD = 'deterministic_v1';
export const MATCH_EVALUATION_SCHEMA_VERSION = '1.0.0';

export type MatchDecision = 'confirmed' | 'rejected' | 'needs_review';

export type IdentifierKind = 'gtin' | 'modelNumber' | 'serialNumber' | 'lotNumber';

export type OwnedProductEvidence = {
  productName: string | null;
  brand: string | null;
  category: string | null;
  gtin: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  lotNumber: string | null;
  purchaseDate: string | null;
  identificationMethod: string | null;
};

export type OfficialRecallScopeEvidence = {
  scopeId?: string | null;
  brand?: string | null;
  productName?: string | null;
  gtin?: string | null;
  modelNumber?: string | null;
  serialNumber?: string | null;
  lotNumber?: string | null;
  serialFrom?: string | null;
  serialTo?: string | null;
  lotFrom?: string | null;
  lotTo?: string | null;
  manufacturedFrom?: string | null;
  manufacturedTo?: string | null;
  additionalCriteria?: JsonObject | null;
};

export type OfficialRecallEvidence = {
  recallNoticeId: string;
  source: {
    authority: string;
    externalId: string;
    officialUrl: string;
    retrievedAt?: string | null;
  };
  title: string;
  description: string | null;
  hazard: string | null;
  remedy: string | null;
  recallDate: string;
  scopes: readonly OfficialRecallScopeEvidence[];
  rawEvidence: JsonObject | null;
};

export type EvidenceOutcome = 'matched' | 'conflicting' | 'supporting' | 'unresolved';
export type EvidenceStrength = 'strong' | 'supporting' | 'contextual';

export type MatchEvidence = {
  kind:
    | IdentifierKind
    | 'productName'
    | 'brand'
    | 'manufacturerContext'
    | 'purchaseDateContext'
    | 'additionalCriteria';
  outcome: EvidenceOutcome;
  strength: EvidenceStrength;
  scopeIndex: number;
  ownedValue?: string;
  officialValue?: string;
  detail: string;
};

export type IdentifierEvidence = Partial<Record<IdentifierKind, readonly string[]>>;

export type MatchEvaluation = {
  decision: MatchDecision;
  /** Heuristic evidence-strength score, not a calibrated probability. */
  confidence: number;
  matchedIdentifiers: IdentifierEvidence;
  conflictingIdentifiers: IdentifierEvidence;
  evidenceUsed: readonly MatchEvidence[];
  reasoningSummary: string;
  matchMethod: typeof DETERMINISTIC_MATCH_METHOD;
  schemaVersion: typeof MATCH_EVALUATION_SCHEMA_VERSION;
};

export type ScopeEvaluation = {
  scopeIndex: number;
  relevant: boolean;
  decision: MatchDecision;
  confidence: number;
  matchedIdentifiers: IdentifierEvidence;
  conflictingIdentifiers: IdentifierEvidence;
  evidenceUsed: readonly MatchEvidence[];
  reasoningSummary: string;
};

export type CandidateSignal = {
  kind:
    | 'exact_gtin'
    | 'exact_model'
    | 'exact_serial'
    | 'exact_lot'
    | 'name_overlap'
    | 'manufacturer_text';
  score: number;
  detail: string;
};

export type RecallCandidate = {
  recall: OfficialRecallEvidence;
  retrievalScore: number;
  signals: readonly CandidateSignal[];
};
