import { isValidGtin, normalizeGtin } from './normalization.ts';

/**
 * Phase 17.3-S: the single GTIN identity primitive used by every matching comparison.
 *
 * GS1 stores every GTIN in a 14-digit field, right-justified and zero-filled. Two valid
 * GTIN-8/12/13/14 representations are the same commercial identifier if and only if their
 * zero-filled 14-digit forms are equal; the check digit is unchanged because GS1 weights run
 * from the right. Zeroes are only ever added on the left, never removed, and the value is never
 * converted to a number.
 *
 * Equivalence means "same GTIN" and nothing more. It never confirms a recall by itself and
 * never relaxes model, lot, date, jurisdiction, coverage, or automatic-alert (F-4) conditions.
 *
 * `private.canonical_gtin14(text)` is the SQL mirror of `canonicalGtin14`; both are checked
 * against tests/fixtures/phase-17-3-s-gtin-vectors.json.
 */

export const GTIN_SYMBOLOGIES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'itf14', 'code128'] as const;
export type GtinSymbology = (typeof GTIN_SYMBOLOGIES)[number];
export type GtinFormat = 'gtin8' | 'gtin12' | 'gtin13' | 'gtin14';

export type GtinIdentity = {
  /** The input exactly as received; never rewritten. */
  raw: string;
  valid: boolean;
  /** Digit count of the trimmed input, or null when it is not all digits. */
  sourceLength: number | null;
  /** Format of the validated GTIN (a UPC-E is identified as its expanded GTIN-12). */
  gtinFormat: GtinFormat | null;
  canonicalGtin14: string | null;
  symbology: GtinSymbology | null;
  /** The GTIN-12 a UPC-E expands to, only when the symbology was explicitly `upc_e`. */
  expandedFromUpce: string | null;
};

const formatByLength: Readonly<Record<number, GtinFormat>> = {
  8: 'gtin8',
  12: 'gtin12',
  13: 'gtin13',
  14: 'gtin14',
};

/** Canonical GTIN-14 of a valid GTIN-8/12/13/14, else null. No symbology, so no UPC-E. */
export function canonicalGtin14(value: string | null | undefined): string | null {
  const normalized = normalizeGtin(value);
  return normalized && isValidGtin(normalized) ? normalized.padStart(14, '0') : null;
}

/** True only when both values are valid GTINs with the same canonical GTIN-14. */
export function gtinsEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const canonicalLeft = canonicalGtin14(left);
  return canonicalLeft !== null && canonicalLeft === canonicalGtin14(right);
}

/**
 * Expands an 8-digit UPC-E (number system 0 or 1) to its GTIN-12 (UPC-A) using the GS1
 * zero-suppression rules. The UPC-E check digit is the check digit of the expanded UPC-A, so
 * the result is returned only when that check digit verifies. Callers must only use this when
 * the symbology is known to be UPC-E: an 8-digit value alone is a GTIN-8.
 */
export function expandUpcE(value: string): string | null {
  if (!/^[01]\d{7}$/u.test(value)) return null;
  const numberSystem = value.slice(0, 1);
  const [d1, d2, d3, d4, d5, d6] = value.slice(1, 7);
  const checkDigit = value.slice(7);
  let body: string;
  if (d6 === '0' || d6 === '1' || d6 === '2') {
    body = `${numberSystem}${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  } else if (d6 === '3') {
    body = `${numberSystem}${d1}${d2}${d3}00000${d4}${d5}`;
  } else if (d6 === '4') {
    body = `${numberSystem}${d1}${d2}${d3}${d4}00000${d5}`;
  } else {
    body = `${numberSystem}${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  }
  const upcA = `${body}${checkDigit}`;
  return isValidGtin(upcA) ? upcA : null;
}

/**
 * Full identity of one observed value. The symbology only matters for an 8-digit `upc_e`
 * value, which must be expanded; GTIN-12/13/14 need no symbology to be canonicalized.
 */
export function canonicalizeGtin(
  value: string,
  options: { symbology?: GtinSymbology | null } = {},
): GtinIdentity {
  const symbology = options.symbology ?? null;
  const normalized = normalizeGtin(value);
  const base = {
    raw: value,
    sourceLength: normalized ? normalized.length : null,
    symbology,
  };
  const invalid: GtinIdentity = {
    ...base,
    valid: false,
    gtinFormat: null,
    canonicalGtin14: null,
    expandedFromUpce: null,
  };
  if (!normalized) return invalid;

  if (symbology === 'upc_e' && normalized.length === 8) {
    const expanded = expandUpcE(normalized);
    return expanded
      ? {
          ...base,
          valid: true,
          gtinFormat: 'gtin12',
          canonicalGtin14: expanded.padStart(14, '0'),
          expandedFromUpce: expanded,
        }
      : invalid;
  }

  const canonical = canonicalGtin14(normalized);
  return canonical
    ? {
        ...base,
        valid: true,
        gtinFormat: formatByLength[normalized.length] ?? null,
        canonicalGtin14: canonical,
        expandedFromUpce: null,
      }
    : invalid;
}
