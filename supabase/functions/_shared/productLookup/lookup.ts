import { isFresh, NEGATIVE_TTL_MS, parseCacheEntry, POSITIVE_TTL_MS } from './cache.ts';
import { productLookupEligibility } from './eligibility.ts';
import {
  OFF_PROVIDER,
  type ProductLookupCacheEntry,
  type ProductLookupCacheStore,
  type ProductLookupProvider,
  type ProductLookupProviderOutcome,
  type ProductLookupResult,
} from './types.ts';

export type LookupDependencies = {
  cache: ProductLookupCacheStore;
  provider: ProductLookupProvider;
  now?: () => Date;
};

function fromEntry(entry: ProductLookupCacheEntry, cache: 'hit' | 'miss'): ProductLookupResult {
  const timestamps = { key: entry.key, fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt };
  if (entry.status === 'not_found' || entry.attribution === null) {
    return { status: 'not_found', ...timestamps, cache };
  }
  return {
    status: entry.status,
    ...timestamps,
    name: entry.name,
    brand: entry.brand,
    attribution: entry.attribution,
    cache,
  };
}

/**
 * Phase 17.3c lookup chain:
 *   0. eligibility: invalid or RCN-8 => not_eligible, 0 provider call, 0 cache read or write;
 *   1. cache by canonical GTIN-14: fresh entry => answer, 0 provider call;
 *   2. provider (matching GTIN only), one attempt;
 *   3. found / partial / not_found are cached with their TTL; `unavailable` is never cached.
 * Nothing here throws: every failure ends as `unavailable`, and the caller falls back to manual
 * entry.
 */
export async function lookupProduct(
  matchingGtin: unknown,
  deps: LookupDependencies,
): Promise<ProductLookupResult> {
  const now = deps.now ?? (() => new Date());
  const eligibility = productLookupEligibility(matchingGtin);
  if (!eligibility.eligible) return { status: 'not_eligible', reason: eligibility.reason };
  const { key, providerGtin } = eligibility;

  try {
    const cached = await deps.cache.get(key);
    if (cached && cached.key === key && isFresh(cached, now())) return fromEntry(cached, 'hit');
  } catch {
    // An unreadable cache is a miss.
  }

  let outcome;
  try {
    outcome = await deps.provider(providerGtin, key);
  } catch {
    return { status: 'unavailable', reason: 'network' };
  }
  if (outcome.status === 'unavailable') return outcome;

  // A provider may report an older fetch (an upstream cache); never a future one.
  const nowTime = now().getTime();
  const fetchedAtTime = outcome.fetchedAt ? Date.parse(outcome.fetchedAt) : NaN;
  const fetchedAt = new Date(
    Number.isFinite(fetchedAtTime) ? Math.min(fetchedAtTime, nowTime) : nowTime,
  );
  const ttl = outcome.status === 'not_found' ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
  const entry: ProductLookupCacheEntry = {
    schema: 1,
    key,
    provider: OFF_PROVIDER,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: new Date(fetchedAt.getTime() + ttl).toISOString(),
    ...(outcome.status === 'not_found'
      ? { status: 'not_found', name: null, brand: null, attribution: null }
      : {
          status: outcome.status,
          name: outcome.name,
          brand: outcome.brand,
          attribution: outcome.attribution,
        }),
  };
  try {
    await deps.cache.set(entry);
  } catch {
    // Best effort: the suggestion is still returned.
  }
  return fromEntry(entry, 'miss');
}

/**
 * Re-validates a lookup result received over the network (the app reading `identify-product`)
 * as a provider outcome. Everything is checked again, including the suggestion quality rules and
 * the attribution; anything unexpected is `unavailable` and is never cached.
 */
export function providerOutcomeFromResult(
  value: unknown,
  key: string,
): ProductLookupProviderOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'unavailable', reason: 'invalid_response' };
  }
  const input = value as Record<string, unknown>;
  if (input.status === 'unavailable') {
    const reason = input.reason;
    return {
      status: 'unavailable',
      reason:
        reason === 'disabled' ||
        reason === 'not_configured' ||
        reason === 'circuit_open' ||
        reason === 'timeout' ||
        reason === 'network' ||
        reason === 'rate_limited' ||
        reason === 'http_error'
          ? reason
          : 'invalid_response',
    };
  }
  const entry = parseCacheEntry({
    schema: 1,
    provider: OFF_PROVIDER,
    key: input.key,
    status: input.status,
    name: input.status === 'not_found' ? null : input.name,
    brand: input.status === 'not_found' ? null : input.brand,
    attribution: input.status === 'not_found' ? null : input.attribution,
    fetchedAt: input.fetchedAt,
    expiresAt: input.expiresAt,
  });
  if (!entry || entry.key !== key) return { status: 'unavailable', reason: 'invalid_response' };
  if (entry.status === 'not_found' || entry.attribution === null) {
    return { status: 'not_found', fetchedAt: entry.fetchedAt };
  }
  return {
    status: entry.status,
    name: entry.name,
    brand: entry.brand,
    attribution: entry.attribution,
    fetchedAt: entry.fetchedAt,
  };
}
