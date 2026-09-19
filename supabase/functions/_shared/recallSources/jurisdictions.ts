import type { RecallJurisdiction } from './types.ts';

const euCountries = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
]);

const eeaCountries = new Set([...euCountries, 'IS', 'LI', 'NO']);

/** Geography is retrieval context only; callers must not use false as a hard match rejection. */
export function isJurisdictionRelevantToCountry(
  jurisdiction: RecallJurisdiction,
  purchaseCountryCode: string | null,
): boolean {
  if (jurisdiction.type === 'global') return true;
  if (!purchaseCountryCode) return true;
  if (jurisdiction.type === 'country') return jurisdiction.code === purchaseCountryCode;
  if (jurisdiction.code === 'EU') return euCountries.has(purchaseCountryCode);
  if (jurisdiction.code === 'EEA') return eeaCountries.has(purchaseCountryCode);
  return false;
}
