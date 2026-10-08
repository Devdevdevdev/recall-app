import {
  OFF_LICENSE,
  OFF_PROVIDER,
  type OffDatabase,
  type ProductLookupAttribution,
} from './types.ts';

/** Same limits as ProductForm, so a suggestion is never silently truncated by the input. */
export const SUGGESTED_NAME_MAX_LENGTH = 200;
export const SUGGESTED_BRAND_MAX_LENGTH = 120;

// Catalogue placeholders that mean "no value", not a value (compared without case/punctuation).
const PLACEHOLDERS = new Set([
  'unknown',
  'inconnu',
  'inconnue',
  'na',
  'nd',
  'none',
  'null',
  'undefined',
  'generic',
  'generique',
  'unbranded',
  'nobrand',
  'sansmarque',
  'doesnotapply',
]);

function compact(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Minimum quality to suggest a value: a string that, once control characters and whitespace runs
 * are collapsed, holds 2..max characters including at least one letter, and is not a placeholder.
 * Anything else is "no value": never truncated, never repaired, never invented.
 */
function cleanSuggestedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim();
  if (cleaned.length < 2 || cleaned.length > maxLength) return null;
  if (!/\p{L}/u.test(cleaned)) return null;
  if (PLACEHOLDERS.has(compact(cleaned))) return null;
  return cleaned;
}

export function cleanSuggestedName(value: unknown): string | null {
  return cleanSuggestedText(value, SUGGESTED_NAME_MAX_LENGTH);
}

/**
 * OFF `brands` is a comma-separated list ("Nutella, Ferrero"); its first usable entry is
 * suggested. Entries are never merged or reordered.
 */
export function cleanSuggestedBrand(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  for (const part of value.split(',')) {
    const brand = cleanSuggestedText(part, SUGGESTED_BRAND_MAX_LENGTH);
    if (brand) return brand;
  }
  return null;
}

const DATABASES: Readonly<Record<string, { database: OffDatabase; sourceName: string }>> = {
  'world.openfoodfacts.org': { database: 'openfoodfacts', sourceName: 'Open Food Facts' },
  'world.openbeautyfacts.org': { database: 'openbeautyfacts', sourceName: 'Open Beauty Facts' },
  'world.openpetfoodfacts.org': { database: 'openpetfoodfacts', sourceName: 'Open Pet Food Facts' },
  'world.openproductsfacts.org': {
    database: 'openproductsfacts',
    sourceName: 'Open Products Facts',
  },
};

/** Only the four Open Food Facts family hosts are accepted, including after a redirect. */
export function offDatabaseForHost(
  host: string,
): { database: OffDatabase; sourceName: string } | null {
  return Object.prototype.hasOwnProperty.call(DATABASES, host) ? (DATABASES[host] ?? null) : null;
}

export function offAttribution(host: string, code: string): ProductLookupAttribution | null {
  const database = offDatabaseForHost(host);
  if (!database || !/^[0-9]{8,14}$/u.test(code)) return null;
  return {
    provider: OFF_PROVIDER,
    ...database,
    sourceUrl: `https://${host}/product/${code}`,
    license: OFF_LICENSE,
  };
}

/** Strict re-validation of an attribution read from storage or from the network. */
export function parseAttribution(value: unknown): ProductLookupAttribution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.provider !== OFF_PROVIDER || typeof input.sourceUrl !== 'string') return null;
  const match = /^https:\/\/([a-z.]+)\/product\/([0-9]{8,14})$/u.exec(input.sourceUrl);
  if (!match) return null;
  const attribution = offAttribution(match[1] ?? '', match[2] ?? '');
  return attribution && attribution.database === input.database ? attribution : null;
}
