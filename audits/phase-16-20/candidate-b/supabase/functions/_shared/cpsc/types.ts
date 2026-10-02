export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

export type CpscIngestionRequest = {
  startDate: string;
  endDate: string;
  dryRun: boolean;
  maxRecords?: number;
};

export type CpscScopeInput = {
  productName: string | null;
  gtin: string | null;
  modelNumber: string | null;
  additionalCriteria: JsonObject | null;
};

export type CpscRecallInput = {
  externalId: string;
  title: string;
  description: string | null;
  hazard: string | null;
  remedy: string | null;
  recallDate: string;
  officialUrl: string;
  rawPayload: JsonObject;
  scopes: readonly CpscScopeInput[];
};

export type CpscRecordRejection = {
  externalId: string | null;
  reason: string;
};

export type CpscIngestionStats = {
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  scopeCount: number;
  errors: CpscRecordRejection[];
  examples: Array<{ externalId: string; title: string; scopeCount: number }>;
};
