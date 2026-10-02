import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { evaluateHybridGuardedMatchV2 } from '../supabase/functions/_shared/matching/hybridGuardedMatcherV2.ts';
import { evaluateHybridGuardedMatchV2_1 } from '../supabase/functions/_shared/matching/hybridGuardedMatcherV2_1.ts';
import { evaluateDeterministicMatchV2 } from '../supabase/functions/_shared/matching/deterministicMatcherV2.ts';
import { verifyNemotronConfirmationV2_1 } from '../supabase/functions/_shared/matching/nemotronSafetyVerifierV2_1.ts';
import { validateGuardedAiDecisionV2_1 } from '../supabase/functions/_shared/matching/guardedNemotronSchemaV2_1.ts';
import { buildEvidenceFingerprintV2 } from '../supabase/functions/_shared/recallMatching/fingerprintV2.ts';
import { buildEvidenceFingerprintV2_1 } from '../supabase/functions/_shared/recallMatching/fingerprintV2_1.ts';
import {
  HYBRID_GUARDED_MATCH_METHOD_V2_1,
  MATCH_FINGERPRINT_POLICY_V2_1,
  VERIFIER_VERSION_V2_1,
} from '../supabase/functions/_shared/matching/typesV2_1.ts';
import { projectGuardedModelInputV2_1 } from '../supabase/functions/_shared/matching/guardedNemotronProjectionV2_1.ts';

const provenance = {
  authority: 'CPSC',
  officialUrl: 'https://www.cpsc.gov/Recalls/2026/example',
  sourceField: 'controlled.fixture',
  normalizationRule: 'controlled_fixture',
};

const criterion = (id, kind, operator, value) => ({
  id,
  kind,
  operator,
  required: true,
  ...(operator === 'date_range' || operator === 'range' ? { range: value } : { value }),
  provenance,
});

const modelCriterion = criterion('model', 'model_number', 'equals', 'MODEL-1');
const sizeCriterion = criterion('size', 'size', 'equals', 'Large');

function owned(overrides = {}) {
  return {
    productName: 'Controlled product',
    brand: 'Controlled brand',
    category: null,
    gtin: null,
    modelNumber: 'MODEL-1',
    serialNumber: null,
    lotNumber: null,
    purchaseDate: '2026-01-01',
    identificationMethod: 'controlled_fixture',
    attributes: [{ key: 'size', value: 'Large', valueType: 'text', captureSource: 'manual' }],
    ...overrides,
  };
}

function recall(criteria = [modelCriterion, sizeCriterion], associations = null) {
  const criterionIds = criteria.map(({ id }) => id);
  return {
    recallNoticeId: 'controlled-recall',
    source: {
      authority: 'CPSC',
      externalId: 'controlled',
      officialUrl: provenance.officialUrl,
    },
    title: 'Controlled recall',
    description: null,
    hazard: null,
    remedy: null,
    recallDate: '2026-09-23',
    scopes: [
      {
        productName: 'Controlled product',
        criteria: { semantics: 'ambiguous', criteria },
        associations: associations ?? [
          {
            id: 'association-1',
            criterionIds,
            provenance: { ...provenance, sourceField: 'controlled.association-1' },
          },
        ],
      },
    ],
    rawEvidence: null,
  };
}

function claim(criterionId, ownedEvidence, relation = 'equals', scopeIndex = 0) {
  return { scopeIndex, associationId: 'association-1', criterionId, ownedEvidence, relation };
}

const validDecision = {
  decision: 'confirmed',
  scopeIndex: 0,
  associationId: 'association-1',
  claims: [
    claim('model', { source: 'base', field: 'modelNumber' }),
    claim('size', { source: 'attribute', key: 'size' }),
  ],
  reasoningSummary: 'The supplied structured association is satisfied.',
};

test('frozen v2 contradiction remains preserved as historical behavior', async () => {
  const input = { ownedProduct: owned(), officialRecall: recall() };
  assert.equal(
    evaluateDeterministicMatchV2(input.ownedProduct, input.officialRecall).decision,
    'needs_review',
  );
  const result = await evaluateHybridGuardedMatchV2(input, async () => ({
    decision: 'confirmed',
    claimedCriterionIds: ['model', 'size'],
  }));
  assert.equal(result.evaluation.decision, 'needs_review');
  assert.equal(result.trace.verifierAccepted, false);
});

test('v2.1 honestly reaches an AI-derived confirmation through a real association', async () => {
  const input = { ownedProduct: owned(), officialRecall: recall() };
  const result = await evaluateHybridGuardedMatchV2_1(input, async () => validDecision);
  assert.equal(result.evaluation.decision, 'confirmed');
  assert.equal(result.evaluation.matchMethod, HYBRID_GUARDED_MATCH_METHOD_V2_1);
  assert.equal(result.trace.verifierAccepted, true);
});

const rejectedCases = [
  {
    name: 'invented serial',
    input: () => ({
      ownedProduct: owned(),
      officialRecall: recall([
        modelCriterion,
        criterion('serial', 'serial_number', 'equals', 'SN-1'),
      ]),
    }),
    decision: () => ({
      ...validDecision,
      claims: [
        claim('model', { source: 'base', field: 'modelNumber' }),
        claim('serial', { source: 'base', field: 'serialNumber' }),
      ],
    }),
  },
  {
    name: 'invented lot',
    input: () => ({
      ownedProduct: owned(),
      officialRecall: recall([modelCriterion, criterion('lot', 'lot_number', 'equals', 'LOT-1')]),
    }),
    decision: () => ({
      ...validDecision,
      claims: [
        claim('model', { source: 'base', field: 'modelNumber' }),
        claim('lot', { source: 'base', field: 'lotNumber' }),
      ],
    }),
  },
  {
    name: 'missing size',
    input: () => ({ ownedProduct: owned({ attributes: [] }), officialRecall: recall() }),
    decision: () => validDecision,
  },
  {
    name: 'conflicting variant',
    input: () => ({
      ownedProduct: owned({
        attributes: [{ key: 'variant', value: 'Lite', valueType: 'text', captureSource: 'manual' }],
      }),
      officialRecall: recall([modelCriterion, criterion('variant', 'variant', 'equals', 'Pro')]),
    }),
    decision: () => ({
      ...validDecision,
      claims: [
        claim('model', { source: 'base', field: 'modelNumber' }),
        claim('variant', { source: 'attribute', key: 'variant' }),
      ],
    }),
  },
  {
    name: 'wrong manufacture date',
    input: () => ({
      ownedProduct: owned({
        attributes: [
          {
            key: 'manufacture_date',
            value: '2026-04-01',
            valueType: 'date',
            captureSource: 'manual',
          },
        ],
      }),
      officialRecall: recall([
        modelCriterion,
        criterion('manufacture', 'manufacture_date', 'date_range', {
          from: '2026-03-01',
          to: '2026-03-31',
        }),
      ]),
    }),
    decision: () => ({
      ...validDecision,
      claims: [
        claim('model', { source: 'base', field: 'modelNumber' }),
        claim('manufacture', { source: 'attribute', key: 'manufacture_date' }, 'date_range'),
      ],
    }),
  },
  {
    name: 'purchase date substituted for manufacture date',
    input: () => ({
      ownedProduct: owned({ attributes: [] }),
      officialRecall: recall([
        modelCriterion,
        criterion('manufacture', 'manufacture_date', 'date_range', {
          from: '2025-01-01',
          to: '2026-12-31',
        }),
      ]),
    }),
    decision: () => ({
      ...validDecision,
      claims: [
        claim('model', { source: 'base', field: 'modelNumber' }),
        claim('manufacture', { source: 'base', field: 'purchaseDate' }, 'date_range'),
      ],
    }),
  },
  {
    name: 'wrong scope reference',
    input: () => ({ ownedProduct: owned(), officialRecall: recall() }),
    decision: () => ({
      ...validDecision,
      scopeIndex: 7,
      claims: validDecision.claims.map((item) => ({ ...item, scopeIndex: 7 })),
    }),
  },
  {
    name: 'nonexistent criterion reference',
    input: () => ({ ownedProduct: owned(), officialRecall: recall() }),
    decision: () => ({
      ...validDecision,
      claims: [
        claim('model', { source: 'base', field: 'modelNumber' }),
        claim('missing', { source: 'attribute', key: 'size' }),
      ],
    }),
  },
  {
    name: 'partial mandatory criteria',
    input: () => ({ ownedProduct: owned(), officialRecall: recall() }),
    decision: () => ({
      ...validDecision,
      claims: [claim('model', { source: 'base', field: 'modelNumber' })],
    }),
  },
  {
    name: 'unresolved mandatory condition',
    input: () => ({
      ownedProduct: owned({ serialNumber: 'ABC-1' }),
      officialRecall: recall([
        modelCriterion,
        criterion('serial', 'serial_number', 'range', { from: '1000', to: '2000' }),
      ]),
    }),
    decision: () => ({
      ...validDecision,
      claims: [
        claim('model', { source: 'base', field: 'modelNumber' }),
        claim('serial', { source: 'base', field: 'serialNumber' }, 'range'),
      ],
    }),
  },
  {
    name: 'empty mandatory association',
    input: () => ({
      ownedProduct: owned(),
      officialRecall: recall(
        [],
        [
          {
            id: 'empty-association',
            criterionIds: [],
            provenance: { ...provenance, sourceField: 'controlled.empty-association' },
          },
        ],
      ),
    }),
    decision: () => ({
      decision: 'confirmed',
      scopeIndex: 0,
      associationId: 'empty-association',
      claims: [],
    }),
  },
];

for (const item of rejectedCases) {
  test(`v2.1 verifier rejects ${item.name}`, () => {
    const input = item.input();
    assert.equal(
      verifyNemotronConfirmationV2_1({ ...input, aiDecision: item.decision() }).accepted,
      false,
    );
  });
}

test('future model projection excludes labels and evaluation metadata', () => {
  const projection = projectGuardedModelInputV2_1({
    ownedProduct: owned(),
    officialRecall: recall(),
  });
  const serialized = JSON.stringify(projection);
  for (const forbidden of [
    'expected',
    'caseId',
    'labelRationale',
    'deterministicDecision',
    'split',
    'evaluation',
    'metrics',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(serialized.includes('purchaseDate'), false);
  assert.equal(serialized.includes('scanDate'), false);
});

test('v2.1 schema excludes weak name, brand, prose, purchase-date, and scan-date claims', () => {
  for (const ownedEvidence of [
    { source: 'base', field: 'productName' },
    { source: 'base', field: 'brand' },
    { source: 'base', field: 'purchaseDate' },
    { source: 'base', field: 'scanDate' },
    { source: 'prose', field: 'description' },
  ]) {
    assert.equal(
      validateGuardedAiDecisionV2_1({
        ...validDecision,
        claims: [{ ...validDecision.claims[0], ownedEvidence }],
      }),
      null,
    );
  }
});

test('v2.1 identifiers are explicitly versioned', () => {
  assert.equal(VERIFIER_VERSION_V2_1, '2.1.0');
  assert.equal(HYBRID_GUARDED_MATCH_METHOD_V2_1, 'hybrid_guarded_v2_1');
  assert.equal(MATCH_FINGERPRINT_POLICY_V2_1, 'phase_16_guarded_v2_1_offline');
});

test('v2.1 fingerprint is separate from frozen v2 without changing v2 inputs', async () => {
  const input = {
    ownedProduct: owned(),
    officialRecall: recall(),
    rawPayload: { controlled: true },
    modelId: 'offline-fixture',
  };
  const [v2, v2_1] = await Promise.all([
    buildEvidenceFingerprintV2(input),
    buildEvidenceFingerprintV2_1(input),
  ]);
  assert.match(v2_1, /^[0-9a-f]{64}$/u);
  assert.notEqual(v2_1, v2);
});

test('proposed AI-value holdout is balanced, disjoint, provenance-complete, and v2-abstaining', async () => {
  const dataset = JSON.parse(
    await readFile(
      new URL(
        '../benchmarks/recall-matching/phase-16/ai-value-holdout.proposed.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const audit = JSON.parse(
    await readFile(
      new URL(
        '../benchmarks/recall-matching/phase-16/ai-value-holdout-audit.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.equal(dataset.cases.length, 12);
  assert.deepEqual(dataset.classDistribution, { match: 4, no_match: 4, needs_review: 4 });
  assert.equal(new Set(dataset.cases.map((item) => item.recallFamilyId)).size, 4);
  assert.ok(dataset.cases.every((item) => item.deterministicV2Decision === 'needs_review'));
  assert.ok(
    dataset.cases.every((item) =>
      item.officialUrl.startsWith('https://www.cpsc.gov/Recalls/2026/'),
    ),
  );
  assert.equal(audit.familyOverlapCount, 0);
  assert.equal(audit.missingProvenanceCount, 0);
  assert.equal(audit.labelSource, 'controlled_authoritative_evidence');
});

test('Phase 15 safety replay remains unchanged under v2.1 advisory behavior', async () => {
  const result = JSON.parse(
    await readFile(
      new URL(
        '../benchmarks/recall-matching/phase-16/results/hybrid-guarded-v2-1-phase15-safety.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.equal(result.totalCases, 200);
  assert.equal(result.changedDecisionCount, 0);
  assert.equal(result.unsafeConfirmations, 0);
  assert.equal(result.needsReviewPreserved, 66);
});
