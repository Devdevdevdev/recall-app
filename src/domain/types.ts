export type JsonPrimitive = boolean | number | string | null;

export type JsonObject = { [key: string]: JsonValue };

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type RecallMatchStatus = 'candidate' | 'confirmed' | 'rejected' | 'needs_review';

export type AlertStatus = 'unread' | 'read' | 'dismissed';

export type OwnedProduct = {
  id: string;
  userId: string;
  brand: string | null;
  productName: string | null;
  category: string | null;
  gtin: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  lotNumber: string | null;
  purchaseDate: string | null;
  imagePath: string | null;
  identificationMethod: string | null;
  identificationConfidence: number | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * User-editable inventory fields. Ownership and persistence metadata intentionally
 * do not belong here: the repository derives ownership from the authenticated session.
 */
export type OwnedProductInput = {
  brand: string | null;
  productName: string;
  category: string | null;
  gtin: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  lotNumber: string | null;
  purchaseDate: string | null;
  /** Set internally by a validated acquisition flow; never chosen in the product form. */
  identificationMethod?: 'barcode_scan' | 'ocr_assisted';
};

export type RecallSource = {
  id: string;
  name: string;
  jurisdiction: string;
  baseUrl: string;
  isAuthoritative: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RecallNotice = {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  description: string | null;
  hazard: string | null;
  remedy: string | null;
  recallDate: string;
  officialUrl: string;
  retrievedAt: string;
  rawPayload: JsonObject;
  createdAt: string;
  updatedAt: string;
};

export type RecallScope = {
  id: string;
  recallNoticeId: string;
  brand: string | null;
  productName: string | null;
  gtin: string | null;
  modelNumber: string | null;
  lotFrom: string | null;
  lotTo: string | null;
  serialFrom: string | null;
  serialTo: string | null;
  manufacturedFrom: string | null;
  manufacturedTo: string | null;
  additionalCriteria: JsonObject | null;
  createdAt: string;
};

export type RecallMatch = {
  id: string;
  ownedProductId: string;
  recallNoticeId: string;
  status: RecallMatchStatus;
  confidence: number;
  matchMethod: string;
  matchedIdentifiers: JsonObject;
  reasoningSummary: string;
  aiProvider: string | null;
  aiModel: string | null;
  schemaVersion: string;
  evaluatedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type Alert = {
  id: string;
  userId: string;
  recallMatchId: string;
  status: AlertStatus;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
};

export type RecallAlertProduct = {
  id: string;
  brand: string | null;
  productName: string | null;
  gtin: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  lotNumber: string | null;
};

export type RecallAlertNotice = {
  id: string;
  title: string;
  hazard: string | null;
  remedy: string | null;
  recallDate: string;
  officialUrl: string;
};

export type RecallAlertMatch = {
  id: string;
  status: RecallMatchStatus;
  confidence: number;
  method: string;
  reasoningSummary: string;
  evaluatedAt: string;
};

/**
 * Consumer-safe alert projection. It intentionally excludes raw recall payloads,
 * model prompts/responses, provider details, fingerprints, and orchestration state.
 */
export type RecallAlert = Alert & {
  match: RecallAlertMatch;
  product: RecallAlertProduct;
  notice: RecallAlertNotice;
};
