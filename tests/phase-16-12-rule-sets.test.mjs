import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { extractCpscPage } from '../supabase/functions/_shared/cpsc/htmlExtractor.ts';
import { ingestCpscRecallIdentity } from '../supabase/functions/_shared/cpsc/ingestionGate.ts';
import {
  proposeCpscTableCriteria,
  semanticCpscRevision,
} from '../supabase/functions/_shared/cpsc/pageEvidence.ts';
import { evaluateDeterministicMatchV2 } from '../supabase/functions/_shared/matching/deterministicMatcherV2.ts';
import {
  DETERMINISTIC_RULE_SETS_ADAPTER_V2,
  evaluateDeterministicRuleSetsV2,
} from '../supabase/functions/_shared/matching/deterministicRuleSetsV2.ts';
import {
  evaluateProductionPairV2,
  projectOwnedProductForProductionV2,
  projectRecallForProductionV2,
} from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';
import {
  computeRuleSetFingerprintV2,
  evaluateRuleSetsPairV2,
  projectRecallRuleSetsForProductionV2,
  ruleSetsFingerprintV2,
  validateLiveRuleSetEnvelopeV2,
} from '../supabase/functions/_shared/recallMatching/ruleSetsV2.ts';
import { validatePhase15Split } from '../benchmarks/recall-matching/phase-15/dataset.ts';
import {
  projectPhase15OwnedProductV2,
  projectPhase15RecallV2,
} from '../benchmarks/recall-matching/phase-16/projection.ts';

const root = new URL('../', import.meta.url);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const uuid = (seed) => {
  const hex = sha(String(seed));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const authority = 'U.S. Consumer Product Safety Commission (CPSC)';

async function charBroilPage() {
  const html = await readFile(new URL('tests/fixtures/cpsc-pages/char-broil.html', root), 'utf8');
  const url = /<link rel="canonical" href="([^"]+)"/u.exec(html)[1];
  return extractCpscPage(html, url);
}

/** A table whose rows pair each model with its own date code. */
function pairedPage() {
  const url = 'https://www.cpsc.gov/Recalls/2026/Paired-Grill-Recall';
  return {
    recallNumber: '26951',
    canonicalUrl: url,
    title: 'Paired Grill Recall',
    publicationDate: '2026-09-20',
    description: 'This recall involves two grills.',
    recallDetails: {},
    tables: [
      [
        ['Product', 'Model No.', 'Date Code'],
        ['Grill A', 'MODEL-A', '2510'],
        ['Grill B', 'MODEL-B', '2511'],
      ],
    ],
  };
}

/**
 * Emulates the database builder: one rule set per conjunction, members ordered
 * by candidate id, identity inputs carried in `review`.
 */
async function servedEnvelope(page, { reviewer = uuid('reviewer'), drop = [] } = {}) {
  const revision = await semanticCpscRevision(page);
  const { candidates } = await proposeCpscTableCriteria(page);
  const scopeId = uuid(`${page.recallNumber}:scope`);
  const groups = new Map();
  candidates.forEach((proposal, index) => {
    const members = groups.get(proposal.conjunctionKey) ?? [];
    members.push({ ...proposal, candidateId: uuid(`${page.recallNumber}:candidate:${index}`) });
    groups.set(proposal.conjunctionKey, members);
  });
  const ruleSets = [];
  for (const [conjunctionGroup, members] of groups) {
    members.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    const set = {
      semantics: 'all_of',
      criteria: members.map((member) => ({
        id: `cpsc-ledger-${member.candidateId}`,
        kind: member.kind.startsWith('model') ? 'model_number' : 'date_code',
        operator: member.operator === 'exact' ? 'equals' : 'one_of',
        required: true,
        provenance: {
          authority: 'CPSC',
          officialUrl: page.canonicalUrl,
          sourceField: `cpsc-page:${member.sourceAddress.tableIdentity}/${member.sourceAddress.rowIdentity}/${member.sourceAddress.fieldIdentity}`,
          normalizationRule: 'identifier_v2',
        },
        ...(member.operator === 'exact' ? { value: member.value } : { values: member.value }),
      })),
      review: {
        origin: 'human_review_ledger',
        revisionId: uuid(`${page.recallNumber}:revision`),
        sourceRevisionHash: revision.semanticHash,
        conjunctionGroup,
        scopeId,
        scopeFingerprint: sha(`${scopeId}:fingerprint`),
        candidateIds: members.map((member) => member.candidateId),
        reviewEventIds: members.map((member) => uuid(`${member.candidateId}:event`)),
        reviewerIds: members.map(() => reviewer),
        reviewedAt: '2026-09-26T10:00:00.000Z',
        schema: 'recall_rule_set_v1',
        identityFingerprint: sha(`cpsc\u0000${page.recallNumber}`),
        scopeSemanticFingerprint: sha(`${page.recallNumber}:semantic-scope`),
        sourceAddressHashes: members.map((member) => sha(JSON.stringify(member.sourceAddress))),
        ruleSetFingerprint: '',
      },
    };
    set.review.ruleSetFingerprint = await computeRuleSetFingerprintV2(set);
    ruleSets.push(set);
  }
  ruleSets.sort((a, b) => a.review.ruleSetFingerprint.localeCompare(b.review.ruleSetFingerprint));
  const served = ruleSets.filter(
    (set) => !drop.some((model) => JSON.stringify(set).includes(model)),
  );
  return {
    scopeId,
    envelope: {
      semantics: 'any_of',
      schema: 'recall_rule_sets_v1',
      scopeId,
      ruleSets: served,
      coverage: {
        currentRevisionId: uuid(`${page.recallNumber}:revision`),
        proposedRuleSets: ruleSets.length,
        unattributedRuleSets: 0,
        servedRuleSets: served.length,
        complete: served.length === ruleSets.length,
        // Phase 16.13: the database also serves the revision's source-coverage proof.
        sourceCoverage: {
          state: 'recorded',
          coverageStatus: 'complete',
          positiveStatus: 'independent',
          negativeEvidenceEligible: true,
        },
      },
    },
  };
}

function recallRow(page) {
  return {
    recall_notice_id: uuid(`${page.recallNumber}:notice`),
    recall_notice_updated_at: '2026-09-26T10:00:00Z',
    source_authority: authority,
    source_external_id: `cpsc:${page.recallNumber}`,
    source_official_url: page.canonicalUrl,
    source_is_authoritative: true,
    title: page.title,
    description: null,
    hazard: null,
    remedy: null,
    recall_date: '2026-09-20',
    raw_payload: {},
    scopes: [],
  };
}

async function project(page, envelope, scopeId) {
  const recall = recallRow(page);
  const scope = { scope_id: scopeId, product_name: 'Product', model_number: null };
  const validated = await validateLiveRuleSetEnvelopeV2(recall, scope, envelope);
  return {
    validated,
    projection: projectRecallRuleSetsForProductionV2({ ...recall, scopes: [scope] }, [validated]),
  };
}

const owned = (modelNumber, dateCode) =>
  projectOwnedProductForProductionV2({
    owned_product_id: 'owned',
    owned_product_updated_at: '2026-09-26T10:00:00Z',
    user_id: 'user',
    product_name: 'Product',
    brand: null,
    category: null,
    gtin: null,
    model_number: modelNumber,
    serial_number: null,
    lot_number: null,
    purchase_date: null,
    identification_method: 'manual',
    safety_attributes: dateCode ? { date_code: dateCode } : {},
  });

const CHAR_BROIL_MODELS = [
  '25302145',
  '25302146',
  '25302147',
  '25302148',
  '25302149',
  '25302150',
  '25302151',
  '25302159',
  '25302163',
];

test('Char-Broil: 9 authoritative associations become 9 independently usable rule sets', async () => {
  const page = await charBroilPage();
  const { envelope, scopeId } = await servedEnvelope(page);
  assert.equal(envelope.ruleSets.length, 9);
  const { validated, projection } = await project(page, envelope, scopeId);
  assert.equal(validated.ruleSets.length, 9, '9 / 9 rule sets usable');
  assert.equal(validated.coverageComplete, true);
  assert.equal(projection.units.length, 9);
  for (const set of validated.ruleSets) {
    assert.deepEqual(
      set.criteria.map((criterion) => criterion.kind).sort(),
      ['date_code', 'model_number'],
      'each rule set is model AND date-code set',
    );
  }
  for (const model of CHAR_BROIL_MODELS) {
    const evaluation = evaluateRuleSetsPairV2(owned(model, '2511'), projection);
    assert.equal(evaluation.decision, 'confirmed', `${model} + 2511 confirms`);
    const confirmedUnits = evaluation.ruleSetTrace.filter((unit) => unit.decision === 'confirmed');
    assert.equal(confirmedUnits.length, 1, 'exactly the corresponding rule set matches');
    const matched = validated.ruleSets.find(
      (set) => set.review.ruleSetFingerprint === confirmedUnits[0].ruleSetId,
    );
    assert.ok(matched.criteria.some((criterion) => criterion.value === model));
  }
});

test('Char-Broil conjunction safety: no partial or cross-product confirmation', async () => {
  const page = await charBroilPage();
  const { envelope, scopeId } = await servedEnvelope(page);
  const { projection } = await project(page, envelope, scopeId);
  const decide = (model, code) => evaluateRuleSetsPairV2(owned(model, code), projection).decision;
  assert.notEqual(decide('25302145', '2509'), 'confirmed', 'correct model, unlisted date code');
  assert.equal(decide('25302145', '2509'), 'rejected', 'complete coverage allows a safe rejection');
  assert.notEqual(decide('25302199', '2510'), 'confirmed', 'wrong model, valid date code');
  assert.equal(decide(null, '2510'), 'needs_review', 'missing model never confirms');
  assert.equal(decide('25302145', null), 'needs_review', 'missing date code never confirms');
});

test('row-paired table: a date code from another row never qualifies a model', async () => {
  const page = pairedPage();
  const { envelope, scopeId } = await servedEnvelope(page);
  assert.equal(envelope.ruleSets.length, 2);
  const { projection } = await project(page, envelope, scopeId);
  const decide = (model, code) => evaluateRuleSetsPairV2(owned(model, code), projection).decision;
  assert.equal(decide('MODEL-A', '2510'), 'confirmed');
  assert.equal(decide('MODEL-B', '2511'), 'confirmed');
  assert.notEqual(decide('MODEL-A', '2511'), 'confirmed', 'MODEL-A with row B date code');
  assert.notEqual(decide('MODEL-B', '2510'), 'confirmed', 'MODEL-B with row A date code');
  assert.notEqual(decide('MODEL-C', '2510'), 'confirmed', 'unlisted model');
});

test('an incomplete rule set neither serves nor invalidates the complete ones', async () => {
  const page = await charBroilPage();
  const { envelope, scopeId } = await servedEnvelope(page, { drop: ['25302149'] });
  assert.equal(envelope.ruleSets.length, 8);
  const { validated, projection } = await project(page, envelope, scopeId);
  assert.equal(validated.ruleSets.length, 8);
  assert.equal(validated.coverageComplete, false);
  assert.equal(evaluateRuleSetsPairV2(owned('25302145', '2511'), projection).decision, 'confirmed');
  const withheld = evaluateRuleSetsPairV2(owned('25302149', '2511'), projection);
  assert.equal(withheld.decision, 'needs_review', 'product of the unserved row is never rejected');
  assert.equal(withheld.rejectionWithheld, true);
});

test('a tampered or duplicated rule set is dropped individually and coverage becomes incomplete', async () => {
  const page = await charBroilPage();
  const { envelope, scopeId } = await servedEnvelope(page);
  const tampered = structuredClone(envelope);
  const model = tampered.ruleSets[0].criteria.find(
    (criterion) => criterion.kind === 'model_number',
  );
  model.value = '99999999';
  tampered.ruleSets.push(structuredClone(envelope.ruleSets[1]));
  const { validated, projection } = await project(page, tampered, scopeId);
  assert.equal(validated.ruleSets.length, 8);
  assert.equal(validated.droppedRuleSets, 2);
  assert.equal(validated.coverageComplete, false);
  assert.notEqual(
    evaluateRuleSetsPairV2(owned('99999999', '2511'), projection).decision,
    'confirmed',
  );
  await assert.rejects(
    project(page, { ...envelope, semantics: 'all_of' }, scopeId),
    /recall_rule_sets_v1/u,
  );
  await assert.rejects(
    project(page, { ...envelope, scopeId: uuid('other') }, scopeId),
    /envelope/u,
  );
});

test('rule-set fingerprint is semantic: row UUIDs, timestamps, and reviewers are excluded', async () => {
  const page = await charBroilPage();
  const { envelope } = await servedEnvelope(page);
  const set = envelope.ruleSets[0];
  const base = await computeRuleSetFingerprintV2(set);
  assert.equal(base, set.review.ruleSetFingerprint);
  const renamed = structuredClone(set);
  renamed.review.candidateIds = renamed.review.candidateIds.map((id) => uuid(`renamed:${id}`));
  renamed.criteria = renamed.criteria.map((criterion, index) => ({
    ...criterion,
    id: `cpsc-ledger-${renamed.review.candidateIds[index]}`,
  }));
  renamed.review.reviewEventIds = renamed.review.reviewEventIds.map((id) => uuid(`event:${id}`));
  renamed.review.reviewerIds = renamed.review.reviewerIds.map(() => uuid('another reviewer'));
  renamed.review.reviewedAt = '2027-01-01T00:00:00.000Z';
  renamed.review.revisionId = uuid('another revision row');
  renamed.review.scopeId = uuid('another scope row');
  renamed.criteria.reverse();
  assert.equal(await computeRuleSetFingerprintV2(renamed), base);
  const changes = [
    (copy) => {
      copy.criteria.find((c) => c.kind === 'model_number').value = '25302199';
    },
    (copy) => {
      copy.criteria.find((c) => c.kind === 'date_code').values = ['2510', '2511'];
    },
    (copy) => {
      copy.criteria[0].provenance.sourceField += '-moved';
    },
    (copy) => {
      copy.review.sourceAddressHashes = [...copy.review.sourceAddressHashes].reverse();
    },
    (copy) => {
      copy.review.sourceRevisionHash = 'a'.repeat(64);
    },
    (copy) => {
      copy.review.identityFingerprint = 'b'.repeat(64);
    },
    (copy) => {
      copy.review.scopeSemanticFingerprint = 'c'.repeat(64);
    },
  ];
  for (const change of changes) {
    const copy = structuredClone(set);
    change(copy);
    assert.notEqual(await computeRuleSetFingerprintV2(copy), base);
  }
  const permuted = structuredClone(set);
  permuted.criteria.find((c) => c.kind === 'date_code').values.reverse();
  assert.equal(await computeRuleSetFingerprintV2(permuted), base, 'value order is canonical');
});

test('simple recalls: a single rule set behaves exactly like the previous single all_of', async () => {
  const page = pairedPage();
  page.tables[0] = page.tables[0].slice(0, 2);
  const { envelope, scopeId } = await servedEnvelope(page);
  assert.equal(envelope.ruleSets.length, 1);
  const { projection } = await project(page, envelope, scopeId);
  const recall = recallRow(page);
  const scope = { scope_id: scopeId, product_name: 'Product', model_number: null };
  const legacy = projectRecallForProductionV2({ ...recall, scopes: [scope] }, [
    envelope.ruleSets[0],
  ]);
  for (const [model, code] of [
    ['MODEL-A', '2510'],
    ['MODEL-A', '2511'],
    ['MODEL-A', null],
    ['MODEL-Z', '2510'],
    [null, null],
  ]) {
    const product = owned(model, code);
    assert.equal(
      evaluateRuleSetsPairV2(product, projection).decision,
      evaluateProductionPairV2(product, legacy).decision,
      `${model}/${code}`,
    );
  }
  const modelOnly = structuredClone(envelope);
  modelOnly.ruleSets[0].criteria = modelOnly.ruleSets[0].criteria.filter(
    (criterion) => criterion.kind === 'model_number',
  );
  const modelOnlyLegacy = projectRecallForProductionV2({ ...recall, scopes: [scope] }, [
    modelOnly.ruleSets[0],
  ]);
  for (const model of ['MODEL-A', 'MODEL-B', null]) {
    assert.equal(
      evaluateDeterministicMatchV2(owned(model, null), modelOnlyLegacy).decision,
      evaluateDeterministicRuleSetsV2(owned(model, null), {
        ...modelOnlyLegacy,
        scopes: modelOnlyLegacy.scopes.map(({ criteria, ...scope }) => ({
          ...scope,
          ruleSets: [{ ...criteria, ruleSetId: 'single' }],
          ruleSetCoverageComplete: true,
        })),
      }).decision,
    );
  }
});

test('fingerprint of the evaluation is stable under rule-set order and changes with coverage', async () => {
  const page = await charBroilPage();
  const { envelope, scopeId } = await servedEnvelope(page);
  const { projection } = await project(page, envelope, scopeId);
  const reversed = await project(
    page,
    { ...envelope, ruleSets: [...envelope.ruleSets].reverse() },
    scopeId,
  );
  const product = owned('25302145', '2511');
  const first = await ruleSetsFingerprintV2({ ownedProduct: product, projection });
  assert.equal(
    first,
    await ruleSetsFingerprintV2({ ownedProduct: product, projection: reversed.projection }),
  );
  assert.notEqual(
    first,
    await ruleSetsFingerprintV2({
      ownedProduct: product,
      projection: { ...projection, coverageComplete: false },
    }),
  );
});

// Backward compatibility with the frozen deterministic_v2 benchmark.
const load = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const phase15 = 'benchmarks/recall-matching/phase-15/';

test('all 200 frozen benchmark cases decide identically through the rule-set adapter', async () => {
  const schema = await load(`${phase15}benchmark.schema.json`);
  const sources = await load(`${phase15}sources.normalized.json`);
  const frozen = await load(
    'benchmarks/recall-matching/phase-16/results/deterministic-v2-all.json',
  );
  const frozenByCase = new Map(frozen.cases.map((item) => [item.caseId, item.evaluation.decision]));
  const byFamily = new Map(sources.sources.map((source) => [source.recallFamilyId, source]));
  let compared = 0;
  let withheldUnderIncompleteCoverage = 0;
  let gtinCases = 0;
  for (const split of ['development', 'holdout', 'stress']) {
    const dataset = await load(`${phase15}${split}.v2.json`);
    assert.deepEqual(validatePhase15Split(dataset, schema, sources, split), []);
    for (const benchmarkCase of dataset.cases) {
      const source = byFamily.get(benchmarkCase.recallFamilyId);
      const official = projectPhase15RecallV2(source);
      const product = projectPhase15OwnedProductV2(benchmarkCase);
      const ruleSets = official.scopes.map((scope, index) => ({
        ...scope.criteria,
        ruleSetId: `rule-${index}`,
      }));
      const [first] = official.scopes;
      const { criteria: _criteria, ...scopeBase } = first;
      const grouped = {
        ...official,
        scopes: [{ ...scopeBase, ruleSets, ruleSetCoverageComplete: true }],
      };
      const perScope = {
        ...official,
        scopes: official.scopes.map(({ criteria, ...scope }, index) => ({
          ...scope,
          ruleSets: [{ ...criteria, ruleSetId: `rule-${index}` }],
          ruleSetCoverageComplete: true,
        })),
      };
      const expected = frozenByCase.get(benchmarkCase.caseId);
      const decision = evaluateDeterministicRuleSetsV2(product, grouped).decision;
      assert.equal(decision, expected, `${benchmarkCase.caseId} (one scope, N rule sets)`);
      assert.equal(evaluateDeterministicRuleSetsV2(product, perScope).decision, expected);
      const incomplete = evaluateDeterministicRuleSetsV2(product, {
        ...grouped,
        scopes: [{ ...grouped.scopes[0], ruleSetCoverageComplete: false }],
      });
      assert.equal(incomplete.decision === 'confirmed', expected === 'confirmed');
      assert.notEqual(incomplete.decision, 'rejected');
      if (incomplete.rejectionWithheld) withheldUnderIncompleteCoverage += 1;
      if (ruleSets.some((set) => set.criteria.some((criterion) => criterion.kind === 'gtin'))) {
        gtinCases += 1;
      }
      compared += 1;
    }
  }
  assert.equal(compared, 200);
  assert.ok(gtinCases > 0, 'GTIN rules are exercised');
  assert.ok(withheldUnderIncompleteCoverage > 0);
});

test('the three known unsafe cases stay non-confirming through the adapter', async () => {
  const sources = await load(`${phase15}sources.normalized.json`);
  const byFamily = new Map(sources.sources.map((source) => [source.recallFamilyId, source]));
  const stress = await load(`${phase15}stress.v2.json`);
  for (const caseId of ['p15-str-45-2', 'p15-str-45-3', 'p15-str-46-3']) {
    const benchmarkCase = stress.cases.find((item) => item.caseId === caseId);
    const official = projectPhase15RecallV2(byFamily.get(benchmarkCase.recallFamilyId));
    const evaluation = evaluateDeterministicRuleSetsV2(
      projectPhase15OwnedProductV2(benchmarkCase),
      {
        ...official,
        scopes: official.scopes.map(({ criteria, ...scope }, index) => ({
          ...scope,
          ruleSets: [{ ...criteria, ruleSetId: `rule-${index}` }],
          ruleSetCoverageComplete: true,
        })),
      },
    );
    assert.notEqual(evaluation.decision, 'confirmed', caseId);
    assert.equal(evaluation.adapter, DETERMINISTIC_RULE_SETS_ADAPTER_V2);
  }
});

test('ingestion never needs a matcher criterion and never rewrites a quarantined record', async () => {
  const calls = [];
  const database = (handlers) => ({
    rpc(name, parameters) {
      calls.push(name);
      const handler = handlers[name];
      return Promise.resolve(
        handler
          ? { data: handler(parameters), error: null }
          : { data: null, error: { message: `unexpected ${name}` } },
      );
    },
  });
  const record = {
    externalId: '10965',
    title: 'Recall',
    recallDate: '2026-09-10',
    officialUrl: 'https://www.cpsc.gov/Recalls/2026/Recall',
    rawPayload: { RecallID: 10965, RecallNumber: '26753' },
  };
  const held = await ingestCpscRecallIdentity(
    database({
      // Phase 16.16A: the hold is returned only with its payload retained.
      record_cpsc_retained_observation: (parameters) => ({
        status: 'quarantined',
        observationId: uuid('obs'),
        reason: 'API ID belongs to another historical recall',
        decisionClass: 'D_api_id_reuse',
        replayed: false,
        seenCount: 1,
        payloadSha256: parameters.p_payload_hash,
        payloadRetention: 'retained',
      }),
    }),
    record,
  );
  assert.equal(held.status, 'quarantined');
  assert.deepEqual(calls, ['record_cpsc_retained_observation']);
  assert.ok(
    !calls.some((name) => /decide|materialize|recall_v2_scopes|reconcile|invalidate/u.test(name)),
  );
});

test('the rule-set modules import no AI, push, or hybrid code', async () => {
  for (const path of [
    'supabase/functions/_shared/matching/deterministicRuleSetsV2.ts',
    'supabase/functions/_shared/recallMatching/ruleSetsV2.ts',
  ]) {
    const body = await readFile(new URL(path, root), 'utf8');
    assert.doesNotMatch(body, /from ['"].*(nebius|nemotron|push|hybridGuarded)/iu);
  }
});
