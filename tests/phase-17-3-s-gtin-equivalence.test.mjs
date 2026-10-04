// Phase 17.3-S: canonical GTIN equivalence. One TypeScript primitive (matching/gtin.ts),
// one SQL mirror (private.canonical_gtin14) and one vector file shared by both. An equivalent
// representation must behave exactly like the exact representation that already existed, and
// must never by itself create an automatic alert (F-4 stays the final gate).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateGtin as validateAppGtin } from '../src/domain/barcode.ts';
import { validateGtin as validateCpscGtin } from '../supabase/functions/_shared/cpsc/validation.ts';
import { retrieveRecallCandidates } from '../supabase/functions/_shared/matching/candidateRetrieval.ts';
import { evaluateCriterionV2 } from '../supabase/functions/_shared/matching/criterionEvaluatorV2.ts';
import { evaluateDeterministicMatch } from '../supabase/functions/_shared/matching/deterministicMatcher.ts';
import { evaluateDeterministicMatchV2 } from '../supabase/functions/_shared/matching/deterministicMatcherV2.ts';
import {
  canonicalGtin14,
  canonicalizeGtin,
  expandUpcE,
  gtinsEquivalent,
} from '../supabase/functions/_shared/matching/gtin.ts';
import { verifyNemotronConfirmation } from '../supabase/functions/_shared/matching/nemotronSafetyVerifier.ts';
import { isValidGtin } from '../supabase/functions/_shared/matching/normalization.ts';
import {
  assessAutomaticConfirmationEligibility,
  SUPPORTED_CRITERION_KINDS,
} from '../supabase/functions/_shared/productCheck/gate.ts';
import { runOwnedProductCheck } from '../supabase/functions/_shared/productCheck/orchestrator.ts';
import { computeRuleSetFingerprintV2 } from '../supabase/functions/_shared/recallMatching/ruleSetsV2.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const VECTORS_PATH = 'tests/fixtures/phase-17-3-s-gtin-vectors.json';
const PGTAP_PATH = 'supabase/tests/phase-17-3-s-canonical-gtin.sql';
const MIGRATION_PATH =
  'supabase/migrations/20261004090000_phase_17_3_s_canonical_gtin_equivalence.sql';
const vectors = JSON.parse(await read(VECTORS_PATH));

const THULE = { P1: '091021037090', P2: '0091021037090', P3: '00091021037090' };
const THULE_GTIN14 = '00091021037090';
const OTHER_GTIN = '4006381333931';

// ---------------------------------------------------------------------------
// Primitive (A, E, F, G, H, I, J)
// ---------------------------------------------------------------------------
test('A/C/D/E/G/H/J: shared canonical vectors (symbology-free, same as SQL)', () => {
  assert.ok(vectors.canonical.length >= 30);
  for (const vector of vectors.canonical) {
    assert.equal(canonicalGtin14(vector.input), vector.canonical, vector.id);
    if (typeof vector.input === 'string') {
      const identity = canonicalizeGtin(vector.input);
      assert.equal(identity.canonicalGtin14, vector.canonical, vector.id);
      assert.equal(identity.valid, vector.canonical !== null, vector.id);
      assert.equal(identity.raw, vector.input, `${vector.id}: raw representation is kept`);
      assert.equal(identity.expandedFromUpce, null, vector.id);
    }
  }
});

test('A: the three Thule representations have exactly one canonical GTIN-14', () => {
  const identities = Object.values(THULE).map((value) => canonicalizeGtin(value));
  assert.deepEqual(
    identities.map((identity) => identity.canonicalGtin14),
    [THULE_GTIN14, THULE_GTIN14, THULE_GTIN14],
  );
  assert.deepEqual(
    identities.map((identity) => [identity.raw, identity.sourceLength, identity.gtinFormat]),
    [
      ['091021037090', 12, 'gtin12'],
      ['0091021037090', 13, 'gtin13'],
      ['00091021037090', 14, 'gtin14'],
    ],
  );
  for (const left of Object.values(THULE))
    for (const right of Object.values(THULE)) assert.ok(gtinsEquivalent(left, right));
});

test('E/F: invalid values fail closed and different GTINs are never equivalent', () => {
  assert.equal(gtinsEquivalent('091021037091', '091021037091'), false, 'invalid never equal');
  assert.equal(gtinsEquivalent(null, null), false);
  assert.equal(gtinsEquivalent('', ''), false);
  assert.equal(gtinsEquivalent(THULE.P1, OTHER_GTIN), false);
  assert.equal(gtinsEquivalent(THULE.P1, '10091021037097'), false, 'packaging indicator');
});

test('G: leading zeroes are preserved and never parsed as a number', () => {
  for (let seed = 0; seed < 2000; seed += 1) {
    const body = String((seed * 7919) % 10 ** 11).padStart(11, '0');
    let sum = 0;
    [...body].reverse().forEach((digit, index) => {
      sum += Number(digit) * (index % 2 === 0 ? 3 : 1);
    });
    const gtin12 = `${body}${(10 - (sum % 10)) % 10}`;
    const canonical = canonicalGtin14(gtin12);
    assert.equal(canonical, `00${gtin12}`);
    assert.equal(canonicalGtin14(`0${gtin12}`), canonical);
  }
});

test('I/O: UPC-E expands only with explicit upc_e symbology (every GS1 branch)', () => {
  for (const vector of vectors.upce) {
    assert.equal(expandUpcE(vector.input), vector.expanded, vector.id);
    const identity = canonicalizeGtin(vector.input, { symbology: 'upc_e' });
    assert.equal(identity.canonicalGtin14, vector.canonical, vector.id);
    assert.equal(identity.expandedFromUpce, vector.expanded, vector.id);
    assert.equal(identity.raw, vector.input, vector.id);
    assert.equal(identity.symbology, 'upc_e', vector.id);
    if (vector.expanded) assert.equal(identity.gtinFormat, 'gtin12', vector.id);
  }
  const thuleUpcE = canonicalizeGtin('04252614', { symbology: 'upc_e' });
  assert.equal(thuleUpcE.expandedFromUpce, '042100005264');
  assert.equal(thuleUpcE.canonicalGtin14, '00042100005264');
  // A 12-digit value labelled upc_e (already expanded by a platform) is a plain GTIN-12.
  assert.equal(
    canonicalizeGtin('042100005264', { symbology: 'upc_e' }).canonicalGtin14,
    '00042100005264',
  );
});

test('J: an 8-digit value without upc_e symbology is never guessed to be a UPC-E', () => {
  assert.equal(canonicalizeGtin('04252614').valid, false);
  assert.equal(canonicalizeGtin('04252614', { symbology: 'ean8' }).valid, false);
  assert.equal(canonicalizeGtin('04252614', { symbology: null }).valid, false);
  // Valid as both a GTIN-8 and a UPC-E: the symbology alone decides, never the digits.
  assert.equal(canonicalizeGtin('01234558').canonicalGtin14, '00000001234558');
  assert.equal(
    canonicalizeGtin('01234558', { symbology: 'upc_e' }).canonicalGtin14,
    '00012345000058',
  );
  assert.equal(gtinsEquivalent('04252614', '042100005264'), false);
});

test('the primitive keeps the existing validators exactly (app, CPSC ingestion, matching)', () => {
  for (const vector of vectors.canonical.filter((item) => typeof item.input === 'string')) {
    const valid = vector.canonical !== null;
    assert.equal(isValidGtin(vector.input), valid, `matching ${vector.id}`);
    assert.equal(validateAppGtin(vector.input).isValid, valid, `app ${vector.id}`);
    assert.equal(validateCpscGtin(vector.input), valid, `cpsc ${vector.id}`);
  }
});

// ---------------------------------------------------------------------------
// SQL parity guards (the SQL itself runs in supabase/tests via test:database)
// ---------------------------------------------------------------------------
test('the pgTAP suite embeds the shared vector file byte for byte', async () => {
  const pgtap = await read(PGTAP_PATH);
  const match = /\$vectors\$([\s\S]*?)\$vectors\$/u.exec(pgtap);
  assert.ok(match, 'vector block present');
  assert.equal(match[1].trim(), (await read(VECTORS_PATH)).trim());
});

test('the SQL trim set is exactly the String.prototype.trim set', async () => {
  const migration = await read(MIGRATION_PATH);
  const literal = /pg_catalog\.btrim\(p_value, E'([^']+)'\)/u.exec(migration);
  assert.ok(literal, 'btrim character list present');
  const sqlSet = [...literal[1].matchAll(/\\u([0-9a-f]{4})/gu)].map((m) => parseInt(m[1], 16));
  assert.equal(literal[1], sqlSet.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join(''));
  const jsSet = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const character = String.fromCodePoint(code);
    if (`${character}1`.trim() === '1') jsSet.push(code);
  }
  assert.deepEqual(sqlSet, jsSet);
});

test('the migration only adds canonical equality to candidate retrieval (nothing narrowed)', async () => {
  const migration = await read(MIGRATION_PATH);
  const legacy = (
    await read('supabase/migrations/20260914100000_phase_10_recall_matching.sql')
  ).concat(
    await read('supabase/migrations/20261002120000_phase_17_7a_1_owned_product_recall_checks.sql'),
  );
  for (const predicate of [
    "pg_catalog.regexp_replace(owned_product.gtin, '[^0-9]', '', 'g') =",
    "pg_catalog.regexp_replace(exact_scope.gtin, '[^0-9]', '', 'g')",
    "pg_catalog.regexp_replace(candidate_scope.gtin, '[^0-9]', '', 'g')",
    "pg_catalog.regexp_replace(scope.gtin, '[^0-9]', '', 'g') = product.gtin_key",
  ]) {
    assert.ok(legacy.includes(predicate) && migration.includes(predicate), predicate);
  }
  assert.match(migration, /create or replace function public\.get_recall_candidates\(/u);
  assert.match(
    migration,
    /create or replace function public\.get_owned_product_recall_candidates\(/u,
  );
  const code = migration.replace(/--[^\n]*/gu, '');
  assert.doesNotMatch(code, /\b(update|delete from|insert into|alter table|drop)\b/iu);
  assert.doesNotMatch(code, /automatic_alert|recall_matching_policy|finalize_recall/iu);
});

// ---------------------------------------------------------------------------
// Documented re-freeze (benchmarks/recall-matching/phase-17-3-s-refreeze.json)
// ---------------------------------------------------------------------------
test('the 17.3-S re-freeze is limited to the GTIN comparison files and keeps history', async () => {
  const sha256 = async (path) =>
    (await import('node:crypto'))
      .createHash('sha256')
      .update(await readFile(new URL(path, root)))
      .digest('hex');
  const record = JSON.parse(await read('benchmarks/recall-matching/phase-17-3-s-refreeze.json'));
  const matching = 'supabase/functions/_shared/matching/';
  assert.deepEqual(
    record.entries.map((entry) => `${entry.manifest}#${entry.path}`).sort(),
    [
      `benchmarks/recall-matching/phase-15/freeze-manifest.json#${matching}evidence.ts`,
      'benchmarks/recall-matching/phase-15/freeze-manifest.json#benchmarks/recall-matching/phase-9-1/holdout-manifest.json',
      `benchmarks/recall-matching/phase-16/freeze-manifest.json#${matching}criterionEvaluatorV2.ts`,
      `benchmarks/recall-matching/phase-9-1/holdout-manifest.json#${matching}evidence.ts`,
      `benchmarks/recall-matching/phase-9-1/holdout-manifest.json#${matching}nemotronSafetyVerifier.ts`,
    ].sort(),
  );
  for (const entry of record.entries) {
    const manifest = JSON.parse(await read(entry.manifest));
    assert.equal(manifest[entry.section][entry.path], entry.after, entry.path);
    assert.equal(await sha256(entry.path), entry.after, entry.path);
    assert.notEqual(entry.before, entry.after, entry.path);
  }
  for (const [path, digest] of Object.entries(record.unchanged)) {
    assert.equal(await sha256(path), digest, path);
  }
  // History is not rewritten: the Phase 15 reports still pin the files their runs used.
  const report = JSON.parse(await read('benchmarks/recall-matching/phase-15/final-report.json'));
  const before = record.entries.find((entry) => entry.path === `${matching}evidence.ts`).before;
  assert.equal(JSON.stringify(report).includes(`"${matching}evidence.ts":"${before}"`), true);
});

// ---------------------------------------------------------------------------
// Thule regression: P1/P2/P3 against the one 8877 scope 091021037090
// ---------------------------------------------------------------------------
const CPSC_URL = 'https://www.cpsc.gov/Recalls/2020/Thule-Recalls-Strollers-Due-to-Injury-Hazard';

function owned(gtin, overrides = {}) {
  return {
    productName: 'Sleek stroller',
    brand: 'Thule',
    category: null,
    gtin,
    modelNumber: null,
    serialNumber: null,
    lotNumber: null,
    purchaseDate: null,
    identificationMethod: 'barcode_scan',
    ...overrides,
  };
}

function recallV1(scopeOverrides = {}, scopes = null) {
  return {
    recallNoticeId: 'notice-8877',
    source: { authority: 'CPSC', externalId: '8877', officialUrl: CPSC_URL },
    title: 'Thule Recalls Strollers Due to Injury Hazard',
    description: null,
    hazard: null,
    remedy: null,
    recallDate: '2020-08-12',
    scopes: scopes ?? [
      { brand: 'Thule', productName: 'Sleek stroller', gtin: THULE.P1, ...scopeOverrides },
    ],
    rawEvidence: null,
  };
}

/** Everything a decision depends on, with the raw GTIN strings factored out. */
function shape(result) {
  return {
    decision: result.decision,
    confidence: result.confidence,
    matchedKinds: Object.keys(result.matchedIdentifiers).sort(),
    conflictingKinds: Object.keys(result.conflictingIdentifiers).sort(),
    evidence: result.evidenceUsed.map((item) => `${item.kind}:${item.outcome}:${item.strength}`),
  };
}

test('B/N/O: candidate retrieval gives P1, P2 and P3 the same exact_gtin signal', () => {
  const signals = Object.values(THULE).map((gtin) =>
    retrieveRecallCandidates(owned(gtin), [recallV1()]).map((candidate) =>
      candidate.signals.map((signal) => signal.kind).sort(),
    ),
  );
  assert.deepEqual(
    signals[0],
    [['exact_gtin', 'name_overlap']].map((s) => s.sort()),
  );
  assert.deepEqual(signals[1], signals[0]);
  assert.deepEqual(signals[2], signals[0]);
  // A recall published in 13 or 14 digits retrieves the 12-digit product too.
  for (const official of [THULE.P2, THULE.P3]) {
    const [candidate] = retrieveRecallCandidates(owned(THULE.P1), [recallV1({ gtin: official })]);
    assert.ok(
      candidate.signals.some((signal) => signal.kind === 'exact_gtin'),
      official,
    );
  }
  // E/F: a really different or invalid GTIN still produces no GTIN signal.
  for (const gtin of [OTHER_GTIN, '0091021037091', '04252614']) {
    const candidates = retrieveRecallCandidates(owned(gtin), [recallV1()]);
    assert.ok(
      candidates.every((candidate) => !candidate.signals.some((s) => s.kind === 'exact_gtin')),
      gtin,
    );
  }
});

test('C/P: v1 never rejects an equivalent representation and behaves as the exact one', () => {
  const variants = {
    'gtin-only': {},
    'lot-inside': { lotFrom: '1000', lotTo: '1999' },
    'brand-conflict': { brand: 'Other brand' },
    'manufacture-window': { manufacturedFrom: '2018-01-01', manufacturedTo: '2019-12-31' },
    'model-mismatch': { modelNumber: 'OTHER-1' },
  };
  for (const [name, scope] of Object.entries(variants)) {
    for (const ownedOverrides of [
      {},
      { lotNumber: '1500' },
      { lotNumber: '2500' },
      { modelNumber: '11000017' },
    ]) {
      const reference = shape(
        evaluateDeterministicMatch(owned(THULE.P1, ownedOverrides), recallV1(scope)),
      );
      for (const gtin of [THULE.P2, THULE.P3]) {
        const result = evaluateDeterministicMatch(owned(gtin, ownedOverrides), recallV1(scope));
        assert.deepEqual(
          shape(result),
          reference,
          `${name} ${gtin} ${JSON.stringify(ownedOverrides)}`,
        );
        assert.equal(result.conflictingIdentifiers.gtin, undefined, `${name} ${gtin}`);
        if (result.matchedIdentifiers.gtin) {
          assert.deepEqual(result.matchedIdentifiers.gtin, [gtin], 'raw owned value is recorded');
        }
      }
    }
  }
  const p2 = evaluateDeterministicMatch(owned(THULE.P2), recallV1());
  assert.equal(p2.decision, 'confirmed');
  const gtinItem = p2.evidenceUsed.find((item) => item.kind === 'gtin');
  assert.equal(gtinItem.ownedValue, THULE.P2);
  assert.equal(gtinItem.officialValue, THULE.P1);
  assert.match(gtinItem.detail, /Equivalent valid GTIN/u);
  assert.match(
    evaluateDeterministicMatch(owned(THULE.P1), recallV1()).evidenceUsed.find(
      (i) => i.kind === 'gtin',
    ).detail,
    /^Exact valid GTIN match/u,
    'the exact case keeps its historical detail',
  );
});

test('E/F (v1): really different GTINs stay contradictory, invalid ones stay unresolved', () => {
  const different = evaluateDeterministicMatch(owned(OTHER_GTIN), recallV1());
  assert.equal(different.decision, 'rejected');
  assert.deepEqual(different.conflictingIdentifiers.gtin, [`${OTHER_GTIN} != ${THULE.P1}`]);
  const invalid = evaluateDeterministicMatch(owned('0091021037091'), recallV1());
  assert.equal(invalid.conflictingIdentifiers.gtin, undefined);
  assert.ok(
    invalid.evidenceUsed.some((item) => item.kind === 'gtin' && item.outcome === 'unresolved'),
  );
});

const provenance = {
  authority: 'CPSC',
  officialUrl: CPSC_URL,
  sourceField: 'cpsc-page:upc',
  normalizationRule: 'gtin_v1',
};
const criterion = (overrides) => ({
  id: `c-${overrides.kind}`,
  required: true,
  provenance,
  ...overrides,
});
const ownedV2 = (gtin, overrides = {}) => ({ ...owned(gtin, overrides), attributes: [] });

test('D/Q: v2 GTIN criteria match every equivalent form and never conflict with them', () => {
  for (const official of Object.values(THULE)) {
    for (const gtin of Object.values(THULE)) {
      const equals = evaluateCriterionV2(
        ownedV2(gtin),
        criterion({ kind: 'gtin', operator: 'equals', value: official }),
      );
      assert.equal(equals.outcome, 'matched', `equals ${gtin} ~ ${official}`);
      assert.equal(equals.ownedValue, gtin, 'raw owned value is reported');
      const oneOf = evaluateCriterionV2(
        ownedV2(gtin),
        criterion({ kind: 'gtin', operator: 'one_of', values: [OTHER_GTIN, official] }),
      );
      assert.equal(oneOf.outcome, 'matched', `one_of ${gtin} ~ ${official}`);
    }
  }
  const outcome = (gtin, value) =>
    evaluateCriterionV2(ownedV2(gtin), criterion({ kind: 'gtin', operator: 'equals', value }))
      .outcome;
  assert.equal(outcome(THULE.P2, OTHER_GTIN), 'conflicting', 'canonical-different');
  assert.equal(outcome('0091021037091', THULE.P1), 'unresolved', 'invalid owned fails closed');
  assert.equal(outcome(null, THULE.P1), 'missing');
  // Unchanged legacy behaviour outside equivalence: an invalid official value still conflicts
  // with a valid owned value that is not byte-identical.
  assert.equal(outcome(THULE.P1, '091021037091'), 'conflicting');
  // Non-GTIN kinds are untouched: no canonicalization of model numbers.
  assert.equal(
    evaluateCriterionV2(
      ownedV2(THULE.P1, { modelNumber: '011000017' }),
      criterion({ kind: 'model_number', operator: 'equals', value: '11000017' }),
    ).outcome,
    'conflicting',
  );
});

test('T (v2): a matched GTIN never relaxes lot, date or model criteria', () => {
  const scope = (criteria) => ({
    brand: 'Thule',
    productName: 'Sleek stroller',
    gtin: THULE.P1,
    criteria: { semantics: 'all_of', criteria },
  });
  const recall = (criteria) => ({ ...recallV1(), scopes: [scope(criteria)] });
  const GTIN = criterion({ kind: 'gtin', operator: 'equals', value: THULE.P1 });
  const LOT = criterion({ kind: 'lot_number', operator: 'equals', value: '1500' });
  const MODEL = criterion({ kind: 'model_number', operator: 'equals', value: '11000017' });
  const cases = [
    [[GTIN, LOT], { lotNumber: '1500' }],
    [[GTIN, LOT], { lotNumber: '2500' }],
    [[GTIN, LOT], {}],
    [[GTIN, MODEL], { modelNumber: 'OTHER-1' }],
    [[GTIN, MODEL], {}],
  ];
  for (const [criteria, overrides] of cases) {
    const reference = evaluateDeterministicMatchV2(ownedV2(THULE.P1, overrides), recall(criteria));
    for (const gtin of [THULE.P2, THULE.P3]) {
      const result = evaluateDeterministicMatchV2(ownedV2(gtin, overrides), recall(criteria));
      assert.equal(result.decision, reference.decision, `${gtin} ${JSON.stringify(overrides)}`);
      assert.deepEqual(
        result.criterionEvaluations.map((item) => `${item.kind}:${item.outcome}`),
        reference.criterionEvaluations.map((item) => `${item.kind}:${item.outcome}`),
      );
    }
  }
  const wrongLot = evaluateDeterministicMatchV2(
    ownedV2(THULE.P2, { lotNumber: '2500' }),
    recall([GTIN, LOT]),
  );
  assert.notEqual(wrongLot.decision, 'confirmed');
  const missingLot = evaluateDeterministicMatchV2(ownedV2(THULE.P3), recall([GTIN, LOT]));
  assert.notEqual(missingLot.decision, 'confirmed');
});

test('R: the Nemotron safety verifier accepts equivalent GTIN claims and nothing more', () => {
  const input = (gtin) => ({
    ownedProduct: owned(gtin),
    officialRecall: recallV1({ additionalCriteria: null }),
  });
  const output = (gtin, claimedOfficialValue = THULE.P1) => ({
    decision: 'confirmed',
    confidence: 0.9,
    matchedIdentifiers: { gtin: [], modelNumber: [], serialNumber: [], lotNumber: [] },
    conflictingIdentifiers: { gtin: [], modelNumber: [], serialNumber: [], lotNumber: [] },
    evidenceUsed: [],
    reasoningSummary: 'GTIN claim.',
    evidenceClaims: [
      {
        criterion: 'gtin',
        ownedField: 'gtin',
        ownedValue: gtin,
        claimedOfficialValue,
        sourceKind: 'scope',
        scopeIndex: 0,
        sourceField: 'gtin',
        sourceIndex: null,
      },
    ],
  });
  for (const gtin of Object.values(THULE)) {
    const verification = verifyNemotronConfirmation(input(gtin), output(gtin));
    assert.equal(verification.accepted, true, gtin);
  }
  assert.equal(verifyNemotronConfirmation(input(OTHER_GTIN), output(OTHER_GTIN)).accepted, false);
  // The claim must still copy the supplied values verbatim; equivalence does not relax that.
  assert.equal(verifyNemotronConfirmation(input(THULE.P2), output(THULE.P1)).accepted, false);
  assert.equal(
    verifyNemotronConfirmation(input(THULE.P2), output(THULE.P2, THULE.P3)).accepted,
    false,
  );
});

// ---------------------------------------------------------------------------
// Product check + F-4 gate (S, T, U)
// ---------------------------------------------------------------------------
test('S: a GTIN criterion is never an automatic-alert criterion (F-4 unchanged)', () => {
  assert.deepEqual([...SUPPORTED_CRITERION_KINDS].sort(), ['date_code', 'model_number']);
  const gate = (criteria) =>
    assessAutomaticConfirmationEligibility({
      sourceIsAuthoritative: true,
      purchaseCountryCode: 'US',
      noticeJurisdictions: [{ type: 'country', code: 'US' }],
      scopes: [
        {
          kind: 'validated',
          value: {
            ruleSets: [{ semantics: 'all_of', criteria }],
            coverageComplete: true,
            droppedRuleSets: 0,
          },
        },
      ],
    });
  assert.equal(gate([{ kind: 'gtin', required: true }]), 'unsupported_scope');
  assert.equal(
    gate([
      { kind: 'gtin', required: true },
      { kind: 'model_number', required: true },
    ]),
    'unsupported_scope',
  );
});

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOTICE = uuid(100);
const SCOPE = uuid(200);
const HEX = (c) => c.repeat(64);

function productRow(gtin, overrides = {}) {
  return {
    owned_product_id: uuid(1),
    owned_product_updated_at: '2026-10-02T10:00:00.000001+00:00',
    user_id: uuid(9001),
    product_name: 'Sleek stroller',
    brand: 'Thule',
    category: null,
    gtin,
    model_number: '11000017',
    serial_number: null,
    lot_number: null,
    identification_method: 'barcode_scan',
    safety_attributes: { date_code: '1805' },
    ...overrides,
  };
}

function recallRow(overrides = {}) {
  return {
    recall_notice_id: NOTICE,
    recall_notice_updated_at: '2026-10-01T00:00:00.000001+00:00',
    source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
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
    jurisdictions: [{ type: 'country', code: 'US' }],
    exact_rank: 4,
    ...overrides,
  };
}

async function ruleSet(criteria) {
  const candidateIds = criteria.map((_, index) => uuid(300 + index));
  const set = {
    semantics: 'all_of',
    criteria: criteria.map((item, index) => ({
      id: `cpsc-ledger-${candidateIds[index]}`,
      required: true,
      provenance: {
        authority: 'CPSC',
        officialUrl: CPSC_URL,
        normalizationRule: 'identifier_v2',
        sourceField: `cpsc-page:table:1:${index}`,
      },
      ...item,
    })),
    review: {
      origin: 'human_review_ledger',
      schema: 'recall_rule_set_v1',
      revisionId: uuid(400),
      sourceRevisionHash: HEX('a'),
      conjunctionGroup: 'g1',
      scopeId: SCOPE,
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
  complete: true,
  unattributedRuleSets: 0,
  sourceCoverage: {
    state: 'recorded',
    coverageStatus: 'complete',
    positiveStatus: 'independent',
    negativeEvidenceEligible: true,
  },
};

function scopeRow(sets, coverage) {
  return {
    scope_id: SCOPE,
    brand: null,
    product_name: null,
    gtin: THULE.P1,
    model_number: null,
    lot_from: null,
    lot_to: null,
    serial_from: null,
    serial_to: null,
    manufactured_from: null,
    manufactured_to: null,
    additional_criteria: { association: 'recall-level', evidence_level: 'recall' },
    reviewed_criteria:
      sets === undefined
        ? null
        : {
            semantics: 'any_of',
            schema: 'recall_rule_sets_v1',
            scopeId: SCOPE,
            ruleSets: sets,
            coverage: {
              ...(coverage ?? completeCoverage),
              servedRuleSets: sets.length,
              proposedRuleSets: sets.length,
            },
          },
  };
}

function fakeStore(row, scope, recallOverrides) {
  const calls = { finalize: [], alerts: [] };
  return {
    calls,
    async getProductEvidence(id) {
      return id === row.owned_product_id ? row : null;
    },
    async listCandidateRecalls({ after }) {
      return after ? [] : [recallRow(recallOverrides)];
    },
    async getReviewedScopes() {
      return [scope];
    },
    async claimPair() {
      return { status: 'claimed', leaseToken: 'pair-lease' };
    },
    async finalizeV2(input) {
      calls.finalize.push(input);
      return {
        status: 'finalized',
        alertEligibility: input.status === 'confirmed' ? 'created' : 'none',
      };
    },
    async createAlert(productId, recallId) {
      calls.alerts.push([productId, recallId]);
      return 'created';
    },
  };
}

async function productCheck(
  gtin,
  { sets, coverage, productOverrides, recallOverrides, country = 'US' } = {},
) {
  const row = productRow(gtin, productOverrides);
  const store = fakeStore(
    row,
    scopeRow(sets === undefined ? undefined : await Promise.all(sets), coverage),
    recallOverrides,
  );
  const result = await runOwnedProductCheck(
    {
      ownedProductId: row.owned_product_id,
      leaseToken: 'job-lease',
      matchingRevision: 1,
      productUpdatedAt: row.owned_product_updated_at,
      purchaseCountryCode: country,
      cursor: null,
      maxCandidates: 25,
    },
    store,
    { deadline: Date.now() + 10_000 },
  );
  const finalize = store.calls.finalize.map((call) => ({
    status: call.status,
    confidence: call.confidence,
    matchedKinds: Object.keys(call.matchedIdentifiers ?? {}).sort(),
    reasoningSummary: call.reasoningSummary,
  }));
  return {
    result: { ...result, cursor: undefined },
    finalize,
    alerts: store.calls.alerts,
    calls: store.calls,
  };
}

const MODEL = { kind: 'model_number', operator: 'equals', value: '11000017' };
const DATE_CODES = { kind: 'date_code', operator: 'one_of', values: ['1805', '1806'] };
const LOT_RULE = { kind: 'lot_number', operator: 'equals', value: '1500' };

test('U/16: equivalence-only product checks create no alert and match P1 exactly', async () => {
  const p1 = await productCheck(THULE.P1);
  assert.equal(p1.finalize.length, 1);
  assert.equal(p1.finalize[0].status, 'needs_review');
  assert.deepEqual(p1.finalize[0].matchedKinds, ['gtin']);
  assert.deepEqual(p1.alerts, []);
  for (const gtin of [THULE.P2, THULE.P3]) {
    const other = await productCheck(gtin);
    assert.deepEqual(other.result, p1.result, gtin);
    assert.deepEqual(other.finalize, p1.finalize, gtin);
    assert.deepEqual(other.calls.finalize[0].matchedIdentifiers, { gtin: [gtin] }, 'raw kept');
    assert.deepEqual(other.alerts, [], gtin);
  }
});

test('T/U: jurisdiction, coverage and unsupported rules still block P2/P3 like P1', async () => {
  const scenarios = {
    'incomplete coverage': {
      sets: [ruleSet([MODEL, DATE_CODES])],
      coverage: { ...completeCoverage, complete: false },
    },
    'jurisdiction mismatch': { sets: [ruleSet([MODEL, DATE_CODES])], country: 'CA' },
    'unknown purchase country': { sets: [ruleSet([MODEL, DATE_CODES])], country: null },
    'lot rule (unsupported kind)': {
      sets: [ruleSet([MODEL, LOT_RULE])],
      productOverrides: { lot_number: '1500' },
    },
    'wrong date code': {
      sets: [ruleSet([MODEL, DATE_CODES])],
      productOverrides: { safety_attributes: { date_code: '1999' } },
    },
    'missing date code': {
      sets: [ruleSet([MODEL, DATE_CODES])],
      productOverrides: { safety_attributes: {} },
    },
    'wrong model': {
      sets: [ruleSet([MODEL, DATE_CODES])],
      productOverrides: { model_number: 'OTHER-1' },
    },
    'GTIN-only reviewed rule': {
      sets: [ruleSet([{ kind: 'gtin', operator: 'equals', value: THULE.P1 }])],
    },
    'GTIN + model reviewed rule': {
      sets: [ruleSet([{ kind: 'gtin', operator: 'equals', value: THULE.P1 }, MODEL])],
    },
  };
  for (const [name, options] of Object.entries(scenarios)) {
    const reference = await productCheck(THULE.P1, options);
    assert.deepEqual(reference.alerts, [], `${name}: no alert for P1`);
    for (const gtin of [THULE.P2, THULE.P3]) {
      const other = await productCheck(gtin, options);
      assert.deepEqual(other.result, reference.result, `${name} ${gtin}`);
      assert.deepEqual(other.finalize, reference.finalize, `${name} ${gtin}`);
      assert.deepEqual(other.alerts, [], `${name} ${gtin}`);
    }
  }
});

test('complete reviewed model + date rules: P2/P3 behave exactly as P1 (GTIN plays no part)', async () => {
  const options = { sets: [ruleSet([MODEL, DATE_CODES])] };
  const reference = await productCheck(THULE.P1, options);
  assert.equal(reference.finalize[0].status, 'confirmed');
  assert.equal(reference.alerts.length, 1);
  for (const gtin of [THULE.P2, THULE.P3]) {
    const other = await productCheck(gtin, options);
    assert.deepEqual(other.result, reference.result, gtin);
    assert.deepEqual(other.finalize, reference.finalize, gtin);
    assert.equal(other.alerts.length, 1, gtin);
  }
  // Without the GTIN (and with a model the scope does not list) nothing is retrieved by GTIN:
  // the alert above comes from the reviewed model + date code rules, not from the GTIN.
  const different = await productCheck(OTHER_GTIN, options);
  assert.notDeepEqual(different.finalize, reference.finalize);
});
