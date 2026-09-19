import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { toOwnedProduct, toOwnedProductWriteRow } from '../src/data/ownedProductsMappers.ts';
import {
  productCreationPrefillFromParams,
  productFormValuesFromProduct,
  validateProductForm,
} from '../src/features/products/productFormUtils.ts';
import {
  dateOnlyToLocalDate,
  dateToDateOnly,
  formatScanDate,
  todayDateOnly,
} from '../src/features/products/purchaseDate.ts';
import { healthCanadaRecallSourceAdapter } from '../supabase/functions/_shared/healthCanada/adapter.ts';
import {
  fetchHealthCanadaSnapshot,
  filterHealthCanadaRecords,
  healthCanadaDataUrl,
} from '../supabase/functions/_shared/healthCanada/client.ts';
import { mapHealthCanadaRecall } from '../supabase/functions/_shared/healthCanada/mapper.ts';
import {
  isJurisdictionRelevantToCountry,
  listRecallSourceAdapters,
} from '../supabase/functions/_shared/recallSources/index.ts';
import { buildEvidenceFingerprint } from '../supabase/functions/_shared/recallMatching/fingerprint.ts';
import { projectOwnedProduct } from '../supabase/functions/_shared/recallMatching/projection.ts';
import { runRecallAutomation } from '../supabase/functions/_shared/automation/orchestrator.ts';

const scanDate = '2026-09-17';
const baseInput = {
  productName: 'Thule RideAlong 2',
  brand: 'Thule',
  category: 'Child bicycle seat',
  gtin: '091021037090',
  modelNumber: '100106',
  serialNumber: 'SN-1',
  lotNumber: 'LOT-1',
  scanDate,
  purchaseDate: '2026-09-10',
  purchaseCountryCode: 'BE',
};

const row = {
  id: '10000000-0000-4000-8000-000000000001',
  user_id: '10000000-0000-4000-8000-000000000002',
  brand: baseInput.brand,
  product_name: baseInput.productName,
  category: baseInput.category,
  gtin: baseInput.gtin,
  model_number: baseInput.modelNumber,
  serial_number: baseInput.serialNumber,
  lot_number: baseInput.lotNumber,
  scan_date: baseInput.scanDate,
  purchase_date: baseInput.purchaseDate,
  purchase_country_code: baseInput.purchaseCountryCode,
  image_path: null,
  identification_method: 'barcode_scan',
  identification_confidence: null,
  created_at: '2026-09-17T22:30:00.000Z',
  updated_at: '2026-09-17T22:30:00.000Z',
};

test('manual, barcode, and OCR creation all receive today in the local calendar', () => {
  const expected = todayDateOnly();
  assert.equal(productCreationPrefillFromParams({}).values.scanDate, expected);
  assert.equal(
    productCreationPrefillFromParams({ source: 'barcode_scan', gtin: baseInput.gtin }).values
      .scanDate,
    expected,
  );
  assert.equal(
    productCreationPrefillFromParams({ source: 'ocr_assisted', modelNumber: '100106' }).values
      .scanDate,
    expected,
  );
});

test('date-only scan values round-trip locally without a UTC day shift', () => {
  const lateLocalDate = new Date(2026, 8, 17, 23, 45, 0);
  assert.equal(dateToDateOnly(lateLocalDate), scanDate);
  const parsed = dateOnlyToLocalDate(scanDate);
  assert.ok(parsed);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 8);
  assert.equal(parsed.getDate(), 17);
  assert.equal(formatScanDate(scanDate), '17 Sep 2026');
});

test('scan date is editable, required, serialized as YYYY-MM-DD, and preserves created_at', () => {
  const product = toOwnedProduct(row);
  const values = productFormValuesFromProduct(product);
  assert.equal(values.scanDate, scanDate);
  const changed = validateProductForm({ ...values, scanDate: '2026-09-16' });
  assert.equal(changed.errors.scanDate, undefined);
  assert.equal(changed.input?.scanDate, '2026-09-16');
  assert.equal(toOwnedProductWriteRow(changed.input).scan_date, '2026-09-16');
  assert.equal(product.createdAt, row.created_at);
  assert.match(
    validateProductForm({ ...values, scanDate: '' }).errors.scanDate ?? '',
    /real scan date/u,
  );
});

test('GTIN text and secondary identifiers survive scan-date serialization', () => {
  const write = toOwnedProductWriteRow(baseInput);
  assert.equal(write.gtin, '091021037090');
  assert.equal(write.model_number, '100106');
  assert.equal(write.serial_number, 'SN-1');
  assert.equal(write.lot_number, 'LOT-1');
});

test('scan_date is excluded from matching projection and fingerprint evidence', async () => {
  const evidenceRow = {
    owned_product_id: row.id,
    product_name: row.product_name,
    brand: row.brand,
    category: row.category,
    gtin: row.gtin,
    model_number: row.model_number,
    serial_number: row.serial_number,
    lot_number: row.lot_number,
    purchase_date: row.purchase_date,
    identification_method: row.identification_method,
  };
  const first = projectOwnedProduct({ ...evidenceRow, scan_date: '2026-09-16' });
  const second = projectOwnedProduct({ ...evidenceRow, scan_date: '2026-09-17' });
  assert.equal('scanDate' in first, false);
  assert.equal('scan_date' in first, false);
  assert.deepEqual(first, second);

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
    scopes: [{ gtin: baseInput.gtin }],
    rawEvidence: null,
  };
  const fingerprint = { officialRecall, rawPayload: { RecallID: 1 }, modelId: 'test-model' };
  assert.equal(
    await buildEvidenceFingerprint({ ...fingerprint, ownedProduct: first }),
    await buildEvidenceFingerprint({ ...fingerprint, ownedProduct: second }),
  );
});

test('editing scan_date has no matching orchestration hook', async () => {
  const [repository, projection] = await Promise.all([
    readFile(new URL('../src/data/SupabaseOwnedProductsRepository.ts', import.meta.url), 'utf8'),
    readFile(
      new URL('../supabase/functions/_shared/recallMatching/projection.ts', import.meta.url),
      'utf8',
    ),
  ]);
  assert.doesNotMatch(repository, /process-recall-matches|recall_matches|fingerprint/u);
  assert.doesNotMatch(projection, /scan_date|scanDate/u);
});

test('Health Canada fixture normalizes explicit official fields without inventing identifiers', async () => {
  const records = JSON.parse(
    await readFile(
      new URL(
        '../supabase/functions/_shared/healthCanada/fixtures/health-canada-real-records.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const notice = mapHealthCanadaRecall(records[0]);
  assert.equal(notice.externalId, '82616');
  assert.equal(notice.recallDate, '2026-09-15');
  assert.equal(notice.officialUrl.includes('recalls-rappels.canada.ca'), true);
  assert.deepEqual(notice.jurisdictions, [{ type: 'country', code: 'CA' }]);
  assert.equal(notice.scopes[0].brand, null);
  assert.equal(notice.scopes[0].gtin, null);
  assert.equal(notice.scopes[0].modelNumber, null);
  assert.equal(notice.scopes[0].productName, 'Simond brand Alpinism quickdraws');
});

test('Health Canada uses a deterministic window version and explicit cache revalidation', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        '../supabase/functions/_shared/healthCanada/fixtures/health-canada-2026-09-17-window.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const complete = (record) => ({
    ...record,
    Organization: 'Fixture authority',
    Product: record.Title,
    Issue: '',
    'What you should do': '',
    Category: 'Fixture category',
    'Recall class': '',
    Archived: '0',
  });
  const sourceRecords = [
    complete({
      NID: 'before',
      Title: 'Before',
      URL: 'https://example.invalid/before',
      'Last updated': '2026-09-16',
    }),
    ...fixture.records.map(complete),
    complete({
      NID: 'after',
      Title: 'After',
      URL: 'https://example.invalid/after',
      'Last updated': '2026-09-18',
    }),
  ];
  const calls = [];
  const fetchImplementation = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    const body = JSON.stringify(sourceRecords);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(body).byteLength),
        etag: '"fixture"',
        'last-modified': 'Sat, 19 Sep 2026 02:17:17 GMT',
        'x-cache': 'TCP_MISS',
      },
    });
  };
  const request = { startDate: '2026-09-17', endDate: '2026-09-17', maxRecords: 100 };
  const result = await fetchHealthCanadaSnapshot(request, fetchImplementation);

  assert.equal(result.records.length, 9);
  assert.equal(result.diagnostics.windowRecordCount, 9);
  assert.equal(result.diagnostics.totalParsedRecords, 11);
  assert.match(result.diagnostics.bodySha256, /^[a-f0-9]{64}$/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, healthCanadaDataUrl(request));
  assert.equal(new URL(calls[0].url).searchParams.get('recall_snapshot_date'), '2026-09-17');
  assert.equal(calls[0].headers.get('cache-control'), 'no-cache');
  assert.equal(calls[0].headers.get('pragma'), 'no-cache');
  assert.equal(calls[0].headers.get('accept'), 'application/json');
});

test('Health Canada date windows are inclusive at the 2026-09-16/17/18 boundaries', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        '../supabase/functions/_shared/healthCanada/fixtures/health-canada-2026-09-17-window.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const records = [
    { NID: 'before', 'Last updated': '2026-09-16' },
    ...fixture.records,
    { NID: 'after', 'Last updated': '2026-09-18' },
  ];
  const select = (startDate, endDate) =>
    filterHealthCanadaRecords(records, { startDate, endDate, maxRecords: 100 });

  assert.equal(select('2026-09-16', '2026-09-16').length, 1);
  assert.equal(select('2026-09-17', '2026-09-17').length, 9);
  assert.equal(select('2026-09-18', '2026-09-18').length, 1);
  assert.equal(select('2026-09-16', '2026-09-18').length, 11);
});

test('adapter registry has stable CPSC and Health Canada identities with bounded retrieval', () => {
  const definitions = listRecallSourceAdapters().map((adapter) => adapter.definition);
  assert.deepEqual(
    definitions.map(({ key }) => key),
    ['cpsc', 'health_canada'],
  );
  assert.equal(healthCanadaRecallSourceAdapter.definition.retrieval.maximumRecords, 100);
  assert.equal(
    healthCanadaRecallSourceAdapter.definition.retrieval.watermarkKind,
    'last_updated_date',
  );
  assert.deepEqual(
    healthCanadaRecallSourceAdapter.watermarkFor([], {
      startDate: '2026-09-17',
      endDate: '2026-09-18',
      maxRecords: 50,
    }),
    { kind: 'last_updated_date', value: '2026-09-18' },
  );
});

test('EU and EEA containment are explicit context and never ISO country substitutions', () => {
  assert.equal(isJurisdictionRelevantToCountry({ type: 'region', code: 'EU' }, 'BE'), true);
  assert.equal(isJurisdictionRelevantToCountry({ type: 'region', code: 'EEA' }, 'NO'), true);
  assert.equal(isJurisdictionRelevantToCountry({ type: 'region', code: 'EU' }, 'US'), false);
  assert.equal(isJurisdictionRelevantToCountry({ type: 'country', code: 'CA' }, 'CA'), true);
  assert.equal(isJurisdictionRelevantToCountry({ type: 'global', code: 'GLOBAL' }, 'JP'), true);
  assert.equal(isJurisdictionRelevantToCountry({ type: 'region', code: 'EU' }, null), true);
});

test('alerts describe multi-source official coverage without claiming CPSC-only coverage', async () => {
  const alertsSource = await readFile(
    new URL('../src/features/alerts/AlertsScreen.tsx', import.meta.url),
    'utf8',
  );
  assert.match(alertsSource, /backed by official product-safety notices\./u);
  assert.doesNotMatch(alertsSource, /backed by official CPSC safety notices\./u);
});

test('one source failure preserves successful ingestion and is reported as partial success', async () => {
  const calls = [];
  const result = await runRecallAutomation(
    {
      trigger: 'cron',
      verificationMode: false,
      maxRecalls: null,
      maxCandidatePairs: null,
      maxAiEscalations: null,
      notificationBatchSize: null,
    },
    {
      store: {
        async claimRun() {
          return {
            status: 'claimed',
            runId: '10000000-0000-4000-8000-000000000001',
            leaseToken: '20000000-0000-4000-8000-000000000002',
            windowStart: '2026-09-10',
            windowEnd: '2026-09-17',
            maxRecalls: 100,
            maxCandidatePairs: 500,
            maxAiEscalations: 5,
            notificationBatchSize: 25,
            aiEnabled: false,
            pushEnabled: true,
          };
        },
        async recordIngestion(input) {
          calls.push(['record-ingestion', input]);
        },
        async listPendingRecalls() {
          return ['30000000-0000-4000-8000-000000000003'];
        },
        async recordMatching(input) {
          calls.push(['record-matching', input]);
        },
        async completeRun(input) {
          calls.push(['complete', input]);
        },
      },
      async ingest() {
        return {
          fetched: 1,
          inserted: 1,
          updated: 0,
          unchanged: 0,
          rejected: 0,
          affectedRecallIds: ['30000000-0000-4000-8000-000000000003'],
          successfulSources: 1,
          sourceFailures: 1,
          sources: [
            { sourceKey: 'cpsc', status: 'success' },
            { sourceKey: 'health_canada', status: 'failed', errorCode: 'source_http_502' },
          ],
        };
      },
      async match() {
        return {
          recallsProcessed: 1,
          candidatePairs: 0,
          deterministicResolved: 0,
          nemotronEscalated: 0,
          confirmed: 0,
          rejected: 0,
          needsReview: 0,
          alertsCreated: 0,
          failures: 0,
          providerFailures: 0,
          limitsReached: 0,
        };
      },
      async push() {
        calls.push(['push']);
        return { claimed: 0, accepted: 0, failed: 0, invalidDevices: 0, transientFailures: 0 };
      },
      pushDeliveryGateEnabled: true,
    },
  );

  assert.equal(result.status, 'partial_success');
  assert.equal(result.errorCode, 'source_partial_failure');
  assert.ok(calls.some(([name]) => name === 'record-ingestion'));
  assert.ok(calls.some(([name]) => name === 'record-matching'));
  assert.equal(
    calls.some(([name]) => name === 'push'),
    false,
  );
});
