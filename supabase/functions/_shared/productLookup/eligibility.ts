import { canonicalGtin14 } from '../matching/gtin.ts';

/**
 * Phase 17.3c: which GTINs may be sent to a product catalogue to suggest a name and brand.
 *
 * Product lookup only reuses the Phase 17.3-S GTIN primitive; it never reads, and is never read
 * by, the recall matching engine. Eligibility says nothing about recalls.
 *
 * The input is the matching GTIN (`ScannedBarcode.matchingGtin`, i.e. what Recall stores: a
 * UPC-E is already expanded to its UPC-A). It must be exactly 8, 12, 13 or 14 ASCII digits with a
 * valid check digit; nothing is trimmed or padded.
 */
export type ProductLookupEligibility =
  | {
      eligible: true;
      /** Sent to the provider: the matching GTIN, unchanged. */
      providerGtin: string;
      /** Cache key: the canonical GTIN-14 (Phase 17.3-S). */
      key: string;
    }
  | { eligible: false; reason: 'invalid_gtin' | 'rcn_8' };

const GTIN_SHAPE = /^(?:[0-9]{8}|[0-9]{12,14})$/u;

/**
 * RCN-8 (GS1 General Specifications 2.1.11-2.1.12, decided in Phase 17.3b): a GTIN-8 whose GS1-8
 * prefix starts with 0 or 2 is a Restricted Circulation Number, assigned locally and not unique
 * worldwide, so a catalogue answer may describe another product. Decided on the 8-digit matching
 * GTIN only, never on the zero-filled GTIN-14, which cannot tell a GTIN-8 from a GTIN-12 that
 * starts with zeroes.
 */
export function isRcn8(matchingGtin: string): boolean {
  return matchingGtin.length === 8 && /^[02]/u.test(matchingGtin);
}

export function productLookupEligibility(matchingGtin: unknown): ProductLookupEligibility {
  if (typeof matchingGtin !== 'string' || !GTIN_SHAPE.test(matchingGtin)) {
    return { eligible: false, reason: 'invalid_gtin' };
  }
  const key = canonicalGtin14(matchingGtin);
  if (key === null) return { eligible: false, reason: 'invalid_gtin' };
  if (isRcn8(matchingGtin)) return { eligible: false, reason: 'rcn_8' };
  return { eligible: true, providerGtin: matchingGtin, key };
}
