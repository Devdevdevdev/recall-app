// Phase 17.3a: scan identity foundation. The camera payload (raw) and its symbology are kept,
// the matching GTIN and canonical GTIN-14 are derived with the single Phase 17.3-S primitive,
// a UPC-E is expanded only when the scanner reported upc_e, and manual input never is.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  toOwnedProduct,
  toOwnedProductScanProvenanceRow,
  toOwnedProductWriteRow,
} from '../src/data/ownedProductsMappers.ts';
import {
  gtinCarrierLengths,
  productBarcodeFormats,
  toScannedBarcode,
  validateGtin,
} from '../src/domain/barcode.ts';
import {
  barcodeScanForSubmission,
  productCreationPrefillFromParams,
  productFormValuesFromProduct,
  scannedBarcodeDetail,
  scannedBarcodeForGtin,
  scannedGtinNote,
  validateProductForm,
} from '../src/features/products/productFormUtils.ts';
import {
  canonicalGtin14,
  canonicalizeGtin,
  expandUpcE,
} from '../supabase/functions/_shared/matching/gtin.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const VECTORS_173S = 'tests/fixtures/phase-17-3-s-gtin-vectors.json';
const VECTORS_173A = 'tests/fixtures/phase-17-3a-upce-vectors.json';
const PGTAP_173A = 'supabase/tests/phase-17-3a-scan-provenance.sql';
const vectors = JSON.parse(await read(VECTORS_173S));
const vectors173a = JSON.parse(await read(VECTORS_173A));

const UPC_A = '091021037090';
const THULE_GTIN14 = '00091021037090';
const UPC_E = '04252614';
const UPC_E_EXPANDED = '042100005264';
const UPC_E_GTIN14 = '00042100005264';
const EAN_8 = '96385074';

/** Exactly the params ScanScreen.useBarcode sends. */
const routeParamsFor = (scanned) => ({
  barcodeRawValue: scanned.rawValue,
  barcodeSymbology: scanned.format,
  source: 'barcode_scan',
});

const productRow = {
  id: '173a0000-0000-4000-8000-000000000001',
  user_id: '173a0000-0000-4000-8000-000000009001',
  brand: null,
  product_name: 'Soda can',
  category: null,
  gtin: UPC_E_EXPANDED,
  model_number: null,
  serial_number: null,
  lot_number: null,
  scan_date: '2026-10-05',
  purchase_date: null,
  purchase_country_code: 'US',
  safety_attributes: {},
  barcode_raw_value: UPC_E,
  barcode_symbology: 'upc_e',
  image_path: null,
  identification_method: 'barcode_scan',
  identification_confidence: null,
  created_at: '2026-10-05T10:00:00.000Z',
  updated_at: '2026-10-05T10:00:00.000Z',
};

// ---------------------------------------------------------------------------
// T1-T8: scanner identity
// ---------------------------------------------------------------------------
test('T1: UPC-A is valid with canonical 00091021037090', () => {
  assert.deepEqual(toScannedBarcode('upc_a', UPC_A), {
    rawValue: UPC_A,
    format: 'upc_a',
    classification: 'valid_gtin',
    matchingGtin: UPC_A,
    canonicalGtin14: THULE_GTIN14,
    transformation: null,
  });
});

test('T2/T3: EAN-13 and GTIN-14 forms share the UPC-A canonical, raw kept per form', () => {
  const ean13 = toScannedBarcode('ean13', '0091021037090');
  assert.equal(ean13.canonicalGtin14, THULE_GTIN14);
  assert.equal(ean13.matchingGtin, '0091021037090');
  // A 12-digit payload reported as ean13 (same symbol family) is the same GTIN; no zero is added.
  const ean13Twelve = toScannedBarcode('ean13', UPC_A);
  assert.equal(ean13Twelve.canonicalGtin14, THULE_GTIN14);
  assert.equal(ean13Twelve.matchingGtin, UPC_A);
  const gtin14 = toScannedBarcode('itf14', THULE_GTIN14);
  assert.equal(gtin14.classification, 'valid_gtin');
  assert.equal(gtin14.canonicalGtin14, THULE_GTIN14);
  assert.equal(gtin14.matchingGtin, THULE_GTIN14);
  assert.equal(validateGtin(THULE_GTIN14).isValid, true, 'manual GTIN-14 is valid');
});

test('T4: UPC-E 04252614 with symbology upc_e expands to UPC-A 042100005264', () => {
  assert.deepEqual(toScannedBarcode('upc_e', UPC_E), {
    rawValue: UPC_E,
    format: 'upc_e',
    classification: 'valid_gtin',
    matchingGtin: UPC_E_EXPANDED,
    canonicalGtin14: UPC_E_GTIN14,
    transformation: 'upc_e_to_upc_a',
  });
  // A platform that already delivers the expanded UPC-A needs no transformation.
  const expanded = toScannedBarcode('upc_e', UPC_E_EXPANDED);
  assert.equal(expanded.canonicalGtin14, UPC_E_GTIN14);
  assert.equal(expanded.transformation, null);
});

test('T4: every 17.3-S UPC-E vector gives the same result through the scanner contract', () => {
  for (const vector of vectors.upce) {
    const scanned = toScannedBarcode('upc_e', vector.input);
    assert.equal(scanned.matchingGtin, vector.expanded, vector.id);
    assert.equal(scanned.canonicalGtin14, vector.canonical, vector.id);
    assert.equal(scanned.rawValue, vector.input, vector.id);
  }
});

test('T5: 04252614 without upc_e symbology is never expanded', () => {
  for (const format of ['ean8', 'ean13', 'upc_a', 'itf14', 'code128']) {
    const scanned = toScannedBarcode(format, UPC_E);
    assert.equal(scanned.matchingGtin, null, format);
    assert.equal(scanned.transformation, null, format);
  }
  assert.equal(validateGtin(UPC_E).isValid, false, 'manual 04252614 is an invalid GTIN-8');
  assert.equal(canonicalGtin14(UPC_E), null);
});

test('T6: a valid EAN-8 is a GTIN-8, never a UPC-E', () => {
  const ean8 = toScannedBarcode('ean8', EAN_8);
  assert.equal(ean8.canonicalGtin14, '00000096385074');
  assert.equal(ean8.transformation, null);
  // 01234558 is valid in both interpretations: only the reported symbology decides.
  assert.equal(toScannedBarcode('ean8', '01234558').canonicalGtin14, '00000001234558');
  assert.equal(toScannedBarcode('upc_e', '01234558').canonicalGtin14, '00012345000058');
});

test('T7: invalid or unsupported payloads fail closed', () => {
  const cases = [
    ['upc_a', '091021037091'], // bad check digit
    ['upc_e', '04252615'], // bad UPC-E check digit
    ['upc_e', '24252614'], // number system 2
    ['upc_e', '4252614'], // 7 digits
    ['upc_e', '425261'], // 6 digits
    ['ean13', THULE_GTIN14], // EAN-13 cannot carry 14 digits
    ['upc_a', EAN_8], // UPC-A cannot carry 8 digits
    ['itf14', UPC_A], // ITF-14 carries exactly 14 digits
    ['upc_a', ` ${UPC_A}`], // never trimmed silently at the scanner boundary
    ['upc_a', `${UPC_A}\n`],
    ['ean13', '００９１０２１０３７０９０'], // full-width digits
    ['ean13', ''],
  ];
  for (const [format, raw] of cases) {
    const scanned = toScannedBarcode(format, raw);
    assert.equal(
      scanned.classification,
      'invalid_or_unsupported',
      `${format} ${JSON.stringify(raw)}`,
    );
    assert.equal(scanned.matchingGtin, null);
    assert.equal(scanned.canonicalGtin14, null);
    assert.equal(scanned.rawValue, raw, 'raw is still reported unchanged');
  }
});

test('T7: a Code 128 is never treated as a GTIN, even with a valid check digit', () => {
  const numeric = toScannedBarcode('code128', UPC_A);
  assert.equal(numeric.classification, 'non_gtin_product_code');
  assert.equal(numeric.matchingGtin, null);
  assert.equal(
    toScannedBarcode('code128', '8SSA10M42792C1SG85R0L15').classification,
    'non_gtin_product_code',
  );
  assert.equal(toScannedBarcode('code128', ' \u0000 ').classification, 'invalid_or_unsupported');
  assert.equal(Object.hasOwn(gtinCarrierLengths, 'code128'), false);
});

test('T8: leading zeroes are preserved everywhere', () => {
  const scanned = toScannedBarcode('upc_e', UPC_E);
  assert.equal(scanned.rawValue, '04252614');
  assert.equal(scanned.matchingGtin, '042100005264');
  assert.equal(toScannedBarcode('ean13', '0091021037090').matchingGtin, '0091021037090');
  assert.equal(validateGtin('0091021037090').normalizedValue, '0091021037090');
});

// ---------------------------------------------------------------------------
// One GTIN semantics: app wrapper = Edge primitive = SQL vectors
// ---------------------------------------------------------------------------
test('shared semantics: app validation accepts exactly the 17.3-S canonical vectors', () => {
  for (const vector of vectors.canonical) {
    if (typeof vector.input !== 'string') continue;
    assert.equal(validateGtin(vector.input).isValid, vector.canonical !== null, vector.id);
    assert.equal(canonicalizeGtin(vector.input).canonicalGtin14, vector.canonical, vector.id);
  }
});

test('TS/SQL UPC-E parity: expandUpcE matches every vector the SQL mirror runs', () => {
  for (const vector of [...vectors.upce, ...vectors173a.upce]) {
    assert.equal(expandUpcE(vector.input), vector.expanded, vector.id);
    assert.equal(canonicalGtin14(expandUpcE(vector.input)), vector.canonical, vector.id);
  }
  assert.ok(vectors173a.upce.length >= 15);
  const d6 = new Set(
    [...vectors.upce, ...vectors173a.upce]
      .filter((vector) => vector.expanded && vector.input.startsWith('0'))
      .map((vector) => vector.input[6]),
  );
  assert.deepEqual(
    [...d6].sort(),
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
    'every d6 branch is covered for number system 0',
  );
});

test('TS/SQL UPC-E parity: the pgTAP suite embeds both vector files byte for byte', async () => {
  const pgtap = await read(PGTAP_173A);
  const s = /\$vectors\$\n([\s\S]*?)\n\$vectors\$/u.exec(pgtap);
  assert.ok(s, '17.3-S block present');
  assert.equal(s[1], (await read(VECTORS_173S)).trim());
  const blocks = [...pgtap.matchAll(/\$vectors173a\$\n([\s\S]*?)\n\$vectors173a\$/gu)];
  assert.equal(blocks.length, 2, 'both 17.3a blocks present');
  for (const block of blocks) assert.equal(block[1], (await read(VECTORS_173A)).trim());
  const migration = await read(
    'supabase/migrations/20261005090000_phase_17_3a_scan_identity_provenance.sql',
  );
  assert.match(
    migration,
    /when barcode_symbology = 'upc_e' and pg_catalog\.length\(barcode_raw_value\) = 8\s+then private\.expand_upce_to_upca\(barcode_raw_value\)/u,
    'only upc_e is ever expanded in SQL',
  );
  assert.equal(migration.match(/private\.expand_upce_to_upca\(barcode_raw_value\)/gu).length, 1);
});

test('shared semantics: the app has no second check-digit implementation', async () => {
  const barcode = await read('src/domain/barcode.ts');
  assert.match(barcode, /from '\.\.\/\.\.\/supabase\/functions\/_shared\/matching\/gtin\.ts'/u);
  assert.match(
    barcode,
    /from '\.\.\/\.\.\/supabase\/functions\/_shared\/matching\/normalization\.ts'/u,
  );
  assert.doesNotMatch(barcode, /weightedSum|% 10|padStart/u);
  assert.deepEqual(
    [...productBarcodeFormats],
    ['ean13', 'ean8', 'upc_a', 'upc_e', 'itf14', 'code128'],
    'no QR, DataMatrix or PDF417 enabled in 17.3a',
  );
});

// ---------------------------------------------------------------------------
// T9: manual input
// ---------------------------------------------------------------------------
test('T9: manual 8 digits are GTIN-8 only and never get a symbology', () => {
  const base = { ...productCreationPrefillFromParams({}).values, productName: 'Manual' };
  const ean8 = validateProductForm({ ...base, gtin: EAN_8 });
  assert.equal(ean8.input?.gtin, EAN_8);
  assert.equal(ean8.input?.barcodeScan, undefined);
  assert.equal(canonicalGtin14(ean8.input?.gtin), '00000096385074');
  assert.match(validateProductForm({ ...base, gtin: UPC_E }).errors.gtin ?? '', /check digit/u);
  for (const gtin of [UPC_A, '0091021037090', THULE_GTIN14]) {
    const result = validateProductForm({ ...base, gtin: ` ${gtin} ` });
    assert.equal(result.input?.gtin, gtin, 'manual input keeps its trimmed representation');
    assert.equal(canonicalGtin14(result.input?.gtin), THULE_GTIN14);
  }
  assert.equal(productCreationPrefillFromParams({}).scannedBarcode, null);
  assert.equal(barcodeScanForSubmission(null, EAN_8), null);
});

// ---------------------------------------------------------------------------
// T10-T12: provenance and route
// ---------------------------------------------------------------------------
test('T10/T11/T12: Scan -> route -> ProductForm loses nothing', async () => {
  for (const [format, raw, gtin] of [
    ['upc_a', UPC_A, UPC_A],
    ['ean13', '0091021037090', '0091021037090'],
    ['ean8', EAN_8, EAN_8],
    ['itf14', THULE_GTIN14, THULE_GTIN14],
    ['upc_e', UPC_E, UPC_E_EXPANDED],
  ]) {
    const scanned = toScannedBarcode(format, raw);
    const prefill = productCreationPrefillFromParams(routeParamsFor(scanned), 'US');
    assert.deepEqual(prefill.scannedBarcode, scanned, format);
    assert.equal(prefill.identificationMethod, 'barcode_scan');
    assert.equal(prefill.values.gtin, gtin, `${format}: form is prefilled with the matching GTIN`);
    assert.equal(prefill.values.purchaseCountryCode, 'US');
  }

  const screen = await read('src/features/scan/ScanScreen.tsx');
  assert.match(screen, /toScannedBarcode\(format, event\.data\)/u);
  assert.match(screen, /barcodeRawValue: detectedBarcode\.rawValue,/u);
  assert.match(screen, /barcodeSymbology: detectedBarcode\.format,/u);
  assert.doesNotMatch(screen, /JSON\.stringify|event\.raw/u, 'no JSON blob, no Android-only raw');
});

test('T12: route params are untrusted and revalidated', () => {
  const tampered = [
    { source: 'barcode_scan', barcodeRawValue: UPC_E, barcodeSymbology: 'ean8' },
    { source: 'barcode_scan', barcodeRawValue: UPC_E, barcodeSymbology: 'code128' },
    { source: 'barcode_scan', barcodeRawValue: UPC_E, barcodeSymbology: 'qr' },
    { source: 'barcode_scan', barcodeRawValue: [UPC_E], barcodeSymbology: 'upc_e' },
    { source: 'barcode_scan', barcodeRawValue: '04252615', barcodeSymbology: 'upc_e' },
    { source: 'ocr_assisted', barcodeRawValue: UPC_E, barcodeSymbology: 'upc_e' },
  ];
  for (const params of tampered) {
    const prefill = productCreationPrefillFromParams(params);
    assert.equal(prefill.scannedBarcode, null, JSON.stringify(params));
    assert.equal(prefill.values.gtin, '');
  }
  // The legacy bare-GTIN route still works, without provenance.
  const legacy = productCreationPrefillFromParams({ source: 'barcode_scan', gtin: UPC_A });
  assert.equal(legacy.values.gtin, UPC_A);
  assert.equal(legacy.scannedBarcode, null);
});

// ---------------------------------------------------------------------------
// T13-T15: save and edit
// ---------------------------------------------------------------------------
function saveFromScan(format, raw, edit = (values) => values) {
  const prefill = productCreationPrefillFromParams(routeParamsFor(toScannedBarcode(format, raw)));
  const { input } = validateProductForm(edit({ ...prefill.values, productName: 'Scanned' }));
  assert.ok(input);
  const barcodeScan = barcodeScanForSubmission(prefill.scannedBarcode, input.gtin);
  return {
    prefill,
    input,
    insertRow: {
      ...toOwnedProductWriteRow(input),
      ...toOwnedProductScanProvenanceRow(barcodeScan ?? undefined),
    },
  };
}

test('T13: saving a UPC-A scan is backend-compatible', () => {
  const { insertRow } = saveFromScan('upc_a', UPC_A);
  assert.equal(insertRow.gtin, UPC_A);
  assert.equal(canonicalGtin14(insertRow.gtin), THULE_GTIN14, 'SQL mirror gives the same key');
  assert.equal(insertRow.barcode_raw_value, UPC_A);
  assert.equal(insertRow.barcode_symbology, 'upc_a');
});

test('T14: saving a UPC-E scan stores the UPC-A for matching and keeps the raw UPC-E', () => {
  const { insertRow, prefill } = saveFromScan('upc_e', UPC_E);
  assert.equal(insertRow.gtin, UPC_E_EXPANDED);
  assert.equal(
    canonicalGtin14(insertRow.gtin),
    UPC_E_GTIN14,
    'the symbology-free 17.3-S primitive and SQL mirror already match it',
  );
  assert.equal(insertRow.barcode_raw_value, UPC_E);
  assert.equal(insertRow.barcode_symbology, 'upc_e');
  assert.equal(
    scannedGtinNote(prefill.scannedBarcode, UPC_E_EXPANDED),
    'Scanned UPC-E code 04252614, saved as its full 12-digit form.',
  );
  assert.equal(
    scannedGtinNote(toScannedBarcode('upc_a', UPC_A), UPC_A),
    null,
    'no note when nothing was transformed',
  );
});

test('T14: provenance is dropped when the user replaces the GTIN before saving', () => {
  const replaced = saveFromScan('upc_e', UPC_E, (values) => ({ ...values, gtin: '4006381333931' }));
  assert.equal(replaced.insertRow.barcode_raw_value, undefined);
  assert.equal(replaced.insertRow.barcode_symbology, undefined);
  const cleared = saveFromScan('upc_a', UPC_A, (values) => ({ ...values, gtin: '' }));
  assert.equal(cleared.insertRow.barcode_raw_value, undefined);
  // An equivalent representation is still the scanned GTIN.
  const equivalent = saveFromScan('upc_a', UPC_A, (values) => ({ ...values, gtin: THULE_GTIN14 }));
  assert.equal(equivalent.insertRow.barcode_raw_value, UPC_A);
  assert.equal(
    scannedGtinNote(toScannedBarcode('upc_e', UPC_E), '4006381333931'),
    null,
    'the UPC-E note disappears once the field no longer holds its expansion',
  );
});

test('T15: editing a scanned product never rewrites its provenance from the app', async () => {
  const product = toOwnedProduct(productRow);
  assert.deepEqual(product.barcodeScan, { rawValue: UPC_E, symbology: 'upc_e' });
  assert.equal(scannedBarcodeDetail(product), '04252614 (UPC-E)');
  assert.equal(
    scannedBarcodeForGtin(product.barcodeScan, product.gtin)?.transformation,
    'upc_e_to_upc_a',
  );

  const { input } = validateProductForm({
    ...productFormValuesFromProduct(product),
    brand: 'Acme',
  });
  assert.ok(input);
  const updateRow = toOwnedProductWriteRow(input);
  assert.equal(updateRow.gtin, UPC_E_EXPANDED);
  assert.equal('barcode_raw_value' in updateRow, false);
  assert.equal('barcode_symbology' in updateRow, false);

  // If the GTIN is later changed, the database clears the provenance (pgTAP). Even a row that
  // still carried it would never expose it: provenance only describes the current gtin.
  const edited = { ...product, gtin: '4006381333931' };
  assert.equal(scannedBarcodeDetail(edited), null);
  assert.equal(scannedBarcodeForGtin(edited.barcodeScan, edited.gtin), null);

  const repository = await read('src/data/SupabaseOwnedProductsRepository.ts');
  const update = repository.slice(repository.indexOf('async update('));
  assert.doesNotMatch(update.slice(0, update.indexOf('async delete(')), /ScanProvenance|barcode_/u);
});

test('T15: defense in depth — the mapper never exposes provenance that does not describe gtin', () => {
  const stale = [
    { gtin: '4006381333931' }, // UPC-E raw kept beside another GTIN (SQL cannot expand it)
    { gtin: null },
    { gtin: '042100005265' }, // invalid
    { gtin: '04252614' }, // the raw UPC-E itself, read without symbology
    { barcode_raw_value: '04252615' }, // invalid UPC-E
  ];
  for (const change of stale) {
    assert.equal(
      'barcodeScan' in toOwnedProduct({ ...productRow, ...change }),
      false,
      JSON.stringify(change),
    );
  }
  for (const gtin of [UPC_E_EXPANDED, '0042100005264', UPC_E_GTIN14]) {
    assert.deepEqual(
      toOwnedProduct({ ...productRow, gtin }).barcodeScan,
      { rawValue: UPC_E, symbology: 'upc_e' },
      `equivalent ${gtin}`,
    );
  }
});

test('T15: a UPC-A scan adds no redundant detail row', () => {
  const product = toOwnedProduct({
    ...productRow,
    gtin: UPC_A,
    barcode_raw_value: UPC_A,
    barcode_symbology: 'upc_a',
  });
  assert.equal(scannedBarcodeDetail(product), null);
});

// ---------------------------------------------------------------------------
// T16: existing products
// ---------------------------------------------------------------------------
test('T16: existing manual and pre-17.3a products are unchanged', () => {
  const { barcode_raw_value: _raw, barcode_symbology: _symbology, ...legacyRow } = productRow;
  const legacy = toOwnedProduct({
    ...legacyRow,
    gtin: '04252614',
    identification_method: 'manual',
  });
  assert.equal('barcodeScan' in legacy, false);
  assert.equal(scannedBarcodeDetail(legacy), null);
  const nullColumns = toOwnedProduct({
    ...productRow,
    barcode_raw_value: null,
    barcode_symbology: null,
  });
  assert.equal('barcodeScan' in nullColumns, false);
  const unknownSymbology = toOwnedProduct({ ...productRow, barcode_symbology: 'code128' });
  assert.equal(
    'barcodeScan' in unknownSymbology,
    false,
    'unknown provenance is ignored, not trusted',
  );
  // A historical 8-digit GTIN is never re-read as UPC-E.
  assert.equal(canonicalGtin14(legacy.gtin), null);
});
