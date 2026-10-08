import { cleanSuggestedBrand, cleanSuggestedName, parseAttribution } from './quality.ts';
import {
  OFF_PROVIDER,
  type ProductLookupCacheEntry,
  type ProductLookupCacheStore,
} from './types.ts';

/** Phase 17.3b section 10: positive 30 days, negative 7 days (OFF keeps growing). */
export const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const GTIN14 = /^[0-9]{14}$/u;

function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Strict validation of a stored entry. Anything malformed, from another schema, or whose values
 * no longer pass the suggestion quality rules is treated as a cache miss.
 */
export function parseCacheEntry(value: unknown): ProductLookupCacheEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const fetchedAt = instant(input.fetchedAt);
  const expiresAt = instant(input.expiresAt);
  if (
    input.schema !== 1 ||
    input.provider !== OFF_PROVIDER ||
    typeof input.key !== 'string' ||
    !GTIN14.test(input.key) ||
    fetchedAt === null ||
    expiresAt === null ||
    expiresAt <= fetchedAt
  ) {
    return null;
  }
  const base = {
    schema: 1,
    key: input.key,
    provider: OFF_PROVIDER,
    fetchedAt: input.fetchedAt as string,
    expiresAt: input.expiresAt as string,
  } as const;

  if (input.status === 'not_found') {
    return input.name === null && input.brand === null && input.attribution === null
      ? { ...base, status: 'not_found', name: null, brand: null, attribution: null }
      : null;
  }
  if (input.status !== 'found' && input.status !== 'partial') return null;
  const name = input.name === null ? null : cleanSuggestedName(input.name);
  const brand = input.brand === null ? null : cleanSuggestedBrand(input.brand);
  const attribution = parseAttribution(input.attribution);
  if (
    attribution === null ||
    name !== input.name ||
    brand !== input.brand ||
    (name === null && brand === null) ||
    input.status !== (name !== null && brand !== null ? 'found' : 'partial')
  ) {
    return null;
  }
  return { ...base, status: input.status, name, brand, attribution };
}

export function isFresh(entry: ProductLookupCacheEntry, now: Date): boolean {
  return Date.parse(entry.expiresAt) > now.getTime();
}

/** Non-durable, bounded, per-process store (Edge isolate). Oldest insertion is evicted first. */
export function createMemoryProductLookupCache(maxEntries = 500): ProductLookupCacheStore {
  const entries = new Map<string, ProductLookupCacheEntry>();
  return {
    get: async (key) => entries.get(key) ?? null,
    set: async (entry) => {
      entries.delete(entry.key);
      entries.set(entry.key, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * Store kept as one JSON document in a key-value storage (the device's `localStorage`). Bounded;
 * expired and oldest entries are dropped on write. A storage failure is only ever a cache miss.
 */
export function createKeyValueProductLookupCache(
  storage: () => KeyValueStorage | null,
  storageKey: string,
  maxEntries = 200,
): ProductLookupCacheStore & { clear(): void } {
  function readAll(): ProductLookupCacheEntry[] {
    try {
      const raw = storage()?.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.map(parseCacheEntry).filter((entry) => entry !== null)
        : [];
    } catch {
      return [];
    }
  }

  return {
    get: async (key) => readAll().find((entry) => entry.key === key) ?? null,
    set: async (entry) => {
      const now = Date.now();
      const kept = readAll()
        .filter((existing) => existing.key !== entry.key && Date.parse(existing.expiresAt) > now)
        .concat(entry)
        .sort((left, right) => Date.parse(left.fetchedAt) - Date.parse(right.fetchedAt))
        .slice(-maxEntries);
      try {
        storage()?.setItem(storageKey, JSON.stringify(kept));
      } catch {
        // Best effort: an unwritable cache only means the next scan looks the product up again.
      }
    },
    clear: () => {
      try {
        storage()?.removeItem(storageKey);
      } catch {
        // Nothing to do: the cache holds no account data and expires on its own.
      }
    },
  };
}
