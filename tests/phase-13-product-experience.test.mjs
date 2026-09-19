import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  COUNTRY_CATALOG,
  getCountryName,
  isSupportedCountryCode,
  searchCountries,
} from '../src/domain/countries.ts';
import { toOwnedProduct, toOwnedProductWriteRow } from '../src/data/ownedProductsMappers.ts';
import {
  mergeOptionalDefaultCountry,
  productCreationPrefillFromParams,
  productFormValuesFromProduct,
  validateProductForm,
} from '../src/features/products/productFormUtils.ts';
import {
  formatMonitoringStatus,
  getAuthorityDisplayName,
  getJurisdictionDisplayName,
  getSourceLanguageDisplayName,
  inferJurisdictionType,
  toCoverageSource,
} from '../src/features/coverage/coveragePresentation.ts';
import { buildEvidenceFingerprint } from '../supabase/functions/_shared/recallMatching/fingerprint.ts';
import { projectOwnedProduct } from '../supabase/functions/_shared/recallMatching/projection.ts';

const productRow = {
  id: '10000000-0000-4000-8000-000000000001',
  user_id: '10000000-0000-4000-8000-000000000002',
  brand: 'Thule',
  product_name: 'Sleek stroller',
  category: 'Strollers',
  gtin: '091021037090',
  model_number: '11000001',
  serial_number: null,
  lot_number: null,
  scan_date: '2026-09-10',
  purchase_date: '2026-09-10',
  purchase_country_code: 'BE',
  image_path: null,
  identification_method: 'manual',
  identification_confidence: null,
  created_at: '2026-09-10T10:00:00.000Z',
  updated_at: '2026-09-10T10:00:00.000Z',
};

const product = {
  id: productRow.id,
  userId: productRow.user_id,
  brand: productRow.brand,
  productName: productRow.product_name,
  category: productRow.category,
  gtin: productRow.gtin,
  modelNumber: productRow.model_number,
  serialNumber: productRow.serial_number,
  lotNumber: productRow.lot_number,
  scanDate: productRow.scan_date,
  purchaseDate: productRow.purchase_date,
  purchaseCountryCode: productRow.purchase_country_code,
  imagePath: productRow.image_path,
  identificationMethod: productRow.identification_method,
  identificationConfidence: productRow.identification_confidence,
  createdAt: productRow.created_at,
  updatedAt: productRow.updated_at,
};

test('country catalog is canonical ISO alpha-2 data with friendly English lookup', () => {
  assert.equal(COUNTRY_CATALOG.length, 249);
  assert.equal(new Set(COUNTRY_CATALOG.map(({ code }) => code)).size, COUNTRY_CATALOG.length);
  assert.ok(COUNTRY_CATALOG.every(({ code }) => /^[A-Z]{2}$/u.test(code)));
  assert.deepEqual(
    COUNTRY_CATALOG.find(({ code }) => code === 'BE'),
    { code: 'BE', name: 'Belgium' },
  );
  assert.equal(getCountryName('US'), 'United States');
  assert.equal(getCountryName(null), 'Not specified');
  assert.equal(getCountryName('ZZ'), 'Not specified');
});

test('country validation accepts only supported canonical uppercase country codes', () => {
  assert.equal(isSupportedCountryCode('BE'), true);
  assert.equal(isSupportedCountryCode('GB'), true);
  assert.equal(isSupportedCountryCode('be'), false);
  assert.equal(isSupportedCountryCode('EU'), false);
  assert.equal(isSupportedCountryCode('ZZ'), false);
  assert.equal(isSupportedCountryCode('Belgium'), false);
  assert.equal(isSupportedCountryCode(null), false);
});

test('country search uses case-insensitive English names', () => {
  assert.deepEqual(searchCountries('  belGI  '), [{ code: 'BE', name: 'Belgium' }]);
  const unitedStatesMatches = searchCountries('united states');
  assert.ok(unitedStatesMatches.some(({ code }) => code === 'US'));
  assert.ok(unitedStatesMatches.every(({ name }) => name.toLowerCase().includes('united states')));
  assert.deepEqual(searchCountries('ZZ'), []);
});

test('new product prefills use the optional default country without making it mandatory', () => {
  assert.equal(productCreationPrefillFromParams({}, 'BE').values.purchaseCountryCode, 'BE');
  assert.equal(productCreationPrefillFromParams({}, null).values.purchaseCountryCode, '');
  assert.equal(productCreationPrefillFromParams({}).values.purchaseCountryCode, '');
  assert.equal(productCreationPrefillFromParams({}, 'be').values.purchaseCountryCode, '');
});

test('late optional preference enrichment never overwrites product-form work', () => {
  const blank = productCreationPrefillFromParams({ source: 'barcode_scan', gtin: '091021037090' });
  assert.equal(mergeOptionalDefaultCountry(blank.values, 'BE', false).purchaseCountryCode, 'BE');

  const userOverride = { ...blank.values, purchaseCountryCode: 'FR', productName: 'Air fryer' };
  assert.equal(mergeOptionalDefaultCountry(userOverride, 'BE', false).purchaseCountryCode, 'FR');
  assert.equal(mergeOptionalDefaultCountry(blank.values, 'BE', true).purchaseCountryCode, '');
});

test('a user can override the default country on one product', () => {
  const values = {
    ...productCreationPrefillFromParams({}, 'BE').values,
    productName: 'Travel cot',
    purchaseCountryCode: 'FR',
    scanDate: productRow.scan_date,
  };

  assert.deepEqual(validateProductForm(values), {
    errors: {},
    input: {
      productName: 'Travel cot',
      brand: null,
      category: null,
      gtin: null,
      modelNumber: null,
      serialNumber: null,
      lotNumber: null,
      scanDate: '2026-09-10',
      purchaseDate: null,
      purchaseCountryCode: 'FR',
    },
  });
});

test('editing a legacy product preserves its unspecified country', () => {
  const values = productFormValuesFromProduct({ ...product, purchaseCountryCode: null });
  assert.equal(values.purchaseCountryCode, '');
  assert.equal(validateProductForm(values).input?.purchaseCountryCode, null);
});

test('owned product serialization maps canonical country codes in both directions', () => {
  assert.deepEqual(toOwnedProduct(productRow), product);
  assert.deepEqual(
    toOwnedProductWriteRow({
      productName: 'Travel cot',
      brand: null,
      category: null,
      gtin: null,
      modelNumber: null,
      serialNumber: null,
      lotNumber: null,
      scanDate: productRow.scan_date,
      purchaseDate: null,
      purchaseCountryCode: 'FR',
    }),
    {
      product_name: 'Travel cot',
      brand: null,
      category: null,
      gtin: null,
      model_number: null,
      serial_number: null,
      lot_number: null,
      scan_date: '2026-09-10',
      purchase_date: null,
      purchase_country_code: 'FR',
    },
  );
});

test('barcode and OCR prefills retain identifiers while merging the country preference', () => {
  const barcode = productCreationPrefillFromParams(
    { source: 'barcode_scan', gtin: '091021037090' },
    'BE',
  );
  assert.equal(barcode.identificationMethod, 'barcode_scan');
  assert.equal(barcode.values.gtin, '091021037090');
  assert.equal(barcode.values.purchaseCountryCode, 'BE');

  const ocr = productCreationPrefillFromParams(
    {
      source: 'ocr_assisted',
      modelNumber: ' AK396H-MBK ',
      serialNumber: ' SN-001 ',
      lotNumber: ' LOT.09 ',
    },
    'CA',
  );
  assert.equal(ocr.identificationMethod, 'ocr_assisted');
  assert.equal(ocr.values.modelNumber, 'AK396H-MBK');
  assert.equal(ocr.values.serialNumber, 'SN-001');
  assert.equal(ocr.values.lotNumber, 'LOT.09');
  assert.equal(ocr.values.purchaseCountryCode, 'CA');
});

test('coverage source mapping presents the current authoritative source honestly', () => {
  assert.deepEqual(
    toCoverageSource({
      id: '20000000-0000-4000-8000-000000000001',
      sourceKey: 'cpsc',
      authority: 'CPSC',
      jurisdictionType: 'country',
      jurisdictionCode: 'US',
      sourceLanguageCode: 'en',
      isActive: true,
    }),
    {
      id: '20000000-0000-4000-8000-000000000001',
      authority: 'U.S. Consumer Product Safety Commission',
      jurisdiction: 'United States',
      sourceLanguage: 'English',
      status: 'Active',
    },
  );

  assert.deepEqual(
    toCoverageSource({
      id: '20000000-0000-4000-8000-000000000002',
      sourceKey: 'health_canada',
      authority: 'Health Canada Recalls and Safety Alerts',
      jurisdictionType: 'country',
      jurisdictionCode: 'CA',
      sourceLanguageCode: 'en',
      isActive: true,
    }),
    {
      id: '20000000-0000-4000-8000-000000000002',
      authority: 'Health Canada',
      jurisdiction: 'Canada',
      sourceLanguage: 'English',
      status: 'Active',
    },
  );
});

test('authority and jurisdiction codes have friendly English labels', () => {
  assert.equal(
    getAuthorityDisplayName('U.S. Consumer Product Safety Commission (CPSC)', 'cpsc'),
    'U.S. Consumer Product Safety Commission',
  );
  assert.equal(
    getAuthorityDisplayName('Health Canada Recalls and Safety Alerts', 'health_canada'),
    'Health Canada',
  );
  assert.equal(getAuthorityDisplayName('Unknown authority', 'unknown'), 'Unknown authority');
  assert.equal(getJurisdictionDisplayName('country', 'US'), 'United States');
  assert.equal(getJurisdictionDisplayName('region', 'EU'), 'European Union');
  assert.equal(getJurisdictionDisplayName('global', 'GLOBAL'), 'Global');
  assert.equal(inferJurisdictionType('US'), 'country');
  assert.equal(inferJurisdictionType('EU'), 'region');
  assert.equal(inferJurisdictionType('GLOBAL'), 'global');
  assert.equal(getSourceLanguageDisplayName(null), 'Not specified');
});

test('monitoring formatting uses only safe aggregate status fields', () => {
  assert.deepEqual(
    formatMonitoringStatus(
      {
        monitoringEnabled: true,
        lastSuccessfulCheckAt: '2026-09-16T10:30:00.000Z',
        activeSourceCount: 1,
      },
      { locale: 'en-US', timeZone: 'UTC' },
    ),
    {
      isActive: true,
      statusLabel: 'Automatic monitoring active',
      lastCheckedLabel: 'Last checked Sep 16, 2026, 10:30 AM',
      activeSourcesLabel: '1 active official source',
    },
  );

  assert.deepEqual(
    formatMonitoringStatus(
      {
        monitoringEnabled: false,
        lastSuccessfulCheckAt: null,
        activeSourceCount: 0,
      },
      { locale: 'en-US', timeZone: 'UTC' },
    ),
    {
      isActive: false,
      statusLabel: 'Automatic monitoring unavailable',
      lastCheckedLabel: 'No successful check recorded yet',
      activeSourcesLabel: '0 active official sources',
    },
  );
});

test('purchase country is excluded from the Phase 10 projection and matching fingerprint', async () => {
  const baseProductRow = {
    owned_product_id: productRow.id,
    product_name: productRow.product_name,
    brand: productRow.brand,
    category: productRow.category,
    gtin: productRow.gtin,
    model_number: productRow.model_number,
    serial_number: productRow.serial_number,
    lot_number: productRow.lot_number,
    purchase_date: productRow.purchase_date,
    identification_method: productRow.identification_method,
  };
  const belgianProjection = projectOwnedProduct({
    ...baseProductRow,
    purchase_country_code: 'BE',
  });
  const unitedStatesProjection = projectOwnedProduct({
    ...baseProductRow,
    purchase_country_code: 'US',
  });

  assert.equal('purchaseCountryCode' in belgianProjection, false);
  assert.equal('purchase_country_code' in belgianProjection, false);
  assert.deepEqual(belgianProjection, unitedStatesProjection);

  const officialRecall = {
    recallNoticeId: '30000000-0000-4000-8000-000000000001',
    source: {
      authority: 'CPSC',
      externalId: '26-001',
      officialUrl: 'https://www.cpsc.gov/Recalls/2026/example',
    },
    title: 'Example recall',
    description: null,
    hazard: 'Example hazard.',
    remedy: 'Stop use.',
    recallDate: '2026-09-16',
    scopes: [{ gtin: '091021037090' }],
    rawEvidence: null,
  };
  const fingerprintInput = {
    officialRecall,
    rawPayload: { RecallID: 1 },
    modelId: 'nvidia/nemotron-3-super-120b-a12b',
  };

  assert.equal(
    await buildEvidenceFingerprint({ ...fingerprintInput, ownedProduct: belgianProjection }),
    await buildEvidenceFingerprint({ ...fingerprintInput, ownedProduct: unitedStatesProjection }),
  );
});

const frozenBenchmarkArtifacts = {
  'benchmarks/recall-matching/cases.v1.json':
    'c547d61df8e9eacc1d47d46ec505e409d88cd23795abc20cbbfb4e96f67fb3f8',
  'benchmarks/recall-matching/phase-9-1/development.v1.json':
    '1887da996161611c1d48d3fa75fea281d29f49d27befcb52ce818b0728bd81b1',
  'benchmarks/recall-matching/phase-9-1/holdout.v1.json':
    '3dd19b7075cc7f865816f7217984d1e98f6fd83e1aea2cba6ebbc4554502e608',
  'benchmarks/recall-matching/results/deterministic-v1.json':
    '6f5c8bb6c463b31fad78796141cbd0f76dae3986904d547f0e9a498952ee4fb8',
  'benchmarks/recall-matching/results/nemotron-v1.json':
    'c977bd1ab959563b3500cb83706459715697a875843b196c9608657d4ed8ee0b',
  'benchmarks/recall-matching/results/comparison.json':
    '0d436c98883ee3a3f7e1a27e76fe12ba7b46533daee3ee78a811ab0e4e473549',
  'benchmarks/recall-matching/phase-9-1/results/deterministic-holdout-v1.json':
    'b09b469fdbb1c6aaa2c353e46bc605ca94ca6f8f6c7d0813176068c30fc0a5d8',
  'benchmarks/recall-matching/phase-9-1/results/hybrid-holdout-v1.json':
    '1a5a83bfd5ff18bed84eccff29ac634df6be591736128832cdea976c7fe759ea',
};

test('Phase 13 leaves every committed matcher benchmark dataset and result unchanged', async () => {
  for (const [path, expectedHash] of Object.entries(frozenBenchmarkArtifacts)) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, path);
  }
});
