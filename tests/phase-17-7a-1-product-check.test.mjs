// Phase 17.7a-1: safe confirmation gate and targeted product-check orchestrator.
// The orchestrator runs on the unchanged deterministic_v2 library with real
// reviewed rule-set envelopes (validated by validateLiveRuleSetEnvelopeV2); the
// store is an in-memory fake of the existing RPC surface.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assessAutomaticConfirmationEligibility,
  assessJurisdiction,
  SUPPORTED_CRITERION_KINDS,
} from '../supabase/functions/_shared/productCheck/gate.ts';
import { runOwnedProductCheck } from '../supabase/functions/_shared/productCheck/orchestrator.ts';
import {
  parseCheckOwnedProductRequest,
  parseWorkerRequest,
} from '../supabase/functions/_shared/productCheck/handler.ts';
import { computeRuleSetFingerprintV2 } from '../supabase/functions/_shared/recallMatching/ruleSetsV2.ts';

const CPSC = 'U.S. Consumer Product Safety Commission (CPSC)';
const URL_8877 = 'https://www.cpsc.gov/Recalls/2020/Thule-Recalls-Strollers-Due-to-Injury-Hazard';
const GTIN = '091021037090';
const HEX = (c) => c.repeat(64);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOTICE = uuid(100);
const SCOPE = uuid(200);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function product(overrides = {}) {
  return {
    owned_product_id: uuid(1),
    owned_product_updated_at: '2026-10-02T10:00:00.000001+00:00',
    user_id: uuid(9001),
    product_name: 'Thule Sleek stroller',
    brand: 'Thule',
    category: null,
    gtin: GTIN,
    model_number: '11000017',
    serial_number: null,
    lot_number: null,
    identification_method: 'barcode_scan',
    safety_attributes: { date_code: '1805' },
    ...overrides,
  };
}

function recall(overrides = {}) {
  return {
    recall_notice_id: NOTICE,
    recall_notice_updated_at: '2026-10-01T00:00:00.000001+00:00',
    source_authority: CPSC,
    source_external_id: '8877',
    source_official_url: URL_8877,
    source_is_authoritative: true,
    title: 'Thule Recalls Strollers Due to Injury Hazard',
    description: null,
    hazard: null,
    remedy: null,
    recall_date: '2020-08-12',
    raw_payload: {},
    scopes: [],
    jurisdictions: [{ type: 'country', code: 'US' }],
    exact_rank: 4,
    ...overrides,
  };
}

function scopeRow(reviewed, overrides = {}) {
  return {
    scope_id: SCOPE,
    brand: null,
    product_name: null,
    gtin: GTIN,
    model_number: null,
    lot_from: null,
    lot_to: null,
    serial_from: null,
    serial_to: null,
    manufactured_from: null,
    manufactured_to: null,
    additional_criteria: { association: 'recall-level', evidence_level: 'recall' },
    reviewed_criteria: reviewed,
    ...overrides,
  };
}

const provenance = { authority: 'CPSC', officialUrl: URL_8877, normalizationRule: 'identifier_v2' };

/** A human-reviewed all_of rule set exactly as the database builder serves it. */
async function ruleSet(criteria, { scopeId = SCOPE } = {}) {
  const candidateIds = criteria.map((_, index) => uuid(300 + index));
  const set = {
    semantics: 'all_of',
    criteria: criteria.map((criterion, index) => ({
      id: `cpsc-ledger-${candidateIds[index]}`,
      required: true,
      provenance: { ...provenance, sourceField: `cpsc-page:table:1:${index}` },
      ...criterion,
    })),
    review: {
      origin: 'human_review_ledger',
      schema: 'recall_rule_set_v1',
      revisionId: uuid(400),
      sourceRevisionHash: HEX('a'),
      conjunctionGroup: 'g1',
      scopeId,
      scopeFingerprint: HEX('b'),
      candidateIds,
      reviewEventIds: criteria.map((_, index) => uuid(500 + index)),
      reviewerIds: criteria.map((_, index) => uuid(600 + index)),
      reviewedAt: '2026-10-01T00:00:00Z',
      identityFingerprint: HEX('c'),
      scopeSemanticFingerprint: HEX('d'),
      sourceAddressHashes: criteria.map((_, index) => HEX(String(index + 1))),
      ruleSetFingerprint: HEX('0'),
    },
  };
  set.review.ruleSetFingerprint = await computeRuleSetFingerprintV2(set);
  return set;
}

const completeCoverage = {
  currentRevisionId: uuid(400),
  proposedRuleSets: 1,
  unattributedRuleSets: 0,
  servedRuleSets: 1,
  complete: true,
  sourceCoverage: {
    state: 'recorded',
    coverageStatus: 'complete',
    positiveStatus: 'independent',
    negativeEvidenceEligible: true,
  },
};

function envelope(sets, coverage = completeCoverage) {
  return {
    semantics: 'any_of',
    schema: 'recall_rule_sets_v1',
    scopeId: SCOPE,
    ruleSets: sets,
    coverage: { ...coverage, servedRuleSets: sets.length, proposedRuleSets: sets.length },
  };
}

const MODEL = { kind: 'model_number', operator: 'equals', value: '11000017' };
const DATE_CODES = {
  kind: 'date_code',
  operator: 'one_of',
  values: ['1805', '1806', '1807', '1808', '1809', '1810', '1811', '1812', '1901', '1909'],
};

function fakeStore({ products, recalls, scopes, claimPairQueue = [] }) {
  const evaluations = new Map();
  const alerts = new Set();
  const calls = { claimPair: [], finalize: [], alerts: [], listed: [] };
  return {
    calls,
    evaluations,
    async getProductEvidence(id) {
      return products.find((row) => row.owned_product_id === id) ?? null;
    },
    async listCandidateRecalls({ productId, after, limit }) {
      calls.listed.push({ productId, after, limit });
      return [...recalls]
        .sort(
          (a, b) =>
            b.exact_rank - a.exact_rank || a.recall_notice_id.localeCompare(b.recall_notice_id),
        )
        .filter(
          (row) =>
            !after ||
            row.exact_rank < after.rank ||
            (row.exact_rank === after.rank && row.recall_notice_id > after.recallId),
        )
        .slice(0, limit);
    },
    async getReviewedScopes(id) {
      return scopes[id] ?? [];
    },
    async claimPair(input) {
      calls.claimPair.push(input);
      return claimPairQueue.shift() ?? { status: 'claimed', leaseToken: 'pair-lease' };
    },
    async finalizeV2(input) {
      calls.finalize.push(input);
      const key = `${input.ownedProductId}|${input.recallNoticeId}|${input.evidenceFingerprint}`;
      if (evaluations.has(key)) return { status: 'unchanged', alertEligibility: 'none' };
      evaluations.set(key, input.status);
      return {
        status: 'finalized',
        alertEligibility: input.status === 'confirmed' ? 'created' : 'none',
      };
    },
    async createAlert(productId, recallId) {
      calls.alerts.push([productId, recallId]);
      const key = `${productId}|${recallId}`;
      if (alerts.has(key)) return 'existing';
      alerts.add(key);
      return 'created';
    },
  };
}

function claimFor(row, overrides = {}) {
  return {
    ownedProductId: row.owned_product_id,
    leaseToken: 'job-lease',
    matchingRevision: 1,
    productUpdatedAt: row.owned_product_updated_at,
    purchaseCountryCode: 'US',
    cursor: null,
    maxCandidates: 25,
    ...overrides,
  };
}

const run = (claim, store, deadline = Date.now() + 10_000) =>
  runOwnedProductCheck(claim, store, { deadline });

async function scenario({
  productOverrides = {},
  sets,
  coverage,
  claimOverrides = {},
  recallOverrides = {},
  scopeOverrides = {},
}) {
  const row = product(productOverrides);
  const reviewed = sets === undefined ? null : envelope(await Promise.all(sets), coverage);
  const store = fakeStore({
    products: [row],
    recalls: [recall(recallOverrides)],
    scopes: { [NOTICE]: [scopeRow(reviewed, scopeOverrides)] },
  });
  const result = await run(claimFor(row, claimOverrides), store);
  return { row, store, result };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------
test('gate: jurisdiction rule (structured rows only)', () => {
  const us = [{ type: 'country', code: 'US' }];
  assert.equal(assessJurisdiction('US', us), 'compatible');
  assert.equal(assessJurisdiction('CA', us), 'jurisdiction_mismatch');
  assert.equal(assessJurisdiction(null, us), 'incomplete_evidence');
  assert.equal(assessJurisdiction(null, [{ type: 'global', code: 'GLOBAL' }]), 'compatible');
  assert.equal(assessJurisdiction('FR', [{ type: 'region', code: 'EU' }]), 'human_review_required');
  assert.equal(assessJurisdiction('US', []), 'unsupported_scope');
  assert.equal(
    assessJurisdiction('US', [{ type: 'country', code: 'usa' }]),
    'human_review_required',
  );
  assert.equal(assessJurisdiction('usa', us), 'human_review_required');
});

test('gate: never wider than the live v2 allowlist', () => {
  assert.deepEqual([...SUPPORTED_CRITERION_KINDS].sort(), ['date_code', 'model_number']);
});

test('gate: eligibility requires proven, complete, supported, unambiguous rule sets', () => {
  const ok = (overrides = {}) => ({
    ruleSets: [
      {
        semantics: 'all_of',
        criteria: [{ kind: 'model_number', required: true }],
      },
    ],
    coverageComplete: true,
    droppedRuleSets: 0,
    ...overrides,
  });
  const base = {
    sourceIsAuthoritative: true,
    purchaseCountryCode: 'US',
    noticeJurisdictions: [{ type: 'country', code: 'US' }],
  };
  const gate = (scopes, extra = {}) =>
    assessAutomaticConfirmationEligibility({ ...base, scopes, ...extra });
  assert.equal(gate([{ kind: 'validated', value: ok() }]), 'eligible');
  assert.equal(
    gate([{ kind: 'validated', value: ok() }], { sourceIsAuthoritative: false }),
    'unsupported_scope',
  );
  assert.equal(gate([]), 'unsupported_scope');
  assert.equal(gate([{ kind: 'absent' }]), 'unsupported_scope');
  assert.equal(gate([{ kind: 'validated', value: ok() }, { kind: 'absent' }]), 'unsupported_scope');
  assert.equal(gate([{ kind: 'invalid' }]), 'human_review_required');
  assert.equal(gate([{ kind: 'validated', value: ok({ ruleSets: [] }) }]), 'unsupported_scope');
  assert.equal(
    gate([{ kind: 'validated', value: ok({ coverageComplete: false }) }]),
    'unsupported_scope',
  );
  assert.equal(
    gate([{ kind: 'validated', value: ok({ droppedRuleSets: 1 }) }]),
    'human_review_required',
  );
  assert.equal(
    gate([
      {
        kind: 'validated',
        value: ok({ ruleSets: [{ semantics: 'ambiguous', criteria: [] }] }),
      },
    ]),
    'human_review_required',
  );
  for (const kind of ['gtin', 'lot_number', 'manufacture_date', 'serial_number']) {
    assert.equal(
      gate([
        {
          kind: 'validated',
          value: ok({ ruleSets: [{ semantics: 'all_of', criteria: [{ kind, required: true }] }] }),
        },
      ]),
      'unsupported_scope',
      kind,
    );
  }
  // Jurisdiction is decided before completeness.
  assert.equal(gate([{ kind: 'absent' }], { purchaseCountryCode: 'CA' }), 'jurisdiction_mismatch');
});

// ---------------------------------------------------------------------------
// Matching scenarios
// ---------------------------------------------------------------------------
test('an old recall already in the database is found and evaluated for a new product', async () => {
  const { store, result } = await scenario({ sets: [ruleSet([MODEL, DATE_CODES])] });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.counters.candidates, 1);
  assert.equal(store.calls.finalize.length, 1);
});

test('GTIN candidate without reviewed criteria: possible match, no alert (8877 today)', async () => {
  const { store, result } = await scenario({ sets: undefined });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.counters.possibleMatches, 1);
  assert.deepEqual(result.counters.gate, { unsupported_scope: 1 });
  assert.equal(store.calls.finalize[0].status, 'needs_review');
  assert.equal(store.calls.finalize[0].confidence, 0);
  assert.deepEqual(store.calls.finalize[0].matchedIdentifiers, { gtin: [GTIN] });
  assert.match(store.calls.finalize[0].reasoningSummary, /withheld \(unsupported_scope\)/u);
  assert.equal(store.calls.alerts.length, 0);
});

test('GTIN candidate + complete supported reviewed rules (model + date code): confirmed and one alert', async () => {
  const { row, store, result } = await scenario({ sets: [ruleSet([MODEL, DATE_CODES])] });
  assert.equal(result.counters.confirmed, 1);
  assert.equal(result.counters.alertsCreated, 1);
  assert.deepEqual(result.counters.gate, { eligible: 1 });
  assert.equal(store.calls.finalize[0].status, 'confirmed');
  assert.deepEqual(store.calls.alerts, [[row.owned_product_id, NOTICE]]);
});

test('a contradicted supported criterion (wrong date code) is rejected, no alert', async () => {
  const { store, result } = await scenario({
    productOverrides: { safety_attributes: { date_code: '1701' } },
    sets: [ruleSet([MODEL, DATE_CODES])],
  });
  assert.equal(result.counters.rejected, 1);
  assert.equal(store.calls.finalize[0].status, 'rejected');
  assert.equal(store.calls.alerts.length, 0);
});

test('a date code outside the reviewed list is rejected, no alert', async () => {
  const { store } = await scenario({
    productOverrides: { safety_attributes: { date_code: '2001' } },
    sets: [ruleSet([MODEL, DATE_CODES])],
  });
  assert.equal(store.calls.finalize[0].status, 'rejected');
  assert.equal(store.calls.alerts.length, 0);
});

test('a missing required value (no date code captured) needs verification, no alert', async () => {
  const { store, result } = await scenario({
    productOverrides: { safety_attributes: {} },
    sets: [ruleSet([MODEL, DATE_CODES])],
  });
  assert.equal(result.counters.possibleMatches, 1);
  assert.equal(store.calls.finalize[0].status, 'needs_review');
  assert.match(store.calls.finalize[0].reasoningSummary, /incomplete_evidence/u);
  assert.equal(store.calls.alerts.length, 0);
});

test('a lot or manufacture-date rule set is outside the allowlist: never confirmed or rejected', async () => {
  for (const criterion of [
    { kind: 'lot_number', operator: 'equals', value: '1500' },
    {
      kind: 'manufacture_date',
      operator: 'date_range',
      range: { from: '2018-05-01', to: '2019-09-30' },
    },
  ]) {
    const { store, result } = await scenario({
      productOverrides: { lot_number: '2500' },
      sets: [ruleSet([MODEL, criterion])],
    });
    assert.equal(store.calls.finalize[0].status, 'needs_review', criterion.kind);
    // The live validator drops the rule set (kind outside the allowlist): unsupported scope.
    assert.deepEqual(result.counters.gate, { unsupported_scope: 1 }, criterion.kind);
    assert.equal(store.calls.alerts.length, 0, criterion.kind);
  }
});

test('incomplete authoritative coverage: possible match even when every reviewed criterion matches', async () => {
  const { store, result } = await scenario({
    sets: [ruleSet([MODEL, DATE_CODES])],
    coverage: { ...completeCoverage, complete: false },
  });
  assert.deepEqual(result.counters.gate, { unsupported_scope: 1 });
  assert.equal(store.calls.finalize[0].status, 'needs_review');
  assert.equal(store.calls.alerts.length, 0);
});

test('incompatible jurisdiction never alerts, even with complete matching rules', async () => {
  const { store, result } = await scenario({
    sets: [ruleSet([MODEL, DATE_CODES])],
    claimOverrides: { purchaseCountryCode: 'CA' },
  });
  assert.deepEqual(result.counters.gate, { jurisdiction_mismatch: 1 });
  assert.equal(store.calls.finalize[0].status, 'needs_review');
  assert.equal(store.calls.alerts.length, 0);
});

test('unknown purchase country needs verification unless the notice is explicitly GLOBAL', async () => {
  const unknown = await scenario({
    sets: [ruleSet([MODEL, DATE_CODES])],
    claimOverrides: { purchaseCountryCode: null },
  });
  assert.deepEqual(unknown.result.counters.gate, { incomplete_evidence: 1 });
  assert.equal(unknown.store.calls.alerts.length, 0);
  const global = await scenario({
    sets: [ruleSet([MODEL, DATE_CODES])],
    claimOverrides: { purchaseCountryCode: null },
    recallOverrides: { jurisdictions: [{ type: 'global', code: 'GLOBAL' }] },
  });
  assert.equal(global.result.counters.confirmed, 1);
});

test('a weak name-only candidate that is not eligible is ignored (nothing persisted)', async () => {
  const { store, result } = await scenario({
    productOverrides: { gtin: null, model_number: null },
    sets: undefined,
    scopeOverrides: { gtin: null, product_name: 'Thule Sleek strollers' },
  });
  assert.equal(result.counters.ignored, 1);
  assert.equal(store.calls.claimPair.length, 0);
  assert.equal(store.calls.finalize.length, 0);
});

test('two users with the same GTIN: each check touches only its own product', async () => {
  const a = product();
  const b = product({ owned_product_id: uuid(2), user_id: uuid(9002) });
  const reviewed = envelope([await ruleSet([MODEL, DATE_CODES])]);
  const store = fakeStore({
    products: [a, b],
    recalls: [recall()],
    scopes: { [NOTICE]: [scopeRow(reviewed)] },
  });
  await run(claimFor(a), store);
  assert.deepEqual(
    [...new Set(store.calls.finalize.map((call) => call.ownedProductId))],
    [a.owned_product_id],
  );
  assert.deepEqual(store.calls.alerts, [[a.owned_product_id, NOTICE]]);
});

test('two products of the same user keep separate results', async () => {
  const first = product();
  const second = product({ owned_product_id: uuid(3), safety_attributes: {} });
  const reviewed = envelope([await ruleSet([MODEL, DATE_CODES])]);
  const store = fakeStore({
    products: [first, second],
    recalls: [recall()],
    scopes: { [NOTICE]: [scopeRow(reviewed)] },
  });
  const one = await run(claimFor(first), store);
  const two = await run(claimFor(second), store);
  assert.equal(one.counters.confirmed, 1);
  assert.equal(two.counters.possibleMatches, 1);
  assert.deepEqual(store.calls.alerts, [[first.owned_product_id, NOTICE]]);
});

test('double execution creates no duplicate alert', async () => {
  const row = product();
  const reviewed = envelope([await ruleSet([MODEL, DATE_CODES])]);
  const store = fakeStore({
    products: [row],
    recalls: [recall()],
    scopes: { [NOTICE]: [scopeRow(reviewed)] },
  });
  const first = await run(claimFor(row), store);
  const second = await run(claimFor(row), store);
  assert.equal(first.counters.alertsCreated, 1);
  assert.equal(second.counters.alertsCreated, 0);
  assert.equal(
    store.calls.finalize[0].evidenceFingerprint,
    store.calls.finalize[1].evidenceFingerprint,
  );
  assert.equal(store.evaluations.size, 1);
});

test('the fingerprint changes with the gate inputs (purchase country)', async () => {
  const us = await scenario({ sets: [ruleSet([MODEL, DATE_CODES])] });
  const ca = await scenario({
    sets: [ruleSet([MODEL, DATE_CODES])],
    claimOverrides: { purchaseCountryCode: 'CA' },
  });
  assert.notEqual(
    us.store.calls.finalize[0].evidenceFingerprint,
    ca.store.calls.finalize[0].evidenceFingerprint,
  );
});

// ---------------------------------------------------------------------------
// Fail closed, bounds, resume
// ---------------------------------------------------------------------------
async function multiRecallStore(count, claimPairQueue = []) {
  const row = product();
  const recalls = Array.from({ length: count }, (_, index) =>
    recall({ recall_notice_id: uuid(1000 + index) }),
  );
  const scopes = Object.fromEntries(
    recalls.map((item) => [item.recall_notice_id, [scopeRow(null)]]),
  );
  return { row, store: fakeStore({ products: [row], recalls, scopes, claimPairQueue }) };
}

test('a busy pair stops the run before the cursor passes it; the next attempt resumes there', async () => {
  const { row, store } = await multiRecallStore(3, [
    { status: 'claimed', leaseToken: 'l1' },
    { status: 'busy' },
  ]);
  const first = await run(claimFor(row), store);
  assert.deepEqual(first.outcome, 'retry');
  assert.equal(first.error, 'busy');
  assert.equal(store.calls.finalize.length, 1);
  const resumed = await run(claimFor(row, { cursor: { rank: 4, recallId: uuid(1000) } }), store);
  assert.equal(resumed.outcome, 'complete');
  assert.deepEqual(
    store.calls.claimPair.slice(2).map((call) => call.recallNoticeId),
    [uuid(1001), uuid(1002)],
  );
});

test('a store failure fails closed (retry), nothing is decided for that pair', async () => {
  const { row, store } = await multiRecallStore(1);
  store.finalizeV2 = async () => {
    throw new Error('database unavailable');
  };
  const result = await run(claimFor(row), store);
  assert.deepEqual([result.outcome, result.error], ['retry', 'failure']);
  assert.equal(store.calls.alerts.length, 0);
});

test('the candidate budget is bounded and progress continues from a cursor', async () => {
  const { row, store } = await multiRecallStore(5);
  const first = await run(claimFor(row, { maxCandidates: 2 }), store);
  assert.equal(first.outcome, 'continue');
  assert.deepEqual(first.cursor, { rank: 4, recallId: uuid(1001) });
  assert.equal(first.counters.candidates, 2);
  const next = await run(claimFor(row, { maxCandidates: 2, cursor: first.cursor }), store);
  assert.deepEqual(next.cursor, { rank: 4, recallId: uuid(1003) });
  const last = await run(claimFor(row, { maxCandidates: 2, cursor: next.cursor }), store);
  assert.equal(last.outcome, 'complete');
  assert.equal(new Set(store.calls.finalize.map((call) => call.recallNoticeId)).size, 5);
});

test('the time budget is bounded (timeout before any progress is a retry)', async () => {
  const { row, store } = await multiRecallStore(2);
  const result = await runOwnedProductCheck(claimFor(row), store, { deadline: 0 });
  assert.deepEqual([result.outcome, result.error], ['retry', 'timeout']);
  assert.equal(store.calls.finalize.length, 0);
});

test('a product edited after the claim is not evaluated (product_changed)', async () => {
  const { row, store } = await multiRecallStore(1);
  const result = await run(claimFor(row, { productUpdatedAt: '2020-01-01T00:00:00Z' }), store);
  assert.deepEqual([result.outcome, result.error], ['retry', 'product_changed']);
  assert.equal(store.calls.claimPair.length, 0);
});

test('a deleted product completes without any write', async () => {
  const { row, store } = await multiRecallStore(1);
  store.getProductEvidence = async () => null;
  const result = await run(claimFor(row), store);
  assert.equal(result.outcome, 'complete');
  assert.equal(store.calls.listed.length, 0);
});

// ---------------------------------------------------------------------------
// Request parsing (no user id, list, or bound from the body)
// ---------------------------------------------------------------------------
test('user request: exactly one owned product id', () => {
  assert.deepEqual(parseCheckOwnedProductRequest({ ownedProductId: uuid(1).toUpperCase() }), {
    ownedProductId: uuid(1),
  });
  for (const body of [
    null,
    [],
    {},
    { ownedProductId: 'nope' },
    { ownedProductId: uuid(1), userId: uuid(2) },
    { ownedProductIds: [uuid(1)] },
    { ownedProductId: [uuid(1)] },
  ]) {
    assert.throws(() => parseCheckOwnedProductRequest(body), JSON.stringify(body));
  }
});

test('worker request: bounded batch only', () => {
  assert.deepEqual(parseWorkerRequest({}), { maxProducts: 5 });
  assert.deepEqual(parseWorkerRequest({ maxProducts: 25 }), { maxProducts: 25 });
  for (const body of [
    { maxProducts: 0 },
    { maxProducts: 26 },
    { maxProducts: 1.5 },
    { all: true },
  ]) {
    assert.throws(() => parseWorkerRequest(body), JSON.stringify(body));
  }
});

// ---------------------------------------------------------------------------
// No AI, no v1 fallback, unchanged libraries
// ---------------------------------------------------------------------------
const productCheckSources = [
  'supabase/functions/_shared/productCheck/gate.ts',
  'supabase/functions/_shared/productCheck/orchestrator.ts',
  'supabase/functions/_shared/productCheck/handler.ts',
  'supabase/functions/_shared/productCheck/supabaseStore.ts',
  'supabase/functions/_shared/productCheck/server.ts',
  'supabase/functions/check-owned-product/index.ts',
  'supabase/functions/process-owned-product-checks/index.ts',
];

test('the product-check path imports no AI provider and no v1 matcher or orchestrator', async () => {
  for (const file of productCheckSources) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/gu)].map((match) => match[1]);
    for (const target of imports) {
      assert.doesNotMatch(target, /nebius|nemotron|hybrid|guarded/iu, `${file} -> ${target}`);
      assert.doesNotMatch(
        target,
        /deterministicMatcher\.ts$|recallMatching\/orchestrator\.ts$|recallMatching\/index\.ts$|legacyRun|process-recall-matches/u,
        `${file} -> ${target}`,
      );
    }
    assert.doesNotMatch(
      source,
      /finalize_recall_match_evaluation'|from\('alerts'\)|recall_matches/u,
      file,
    );
  }
});

// SHA-256 of the files this phase must not change (computed at HEAD 4c3d19e).
// Phase 17.7a F-4 deliberately changed recallMatching/orchestrator.ts (counts the
// stored status, safetyWithheld) and process-recall-matches/{legacyRun,store}.ts
// (surface stored_status / safety_status); their digests are the F-4 versions.
// Phase 17.7a-2 deliberately changed the automation orchestrator, index and children
// (product-check stage, disabled by default); their digests are the 17.7a-2 versions,
// and tests/phase-17-7a-2-automation.test.mjs pins the production baseline they diverge from.
const FROZEN = {
  'supabase/functions/_shared/matching/aggregation.ts':
    '6a73899f6f07553499ca862855c508258be143b63e5e150b8fb6181c214a4b63',
  'supabase/functions/_shared/matching/candidateRetrieval.ts':
    '37a23a8da45927ab0a51ac73069343ea29b1e5e68acbbfb89a81dd61279e108e',
  'supabase/functions/_shared/matching/criterionEvaluatorV2.ts':
    '32c6110d66a60b48e48ba2275532ce395bf114a328d9a6cec7689b4eef5e450d',
  'supabase/functions/_shared/matching/deterministicMatcher.ts':
    '1ae93803147fb7bb8ee652e874c0b012c9681ffc05503b5a06a3b66ec955e6bb',
  'supabase/functions/_shared/matching/deterministicMatcherV2.ts':
    '5c397f58a02be37e1601de4f556cde1f58a39f622eb35de097a093e8f334bc46',
  'supabase/functions/_shared/matching/deterministicRuleSetsV2.ts':
    '6714524a94f43646ba3132895e261df68608774528c8d56f551af33698fd1f2a',
  'supabase/functions/_shared/matching/evidence.ts':
    '89989ca2a665044e5f3ca457d41572ed0f1c129d5e7063a66de4db63fba7219f',
  'supabase/functions/_shared/matching/normalization.ts':
    'e4824410dae250efe254423a9413880dae5583e854697deca3e4f364c08b5c02',
  'supabase/functions/_shared/recallMatching/fingerprint.ts':
    'f63728c6b88bbf003e1a9b7be4cc78051391f7233df0a6da0622dc04750997e3',
  'supabase/functions/_shared/recallMatching/orchestrator.ts':
    '0af16c7158eea841e3ebc762170ea9941c177430d35055aa8fab05e582166639',
  'supabase/functions/_shared/recallMatching/orchestratorV2.ts':
    '1319a2194e3906abe764e91644dfcdd4f13ce3ab2f1b81582ab845f7083201ff',
  'supabase/functions/_shared/recallMatching/policySelector.ts':
    '09e44c116fa28672cd7fc583c76f9f2df8dd12a84946cda9044ae5cc493a5052',
  'supabase/functions/_shared/recallMatching/productionPolicyV2.ts':
    'd9c6b51062df459fb8a9ee779a582e0164fad9bf59456114128b1ccf5778c9c9',
  'supabase/functions/_shared/recallMatching/projection.ts':
    '1d961c0027b52a9c64ab449135e615506ed9143ff8077933e5a490053373cc2c',
  'supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts':
    'a5ae805ffb949bd83495a1a2aa9b4833303da02e7b84d68265eda7df58ed9e51',
  'supabase/functions/_shared/recallMatching/ruleSetsV2.ts':
    '49d6080b516dd14148028f5970ada0ecf70fbf1deb2dbc2343d52484207407ec',
  'supabase/functions/_shared/automation/orchestrator.ts':
    'dccbbd177ff7206a3dacffcc702a454729c6e157b5a922ac2c8a7471837fc35d',
  'supabase/functions/process-recall-matches/index.ts':
    '94105ddd9f59010a0592d4fec46c9fa6bc28d3967366ea6c85e2e45f9d77eb9e',
  'supabase/functions/process-recall-matches/legacyRun.ts':
    '19a12b15deba41c345f5572ac81f1fd3c461ba7bb171b76f2b93f93730582049',
  'supabase/functions/process-recall-matches/store.ts':
    'daa90146ede74a5d871449bcfdf316c662508571c15ac65b98c9f295d1b77b97',
  'supabase/functions/run-recall-automation/index.ts':
    '392f21637fb7da1f8a2d6b5182a17f05fac211e12c1e47607fc67d9293eb1445',
  'supabase/functions/run-recall-automation/children.ts':
    '6470b2bc4d9e5a40db55cae5523de2a2a52000586fde7110abc414adf5ff6377',
};

test('v1/v2 matching libraries, the v1 pipeline and the automation are unchanged', async () => {
  for (const [file, expected] of Object.entries(FROZEN)) {
    const digest = createHash('sha256')
      .update(await readFile(new URL(`../${file}`, import.meta.url)))
      .digest('hex');
    assert.equal(digest, expected, file);
  }
});

test('the production matcher policy is still v1 by default (v2 globally inactive)', async () => {
  const { productionMatcherPolicy } =
    await import('../supabase/functions/_shared/recallMatching/policySelector.ts');
  assert.equal(productionMatcherPolicy(undefined), 'phase_10_guarded_v1');
});
