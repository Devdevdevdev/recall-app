/** Product barcode formats intentionally accepted by Recall's camera scanner. */
export const productBarcodeFormats = [
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'itf14',
  'code128',
] as const;

export type ProductBarcodeFormat = (typeof productBarcodeFormats)[number];

export type GtinValidationResult = {
  normalizedValue: string | null;
  isSyntaxValid: boolean;
  isValid: boolean;
};

export type BarcodeClassification =
  'valid_gtin' | 'non_gtin_product_code' | 'invalid_or_unsupported';

export type ScannedBarcode = {
  classification: BarcodeClassification;
  rawValue: string;
  normalizedValue: string | null;
  format: ProductBarcodeFormat;
  gtin: string | null;
  isValidGtin: boolean;
};

const supportedGtinLengths = [8, 12, 13, 14] as const;

/**
 * Normalizes a possible GTIN without ever converting it to a number, which preserves leading
 * zeroes. GS1 check digits use alternating 3 and 1 weights from the right, excluding the check
 * digit itself.
 */
export function validateGtin(rawValue: string): GtinValidationResult {
  const normalizedValue = rawValue.trim();
  const isSyntaxValid =
    /^\d+$/.test(normalizedValue) &&
    supportedGtinLengths.includes(normalizedValue.length as (typeof supportedGtinLengths)[number]);

  if (!isSyntaxValid) {
    return { normalizedValue: normalizedValue || null, isSyntaxValid: false, isValid: false };
  }

  const body = normalizedValue.slice(0, -1);
  const expectedCheckDigit = Number(normalizedValue.at(-1));
  const weightedSum = [...body]
    .reverse()
    .reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
  const calculatedCheckDigit = (10 - (weightedSum % 10)) % 10;

  return {
    normalizedValue,
    isSyntaxValid: true,
    isValid: calculatedCheckDigit === expectedCheckDigit,
  };
}

export function toScannedBarcode(
  format: ProductBarcodeFormat,
  rawValue: string,
  valueForNormalization = rawValue,
): ScannedBarcode {
  const validation = validateGtin(valueForNormalization);
  const isUsefulCode128 =
    format === 'code128' &&
    validation.normalizedValue !== null &&
    !/[\u0000-\u001f\u007f]/u.test(validation.normalizedValue);
  const classification: BarcodeClassification = validation.isValid
    ? 'valid_gtin'
    : isUsefulCode128
      ? 'non_gtin_product_code'
      : 'invalid_or_unsupported';

  return {
    classification,
    rawValue,
    normalizedValue: validation.normalizedValue,
    format,
    gtin: validation.isValid ? validation.normalizedValue : null,
    isValidGtin: validation.isValid,
  };
}
