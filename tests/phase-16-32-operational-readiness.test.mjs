import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { extractCpscPageStructure } from '../supabase/functions/_shared/cpsc/htmlExtractor.ts';
import { semanticCpscRevision } from '../supabase/functions/_shared/cpsc/pageEvidence.ts';
import {
  PAGE_WORKER_CLAIM_RESERVE_MS,
  PAGE_WORKER_MAX_CONCURRENCY,
  PAGE_WORKER_MAX_MS,
  PAGE_WORKER_PAGE_RESERVE_MS,
  runCpscPageWorker,
} from '../supabase/functions/_shared/cpsc/scheduledPageWorker.ts';
import { buildCpscSourceCoverage } from '../supabase/functions/_shared/cpsc/sourceCoverage.ts';
import { projectOwnedProductForProductionV2 } from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';
import {
  computeRuleSetFingerprintV2,
  evaluateRuleSetsPairV2,
  projectRecallRuleSetsForProductionV2,
  validateLiveRuleSetEnvelopeV2,
} from '../supabase/functions/_shared/recallMatching/ruleSetsV2.ts';

// Production values recorded read-only in Phase 16.31b / 16.32 for 26773
// (revision c7919ccf…, ledger 4a7ec80a…). The fixture's raw bytes differ from
// the retained production bytes; every semantic and coverage identity must not.
const PRODUCTION_26773 = {
  semanticHash: 'd37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667',
  tableIdentity:
    'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978',
  coverageFingerprint: 'faea74e5b6a1be8861b3a79b00d76750dcc20f552e476bcb58a1f17dd563a65a',
  interpretationFingerprint: '38d9006c8b3d5b0e151766f795b641b10190ff3d7affcb0d7a46500f36b4d37e',
  rowIdentities: [
    '4a6cc5be45760f9774c1b4281a02e428a6a832c03eca6b2b6d38f24a0eb92e68',
    '5f832aaf587748a80e518f9979fd7634b377574b634605891d75f7a33c512b4b',
    '6427cf1e40f7a51b53aa0b6ede9e7f48812d43442989067cc0923e4d10d1ad58',
    '6eaad3c9ce9220f8852d7d4ae7581918a78ccc513f9726ae3094ca56a1f30940',
    '94245b2eefe002535a2ee8f393c12f3a2bc185323e81dc351d550f5b6c49d431',
    '94493055367286a25d054be93cdd078defff54c83466101565570297a261fabb',
    'e61218ab39ecccb87269f595b042b9f653873afd76fa4a7141825366b7b28f0a',
    'ed70e1c846b4fd22dc267e36eacab58aeda21283981b38e9b8394e2beb12b7f9',
    'ef15f29f28d9be689e938438a1a4292084ed5d96e96b57ef77b8ed69ecb4be42',
  ],
  // model -> production evidence fingerprint of its row conjunction
  rows: {
    25302145: '66b72dc2f500e6040cc12866a8f143c1be57b3c63a7e25c3dd8474c6a1a8fb0b',
    25302146: '751c305a7b7d3fcd7639f0a25ac450cd41d580e06498300dc6304bc546b37901',
    25302147: '00db048927d4a9ab170b336068cbcd7158dd39f6ce48d224a6e439f0db9c0350',
    25302148: '32bf5509e0264f47ddec3fa8d6d3ca9c27a5beb276aa7b9280be35ad458a2625',
    25302149: '58bf7e5738e0278ca59733a7a4b254ac6e15b49e0d229003af71e82f82ad0896',
    25302150: '5c7fbbcd1900d110b2e69757de8a44a6023771666719cb7e1e7ef897331fb446',
    25302151: 'cb3489b00be64ccdb3887c31e06c967fc7e7665f9d891472d6e33e8412cb7e14',
    25302159: 'a6e096ab985f8c89727bb1afbfb5760c7875391c194b434c742d8466ab2b800e',
    25302163: 'e8b9985d21a2c3ad4188179a16a0217f6b98b0b4d093661acc0a1ffc19554d6d',
  },
  governingSentence:
    'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.',
};

const root = new URL('../', import.meta.url);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const uuid = (seed) => {
  const hex = sha(String(seed));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const charBroil = () =>
  readFile(new URL('tests/fixtures/cpsc-pages/char-broil.html', root), 'utf8');
const canonicalOf = (body) => /<link rel="canonical" href="([^"]+)"/u.exec(body)[1];

async function analyze(body) {
  const { page, census } = extractCpscPageStructure(body, canonicalOf(body));
  const revision = await semanticCpscRevision(page);
  return { page, census, revision, ...(await buildCpscSourceCoverage(page, census, revision)) };
}

function groupsOf(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    groups.set(candidate.conjunctionKey, [
      ...(groups.get(candidate.conjunctionKey) ?? []),
      candidate,
    ]);
  }
  return groups;
}

/**
 * The database serving path after human review, restricted to the reviewed
 * conjunction groups: coverage is complete only when every proposed group is
 * reviewed and the ledger proves the universe (Phase 16.13 contract).
 */
async function served(page, { candidates, summary }, reviewedGroups) {
  if (summary.positiveStatus !== 'independent') return null;
  const revision = await semanticCpscRevision(page);
  const scopeId = uuid(`${page.recallNumber}:scope`);
  const groups = groupsOf(candidates);
  const ruleSets = [];
  for (const [conjunctionGroup, members] of groups) {
    if (!reviewedGroups.has(conjunctionGroup)) continue;
    const ids = members.map((member, index) => ({
      ...member,
      candidateId: uuid(`${conjunctionGroup}:${index}`),
    }));
    ids.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    const set = {
      semantics: 'all_of',
      criteria: ids.map((member) => ({
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
        candidateIds: ids.map((member) => member.candidateId),
        reviewEventIds: ids.map((member) => uuid(`${member.candidateId}:event`)),
        reviewerIds: ids.map(() => uuid('reviewer')),
        reviewedAt: '2026-09-30T10:00:00.000Z',
        schema: 'recall_rule_set_v1',
        identityFingerprint: sha(`cpsc\u0000${page.recallNumber}`),
        scopeSemanticFingerprint: sha(`${page.recallNumber}:semantic-scope`),
        sourceAddressHashes: ids.map((member) => sha(JSON.stringify(member.sourceAddress))),
        ruleSetFingerprint: '',
      },
    };
    set.review.ruleSetFingerprint = await computeRuleSetFingerprintV2(set);
    ruleSets.push(set);
  }
  if (!ruleSets.length) return null;
  const relations = new Set(summary.reviewableRelations);
  const sameUniverse =
    groups.size === relations.size && [...groups.keys()].every((key) => relations.has(key));
  return {
    scopeId,
    envelope: {
      semantics: 'any_of',
      schema: 'recall_rule_sets_v1',
      scopeId,
      ruleSets,
      coverage: {
        currentRevisionId: uuid(`${page.recallNumber}:revision`),
        proposedRuleSets: groups.size,
        unattributedRuleSets: 0,
        servedRuleSets: ruleSets.length,
        complete:
          ruleSets.length === groups.size && summary.negativeEvidenceEligible && sameUniverse,
        sourceCoverage: {
          state: 'recorded',
          coverageStatus: summary.coverageStatus,
          positiveStatus: summary.positiveStatus,
          negativeEvidenceEligible: summary.negativeEvidenceEligible,
        },
      },
    },
  };
}

async function decider(page, envelope) {
  const recall = {
    recall_notice_id: uuid(`${page.recallNumber}:notice`),
    recall_notice_updated_at: '2026-09-30T10:00:00Z',
    source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
    source_external_id: `cpsc:${page.recallNumber}`,
    source_official_url: page.canonicalUrl,
    source_is_authoritative: true,
    title: page.title,
    description: null,
    hazard: null,
    remedy: null,
    recall_date: '2026-09-17',
    raw_payload: {},
    scopes: [],
  };
  const scope = {
    scope_id: envelope?.scopeId ?? uuid(`${page.recallNumber}:scope`),
    product_name: 'Bistro Pro Electric Grills',
    model_number: null,
  };
  const validated = envelope
    ? await validateLiveRuleSetEnvelopeV2(recall, scope, envelope.envelope)
    : null;
  const projection = projectRecallRuleSetsForProductionV2({ ...recall, scopes: [scope] }, [
    validated,
  ]);
  return (model, code) =>
    evaluateRuleSetsPairV2(
      projectOwnedProductForProductionV2({
        owned_product_id: 'owned',
        owned_product_updated_at: '2026-09-30T10:00:00Z',
        user_id: 'user',
        product_name: 'Grill',
        brand: null,
        category: null,
        gtin: null,
        model_number: model,
        serial_number: null,
        lot_number: null,
        purchase_date: null,
        identification_method: 'manual',
        safety_attributes: code ? { date_code: code } : {},
      }),
      projection,
    ).decision;
}

// ---------------------------------------------------------------------------
// 26773: production equivalence and row-level rule relationships
// ---------------------------------------------------------------------------

test('26773 fixture reproduces every production semantic and coverage identity', async () => {
  const { revision, summary, candidates } = await analyze(await charBroil());
  assert.equal(revision.semanticHash, PRODUCTION_26773.semanticHash);
  assert.deepEqual(
    revision.tableIdentities.map((table) => table.identity),
    [PRODUCTION_26773.tableIdentity],
  );
  assert.deepEqual(
    revision.tableIdentities[0].rows.map((row) => row.identity).sort(),
    PRODUCTION_26773.rowIdentities,
  );
  assert.equal(summary.coverageFingerprint, PRODUCTION_26773.coverageFingerprint);
  assert.equal(summary.interpretationFingerprint, PRODUCTION_26773.interpretationFingerprint);
  assert.deepEqual(summary.dispositionCounts, {
    parsed_reviewable: 10,
    parsed_deferred: 0,
    unresolved: 0,
    unsupported: 0,
    ignored_non_safety: 4,
  });
  assert.equal(candidates.length, 18);
  assert.ok(candidates.every((candidate) => candidate.status === 'unreviewed'));
});

test('26773 is nine row rule sets (model AND date codes), never 81 model/date combinations', async () => {
  const { ledger, candidates } = await analyze(await charBroil());
  const groups = groupsOf(candidates);
  assert.equal(groups.size, 9, 'OR across nine independent row-level rule sets');
  const models = new Set();
  for (const [key, members] of groups) {
    assert.deepEqual(members.map((member) => member.kind).sort(), ['date_code_set', 'model_exact']);
    const model = members.find((member) => member.kind === 'model_exact');
    const dates = members.find((member) => member.kind === 'date_code_set');
    // Both conjuncts address the same row; the key is that row, not a product.
    assert.equal(model.sourceAddress.rowIdentity, dates.sourceAddress.rowIdentity);
    assert.equal(key, `${PRODUCTION_26773.tableIdentity}/${model.sourceAddress.rowIdentity}`);
    assert.equal(model.sourceAddress.evidenceFingerprint, PRODUCTION_26773.rows[model.value]);
    assert.ok(model.authoritativeExcerpt.endsWith(`| ${model.value}`), 'model comes from its row');
    models.add(model.value);
  }
  assert.equal(models.size, 9);
  const pairs = new Set(
    candidates
      .filter((candidate) => candidate.kind === 'model_exact')
      .map((model) => {
        const dates = groups.get(model.conjunctionKey).find((m) => m.kind === 'date_code_set');
        return `${model.value}:${dates.value.join(',')}`;
      }),
  );
  assert.equal(pairs.size, 9, 'nine model/date conjunctions, not a 9 x 9 cross product');

  // The date codes are one page-level restriction, copied into each row.
  const dateCandidates = candidates.filter((candidate) => candidate.kind === 'date_code_set');
  assert.deepEqual(
    [...new Set(dateCandidates.map((candidate) => candidate.authoritativeExcerpt))],
    [PRODUCTION_26773.governingSentence],
  );
  assert.deepEqual(
    [...new Set(dateCandidates.map((candidate) => candidate.value.join(',')))],
    ['2510,2511,2512'],
  );
  const table = ledger.structures.find((structure) => structure.kind === 'table');
  assert.ok(
    table.records.every((record) =>
      record.cells.every((cell) => cell.criterionClass !== 'date_code'),
    ),
    'no table cell carries a date code',
  );
  const governing = ledger.structures
    .find((structure) => structure.kind === 'prose')
    .records.filter((record) => record.relation === `governs:${PRODUCTION_26773.tableIdentity}`);
  assert.equal(governing.length, 1, 'exactly one prose sentence governs the model table');
  assert.equal(governing[0].disposition, 'parsed_reviewable');
});

test('members of different rule sets are never combined across rows', async () => {
  const { page, candidates, summary } = await analyze(await charBroil());
  // A counterfactual page where each row carries its own date codes.
  const perRow = candidates.map((candidate) =>
    candidate.kind === 'date_code_set' &&
    candidate.conjunctionKey.endsWith(PRODUCTION_26773.rowIdentities[0])
      ? { ...candidate, value: ['2401'] }
      : candidate,
  );
  const decide = await decider(
    page,
    await served(page, { candidates: perRow, summary }, new Set(groupsOf(perRow).keys())),
  );
  // 25302149 is the row with identity rowIdentities[0] (evidence 58bf7e57…).
  assert.equal(decide('25302149', '2401'), 'confirmed', 'its own row pairing matches');
  assert.notEqual(decide('25302149', '2510'), 'confirmed', 'another row’s date set never matches');
  assert.notEqual(decide('25302145', '2401'), 'confirmed', 'a date from another row never matches');
});

// ---------------------------------------------------------------------------
// Negative-evidence safety
// ---------------------------------------------------------------------------

test('page-level complete coverage authorizes nothing while candidates are unreviewed', async () => {
  const { page, summary, candidates } = await analyze(await charBroil());
  assert.equal(summary.negativeEvidenceEligible, true, 'the page ledger alone is complete');
  const none = await decider(page, await served(page, { candidates, summary }, new Set()));
  for (const [model, code] of [
    ['25302145', '2511'],
    ['25302145', '2509'],
    ['25302199', '2510'],
  ]) {
    const decision = none(model, code);
    assert.notEqual(decision, 'confirmed', `${model}/${code}: no unreviewed positive`);
    assert.notEqual(decision, 'rejected', `${model}/${code}: no unreviewed negative`);
  }
});

test('an incomplete reviewed universe never produces an authoritative rejection', async () => {
  const { page, summary, candidates } = await analyze(await charBroil());
  const keys = [...groupsOf(candidates).keys()];
  const eight = await decider(
    page,
    await served(page, { candidates, summary }, new Set(keys.slice(1))),
  );
  const missing = groupsOf(candidates)
    .get(keys[0])
    .find((member) => member.kind === 'model_exact').value;
  assert.notEqual(eight(missing, '2510'), 'rejected', 'the unreviewed row is never rejected');
  assert.notEqual(eight('25302199', '2510'), 'rejected', 'no unlisted-model rejection at 8 of 9');
  assert.notEqual(
    eight(missing === '25302145' ? '25302146' : '25302145', '2509'),
    'rejected',
    'no date-code rejection at 8 of 9',
  );

  const all = await decider(page, await served(page, { candidates, summary }, new Set(keys)));
  assert.equal(all('25302145', '2509'), 'rejected', 'only a complete reviewed universe rejects');
  assert.notEqual(all('25302145', null), 'rejected', 'an omitted date code is never a rejection');
  assert.notEqual(all('25302145', null), 'confirmed', 'an omitted date code is never a match');
});

test('a source revision changes every candidate address, so earlier approvals cannot carry over', async () => {
  const body = await charBroil();
  const before = await analyze(body);
  const after = await analyze(
    body.replace('2512 (Dec-2025)', '2512 (Dec-2025) and 2601 (Jan-2026)'),
  );
  assert.notEqual(after.revision.semanticHash, before.revision.semanticHash);
  assert.ok(
    after.candidates.every(
      (candidate) => candidate.sourceAddress.sourceSemanticRevision === after.revision.semanticHash,
    ),
  );
  assert.ok(
    before.candidates.every(
      (candidate) => candidate.sourceAddress.sourceSemanticRevision !== after.revision.semanticHash,
    ),
  );
});

test('census limit: recall-detail prose is outside coverage and needs reviewer attestation', async () => {
  const body = await charBroil();
  const base = await analyze(body);
  // A restriction written only in the Remedy section.
  const restricted = body.replaceAll(
    'Consumers should stop using the recalled electric grills immediately',
    'Only grills sold at Walmart are included. Consumers should stop using the recalled electric grills immediately',
  );
  assert.notEqual(restricted, body, 'fixture remedy text');
  const result = await analyze(restricted);
  assert.notEqual(
    result.revision.semanticHash,
    base.revision.semanticHash,
    'the change is part of the semantic revision',
  );
  assert.equal(
    result.summary.negativeEvidenceEligible,
    true,
    'the page ledger does not see recall-detail prose',
  );
  assert.deepEqual(
    result.summary.dispositionCounts,
    base.summary.dispositionCounts,
    'the new restriction adds no ledger record',
  );
  assert.equal(result.summary.authoritativeRecords, base.summary.authoritativeRecords);
  assert.ok(
    result.ledger.structures.every((structure) => structure.sectionIdentity === 'description'),
  );
});

// ---------------------------------------------------------------------------
// Worker admission timing replayed from production claim timestamps
// ---------------------------------------------------------------------------

/** Replays claim/finish instants (ms after worker start) with a scripted clock. */
async function replay({ maxPages, claimsAt, doneAt, start = -300 }) {
  let clock = start;
  const queue = claimsAt.map((_, index) => ({
    claim_id: `claim-${index}`,
    identity_id: `identity-${index}`,
    official_recall_number: String(30000 + index),
    canonical_url: `https://www.cpsc.gov/Recalls/2026/Replay-${index}`,
    sole_scope_id: null,
  }));
  let claimed = 0;
  let fetches = 0;
  const database = {
    async rpc(name, parameters) {
      if (name === 'claim_cpsc_page_evidence') {
        const next = queue.shift();
        if (!next) return { data: [], error: null };
        clock = Math.max(clock, claimsAt[claimed]);
        next.index = claimed++;
        return { data: [next], error: null };
      }
      if (name === 'finish_cpsc_page_attempt')
        return { data: { outcome: parameters.p_outcome }, error: null };
      return { data: null, error: new Error('unexpected RPC') };
    },
  };
  const result = await runCpscPageWorker(
    database,
    { maxPages, timeBudgetMs: PAGE_WORKER_MAX_MS },
    {
      now: () => clock,
      fetchImpl: async (url) => {
        const index = Number(/Replay-(\d+)/u.exec(url)[1]);
        fetches++;
        // Real delays preserve production completion order.
        await new Promise((resolve) => setTimeout(resolve, (doneAt[index] - claimsAt[index]) / 20));
        clock = Math.max(clock, doneAt[index]);
        return new Response('upstream', { status: 503 });
      },
    },
  );
  return { ...result, fetches };
}

test('the reviewed budget admits claims only in the first two seconds of a cycle', () => {
  assert.equal(PAGE_WORKER_MAX_MS - PAGE_WORKER_CLAIM_RESERVE_MS, 2_000);
  assert.equal(PAGE_WORKER_PAGE_RESERVE_MS, 16_000, '10 s fetch + 4 s statement + 2 s margin');
  assert.equal(PAGE_WORKER_MAX_CONCURRENCY, 2);
  assert.ok(
    PAGE_WORKER_PAGE_RESERVE_MS + 2_000 < 30_000,
    'every admitted page ends inside its 30 s lease',
  );
});

test('16.31 replay: maxPages=6 completes four pages, then admission_budget', async () => {
  // Offsets from the first claim (16:55:01.577): 20164, 20165, 26748, 26755.
  const result = await replay({
    maxPages: 6,
    claimsAt: [0, 372, 1368, 1614],
    doneAt: [1475, 1206, 1820, 2055],
  });
  assert.equal(result.claimed, 4);
  assert.equal(result.stoppedBy, 'admission_budget');
  assert.equal(result.fetches, 4);
});

test('16.31b replay: maxPages=2 completes two pages, then page_limit', async () => {
  // 26761 at 07:02:58.677, 26773 at 07:02:58.929.
  const result = await replay({ maxPages: 2, claimsAt: [0, 252], doneAt: [660, 677] });
  assert.equal(result.claimed, 2);
  assert.equal(result.stoppedBy, 'page_limit');
});

test('a stopped or paused stage is invisible to the worker: no claim, no fetch', async () => {
  const result = await replay({ maxPages: 2, claimsAt: [], doneAt: [] });
  assert.equal(result.claimed, 0);
  assert.equal(result.fetches, 0);
  assert.equal(result.stoppedBy, 'queue_empty');
});
