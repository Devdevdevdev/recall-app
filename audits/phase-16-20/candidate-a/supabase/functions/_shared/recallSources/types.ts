export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type RecallJurisdiction = {
  type: 'country' | 'global' | 'region';
  code: string;
};

export type CanonicalRecallScope = {
  brand: string | null;
  productName: string | null;
  gtin: string | null;
  modelNumber: string | null;
  lotFrom: string | null;
  lotTo: string | null;
  serialFrom: string | null;
  serialTo: string | null;
  additionalCriteria: JsonObject | null;
};

export type CanonicalRecallNotice = {
  externalId: string;
  title: string;
  description: string | null;
  hazard: string | null;
  remedy: string | null;
  recallDate: string;
  updatedAt: string;
  officialUrl: string;
  rawPayload: JsonObject;
  scopes: readonly CanonicalRecallScope[];
  jurisdictions: readonly RecallJurisdiction[];
};

export type RecallSourceDefinition = {
  key: string;
  authorityName: string;
  authoritativeBaseUrl: string;
  jurisdictionCoverage: readonly RecallJurisdiction[];
  sourceLanguageCode: string;
  retrieval: {
    kind: 'date_window';
    maximumWindowDays: number;
    maximumRecords: number;
    watermarkKind: string;
  };
};

export type RecallSourceRetrievalRequest = {
  startDate: string;
  endDate: string;
  maxRecords: number;
};

export type RecallSourceRetrievalResult<RawRecord extends JsonObject = JsonObject> = {
  records: readonly RawRecord[];
  diagnostics: JsonObject;
};

/** Minimal production boundary shared by official recall-source implementations. */
export interface RecallSourceAdapter<RawRecord extends JsonObject = JsonObject> {
  readonly definition: RecallSourceDefinition;
  retrieve(request: RecallSourceRetrievalRequest): Promise<readonly RawRecord[]>;
  retrieveWithDiagnostics?(
    request: RecallSourceRetrievalRequest,
  ): Promise<RecallSourceRetrievalResult<RawRecord>>;
  stableExternalId(record: RawRecord): string | null;
  normalize(record: RawRecord): CanonicalRecallNotice;
  watermarkFor(
    notices: readonly CanonicalRecallNotice[],
    request: RecallSourceRetrievalRequest,
  ): JsonObject;
}
