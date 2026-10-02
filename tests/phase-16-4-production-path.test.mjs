import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { productionMatcherPolicy } from '../supabase/functions/_shared/recallMatching/policySelector.ts';
import { processRecallMatchesV2 } from '../supabase/functions/_shared/recallMatching/orchestratorV2.ts';
import {
  sourcePayloadSha256,
  validateLiveReviewedCriteriaV2,
} from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';
import {
  productionFingerprintV2,
  projectOwnedProductForProductionV2,
  projectRecallForProductionV2,
} from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';
import { computeRuleSetFingerprintV2 } from '../supabase/functions/_shared/recallMatching/ruleSetsV2.ts';

const url = 'https://www.cpsc.gov/Recalls/2026/phase-16-4';
const rawPayload = {
  Products: [{ Name: 'Controlled product', Model: 'MODEL-1', Color: 'Blue' }],
  ProductUPCs: [{ UPC: '012345678905' }],
};
const recall = {
  recall_notice_id: 'a2000000-0000-4000-8000-000000000001',
  recall_notice_updated_at: '2026-09-23T10:00:00Z',
  source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
  source_external_id: 'phase-16-4',
  source_official_url: url,
  source_is_authoritative: true,
  title: 'Controlled product recall',
  description: 'Blue model descriptive text',
  hazard: null,
  remedy: null,
  recall_date: '2026-09-20',
  raw_payload: rawPayload,
  scopes: [],
};
const scope = {
  scope_id: 'a3000000-0000-4000-8000-000000000001',
  product_name: 'Controlled product',
  model_number: 'MODEL-1',
  gtin: null,
  lot_from: null,
  lot_to: null,
  serial_from: null,
  serial_to: null,
  additional_criteria: null,
};
const product = (id, model) => ({
  owned_product_id: id,
  owned_product_updated_at: '2026-09-23T10:00:00Z',
  user_id: 'a1000000-0000-4000-8000-000000000001',
  product_name: 'Controlled product',
  brand: null,
  category: null,
  gtin: null,
  model_number: model,
  serial_number: null,
  lot_number: null,
  purchase_date: '2026-09-01',
  identification_method: 'manual',
  safety_attributes: {},
  exact_rank: 1,
});
const candidateId = 'a5000000-0000-4000-8000-000000000001';
const criterion = {
  id: `cpsc-ledger-${candidateId}`,
  kind: 'model_number',
  operator: 'equals',
  required: true,
  value: 'MODEL-1',
  provenance: {
    authority: 'CPSC',
    officialUrl: url,
    sourceField: 'cpsc-page:table/row/model',
    normalizationRule: 'identifier_v2',
  },
};
// Phase 16.11: the only live shape is the database's human-review-ledger build.
async function reviewedSet() {
  return {
    semantics: 'all_of',
    criteria: [criterion],
    review: {
      origin: 'human_review_ledger',
      revisionId: 'a6000000-0000-4000-8000-000000000001',
      sourceRevisionHash: 'a'.repeat(64),
      conjunctionGroup: 'table/row',
      scopeId: scope.scope_id,
      scopeFingerprint: 'b'.repeat(64),
      candidateIds: [candidateId],
      reviewEventIds: ['a7000000-0000-4000-8000-000000000001'],
      reviewerIds: ['a8000000-0000-4000-8000-000000000001'],
      reviewedAt: '2026-09-23T10:00:00Z',
    },
  };
}

// Phase 16.12: the database serves an any_of envelope of rule sets for each scope.
async function reviewedEnvelope() {
  const set = await reviewedSet();
  const ruleSet = {
    ...set,
    review: {
      ...set.review,
      schema: 'recall_rule_set_v1',
      identityFingerprint: 'c'.repeat(64),
      scopeSemanticFingerprint: 'd'.repeat(64),
      sourceAddressHashes: ['e'.repeat(64)],
      ruleSetFingerprint: '',
    },
  };
  ruleSet.review.ruleSetFingerprint = await computeRuleSetFingerprintV2(ruleSet);
  return {
    semantics: 'any_of',
    schema: 'recall_rule_sets_v1',
    scopeId: scope.scope_id,
    ruleSets: [ruleSet],
    coverage: {
      currentRevisionId: set.review.revisionId,
      proposedRuleSets: 1,
      unattributedRuleSets: 0,
      servedRuleSets: 1,
      complete: true,
      // Phase 16.13: the database serves the revision's source-coverage proof too.
      sourceCoverage: {
        state: 'recorded',
        coverageStatus: 'complete',
        positiveStatus: 'independent',
        negativeEvidenceEligible: true,
      },
    },
  };
}

test('default selector is guarded v1 and unknown policies fail closed', () => {
  assert.equal(productionMatcherPolicy(undefined), 'phase_10_guarded_v1');
  assert.equal(productionMatcherPolicy('phase_16_deterministic_v2'), 'phase_16_deterministic_v2');
  assert.throws(() => productionMatcherPolicy('hybrid_guarded_v2'));
});

test('live reviewed criteria must come from the human review ledger', async () => {
  const set = await reviewedSet();
  assert.equal(await validateLiveReviewedCriteriaV2(recall, scope, set), set);
  const legacy = {
    semantics: 'all_of',
    criteria: [
      { ...criterion, provenance: { ...criterion.provenance, sourceField: 'Products[0].Model' } },
    ],
    review: {
      reviewerId: 'reviewer-fixture',
      reviewedAt: '2026-09-23T10:00:00Z',
      sourcePayloadSha256: await sourcePayloadSha256(rawPayload),
      eligibilityStatement: 'Free-text attestation from the retired Phase 16.4 path.',
    },
  };
  await assert.rejects(
    () => validateLiveReviewedCriteriaV2(recall, scope, legacy),
    /human review ledger/u,
  );
  await assert.rejects(
    () => validateLiveReviewedCriteriaV2(recall, { ...scope, scope_id: 'other-scope' }, set),
    /human review ledger/u,
  );
  for (const patch of [
    { kind: 'color', value: 'Blue' },
    { kind: 'gtin', value: '012345678905' },
    { required: false },
    { id: 'cpsc-ledger-forged' },
    { provenance: { ...criterion.provenance, officialUrl: 'https://www.cpsc.gov/Recalls/other' } },
  ]) {
    await assert.rejects(
      () =>
        validateLiveReviewedCriteriaV2(recall, scope, {
          ...set,
          criteria: [{ ...criterion, ...patch }],
        }),
      /ledger-bound structured evidence/u,
    );
  }
  const dateOnly = {
    ...set,
    criteria: [{ ...criterion, kind: 'date_code', value: '2510' }],
  };
  await assert.rejects(
    () => validateLiveReviewedCriteriaV2(recall, scope, dateOnly),
    /product-model anchor/u,
  );
  await assert.rejects(
    () =>
      validateLiveReviewedCriteriaV2({ ...recall, source_authority: 'Health Canada' }, scope, set),
    /Health Canada/u,
  );
});

test('stored invalid evidence fails closed and purchase date is not manufacture evidence', () => {
  assert.throws(
    () =>
      projectOwnedProductForProductionV2({
        ...product('one', 'MODEL-1'),
        safety_attributes: { manufacture_date: '2026-02-30' },
      }),
    /date/u,
  );
  assert.throws(
    () =>
      projectOwnedProductForProductionV2({
        ...product('one', 'MODEL-1'),
        safety_attributes: { scan_date: '2026-09-23' },
      }),
    /invalid/u,
  );
  const owned = projectOwnedProductForProductionV2(product('one', 'MODEL-1'));
  assert.equal(owned.purchaseDate, null);
  assert.equal(owned.attributes.length, 0);
});

test('a restored product value receives a new v2 fingerprint after its revision changes', async () => {
  const owned = projectOwnedProductForProductionV2(product('one', 'MODEL-1'));
  const official = projectRecallForProductionV2({ ...recall, scopes: [scope] }, [
    await reviewedSet(),
  ]);
  const first = await productionFingerprintV2({
    ownedProduct: owned,
    officialRecall: official,
    productRevision: '2026-09-23T10:00:00Z',
    recallRevision: recall.recall_notice_updated_at,
  });
  const restored = await productionFingerprintV2({
    ownedProduct: owned,
    officialRecall: official,
    productRevision: '2026-09-23T11:00:00Z',
    recallRevision: recall.recall_notice_updated_at,
  });
  assert.notEqual(first, restored);
});

test('inactive worker evaluates bounded candidates, persists decisions and recovers replay', async () => {
  const set = await reviewedEnvelope();
  const products = [product('one', 'MODEL-1'), product('two', null), product('three', 'MODEL-2')];
  const evaluations = new Map();
  const eligibility = new Map();
  const alerts = new Set();
  const store = {
    async listAuthoritativeRecalls({ afterRecallId }) {
      return afterRecallId ? [] : [recall];
    },
    async getReviewedScopes() {
      return [{ ...scope, reviewed_criteria: set }];
    },
    async listRecallCandidateProducts({ afterProductId }) {
      return afterProductId ? [] : products;
    },
    async getOwnedSafetyEvidence(id) {
      return products.find((item) => item.owned_product_id === id);
    },
    async claimPair() {
      return { status: 'claimed', leaseToken: 'fixture-lease' };
    },
    async finalizeV2(input) {
      const key = `${input.ownedProductId}:${input.evidenceFingerprint}`;
      if (evaluations.has(key)) return { status: 'unchanged', alertEligibility: 'none' };
      evaluations.set(key, input.status);
      if (input.status === 'confirmed') {
        eligibility.set(input.ownedProductId, 'active');
        return { status: 'finalized', alertEligibility: 'created' };
      }
      if (eligibility.get(input.ownedProductId) === 'active') {
        eligibility.set(input.ownedProductId, 'revoked');
        return { status: 'finalized', alertEligibility: 'revoked' };
      }
      return { status: 'finalized', alertEligibility: 'none' };
    },
    async createAlert(id) {
      if (eligibility.get(id) !== 'active') return 'ineligible';
      if (alerts.has(id)) return 'existing';
      alerts.add(id);
      return 'created';
    },
  };
  const limits = {
    maxRecalls: 1,
    maxCandidatePairs: 10,
    maxNebiusCalls: 0,
    recallNoticeIds: [recall.recall_notice_id],
  };
  const first = await processRecallMatchesV2(limits, store);
  assert.deepEqual(
    [
      first.candidatePairs,
      first.confirmed,
      first.needsReview,
      first.rejected,
      first.eligibilityCreated,
      first.alertsCreated,
      first.aiCalls,
      first.errors,
    ],
    [3, 1, 1, 1, 1, 1, 0, 0],
  );
  assert.ok(first.pairLatencyP95Ms >= first.pairLatencyP50Ms);
  const replay = await processRecallMatchesV2(limits, store);
  assert.equal(replay.duplicateAttempts, 3);
  assert.equal(alerts.size, 1);
  products[0] = {
    ...products[0],
    model_number: null,
    owned_product_updated_at: '2026-09-23T11:00:00Z',
  };
  const changed = await processRecallMatchesV2(limits, store);
  assert.equal(changed.eligibilityRevoked, 1);
  assert.equal(eligibility.get('one'), 'revoked');
  assert.equal(alerts.size, 1);
});

test('v2 import boundary contains no Nebius or push dependency', async () => {
  const paths = [
    'orchestratorV2.ts',
    'reviewedCriteriaV2.ts',
    'productionPolicyV2.ts',
    'ruleSetsV2.ts',
  ];
  for (const path of paths) {
    const body = await readFile(
      new URL(`../supabase/functions/_shared/recallMatching/${path}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(body, /from ['"].*(nebius|push|hybridGuarded)/iu);
  }
});
