import type { GtinCarrierSymbology } from './barcode.ts';
import type { CountryCode } from './countries.ts';

export type JsonPrimitive = boolean | number | string | null;

export type JsonObject = { [key: string]: JsonValue };

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type RecallMatchStatus = 'candidate' | 'confirmed' | 'rejected' | 'needs_review';

export type AlertStatus = 'unread' | 'read' | 'dismissed';

export const PRODUCT_SAFETY_ATTRIBUTE_KEYS = [
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

export type ProductSafetyAttributeKey = (typeof PRODUCT_SAFETY_ATTRIBUTE_KEYS)[number];
export type ProductSafetyAttributes = Partial<Record<ProductSafetyAttributeKey, string>>;

/**
 * Phase 17.3a: provenance of the CURRENT `gtin` — the barcode value delivered to JavaScript and
 * the symbology the scanner reported. The app writes it on creation only; the database clears it
 * as soon as `gtin` stops being canonically equivalent. `gtin` stays the matching GTIN (for a
 * UPC-E, its UPC-A). Not a history of the first scan.
 */
export type BarcodeScanProvenance = {
  rawValue: string;
  symbology: GtinCarrierSymbology;
};

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
  scanDate: string;
  purchaseDate: string | null;
  purchaseCountryCode: CountryCode | null;
  safetyAttributes?: ProductSafetyAttributes;
  /** Present only for products created from a barcode scan since Phase 17.3a. */
  barcodeScan?: BarcodeScanProvenance;
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
  scanDate: string;
  purchaseDate: string | null;
  purchaseCountryCode: CountryCode | null;
  safetyAttributes?: ProductSafetyAttributes;
  /** Set internally by a validated acquisition flow; never chosen in the product form. */
  identificationMethod?: 'barcode_scan' | 'ocr_assisted';
  /** Set internally by the scan flow and persisted on creation only, never on update. */
  barcodeScan?: BarcodeScanProvenance;
};

/**
 * Phase 17.7a server-derived check state of one owned product. `monitored_no_known_recall`
 * only means that no matching recall was found in the currently monitored sources with
 * the available evidence; it never means the product was never recalled.
 */
export const PRODUCT_MONITORING_STATES = [
  'pending_check',
  'checking',
  'monitored_no_known_recall',
  'possible_match_needs_verification',
  'recall_detected',
  'check_failed_retrying',
  'check_failed',
] as const;

export type ProductMonitoringState = (typeof PRODUCT_MONITORING_STATES)[number];

export type ProductMonitoringStatus = {
  ownedProductId: string;
  state: ProductMonitoringState;
  checkedAt: string | null;
  possibleMatches: number;
  confirmedAlerts: number;
  retrying: boolean;
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
  authority: string;
  title: string;
  hazard: string | null;
  remedy: string | null;
  recallDate: string;
  officialUrl: string;
  sourceLanguageCode: string | null;
  jurisdictions: readonly {
    type: 'country' | 'global' | 'region';
    code: string;
  }[];
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
