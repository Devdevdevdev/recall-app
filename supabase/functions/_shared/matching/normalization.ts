const supportedGtinLengths = new Set([8, 12, 13, 14]);
const stopWords = new Set([
  'a',
  'an',
  'and',
  'by',
  'due',
  'for',
  'from',
  'of',
  'the',
  'to',
  'with',
]);

function normalizedUnicode(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

/** Preserves leading zeroes and rejects, rather than removes, non-digit characters. */
export function normalizeGtin(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return /^\d+$/u.test(normalized) ? normalized : null;
}

export function isValidGtin(value: string | null | undefined): boolean {
  const normalized = normalizeGtin(value);
  if (!normalized || !supportedGtinLengths.has(normalized.length)) {
    return false;
  }

  const body = normalized.slice(0, -1);
  const expectedCheckDigit = Number(normalized.at(-1));
  const weightedSum = [...body]
    .reverse()
    .reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);

  return (10 - (weightedSum % 10)) % 10 === expectedCheckDigit;
}

/** Case-folds identifiers but deliberately preserves punctuation such as -, /, and dots. */
export function normalizeIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizedUnicode(value).toLocaleUpperCase('en-US');
  return normalized || null;
}

export function normalizeProductName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizedUnicode(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized || null;
}

export function productNameTokens(value: string | null | undefined): readonly string[] {
  const normalized = normalizeProductName(value);
  if (!normalized) {
    return [];
  }

  return [...new Set(normalized.split(' ').filter((token) => token && !stopWords.has(token)))];
}

/** Symmetric Jaccard token overlap in the inclusive range 0..1. */
export function productNameOverlap(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftTokens = new Set(productNameTokens(left));
  const rightTokens = new Set(productNameTokens(right));
  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

export type RangeComparison = 'inside' | 'outside' | 'ambiguous' | 'unavailable';

/**
 * Compares only exact endpoints or fixed-width digit ranges. Arbitrary serial/lot identifiers are
 * never ordered lexically.
 */
export function compareIdentifierRange(
  value: string | null | undefined,
  from: string | null | undefined,
  to: string | null | undefined,
): RangeComparison {
  const normalizedValue = normalizeIdentifier(value);
  const normalizedFrom = normalizeIdentifier(from);
  const normalizedTo = normalizeIdentifier(to);
  if (!normalizedValue || (!normalizedFrom && !normalizedTo)) {
    return 'unavailable';
  }
  if (!normalizedFrom || !normalizedTo) {
    return 'ambiguous';
  }
  if (normalizedFrom === normalizedTo) {
    return normalizedValue === normalizedFrom ? 'inside' : 'outside';
  }
  if (
    /^\d+$/u.test(normalizedValue) &&
    /^\d+$/u.test(normalizedFrom) &&
    /^\d+$/u.test(normalizedTo) &&
    normalizedValue.length === normalizedFrom.length &&
    normalizedFrom.length === normalizedTo.length
  ) {
    const numericValue = BigInt(normalizedValue);
    const numericFrom = BigInt(normalizedFrom);
    const numericTo = BigInt(normalizedTo);
    if (numericFrom > numericTo) {
      return 'ambiguous';
    }
    return numericValue >= numericFrom && numericValue <= numericTo ? 'inside' : 'outside';
  }

  return 'ambiguous';
}
