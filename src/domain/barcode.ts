// Phase 17.3a: the app never re-implements GTIN rules. Validation, canonical GTIN-14 and UPC-E
// expansion all come from the Phase 17.3-S matching primitive, which the Edge functions use and
// `private.canonical_gtin14` mirrors in SQL, so app, Edge and SQL share one GTIN semantics.
import { canonicalizeGtin } from '../../supabase/functions/_shared/matching/gtin.ts';
import {
  isValidGtin,
  normalizeGtin,
} from '../../supabase/functions/_shared/matching/normalization.ts';

/** Product barcode formats intentionally accepted by Recall's camera scanner. */
export const productBarcodeFormats = [
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'itf14',
  'code128',
] as const;

export type ProductBarcodeFormat = (typeof productBarcodeFormats)[number];

/**
 * Symbologies that carry a GTIN, with the payload lengths each may deliver. Code 128 is
 * deliberately absent: a generic Code 128 is not a GTIN carrier, and GS1-128 (AI 01) is not
 * parsed yet, so a numeric Code 128 is never treated as a GTIN.
 *
 * - EAN-13 and UPC-A are one symbol family (a UPC-A is an EAN-13 starting with 0), so either
 *   12 or 13 digits is a legitimate representation; both canonicalize to the same GTIN-14.
 * - UPC-E delivers its 8-digit zero-suppressed form, which is expanded to UPC-A, or an already
 *   expanded 12-digit UPC-A, which needs no transformation.
 */
export const gtinCarrierLengths = {
  ean13: [12, 13],
  upc_a: [12, 13],
  ean8: [8],
  upc_e: [8, 12],
  itf14: [14],
} as const satisfies Partial<Record<ProductBarcodeFormat, readonly number[]>>;

export type GtinCarrierSymbology = keyof typeof gtinCarrierLengths;

export function isGtinCarrierSymbology(value: unknown): value is GtinCarrierSymbology {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(gtinCarrierLengths, value)
  );
}

export type GtinValidationResult = {
  normalizedValue: string | null;
  isSyntaxValid: boolean;
  isValid: boolean;
};

export type BarcodeClassification =
  'valid_gtin' | 'non_gtin_product_code' | 'invalid_or_unsupported';

export type GtinTransformation = 'upc_e_to_upc_a';

/**
 * Scan identity contract. `rawValue` and `symbology` are what the camera reported and are never
 * rewritten; everything else is derived from them deterministically.
 */
export type ScannedBarcode = {
  /** `BarcodeScanningResult.data` exactly as delivered by expo-camera (both platforms). */
  rawValue: string;
  /** `BarcodeScanningResult.type`, as reported by the scanner. */
  format: ProductBarcodeFormat;
  classification: BarcodeClassification;
  /** The GTIN Recall stores in `owned_products.gtin` and matches on; null unless valid. */
  matchingGtin: string | null;
  /** Internal equivalence key (Phase 17.3-S); never needs to be shown to the user. */
  canonicalGtin14: string | null;
  transformation: GtinTransformation | null;
};

/**
 * Manual and route-parameter GTIN validation: trimmed, ASCII digits, 8/12/13/14, GS1 check
 * digit. An 8-digit value is always a GTIN-8 here; there is no symbology, so never a UPC-E.
 */
export function validateGtin(rawValue: string): GtinValidationResult {
  const trimmed = rawValue.trim();
  const digits = normalizeGtin(rawValue);
  return {
    normalizedValue: trimmed || null,
    isSyntaxValid: digits !== null && [8, 12, 13, 14].includes(digits.length),
    isValid: isValidGtin(rawValue),
  };
}

const invalidOrUnsupported = {
  classification: 'invalid_or_unsupported',
  matchingGtin: null,
  canonicalGtin14: null,
  transformation: null,
} as const;

/**
 * Classifies one camera read. Fails closed: a GTIN carrier is accepted only when its payload is
 * exactly ASCII digits (nothing trimmed, so the persisted raw value is the scanned value), has a
 * length its symbology can carry, and passes the shared GTIN primitive.
 */
export function toScannedBarcode(format: ProductBarcodeFormat, rawValue: string): ScannedBarcode {
  const base = { rawValue, format };

  if (!isGtinCarrierSymbology(format)) {
    const trimmed = rawValue.trim();
    const isUsefulCode = trimmed.length > 0 && !/[\u0000-\u001f\u007f]/u.test(trimmed);
    return isUsefulCode
      ? { ...base, ...invalidOrUnsupported, classification: 'non_gtin_product_code' }
      : { ...base, ...invalidOrUnsupported };
  }

  const lengths: readonly number[] = gtinCarrierLengths[format];
  if (!/^[0-9]+$/u.test(rawValue) || !lengths.includes(rawValue.length)) {
    return { ...base, ...invalidOrUnsupported };
  }

  const identity = canonicalizeGtin(rawValue, { symbology: format });
  if (!identity.valid || identity.canonicalGtin14 === null) {
    return { ...base, ...invalidOrUnsupported };
  }

  return {
    ...base,
    classification: 'valid_gtin',
    matchingGtin: identity.expandedFromUpce ?? rawValue,
    canonicalGtin14: identity.canonicalGtin14,
    transformation: identity.expandedFromUpce ? 'upc_e_to_upc_a' : null,
  };
}
