// Phase 17.7a-1 mobile minimum: monitoring read model mapping, temporary labels,
// bounded resume, and the client-side "relevant edit" check that mirrors the trigger.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  fromCheckOwnedProductResponse,
  toProductMonitoringStatus,
} from '../src/data/productMonitoringMappers.ts';
import { PRODUCT_MONITORING_STATES } from '../src/domain/types.ts';
import {
  hasMatchingAttributeChange,
  monitoringLabel,
  monitoringTone,
  productsToResume,
} from '../src/features/products/productMonitoring.ts';

const row = (state, extra = {}) => ({
  owned_product_id: `p-${state}`,
  state,
  checked_at: null,
  possible_matches: 0,
  confirmed_alerts: 0,
  retrying: false,
  ...extra,
});

test('the client knows exactly the seven server states', () => {
  assert.deepEqual([...PRODUCT_MONITORING_STATES].sort(), [
    'check_failed',
    'check_failed_retrying',
    'checking',
    'monitored_no_known_recall',
    'pending_check',
    'possible_match_needs_verification',
    'recall_detected',
  ]);
});

test('the mapper refuses an unknown state instead of guessing', () => {
  assert.equal(toProductMonitoringStatus(row('recall_detected')).state, 'recall_detected');
  assert.throws(() => toProductMonitoringStatus(row('safe')));
  assert.deepEqual(
    fromCheckOwnedProductResponse('p1', {
      state: 'possible_match_needs_verification',
      checkedAt: '2026-10-02T10:00:00Z',
      possibleMatches: 1,
      confirmedAlerts: 0,
      retrying: false,
    }),
    {
      ownedProductId: 'p1',
      state: 'possible_match_needs_verification',
      checkedAt: '2026-10-02T10:00:00Z',
      possibleMatches: 1,
      confirmedAlerts: 0,
      retrying: false,
    },
  );
});

test('labels stay cautious: no state claims the product was never recalled', () => {
  for (const state of PRODUCT_MONITORING_STATES) {
    const label = monitoringLabel(state);
    assert.ok(label.length > 0, state);
    assert.doesNotMatch(label, /never|safe|not recalled|no recall exists/iu, state);
  }
  assert.match(monitoringLabel('monitored_no_known_recall'), /sources currently monitored/u);
  assert.match(monitoringLabel('possible_match_needs_verification'), /verification needed/u);
  assert.equal(monitoringTone('recall_detected'), 'danger');
  assert.equal(monitoringTone('possible_match_needs_verification'), 'warning');
});

test('at most three pending or retrying checks are resumed on focus', () => {
  const statuses = [
    'pending_check',
    'monitored_no_known_recall',
    'check_failed_retrying',
    'pending_check',
    'checking',
    'pending_check',
    'check_failed',
  ].map((state, index) => toProductMonitoringStatus(row(state, { owned_product_id: `p${index}` })));
  assert.deepEqual(productsToResume(statuses), ['p0', 'p2', 'p3']);
});

const product = (overrides = {}) => ({
  id: 'p',
  userId: 'u',
  brand: 'Thule',
  productName: 'Sleek',
  category: null,
  gtin: '091021037090',
  modelNumber: null,
  serialNumber: null,
  lotNumber: null,
  scanDate: '2026-10-02',
  purchaseDate: null,
  purchaseCountryCode: 'US',
  safetyAttributes: { date_code: '1805' },
  imagePath: null,
  identificationMethod: 'manual',
  identificationConfidence: null,
  createdAt: '2026-10-02T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  ...overrides,
});

test('only matching attributes request an immediate re-check after an edit', () => {
  const before = product();
  for (const change of [
    { category: 'Nursery' },
    { purchaseDate: '2020-01-01' },
    { scanDate: '2026-10-01' },
    { updatedAt: '2026-10-03T00:00:00Z' },
    { safetyAttributes: { date_code: '1805' } },
  ]) {
    assert.equal(
      hasMatchingAttributeChange(before, product(change)),
      false,
      JSON.stringify(change),
    );
  }
  for (const change of [
    { gtin: '012345678905' },
    { modelNumber: 'X' },
    { serialNumber: 'S' },
    { lotNumber: 'L' },
    { brand: 'Other' },
    { productName: 'Renamed' },
    { purchaseCountryCode: 'CA' },
    { safetyAttributes: { date_code: '1806' } },
  ]) {
    assert.equal(hasMatchingAttributeChange(before, product(change)), true, JSON.stringify(change));
  }
});

test('the client relevant-edit list mirrors the server arming trigger columns', async () => {
  const migration = await readFile(
    new URL(
      '../supabase/migrations/20261002120000_phase_17_7a_1_owned_product_recall_checks.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const columns = /after update of ([^\n]+(?:\n\s+[^\n]+)?)\n\s+on public\.owned_products/u
    .exec(migration)[1]
    .split(',')
    .map((item) => item.trim());
  assert.deepEqual(columns.sort(), [
    'brand',
    'gtin',
    'lot_number',
    'model_number',
    'product_name',
    'purchase_country_code',
    'safety_attributes',
    'serial_number',
  ]);
  const helper = await readFile(
    new URL('../src/features/products/productMonitoring.ts', import.meta.url),
    'utf8',
  );
  for (const field of [
    'brand',
    'productName',
    'gtin',
    'modelNumber',
    'serialNumber',
    'lotNumber',
    'purchaseCountryCode',
    'sortedAttributes',
  ]) {
    assert.match(helper, new RegExp(`before\\.${field}|${field}\\(before\\)`, 'u'), field);
  }
});

test('saving never waits for the check: requests are fire-and-forget after a successful save', async () => {
  const source = await readFile(
    new URL('../src/features/products/ProductScreens.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /void productMonitoringRepository\.requestCheck\(productId\)\.catch\(\(\) => undefined\)/u,
  );
  const create = source.indexOf('await ownedProductsRepository.create(');
  const update = source.indexOf('await ownedProductsRepository.update(');
  assert.ok(create > 0 && source.indexOf('requestCheckInBackground(product.id)', create) > create);
  assert.ok(update > 0 && source.indexOf('requestCheckInBackground(id)', update) > update);
});
