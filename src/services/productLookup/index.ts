import 'expo-sqlite/localStorage/install';

import { createKeyValueProductLookupCache } from '../../../supabase/functions/_shared/productLookup/cache.ts';
import {
  lookupProduct,
  providerOutcomeFromResult,
} from '../../../supabase/functions/_shared/productLookup/lookup.ts';
import type {
  ProductLookupProvider,
  ProductLookupResult,
} from '../../../supabase/functions/_shared/productLookup/types.ts';
import { requireSupabaseClient } from '../supabase';

/** Phase 17.3b client budget; the server gives OFF 1 500 ms. One attempt, never retried. */
export const CLIENT_LOOKUP_TIMEOUT_MS = 5_000;

// Device cache: canonical GTIN-14 => suggestion + provenance, licence and TTL. No account data;
// cleared on sign-out because the keys still reveal which barcodes this device looked up.
const deviceCache = createKeyValueProductLookupCache(
  () => globalThis.localStorage ?? null,
  'recall.productLookup.v1',
);

// The request body is the matching GTIN only; the session JWT only proves a signed-in caller.
const identifyProductEndpoint: ProductLookupProvider = async (providerGtin, key) => {
  try {
    const { data, error } = await requireSupabaseClient().functions.invoke<unknown>(
      'identify-product',
      { body: { gtin: providerGtin }, timeout: CLIENT_LOOKUP_TIMEOUT_MS },
    );
    if (error || !data) return { status: 'unavailable', reason: 'network' };
    return providerOutcomeFromResult(data, key);
  } catch {
    return { status: 'unavailable', reason: 'network' };
  }
};

/** Never throws: any failure is `unavailable`, and ProductForm stays fully manual. */
export function lookupProductSuggestion(matchingGtin: string): Promise<ProductLookupResult> {
  return lookupProduct(matchingGtin, { cache: deviceCache, provider: identifyProductEndpoint });
}

export function clearProductLookupCache(): void {
  deviceCache.clear();
}
