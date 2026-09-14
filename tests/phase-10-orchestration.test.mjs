import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mapCpscRecall } from '../supabase/functions/_shared/cpsc/mapper.ts';
import { retrieveRecallCandidates } from '../supabase/functions/_shared/matching/candidateRetrieval.ts';
import { evaluateDeterministicMatch } from '../supabase/functions/_shared/matching/deterministicMatcher.ts';
import {
  PRODUCTION_MATCHING_POLICY_VERSION,
  buildEvidenceFingerprint,
} from '../supabase/functions/_shared/recallMatching/fingerprint.ts';
import {
  projectAuthoritativeRecall,
  projectOwnedProduct,
} from '../supabase/functions/_shared/recallMatching/projection.ts';
import {
  DEFAULT_MATCHING_LIMITS,
  MAX_MATCHING_LIMITS,
  parseMatchingRunRequest,
} from '../supabase/functions/_shared/recallMatching/request.ts';
import {
  processRecallMatches,
  safeMatchingSummary,
} from '../supabase/functions/_shared/recallMatching/orchestrator.ts';

const MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';

function recallRow(overrides = {}) {
  return {
    recall_notice_id: 'notice-row-id',
    source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
    source_external_id: '8877',
    source_official_url: 'https://www.cpsc.gov/Recalls/2026/example',
    source_is_authoritative: true,
    retrieved_at: '2026-09-14T09:30:00.000Z',
    title: 'Example strollers recalled',
    description: 'An official description.',
    hazard: 'A safety hazard.',
    remedy: 'Stop use and contact the manufacturer.',
    recall_date: '2026-08-20',
    raw_payload: { z: 2, nested: { b: true, a: 'stable' }, a: 1 },
    scopes: [
      {
        scope_id: 'scope-row-id',
        created_at: '2026-09-14T09:30:00.000Z',
        brand: 'Thule',
        product_name: 'Sleek stroller',
        gtin: '091021037090',
        model_number: null,
        serial_number: null,
        lot_number: null,
        serial_from: null,
        serial_to: null,
        lot_from: null,
        lot_to: null,
        manufactured_from: null,
        manufactured_to: null,
        additional_criteria: { evidence_level: 'product' },
      },
    ],
    ...overrides,
  };
}

function productRow(overrides = {}) {
  return {
    owned_product_id: 'product-row-id',
    user_id: 'private-user-id',
    updated_at: '2026-09-14T09:30:00.000Z',
    product_name: 'Sleek stroller',
    brand: 'Thule',
    category: 'Stroller',
    gtin: '091021037090',
    model_number: null,
    serial_number: null,
    lot_number: null,
    purchase_date: '2026-01-15',
    identification_method: 'barcode',
    exact_rank: 4,
    ...overrides,
  };
}

function ambiguousProductRow(overrides = {}) {
  return productRow({ gtin: null, model_number: 'ST6', ...overrides });
}

function ambiguousRecallRow(overrides = {}) {
  return recallRow({
    source_external_id: 'ambiguous',
    title: 'Studio Six Headphone Amplifiers recalled',
    scopes: [
      {
        brand: 'AudioLineOut',
        product_name: 'Studio Six Headphone Amplifiers',
        gtin: null,
        model_number: null,
        serial_number: null,
        lot_number: null,
        serial_from: null,
        serial_to: null,
        lot_from: null,
        lot_to: null,
        manufactured_from: null,
        manufactured_to: null,
        additional_criteria: { manufacturer_names: ['AudioLineOut'] },
      },
    ],
    ...overrides,
  });
}

function guardedAttempt(overrides = {}) {
  return {
    output: {
      decision: 'needs_review',
      confidence: 0.4,
      matchedIdentifiers: { gtin: [], modelNumber: [], serialNumber: [], lotNumber: [] },
      conflictingIdentifiers: { gtin: [], modelNumber: [], serialNumber: [], lotNumber: [] },
      evidenceUsed: [],
      reasoningSummary: 'The normalized authoritative evidence remains ambiguous.',
      evidenceClaims: [],
    },
    structuredOutputValid: true,
    apiSucceeded: true,
    failureKind: null,
    retryEligible: false,
    transportRetries: 0,
    latencyMs: 5,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: null },
    ...overrides,
  };
}

function createStore({ recalls = [recallRow()], products = [productRow()], claims = [] } = {}) {
  const finalized = [];
  const claimInputs = [];
  return {
    finalized,
    claimInputs,
    async listAuthoritativeRecalls({ afterRecallId, limit }) {
      assert.ok(limit > 0);
      return afterRecallId ? [] : recalls;
    },
    async listRecallCandidateProducts({ recallNoticeId, afterProductId, limit }) {
      assert.equal(recallNoticeId, recalls[0].recall_notice_id);
      assert.ok(limit > 0);
      return afterProductId ? [] : products;
    },
    async claimPair(input) {
      claimInputs.push(input);
      return claims.shift() ?? { status: 'claimed', leaseToken: `lease-${claimInputs.length}` };
    },
    async finalizePair(input) {
      finalized.push(input);
      return { alertOutcome: input.status === 'confirmed' ? 'created' : 'none' };
    },
  };
}

test('production projection uses normalized authoritative evidence and never raw AI evidence', () => {
  const owned = projectOwnedProduct(productRow());
  const recall = projectAuthoritativeRecall(recallRow());

  assert.deepEqual(owned, {
    productName: 'Sleek stroller',
    brand: 'Thule',
    category: 'Stroller',
    gtin: '091021037090',
    modelNumber: null,
    serialNumber: null,
    lotNumber: null,
    purchaseDate: '2026-01-15',
    identificationMethod: 'barcode',
  });
  assert.equal(recall.rawEvidence, null);
  assert.equal('scopeId' in recall.scopes[0], false);
  assert.equal('retrievedAt' in recall.source, false);
  assert.equal(JSON.stringify(recall).includes('scope-row-id'), false);
  assert.throws(
    () => projectAuthoritativeRecall(recallRow({ source_is_authoritative: false })),
    /authoritative/u,
  );
});

test('production candidate projection confirms an exact GTIN from a real CPSC normalized record', async () => {
  const fixtureUrl = new URL(
    '../supabase/functions/_shared/cpsc/fixtures/cpsc-real-records.json',
    import.meta.url,
  );
  const records = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const mapped = mapCpscRecall(records.find((record) => record.RecallID === 8877));
  const row = recallRow({
    source_external_id: mapped.externalId,
    source_official_url: mapped.officialUrl,
    title: mapped.title,
    description: mapped.description,
    hazard: mapped.hazard,
    remedy: mapped.remedy,
    recall_date: mapped.recallDate,
    raw_payload: mapped.rawPayload,
    scopes: mapped.scopes.map((scope) => ({
      brand: null,
      product_name: scope.productName,
      gtin: scope.gtin,
      model_number: scope.modelNumber,
      serial_from: null,
      serial_to: null,
      lot_from: null,
      lot_to: null,
      manufactured_from: null,
      manufactured_to: null,
      additional_criteria: scope.additionalCriteria,
    })),
  });
  const product = projectOwnedProduct(
    productRow({ product_name: 'Thule Sleek stroller', gtin: '091021037090' }),
  );
  const recall = projectAuthoritativeRecall(row);

  assert.equal(retrieveRecallCandidates(product, [recall]).length, 1);
  assert.equal(evaluateDeterministicMatch(product, recall).decision, 'confirmed');
  assert.equal(recall.rawEvidence, null);
});

test('fingerprints ignore storage metadata/order while product and recall changes force reevaluation', async () => {
  const row = recallRow({
    scopes: [
      recallRow().scopes[0],
      {
        ...recallRow().scopes[0],
        scope_id: 'second-id',
        product_name: 'Another product',
        gtin: null,
        model_number: 'MODEL-2',
      },
    ],
  });
  const first = await buildEvidenceFingerprint({
    ownedProduct: projectOwnedProduct(productRow()),
    officialRecall: projectAuthoritativeRecall(row),
    rawPayload: row.raw_payload,
    modelId: MODEL_ID,
  });
  const reordered = {
    ...row,
    recall_notice_id: 'different-db-id',
    retrieved_at: '2030-01-01T00:00:00.000Z',
    raw_payload: { a: 1, nested: { a: 'stable', b: true }, z: 2 },
    scopes: [
      { ...row.scopes[1], scope_id: 'changed-second-id', created_at: '2030-01-01' },
      { ...row.scopes[0], scope_id: 'changed-first-id', created_at: '2030-01-01' },
    ],
  };
  const second = await buildEvidenceFingerprint({
    ownedProduct: projectOwnedProduct({
      ...productRow(),
      owned_product_id: 'different-product-id',
      user_id: 'different-user-id',
      updated_at: '2030-01-01',
    }),
    officialRecall: projectAuthoritativeRecall(reordered),
    rawPayload: reordered.raw_payload,
    modelId: MODEL_ID,
  });
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(PRODUCTION_MATCHING_POLICY_VERSION.length > 0, true);

  const changedProduct = await buildEvidenceFingerprint({
    ownedProduct: projectOwnedProduct(productRow({ lot_number: 'CHANGED' })),
    officialRecall: projectAuthoritativeRecall(row),
    rawPayload: row.raw_payload,
    modelId: MODEL_ID,
  });
  const changedRecall = await buildEvidenceFingerprint({
    ownedProduct: projectOwnedProduct(productRow()),
    officialRecall: projectAuthoritativeRecall(row),
    rawPayload: { ...row.raw_payload, authoritative_change: true },
    modelId: MODEL_ID,
  });
  assert.notEqual(first, changedProduct);
  assert.notEqual(first, changedRecall);
});

test('request limits have conservative defaults and reject values beyond hard caps', () => {
  assert.deepEqual(parseMatchingRunRequest({}), {
    ...DEFAULT_MATCHING_LIMITS,
    afterRecallId: null,
    recallNoticeIds: null,
  });
  assert.deepEqual(parseMatchingRunRequest(MAX_MATCHING_LIMITS), {
    ...MAX_MATCHING_LIMITS,
    afterRecallId: null,
    recallNoticeIds: null,
  });
  assert.throws(
    () => parseMatchingRunRequest({ maxNebiusCalls: MAX_MATCHING_LIMITS.maxNebiusCalls + 1 }),
    /maxNebiusCalls/u,
  );
  assert.throws(() => parseMatchingRunRequest({ maxRecalls: 1.5 }), /maxRecalls/u);
  assert.throws(() => parseMatchingRunRequest([]), /JSON object/u);
  assert.throws(() => parseMatchingRunRequest({ recallNoticeIds: [] }), /recallNoticeIds/u);
});

test('request supports a bounded targeted recall selection for controlled runs', () => {
  const recallNoticeId = '10000000-0000-4000-8000-000000000001';
  const parsed = parseMatchingRunRequest({
    maxRecalls: 1,
    maxCandidatePairs: 5,
    maxNebiusCalls: 0,
    recallNoticeIds: [recallNoticeId, recallNoticeId],
  });

  assert.deepEqual(parsed.recallNoticeIds, [recallNoticeId]);
  assert.equal(parsed.maxNebiusCalls, 0);
});

test('deterministic confirmation persists without initializing or calling Nebius', async () => {
  const store = createStore();
  let initialized = 0;
  const summary = await processRecallMatches(DEFAULT_MATCHING_LIMITS, {
    store,
    createNemotronEvaluator() {
      initialized += 1;
      throw new Error('must not initialize');
    },
    modelId: MODEL_ID,
    now: () => 10,
    logger: { info() {}, error() {} },
  });

  assert.equal(initialized, 0);
  assert.equal(store.finalized.length, 1);
  assert.equal(store.finalized[0].status, 'confirmed');
  assert.equal(store.finalized[0].matchMethod, 'deterministic_v1');
  assert.equal(store.finalized[0].aiProvider, null);
  assert.equal(store.finalized[0].aiModel, null);
  assert.equal(summary.confirmed, 1);
  assert.equal(summary.alertsCreated, 1);
  assert.equal(summary.nemotronEscalated, 0);
});

test('deterministic rejection persists without an alert or Nebius', async () => {
  const recall = recallRow({
    title: 'Different recalled product',
    scopes: [
      {
        ...recallRow().scopes[0],
        product_name: 'Different recalled product',
        gtin: '843461115513',
        additional_criteria: { manufacturer_names: ['Thule'] },
      },
    ],
  });
  const store = createStore({ recalls: [recall] });
  const summary = await processRecallMatches(DEFAULT_MATCHING_LIMITS, {
    store,
    createNemotronEvaluator: () => {
      throw new Error('must not initialize');
    },
    modelId: MODEL_ID,
  });
  assert.equal(store.finalized[0].status, 'rejected');
  assert.equal(summary.rejected, 1);
  assert.equal(summary.alertsCreated, 0);
});

test('deterministic abstention lazily escalates and passes normalized scopes with rawEvidence null', async () => {
  const recalls = [ambiguousRecallRow()];
  const products = [
    ambiguousProductRow({ product_name: 'Studio Six Headphone Amplifier', brand: 'AudioLineOut' }),
  ];
  const store = createStore({ recalls, products });
  let input;
  let initialized = 0;
  const summary = await processRecallMatches(DEFAULT_MATCHING_LIMITS, {
    store,
    modelId: MODEL_ID,
    createNemotronEvaluator() {
      initialized += 1;
      return async (value) => {
        input = value;
        return guardedAttempt();
      };
    },
  });

  assert.equal(initialized, 1);
  assert.equal(summary.nemotronEscalated, 1);
  assert.equal(store.finalized[0].status, 'needs_review');
  assert.equal(store.finalized[0].matchMethod, 'hybrid_guarded_v1');
  assert.equal(input.officialRecall.rawEvidence, null);
  assert.equal(JSON.stringify(input).includes('raw_payload'), false);
});

test('provider unavailability fails one ambiguous pair safely and deterministic pairs continue', async () => {
  const recalls = [
    ambiguousRecallRow({
      scopes: [{ ...ambiguousRecallRow().scopes[0], gtin: '091021037090' }],
    }),
  ];
  const products = [
    ambiguousProductRow({
      owned_product_id: 'ambiguous-product',
      product_name: 'Studio Six Headphone Amplifier',
      brand: 'AudioLineOut',
    }),
    productRow({
      owned_product_id: 'deterministic-product',
      product_name: 'Studio Six Headphone Amplifiers',
      brand: 'AudioLineOut',
      gtin: '091021037090',
      model_number: null,
    }),
  ];
  const store = createStore({ recalls, products });
  const summary = await processRecallMatches(DEFAULT_MATCHING_LIMITS, {
    store,
    modelId: MODEL_ID,
    createNemotronEvaluator() {
      throw new Error('Required Nebius server configuration is unavailable.');
    },
  });
  assert.equal(summary.failures, 1);
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.confirmed, 1);
  assert.equal(summary.deterministicResolved, 1);
  assert.equal(store.finalized[0].status, 'needs_review');
  assert.equal(store.finalized[0].aiProvider, null);
  assert.equal(store.finalized[1].status, 'confirmed');
});

test('permanent provider authorization failure is not repeated across ambiguous pairs', async () => {
  const recalls = [ambiguousRecallRow()];
  const products = [
    ambiguousProductRow({
      owned_product_id: 'ambiguous-one',
      product_name: 'Studio Six Headphone Amplifier',
    }),
    ambiguousProductRow({
      owned_product_id: 'ambiguous-two',
      product_name: 'Studio Six Headphone Amplifier',
    }),
  ];
  const store = createStore({ recalls, products });
  let calls = 0;
  const summary = await processRecallMatches(DEFAULT_MATCHING_LIMITS, {
    store,
    modelId: MODEL_ID,
    createNemotronEvaluator: () => async () => {
      calls += 1;
      return guardedAttempt({
        output: null,
        structuredOutputValid: false,
        apiSucceeded: false,
        failureKind: 'authorization',
      });
    },
  });

  assert.equal(calls, 1);
  assert.equal(summary.needsReview, 2);
  assert.equal(summary.providerFailures, 1);
  assert.equal(
    store.finalized.every((evaluation) => evaluation.status === 'needs_review'),
    true,
  );
});

test('unchanged and busy claims skip evaluation and persistence', async () => {
  const store = createStore({
    products: [productRow(), productRow({ owned_product_id: 'second-product' })],
    claims: [{ status: 'unchanged' }, { status: 'busy' }],
  });
  const summary = await processRecallMatches(DEFAULT_MATCHING_LIMITS, {
    store,
    modelId: MODEL_ID,
    createNemotronEvaluator: () => {
      throw new Error('must not initialize');
    },
  });
  assert.equal(store.finalized.length, 0);
  assert.equal(summary.unchangedSkipped, 1);
  assert.equal(summary.busySkipped, 1);
});

test('candidate and Nebius limits stop cleanly and orchestration retry remains one', async () => {
  const recalls = [ambiguousRecallRow()];
  const products = [
    ambiguousProductRow({
      owned_product_id: 'one',
      product_name: 'Studio Six Headphone Amplifier',
    }),
    ambiguousProductRow({
      owned_product_id: 'two',
      product_name: 'Studio Six Headphone Amplifier',
    }),
  ];
  const store = createStore({ recalls, products });
  let calls = 0;
  const summary = await processRecallMatches(
    { maxRecalls: 1, maxCandidatePairs: 2, maxNebiusCalls: 2 },
    {
      store,
      modelId: MODEL_ID,
      createNemotronEvaluator: () => async () => {
        calls += 1;
        return guardedAttempt({
          output: null,
          structuredOutputValid: false,
          apiSucceeded: false,
          failureKind: 'timeout',
          retryEligible: true,
        });
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(summary.nemotronEscalated, 1);
  assert.equal(summary.retries, 1);
  assert.equal(summary.needsReview, 2);
  assert.equal(store.finalized[1].matchMethod, 'deterministic_v1');
});

test('safe operational summaries and logs contain counts but no secrets or evidence', async () => {
  const secret = 'do-not-log-this-secret';
  const messages = [];
  const store = createStore();
  const summary = await processRecallMatches(DEFAULT_MATCHING_LIMITS, {
    store,
    modelId: MODEL_ID,
    createNemotronEvaluator: () => {
      throw new Error(secret);
    },
    logger: {
      info(event, value) {
        messages.push(JSON.stringify({ event, value }));
      },
      error(event, value) {
        messages.push(JSON.stringify({ event, value }));
      },
    },
  });
  const safe = safeMatchingSummary(summary);
  const serialized = JSON.stringify({ safe, messages });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('private-user-id'), false);
  assert.equal(serialized.includes('091021037090'), false);
  assert.deepEqual(Object.keys(safe).sort(), [
    'alertsCreated',
    'alertsExisting',
    'candidatePairs',
    'confirmed',
    'deterministicResolved',
    'duration',
    'failures',
    'needsReview',
    'nemotronEscalated',
    'recallsProcessed',
    'rejected',
    'retries',
  ]);
});
