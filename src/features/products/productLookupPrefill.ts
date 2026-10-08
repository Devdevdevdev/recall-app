import { canonicalGtin14 } from '../../../supabase/functions/_shared/matching/gtin.ts';
import type {
  ProductLookupAttribution,
  ProductLookupResult,
} from '../../../supabase/functions/_shared/productLookup/types.ts';

import type { ProductFormValues } from './productFormUtils.ts';

/** `idle`: no eligible scan, nothing is shown. `loading`: the lookup is still running. */
export type ProductLookupState = { status: 'idle' } | { status: 'loading' } | ProductLookupResult;

export type LookupField = 'productName' | 'brand';
export type AppliedSuggestion = Partial<Record<LookupField, string>>;

/**
 * Phase 17.3c rule, deterministic: user input wins. A suggested value fills a field only when
 *   - the lookup found it (`found` or `partial`, never invented for a missing field);
 *   - the GTIN in the form is still the looked-up GTIN (same canonical GTIN-14);
 *   - the user has not edited that field since the form opened, even to clear it;
 *   - the field is empty.
 * Otherwise the field is left exactly as it is, whenever the answer arrives.
 */
export function applyLookupSuggestion(
  values: ProductFormValues,
  editedFields: ReadonlySet<keyof ProductFormValues>,
  lookup: ProductLookupState,
): { values: ProductFormValues; applied: AppliedSuggestion } {
  if (
    (lookup.status !== 'found' && lookup.status !== 'partial') ||
    canonicalGtin14(values.gtin) !== lookup.key
  ) {
    return { values, applied: {} };
  }
  const next = { ...values };
  const applied: AppliedSuggestion = {};
  const suggestions: Record<LookupField, string | null> = {
    productName: lookup.name,
    brand: lookup.brand,
  };
  for (const field of ['productName', 'brand'] as const) {
    const suggestion = suggestions[field];
    if (suggestion && !editedFields.has(field) && values[field].trim() === '') {
      next[field] = suggestion;
      applied[field] = suggestion;
    }
  }
  return Object.keys(applied).length ? { values: next, applied } : { values, applied };
}

export type ProductLookupNotice =
  { kind: 'info'; text: string } | { kind: 'attribution'; attribution: ProductLookupAttribution };

/**
 * The single line ProductForm shows under "Product". A suggestion is attributed (ODbL: licence
 * and source link) while a suggested value is still in the form; the wording never presents it as
 * certain or official.
 */
export function productLookupNotice(
  lookup: ProductLookupState,
  values: Pick<ProductFormValues, LookupField>,
): ProductLookupNotice | null {
  switch (lookup.status) {
    case 'loading':
      return { kind: 'info', text: 'Looking up the product name and brand…' };
    case 'found':
    case 'partial': {
      const stillSuggested =
        (lookup.name !== null && values.productName === lookup.name) ||
        (lookup.brand !== null && values.brand === lookup.brand);
      return stillSuggested ? { kind: 'attribution', attribution: lookup.attribution } : null;
    }
    case 'not_found':
      return {
        kind: 'info',
        text: 'No product details found for this barcode. Enter the name and brand yourself.',
      };
    case 'not_eligible':
      return lookup.reason === 'rcn_8'
        ? {
            kind: 'info',
            text: 'Store-specific barcodes are not looked up. Enter the name and brand yourself.',
          }
        : null;
    case 'unavailable':
      return {
        kind: 'info',
        text: 'Product lookup is unavailable right now. Enter the name and brand yourself.',
      };
    default:
      return null;
  }
}
