import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProductLabel } from '../src/domain/productLabel.ts';
import { toOwnedProduct, toOwnedProductWriteRow } from '../src/data/ownedProductsMappers.ts';
import {
  emptyProductFormValues,
  productFormValuesFromProduct,
  validateProductForm,
} from '../src/features/products/productFormUtils.ts';
import { retrieveRecallCandidates } from '../supabase/functions/_shared/matching/candidateRetrieval.ts';
import { evaluateDeterministicMatchV2 } from '../supabase/functions/_shared/matching/deterministicMatcherV2.ts';
import { evaluateHybridGuardedMatchV2 } from '../supabase/functions/_shared/matching/hybridGuardedMatcherV2.ts';
import {
  DETERMINISTIC_MATCH_METHOD_V2,
  HYBRID_GUARDED_MATCH_METHOD_V2,
  MATCH_EVALUATION_SCHEMA_VERSION_V2,
} from '../supabase/functions/_shared/matching/typesV2.ts';
import { buildEvidenceFingerprintV2 } from '../supabase/functions/_shared/recallMatching/fingerprintV2.ts';

const baseOwned = {
  productName: 'Example product',
  brand: 'Example',
  category: 'consumer_product',
  gtin: null,
  modelNumber: 'MODEL-1',
  serialNumber: null,
  lotNumber: null,
  purchaseDate: null,
  identificationMethod: 'controlled_test_fixture',
  attributes: [],
};

function criterion(kind, operator, input = {}) {
  return {
    id: `${kind}-${operator}`,
    kind,
    operator,
    required: true,
    provenance: {
      authority: 'CPSC',
      officialUrl: 'https://www.cpsc.gov/Recalls/example',
      sourceField: `fixture.${kind}`,
      normalizationRule: 'phase_16_controlled_fixture',
    },
    ...input,
  };
}

function recall(criteria, semantics = 'all_of') {
  return {
    recallNoticeId: 'recall-1',
    source: {
      authority: 'CPSC',
      externalId: 'example',
      officialUrl: 'https://www.cpsc.gov/Recalls/example',
    },
    title: 'Example recall',
    description: null,
    hazard: null,
    remedy: null,
    recallDate: '2026-09-20',
    scopes: [
      {
        productName: 'Example product',
        modelNumber: 'MODEL-1',
        criteria: { semantics, criteria },
      },
    ],
    rawEvidence: null,
  };
}

const modelCriterion = criterion('model_number', 'equals', { value: 'MODEL-1' });
const serialRangeCriterion = criterion('serial_number', 'range', {
  range: { from: 'S000100', to: 'S000199' },
});

test('v2 has explicit matcher and schema identities without changing v1 names', () => {
  assert.equal(DETERMINISTIC_MATCH_METHOD_V2, 'deterministic_v2');
  assert.equal(HYBRID_GUARDED_MATCH_METHOD_V2, 'hybrid_guarded_v2');
  assert.equal(MATCH_EVALUATION_SCHEMA_VERSION_V2, '2.0.0');
});

test('exact model plus serial inside a mandatory range confirms', () => {
  const result = evaluateDeterministicMatchV2(
    { ...baseOwned, serialNumber: 'S000150' },
    recall([modelCriterion, serialRangeCriterion]),
  );
  assert.equal(result.decision, 'confirmed');
});

test('exact model plus serial outside a mandatory range rejects with proven all-of semantics', () => {
  const result = evaluateDeterministicMatchV2(
    { ...baseOwned, serialNumber: 'S000200' },
    recall([modelCriterion, serialRangeCriterion]),
  );
  assert.equal(result.decision, 'rejected');
});

test('exact model plus missing mandatory serial remains needs_review', () => {
  const result = evaluateDeterministicMatchV2(
    baseOwned,
    recall([modelCriterion, serialRangeCriterion]),
  );
  assert.equal(result.decision, 'needs_review');
});

for (const [name, ownedLot, expected] of [
  ['match', 'LOT-9', 'confirmed'],
  ['mismatch', 'LOT-8', 'rejected'],
  ['missing', null, 'needs_review'],
]) {
  test(`exact model plus mandatory lot ${name}`, () => {
    const lot = criterion('lot_number', 'equals', { value: 'LOT-9' });
    assert.equal(
      evaluateDeterministicMatchV2(
        { ...baseOwned, lotNumber: ownedLot },
        recall([modelCriterion, lot]),
      ).decision,
      expected,
    );
  });
}

for (const [name, value, expected] of [
  ['inside', '2026-03-15', 'confirmed'],
  ['outside', '2026-04-01', 'rejected'],
  ['missing', null, 'needs_review'],
]) {
  test(`manufacture date ${name} is evaluated independently`, () => {
    const manufactureDate = criterion('manufacture_date', 'date_range', {
      range: { from: '2026-03-01', to: '2026-03-31' },
    });
    const attributes = value
      ? [{ key: 'manufacture_date', value, valueType: 'date', captureSource: 'manual' }]
      : [];
    const owned = {
      ...baseOwned,
      purchaseDate: '2026-03-15',
      attributes,
    };
    assert.equal(
      evaluateDeterministicMatchV2(owned, recall([modelCriterion, manufactureDate])).decision,
      expected,
    );
  });
}

for (const [name, value, expected] of [
  ['match', 'PRO', 'confirmed'],
  ['mismatch', 'LITE', 'rejected'],
  ['missing', null, 'needs_review'],
]) {
  test(`model plus mandatory variant ${name}`, () => {
    const variant = criterion('variant', 'equals', { value: 'PRO' });
    const attributes = value
      ? [{ key: 'variant', value, valueType: 'text', captureSource: 'manual' }]
      : [];
    assert.equal(
      evaluateDeterministicMatchV2({ ...baseOwned, attributes }, recall([modelCriterion, variant]))
        .decision,
      expected,
    );
  });
}

test('an ordinary exact GTIN recall still confirms', () => {
  const gtin = criterion('gtin', 'equals', { value: '091021037090' });
  assert.equal(
    evaluateDeterministicMatchV2({ ...baseOwned, gtin: '091021037090' }, recall([gtin])).decision,
    'confirmed',
  );
});

test('an exact GTIN cannot bypass a mandatory narrower variant criterion', () => {
  const gtin = criterion('gtin', 'equals', { value: '091021037090' });
  const variant = criterion('variant', 'equals', { value: 'PRO' });
  assert.equal(
    evaluateDeterministicMatchV2({ ...baseOwned, gtin: '091021037090' }, recall([gtin, variant]))
      .decision,
    'needs_review',
  );
});

test('ambiguous criterion semantics can never produce a deterministic confirmation', () => {
  assert.equal(
    evaluateDeterministicMatchV2(
      { ...baseOwned, serialNumber: 'S000150' },
      recall([modelCriterion, serialRangeCriterion], 'ambiguous'),
    ).decision,
    'needs_review',
  );
});

test('hybrid v2 bypasses AI for deterministic outcomes', async () => {
  let calls = 0;
  const result = await evaluateHybridGuardedMatchV2(
    {
      ownedProduct: { ...baseOwned, serialNumber: 'S000150' },
      officialRecall: recall([modelCriterion, serialRangeCriterion]),
    },
    async () => {
      calls += 1;
      throw new Error('must not be called');
    },
  );
  assert.equal(result.evaluation.decision, 'confirmed');
  assert.equal(calls, 0);
});

test('AI cannot invent missing mandatory product evidence', async () => {
  const result = await evaluateHybridGuardedMatchV2(
    {
      ownedProduct: baseOwned,
      officialRecall: recall([modelCriterion, serialRangeCriterion]),
    },
    async () => ({ decision: 'confirmed', claimedCriterionIds: [modelCriterion.id] }),
  );
  assert.equal(result.evaluation.decision, 'needs_review');
});

test('hybrid v2 fails closed on provider errors and invalid structured output', async () => {
  const input = {
    ownedProduct: baseOwned,
    officialRecall: recall([modelCriterion, serialRangeCriterion]),
  };
  const providerFailure = await evaluateHybridGuardedMatchV2(input, async () => {
    throw new Error('fixture provider failure');
  });
  const schemaFailure = await evaluateHybridGuardedMatchV2(input, async () => ({
    decision: 'confirmed',
    claimedCriterionIds: 'not-an-array',
  }));
  assert.equal(providerFailure.evaluation.decision, 'needs_review');
  assert.equal(providerFailure.trace.aiTechnicalFailure, 'provider_error');
  assert.equal(schemaFailure.evaluation.decision, 'needs_review');
  assert.equal(schemaFailure.trace.aiTechnicalFailure, 'schema_violation');
});

test('v2 fingerprint includes attributes and has a separate policy identity', async () => {
  const input = {
    ownedProduct: baseOwned,
    officialRecall: recall([modelCriterion]),
    rawPayload: {},
    modelId: 'fixture-model',
  };
  const first = await buildEvidenceFingerprintV2(input);
  const second = await buildEvidenceFingerprintV2({
    ...input,
    ownedProduct: {
      ...baseOwned,
      attributes: [{ key: 'color', value: 'black', valueType: 'text', captureSource: 'manual' }],
    },
  });
  assert.notEqual(first, second);
});

test('candidate retrieval remains recall-oriented when richer evidence is absent', () => {
  const officialRecall = recall([modelCriterion, serialRangeCriterion]);
  const results = retrieveRecallCandidates(baseOwned, [officialRecall], 10);
  assert.equal(results[0]?.recall.recallNoticeId, officialRecall.recallNoticeId);
});

test('richer product evidence serializes with bounded canonical date values', () => {
  const values = {
    ...emptyProductFormValues(new Date(2026, 8, 20)),
    productName: 'Example product',
    variant: 'Pro',
    color: 'Black',
    size: 'Large',
    capacity: '2 L',
    batteryModel: 'BAT-9',
    chargingPortType: 'USB-C',
    screwState: 'Installed',
    dateCode: '26W38',
    manufactureDate: '2026-03-15',
    productionDate: '2026-03-16',
  };
  const validated = validateProductForm(values);
  assert.equal(validated.errors.manufactureDate, undefined);
  assert.equal(validated.input?.safetyAttributes.manufacture_date, '2026-03-15');
  assert.equal(toOwnedProductWriteRow(validated.input).safety_attributes.color, 'Black');
});

test('product edit serialization keeps scan, purchase, manufacture, and production dates separate', () => {
  const product = toOwnedProduct({
    id: '10000000-0000-4000-8000-000000000001',
    user_id: '10000000-0000-4000-8000-000000000002',
    brand: null,
    product_name: 'Example product',
    category: null,
    gtin: null,
    model_number: null,
    serial_number: null,
    lot_number: null,
    scan_date: '2026-09-20',
    purchase_date: '2026-09-19',
    purchase_country_code: null,
    safety_attributes: {
      manufacture_date: '2026-03-15',
      production_date: '2026-03-16',
    },
    image_path: null,
    identification_method: 'manual',
    identification_confidence: null,
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-20T10:00:00Z',
  });
  const values = productFormValuesFromProduct(product);
  assert.deepEqual(
    [values.scanDate, values.purchaseDate, values.manufactureDate, values.productionDate],
    ['2026-09-20', '2026-09-19', '2026-03-15', '2026-03-16'],
  );
});

test('OCR accepts only explicit richer field/value associations', () => {
  assert.deepEqual(parseProductLabel('COLOR: BLACK\nSIZE: LARGE\nUSB-C port visible'), {
    color: 'BLACK',
    size: 'LARGE',
  });
});
