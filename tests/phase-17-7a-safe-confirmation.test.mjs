// Phase 17.7a-R1: characterization of the confirmation contract for the future
// product-check path. These tests pin the CURRENT behavior of the unchanged
// production matcher (deterministic_v1) and of the unchanged v2 library, next to
// the SAFE outcome the new path must produce. Nothing here changes runtime code.
//
// Vocabulary of the safe contract (docs/phase-17-7a-existing-recall-check-design.md,
// "Safe confirmation contract"):
//   eligible_for_deterministic_confirmation | incomplete_evidence | unsupported_scope
//   | jurisdiction_mismatch | human_review_required
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateDeterministicMatch } from '../supabase/functions/_shared/matching/deterministicMatcher.ts';
import { evaluateDeterministicMatchV2 } from '../supabase/functions/_shared/matching/deterministicMatcherV2.ts';
import { evaluateDeterministicRuleSetsV2 } from '../supabase/functions/_shared/matching/deterministicRuleSetsV2.ts';
import { buildEvidenceFingerprint } from '../supabase/functions/_shared/recallMatching/fingerprint.ts';
import { projectOwnedProduct } from '../supabase/functions/_shared/recallMatching/projection.ts';
import { projectOwnedProductForProductionV2 } from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';
import { validateLiveReviewedCriteriaV2 } from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';

const MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
const GTIN = '091021037090';
const CPSC = 'U.S. Consumer Product Safety Commission (CPSC)';
const HEALTH_CANADA = 'Health Canada Recalls and Safety Alerts';
const CPSC_URL = 'https://www.cpsc.gov/Recalls/2020/Thule-Recalls-Strollers-Due-to-Injury-Hazard';

const owned = (overrides = {}) => ({
  productName: 'Thule Sleek stroller',
  brand: 'Thule',
  category: null,
  gtin: GTIN,
  modelNumber: null,
  serialNumber: null,
  lotNumber: null,
  purchaseDate: null,
  identificationMethod: 'barcode_scan',
  ...overrides,
});

const ownedV2 = (overrides = {}, attributes = []) => ({
  ...owned(overrides),
  purchaseDate: null,
  attributes,
});

const manufactureDate = (value) => ({
  key: 'manufacture_date',
  value,
  valueType: 'date',
  captureSource: 'manual',
});

const recall = (scopes, overrides = {}) => ({
  recallNoticeId: 'notice-17-7a',
  source: { authority: CPSC, externalId: '17007', officialUrl: CPSC_URL },
  title: 'Stroller recall',
  description: null,
  hazard: null,
  remedy: null,
  recallDate: '2020-08-12',
  scopes,
  rawEvidence: null,
  ...overrides,
});

const provenance = (sourceField) => ({
  authority: 'CPSC',
  officialUrl: CPSC_URL,
  sourceField,
  normalizationRule: 'identifier_v2',
});

const gtinCriterion = {
  id: 'gtin',
  kind: 'gtin',
  operator: 'equals',
  required: true,
  value: GTIN,
  provenance: provenance('ProductUPCs'),
};
const lotCriterion = {
  id: 'lot',
  kind: 'lot_number',
  operator: 'range',
  required: true,
  range: { from: '1000', to: '1999' },
  provenance: provenance('cpsc-page:description'),
};
const manufactureCriterion = {
  id: 'manufactured',
  kind: 'manufacture_date',
  operator: 'date_range',
  required: true,
  range: { from: '2018-05-01', to: '2019-09-30' },
  provenance: provenance('cpsc-page:description'),
};

// Structured v1 scopes (what deterministic_v1 can see).
const lotScope = { gtin: GTIN, lotFrom: '1000', lotTo: '1999' };
const windowScope = { gtin: GTIN, manufacturedFrom: '2018-05-01', manufacturedTo: '2019-09-30' };

// Each D1 row: the v1 input, the CURRENT v1 decision, the explicit reviewed
// all_of criteria a human would attest, the v2 core decision on them, and the
// SAFE outcome required from the new path when completeness is NOT proven.
const D1 = [
  {
    id: 'A',
    label: 'exact GTIN, recall states only a GTIN',
    product: owned(),
    scope: { gtin: GTIN },
    v1: 'confirmed',
    criteria: [gtinCriterion],
    productV2: ownedV2(),
    v2: 'confirmed',
    safeWithoutCompletenessProof: 'unsupported_scope',
  },
  {
    id: 'B',
    label: 'exact GTIN + recall requires a lot, product has no lot',
    product: owned(),
    scope: lotScope,
    v1: 'confirmed', // UNSAFE: mandatory lot condition silently ignored
    criteria: [gtinCriterion, lotCriterion],
    productV2: ownedV2(),
    v2: 'needs_review',
    safeWithoutCompletenessProof: 'incomplete_evidence',
  },
  {
    id: 'C',
    label: 'exact GTIN + recall requires a lot, wrong lot',
    product: owned({ lotNumber: '2500' }),
    scope: lotScope,
    v1: 'needs_review',
    criteria: [gtinCriterion, lotCriterion],
    productV2: ownedV2({ lotNumber: '2500' }),
    v2: 'rejected',
    safeWithoutCompletenessProof: 'human_review_required',
  },
  {
    id: 'D',
    label: 'exact GTIN + recall requires a lot, right lot',
    product: owned({ lotNumber: '1500' }),
    scope: lotScope,
    v1: 'confirmed',
    criteria: [gtinCriterion, lotCriterion],
    productV2: ownedV2({ lotNumber: '1500' }),
    v2: 'confirmed',
    safeWithoutCompletenessProof: 'unsupported_scope',
  },
  {
    id: 'E',
    label: 'exact GTIN + manufacture window, date absent',
    product: owned(),
    scope: windowScope,
    v1: 'confirmed', // UNSAFE: mandatory window silently ignored
    criteria: [gtinCriterion, manufactureCriterion],
    productV2: ownedV2(),
    v2: 'needs_review',
    safeWithoutCompletenessProof: 'incomplete_evidence',
  },
  {
    id: 'F',
    label: 'exact GTIN + manufacture window, date outside',
    // v1 only knows purchase date; the manufacture date lives in v2 safety attributes.
    product: owned({ purchaseDate: '2017-01-15' }),
    scope: windowScope,
    v1: 'confirmed', // FALSE POSITIVE: product is provably outside the window
    criteria: [gtinCriterion, manufactureCriterion],
    productV2: ownedV2({}, [manufactureDate('2017-01-15')]),
    v2: 'rejected',
    safeWithoutCompletenessProof: 'human_review_required',
  },
  {
    id: 'G',
    label: 'exact GTIN + manufacture window, date inside',
    product: owned({ purchaseDate: '2019-01-15' }),
    scope: windowScope,
    v1: 'confirmed',
    criteria: [gtinCriterion, manufactureCriterion],
    productV2: ownedV2({}, [manufactureDate('2019-01-15')]),
    v2: 'confirmed',
    safeWithoutCompletenessProof: 'unsupported_scope',
  },
];

for (const row of D1) {
  test(`D1-${row.id} v1 today: ${row.label} -> ${row.v1}`, () => {
    const evaluation = evaluateDeterministicMatch(row.product, recall([row.scope]));
    assert.equal(evaluation.decision, row.v1);
  });

  test(`D1-${row.id} v2 core on explicit reviewed all_of criteria -> ${row.v2}`, () => {
    const evaluation = evaluateDeterministicMatchV2(
      row.productV2,
      recall([{ ...row.scope, criteria: { semantics: 'all_of', criteria: row.criteria } }]),
    );
    assert.equal(evaluation.decision, row.v2);
  });

  test(`D1-${row.id} without a completeness proof v2 never confirms (safe: ${row.safeWithoutCompletenessProof})`, () => {
    // Same structured scope, no reviewed criteria: the v2 library abstains.
    const evaluation = evaluateDeterministicMatchV2(row.productV2, recall([row.scope]));
    assert.equal(evaluation.decision, 'needs_review');
    assert.notEqual(row.safeWithoutCompletenessProof, 'eligible_for_deterministic_confirmation');
  });
}

test('D1 summary: v1 confirms three cases whose mandatory condition is unmet or unknown', () => {
  const unsafe = D1.filter((row) => row.v1 === 'confirmed' && row.v2 !== 'confirmed').map(
    (row) => row.id,
  );
  assert.deepEqual(unsafe, ['B', 'E', 'F']);
});

test('D1 a contradicted rule set with incomplete coverage is withheld, never a rejection', () => {
  for (const row of D1.filter((item) => item.v2 === 'rejected')) {
    const evaluation = evaluateDeterministicRuleSetsV2(
      row.productV2,
      recall([
        {
          ...row.scope,
          ruleSets: [{ semantics: 'all_of', criteria: row.criteria, ruleSetId: `rs-${row.id}` }],
          ruleSetCoverageComplete: false,
        },
      ]),
    );
    assert.equal(evaluation.decision, 'needs_review', row.id);
    assert.equal(evaluation.rejectionWithheld, true, row.id);
  }
});

test('D1 production notice 8877 shape: GTIN-only scopes confirm in v1 while the official text adds a manufacture window and a sticker condition', () => {
  // Public CPSC data, structure identical to production (13 recall-level UPC
  // scopes + one name scope). The mandatory conditions exist only in prose.
  const upcs = [
    '091021037090',
    '091021070585',
    '091021079779',
    '091021091900',
    '091021190214',
    '091021349001',
    '091021433137',
    '091021460256',
    '091021514386',
    '091021648937',
    '091021761773',
    '091021883703',
    '091021978485',
  ];
  const recallLevel = {
    association:
      'CPSC ProductUPCs are recall-level and are not associated with a specific product.',
    evidence_level: 'recall',
  };
  const notice = recall(
    [
      ...upcs.map((gtin) => ({ gtin, additionalCriteria: recallLevel })),
      { productName: 'Thule Sleek strollers' },
    ],
    {
      title: 'Thule Recalls Strollers Due to Injury Hazard',
      description:
        'Only strollers without a QC2020 sticker next to the product label and manufactured ' +
        'between May 2018 through September 2019 are included in this recall.',
    },
  );
  const evaluation = evaluateDeterministicMatch(owned(), notice);
  assert.equal(evaluation.decision, 'confirmed');
  assert.deepEqual(evaluation.matchedIdentifiers.gtin, [GTIN]);
  // Same notice, a product manufactured in 2017 with a QC2020 sticker: v1 still confirms.
  assert.equal(
    evaluateDeterministicMatch(owned({ purchaseDate: '2017-03-01' }), notice).decision,
    'confirmed',
  );
  // The v2 library has no reviewed criteria for it and abstains.
  assert.equal(evaluateDeterministicMatchV2(ownedV2(), notice).decision, 'needs_review');
});

// ---------------------------------------------------------------------------
// Live v2 allowlist: which reviewed criterion kinds can production serve today?
// ---------------------------------------------------------------------------
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HEX = 'a'.repeat(64);
const recallRow = {
  recall_notice_id: UUID(1),
  source_authority: CPSC,
  source_external_id: '8877',
  source_official_url: CPSC_URL,
  source_is_authoritative: true,
  title: 'Thule Recalls Strollers Due to Injury Hazard',
  description: null,
  hazard: null,
  remedy: null,
  recall_date: '2020-08-12',
  raw_payload: {},
  scopes: [],
};
const scopeRow = { scope_id: UUID(2) };

function ledgerSet(kind, operator, value) {
  const candidateId = UUID(10);
  return {
    semantics: 'all_of',
    criteria: [
      {
        id: `cpsc-ledger-${candidateId}`,
        kind,
        operator,
        required: true,
        ...(operator === 'range' ? { range: value } : { value }),
        provenance: provenance('cpsc-page:description'),
      },
    ],
    review: {
      origin: 'human_review_ledger',
      revisionId: UUID(3),
      sourceRevisionHash: HEX,
      conjunctionGroup: 'g1',
      scopeId: scopeRow.scope_id,
      scopeFingerprint: HEX,
      candidateIds: [candidateId],
      reviewEventIds: [UUID(11)],
      reviewerIds: [UUID(12)],
      reviewedAt: '2026-10-02T00:00:00Z',
    },
  };
}

test('live v2 allowlist serves a reviewed model criterion (positive control)', async () => {
  const set = ledgerSet('model_number', 'equals', '11000017');
  assert.equal(await validateLiveReviewedCriteriaV2(recallRow, scopeRow, set), set);
});

for (const [kind, operator, value] of [
  ['gtin', 'equals', GTIN],
  ['lot_number', 'range', { from: '1000', to: '1999' }],
  ['manufacture_date', 'date_range', { from: '2018-05-01', to: '2019-09-30' }],
]) {
  test(`live v2 allowlist refuses a reviewed ${kind} criterion today`, async () => {
    await assert.rejects(
      validateLiveReviewedCriteriaV2(recallRow, scopeRow, ledgerSet(kind, operator, value)),
      /ledger-bound structured evidence/u,
    );
  });
}

// ---------------------------------------------------------------------------
// D2: jurisdiction. v1 neither projects nor fingerprints the purchase country.
// ---------------------------------------------------------------------------
const productRow = (purchaseCountryCode) => ({
  owned_product_id: UUID(20),
  owned_product_updated_at: '2026-10-02T00:00:00.000001+00:00',
  product_name: 'Thule Sleek stroller',
  brand: 'Thule',
  category: null,
  gtin: GTIN,
  model_number: null,
  serial_number: null,
  lot_number: null,
  purchase_date: null,
  identification_method: 'barcode_scan',
  purchase_country_code: purchaseCountryCode,
  safety_attributes: {},
});

const gtinOnlyNotice = (authority, url) =>
  recall([{ gtin: GTIN }], { source: { authority, externalId: 'J', officialUrl: url } });
const US_NOTICE = gtinOnlyNotice(CPSC, CPSC_URL);
const CA_NOTICE = gtinOnlyNotice(
  HEALTH_CANADA,
  'https://recalls-rappels.canada.ca/en/alert-recall/example',
);

// Current v1 behavior and the SAFE outcome required from the new path. Notice
// jurisdiction comes from public.recall_notice_jurisdictions (CPSC -> US,
// Health Canada -> CA in production).
const D2 = [
  {
    label: 'US recall, bought in US',
    notice: US_NOTICE,
    country: 'US',
    safe: 'eligible_for_deterministic_confirmation',
  },
  {
    label: 'US recall, bought in CA',
    notice: US_NOTICE,
    country: 'CA',
    safe: 'jurisdiction_mismatch',
  },
  {
    label: 'CA recall, bought in CA',
    notice: CA_NOTICE,
    country: 'CA',
    safe: 'eligible_for_deterministic_confirmation',
  },
  {
    label: 'CA recall, bought in US',
    notice: CA_NOTICE,
    country: 'US',
    safe: 'jurisdiction_mismatch',
  },
  {
    label: 'US recall, country unknown',
    notice: US_NOTICE,
    country: null,
    safe: 'incomplete_evidence',
  },
];

for (const row of D2) {
  test(`D2 v1 today: ${row.label} -> confirmed (country ignored); safe: ${row.safe}`, () => {
    const projected = projectOwnedProduct(productRow(row.country));
    assert.equal('purchaseCountryCode' in projected, false);
    assert.equal(evaluateDeterministicMatch(projected, row.notice).decision, 'confirmed');
  });
}

test('D2 purchase country changes neither the v1 projection, the v1 fingerprint, nor the v2 projection', async () => {
  const projections = ['US', 'CA', null].map((country) => projectOwnedProduct(productRow(country)));
  assert.deepEqual(projections[0], projections[1]);
  assert.deepEqual(projections[0], projections[2]);
  const fingerprints = await Promise.all(
    projections.map((ownedProduct) =>
      buildEvidenceFingerprint({
        ownedProduct,
        officialRecall: US_NOTICE,
        rawPayload: {},
        modelId: MODEL_ID,
      }),
    ),
  );
  assert.equal(new Set(fingerprints).size, 1);
  assert.deepEqual(
    projectOwnedProductForProductionV2(productRow('US')),
    projectOwnedProductForProductionV2(productRow('CA')),
  );
});

test('D2 production Health Canada scope shape: source metadata keys make v1 abstain even on an exact GTIN', () => {
  // Every production Health Canada scope carries source_* keys in additional_criteria,
  // which deterministic_v1 treats as complex criteria.
  const notice = recall(
    [
      {
        gtin: GTIN,
        additionalCriteria: {
          source_category: 'Consumer products',
          source_recall_class: 'Type II',
        },
      },
    ],
    {
      source: {
        authority: HEALTH_CANADA,
        externalId: 'HC',
        officialUrl: 'https://recalls-rappels.canada.ca/x',
      },
    },
  );
  assert.equal(evaluateDeterministicMatch(owned(), notice).decision, 'needs_review');
});
