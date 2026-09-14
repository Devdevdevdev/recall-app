import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateScopeEvaluations } from '../supabase/functions/_shared/matching/aggregation.ts';
import { retrieveRecallCandidates } from '../supabase/functions/_shared/matching/candidateRetrieval.ts';
import { evaluateDeterministicMatch } from '../supabase/functions/_shared/matching/deterministicMatcher.ts';
import {
  compareIdentifierRange,
  isValidGtin,
  normalizeGtin,
  normalizeIdentifier,
  productNameOverlap,
} from '../supabase/functions/_shared/matching/normalization.ts';

const owned = (overrides = {}) => ({
  productName: null,
  brand: null,
  category: null,
  gtin: null,
  modelNumber: null,
  serialNumber: null,
  lotNumber: null,
  purchaseDate: null,
  identificationMethod: null,
  ...overrides,
});

const recall = (scopes, overrides = {}) => ({
  recallNoticeId: 'notice-1',
  source: {
    authority: 'CPSC',
    externalId: '1',
    officialUrl: 'https://www.cpsc.gov/Recalls/example',
  },
  title: 'Example recall',
  description: null,
  hazard: null,
  remedy: null,
  recallDate: '2026-01-01',
  scopes,
  rawEvidence: null,
  ...overrides,
});

test('normalization preserves leading zeroes and validates GS1 check digits', () => {
  assert.equal(normalizeGtin(' 091021037090 '), '091021037090');
  assert.equal(isValidGtin('091021037090'), true);
  assert.equal(isValidGtin('091021037091'), false);
  assert.equal(normalizeGtin('09-1021-037090'), null);
});

test('model normalization is Unicode-safe and preserves meaningful punctuation', () => {
  assert.equal(normalizeIdentifier('  ak396h-mbk / v1.2  '), 'AK396H-MBK / V1.2');
  assert.equal(normalizeIdentifier('ＡＫ３９６Ｈ－ＭＢＫ'), 'AK396H-MBK');
});

test('product-name overlap is transparent and symmetric', () => {
  const leftRight = productNameOverlap('Thule Sleek stroller', 'Thule Sleek strollers');
  assert.equal(leftRight, productNameOverlap('Thule Sleek strollers', 'Thule Sleek stroller'));
  assert.ok(leftRight > 0);
  assert.equal(productNameOverlap('silicone glue', 'ceiling fan'), 0);
});

test('safe ranges support exact and fixed-width digits only', () => {
  assert.equal(compareIdentifierRange('0015', '0010', '0020'), 'inside');
  assert.equal(compareIdentifierRange('0025', '0010', '0020'), 'outside');
  assert.equal(compareIdentifierRange('LOT-A', 'LOT-A', 'LOT-A'), 'inside');
  assert.equal(compareIdentifierRange('AB15', 'AB10', 'AB20'), 'ambiguous');
  assert.equal(compareIdentifierRange('15', '0010', '0020'), 'ambiguous');
  assert.equal(compareIdentifierRange('0015', '0020', '0010'), 'ambiguous');
});

test('exact valid GTIN confirms and records official evidence', () => {
  const result = evaluateDeterministicMatch(
    owned({ gtin: '091021037090' }),
    recall([{ gtin: '091021037090' }]),
  );
  assert.equal(result.decision, 'confirmed');
  assert.deepEqual(result.matchedIdentifiers.gtin, ['091021037090']);
  assert.equal(result.confidence, 1);
});

test('explicit valid GTIN mismatch rejects one relevant scope', () => {
  const result = evaluateDeterministicMatch(
    owned({ gtin: '091021037090' }),
    recall([{ gtin: '843461115513' }]),
  );
  assert.equal(result.decision, 'rejected');
  assert.equal(result.conflictingIdentifiers.gtin?.length, 1);
});

test('exact model plus compatible name confirms while model alone abstains', () => {
  const confirmed = evaluateDeterministicMatch(
    owned({ productName: 'Halwin ceiling fan', modelNumber: 'ak396h-mbk' }),
    recall([{ productName: 'Halwin ceiling fan', modelNumber: 'AK396H-MBK' }]),
  );
  assert.equal(confirmed.decision, 'confirmed');

  const unresolved = evaluateDeterministicMatch(
    owned({ modelNumber: 'ak396h-mbk' }),
    recall([{ modelNumber: 'AK396H-MBK' }]),
  );
  assert.equal(unresolved.decision, 'needs_review');
});

test('product-name overlap alone never confirms', () => {
  const result = evaluateDeterministicMatch(
    owned({ productName: 'Boon NURSH reusable bottle' }),
    recall([{ productName: 'Boon NURSH 8 oz reusable baby bottles' }]),
  );
  assert.equal(result.decision, 'needs_review');
});

test('one exact matching scope wins over sibling GTIN mismatches', () => {
  const result = evaluateDeterministicMatch(
    owned({ gtin: '091021037090' }),
    recall([{ gtin: '843461115513' }, { gtin: '091021037090' }, { gtin: '764608020302' }]),
  );
  assert.equal(result.decision, 'confirmed');
  assert.deepEqual(result.matchedIdentifiers.gtin, ['091021037090']);
  assert.equal(result.conflictingIdentifiers.gtin, undefined);
  assert.equal(
    result.evidenceUsed.filter((item) => item.kind === 'gtin' && item.outcome === 'conflicting')
      .length,
    2,
  );
});

test('all relevant scopes contradicted rejects', () => {
  const result = evaluateDeterministicMatch(
    owned({ gtin: '091021037090' }),
    recall([{ gtin: '843461115513' }, { gtin: '764608020302' }]),
  );
  assert.equal(result.decision, 'rejected');
});

test('exact serial and exact lot independently confirm', () => {
  assert.equal(
    evaluateDeterministicMatch(
      owned({ serialNumber: 'sn-001/a' }),
      recall([{ serialNumber: 'SN-001/A' }]),
    ).decision,
    'confirmed',
  );
  assert.equal(
    evaluateDeterministicMatch(owned({ lotNumber: 'lot.09' }), recall([{ lotNumber: 'LOT.09' }]))
      .decision,
    'confirmed',
  );
});

test('safe numeric serial ranges confirm inside, reject outside, and abstain when ambiguous', () => {
  assert.equal(
    evaluateDeterministicMatch(
      owned({ serialNumber: '0015' }),
      recall([{ serialFrom: '0010', serialTo: '0020' }]),
    ).decision,
    'confirmed',
  );
  assert.equal(
    evaluateDeterministicMatch(
      owned({ serialNumber: '0025' }),
      recall([{ serialFrom: '0010', serialTo: '0020' }]),
    ).decision,
    'rejected',
  );
  assert.equal(
    evaluateDeterministicMatch(
      owned({ serialNumber: 'AB15' }),
      recall([{ serialFrom: 'AB10', serialTo: 'AB20' }]),
    ).decision,
    'needs_review',
  );
});

test('purchase date is never treated as manufacture date', () => {
  const result = evaluateDeterministicMatch(
    owned({ purchaseDate: '2025-06-01' }),
    recall([{ manufacturedFrom: '2025-01-01', manufacturedTo: '2025-12-31' }]),
  );
  assert.equal(result.decision, 'needs_review');
  assert.match(
    result.evidenceUsed.find((item) => item.kind === 'purchaseDateContext')?.detail ?? '',
    /not manufacture date/u,
  );
});

test('manufacturer context is not promoted to brand equality', () => {
  const result = evaluateDeterministicMatch(
    owned({ productName: 'gas range', brand: 'Fisher & Paykel' }),
    recall([
      {
        productName: 'professional gas range',
        additionalCriteria: { manufacturer_names: ['Fisher & Paykel Appliances Thailand'] },
      },
    ]),
  );
  assert.equal(result.decision, 'needs_review');
  assert.equal(
    result.evidenceUsed.some((item) => item.kind === 'brand'),
    false,
  );
  assert.equal(
    result.evidenceUsed.some((item) => item.kind === 'manufacturerContext'),
    true,
  );
});

test('empty evidence and complex text evidence abstain', () => {
  assert.equal(evaluateDeterministicMatch(owned(), recall([])).decision, 'needs_review');
  assert.equal(
    evaluateDeterministicMatch(
      owned({ productName: 'Baby bib' }),
      recall([
        {
          productName: 'Personalized baby bibs',
          additionalCriteria: { source_product_description: 'Only certain personalized variants.' },
        },
      ]),
    ).decision,
    'needs_review',
  );
});

test('conflicting structured evidence in the same scope abstains', () => {
  const result = evaluateDeterministicMatch(
    owned({ gtin: '091021037090', modelNumber: 'MODEL-A' }),
    recall([{ gtin: '091021037090', modelNumber: 'MODEL-B' }]),
  );
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.matchedIdentifiers.gtin?.length);
  assert.ok(result.conflictingIdentifiers.modelNumber?.length);
});

test('a matching identifier does not bypass unresolved structured restrictions', () => {
  const result = evaluateDeterministicMatch(
    owned({ productName: 'Example product', modelNumber: 'MODEL-A' }),
    recall([
      {
        productName: 'Example product',
        modelNumber: 'MODEL-A',
        additionalCriteria: { source_product_description: 'Only the red variant.' },
      },
    ]),
  );
  assert.equal(result.decision, 'needs_review');
});

test('exact model and name do not bypass an explicit brand conflict', () => {
  const result = evaluateDeterministicMatch(
    owned({ productName: 'Example product', brand: 'Brand A', modelNumber: 'MODEL-A' }),
    recall([
      {
        productName: 'Example product',
        brand: 'Brand B',
        modelNumber: 'MODEL-A',
      },
    ]),
  );
  assert.equal(result.decision, 'needs_review');
});

test('aggregation treats absence as ambiguity', () => {
  const result = aggregateScopeEvaluations([]);
  assert.equal(result.decision, 'needs_review');
  assert.equal(result.confidence, 0);
});

test('candidate retrieval prioritizes exact identifiers and retains weak name candidates', () => {
  const exact = recall([{ gtin: '091021037090' }], { recallNoticeId: 'exact' });
  const nameOnly = recall([{ productName: 'Thule Sleek stroller' }], {
    recallNoticeId: 'name',
    source: {
      authority: 'CPSC',
      externalId: '2',
      officialUrl: 'https://www.cpsc.gov/Recalls/name',
    },
  });
  const unrelated = recall([{ productName: 'Silicone glue' }], {
    recallNoticeId: 'unrelated',
    source: {
      authority: 'CPSC',
      externalId: '3',
      officialUrl: 'https://www.cpsc.gov/Recalls/unrelated',
    },
  });
  const candidates = retrieveRecallCandidates(
    owned({ gtin: '091021037090', productName: 'Thule Sleek stroller' }),
    [unrelated, nameOnly, exact],
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.recall.recallNoticeId),
    ['exact', 'name'],
  );
  assert.equal(candidates[0]?.signals[0]?.kind, 'exact_gtin');
});

test('candidate truncation cannot discard an exact GTIN behind capped lower-tier scores', () => {
  const lowerTier = Array.from({ length: 100 }, (_, index) =>
    recall([{ productName: 'Example product', modelNumber: 'MODEL-A' }], {
      recallNoticeId: `model-${index}`,
      source: {
        authority: 'CPSC',
        externalId: String(index).padStart(3, '0'),
        officialUrl: `https://www.cpsc.gov/Recalls/model-${index}`,
      },
    }),
  );
  const exact = recall([{ gtin: '091021037090' }], {
    recallNoticeId: 'exact-gtin',
    source: {
      authority: 'CPSC',
      externalId: '999',
      officialUrl: 'https://www.cpsc.gov/Recalls/exact-gtin',
    },
  });
  const candidates = retrieveRecallCandidates(
    owned({ productName: 'Example product', modelNumber: 'MODEL-A', gtin: '091021037090' }),
    [...lowerTier, exact],
    { maxCandidates: 100 },
  );
  assert.equal(candidates.length, 100);
  assert.equal(candidates[0]?.recall.recallNoticeId, 'exact-gtin');
});
