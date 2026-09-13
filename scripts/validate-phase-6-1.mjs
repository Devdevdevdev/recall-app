import assert from 'node:assert/strict';

import { toScannedBarcode } from '../src/domain/barcode.ts';
import {
  dateOnlyToLocalDate,
  dateToDateOnly,
  isFuturePurchaseDate,
  purchaseDateOrNull,
} from '../src/features/products/purchaseDate.ts';

const validEan13 = toScannedBarcode('ean13', '4006381333931');
assert.equal(validEan13.classification, 'valid_gtin');
assert.equal(validEan13.gtin, '4006381333931');

const validUpcA = toScannedBarcode('upc_a', '036000291452');
assert.equal(validUpcA.classification, 'valid_gtin');
assert.equal(validUpcA.gtin, '036000291452');

const code128 = toScannedBarcode('code128', '8SSA10M42792C1SG85R0L15');
assert.equal(code128.classification, 'non_gtin_product_code');
assert.equal(code128.gtin, null);

const malformed = toScannedBarcode('code128', '  \u0000  ');
assert.equal(malformed.classification, 'invalid_or_unsupported');
assert.equal(malformed.gtin, null);

const dateOnly = '2026-09-13';
const localDate = dateOnlyToLocalDate(dateOnly);
assert.ok(localDate);
assert.equal(dateToDateOnly(localDate), dateOnly);
assert.equal(isFuturePurchaseDate('2026-09-14', dateOnly), true);
assert.equal(isFuturePurchaseDate(dateOnly, dateOnly), false);

assert.equal(purchaseDateOrNull(''), null);
assert.equal(purchaseDateOrNull('  2026-09-13  '), dateOnly);

console.log('Phase 6.1 barcode and date validation passed (13 assertions).');
