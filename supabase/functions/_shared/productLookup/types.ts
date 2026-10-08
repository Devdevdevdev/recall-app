/**
 * Phase 17.3c product lookup contract. A lookup only ever *suggests* a product name and brand for
 * ProductForm. It is never evidence of a recall, of recall applicability, of F-4, or of a model,
 * date, lot, variant or ownership, and nothing in the recall matching engine reads it.
 */

export const OFF_PROVIDER = 'open_food_facts' as const;
export type ProductLookupProviderId = typeof OFF_PROVIDER;

/** Open Food Facts family database that answered (`product_type=all` may redirect). */
export type OffDatabase =
  'openfoodfacts' | 'openbeautyfacts' | 'openpetfoodfacts' | 'openproductsfacts';

/** https://world.openfoodfacts.org/terms-of-use, read 2026-10-08. */
export const OFF_LICENSE = {
  database: 'ODbL-1.0',
  contents: 'DbCL-1.0',
  images: 'CC-BY-SA-3.0',
} as const;

/** What a UI must be able to show to attribute a suggestion (ODbL: licence + source link). */
export type ProductLookupAttribution = {
  provider: ProductLookupProviderId;
  database: OffDatabase;
  /** Display name, e.g. "Open Food Facts". */
  sourceName: string;
  /** The product page on the answering database. */
  sourceUrl: string;
  license: typeof OFF_LICENSE;
};

export type ProductLookupUnavailableReason =
  | 'disabled'
  | 'not_configured'
  | 'circuit_open'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'http_error'
  | 'invalid_response';

export type ProductLookupNotEligibleReason = 'invalid_gtin' | 'rcn_8';

/** What a provider (OFF adapter, or the Edge transport seen from the app) answers. */
export type ProductLookupProviderOutcome =
  | {
      status: 'found' | 'partial';
      name: string | null;
      brand: string | null;
      attribution: ProductLookupAttribution;
      /** When the data was fetched from the catalogue; defaults to now. */
      fetchedAt?: string;
    }
  | { status: 'not_found'; fetchedAt?: string }
  | { status: 'unavailable'; reason: ProductLookupUnavailableReason };

export type ProductLookupProvider = (
  providerGtin: string,
  key: string,
) => Promise<ProductLookupProviderOutcome>;

export type ProductLookupResult =
  | {
      /** `found`: name and brand; `partial`: exactly one of them. */
      status: 'found' | 'partial';
      key: string;
      name: string | null;
      brand: string | null;
      attribution: ProductLookupAttribution;
      fetchedAt: string;
      expiresAt: string;
      cache: 'hit' | 'miss';
    }
  | {
      status: 'not_found';
      key: string;
      fetchedAt: string;
      expiresAt: string;
      cache: 'hit' | 'miss';
    }
  | { status: 'not_eligible'; reason: ProductLookupNotEligibleReason }
  | { status: 'unavailable'; reason: ProductLookupUnavailableReason };

/**
 * One non-personal cache row. No raw provider response, no user id, no scan payload or
 * symbology: only the canonical GTIN-14 key, the suggestion, provenance, licence and timestamps.
 */
export type ProductLookupCacheEntry = {
  schema: 1;
  key: string;
  provider: ProductLookupProviderId;
  status: 'found' | 'partial' | 'not_found';
  name: string | null;
  brand: string | null;
  /** Null only for `not_found` (no data reused, nothing to attribute). */
  attribution: ProductLookupAttribution | null;
  fetchedAt: string;
  expiresAt: string;
};

export type ProductLookupCacheStore = {
  get(key: string): Promise<ProductLookupCacheEntry | null>;
  set(entry: ProductLookupCacheEntry): Promise<void>;
};
